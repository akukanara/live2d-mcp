import os
import sys
import torch
import numpy as np
import soundfile as sf
import asyncio
import edge_tts
import parselmouth
import faiss

current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(current_dir)

from infer_pack.models import SynthesizerTrnMs768NSFsid
from transformers import HubertModel

async def test_rvc():
    print("=== MEMULAI ANALISIS MANDIRI AUDIO RVC ===")
    
    model_path = r"M:\Users\ahmad\project\live2d-mcp\voice\HuoHuo\HuoHuo.pth"
    index_path = r"M:\Users\ahmad\project\live2d-mcp\voice\HuoHuo\added_IVF273_Flat_nprobe_1_HuoHuo_v2.index"
    
    if not os.path.exists(model_path):
        print(f"Error: Model tidak ditemukan di {model_path}")
        return
        
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device yang terdeteksi: {device}")
    
    # Check FAISS index
    index = None
    if os.path.exists(index_path):
        try:
            index = faiss.read_index(index_path)
            index.make_direct_map()
            print(f"FAISS index loaded! Dimension: {index.d}, Total vectors: {index.ntotal}")
        except Exception as e:
            print(f"Error loading FAISS index: {e}")
            
    # 2. Hasilkan audio dasar menggunakan Edge-TTS
    temp_base = os.path.join(current_dir, "test_base.wav")
    print("Menghasilkan audio dasar Edge-TTS...")
    communicate = edge_tts.Communicate("Halo selamat sore! Senang sekali bisa bertemu denganmu.", "id-ID-GadisNeural")
    await communicate.save(temp_base)
    print(f"Audio dasar disimpan di: {temp_base}")
    
    # Baca input
    y, sr_orig = sf.read(temp_base)
    if len(y.shape) > 1:
        y = np.mean(y, axis=1)
    
    # Resample ke 16000
    if sr_orig != 16000:
        duration = len(y) / sr_orig
        num_samples = int(duration * 16000)
        indices = np.linspace(0, len(y) - 1, num_samples)
        y = np.interp(indices, np.arange(len(y)), y)
        
    y = y / np.max(np.abs(y)) * 0.95
    
    # Muat HuBERT
    print("Memuat HuBERT model...")
    hubert_model = HubertModel.from_pretrained("facebook/hubert-base-ls960").to(device)
    hubert_model.eval()
    
    # Muat RVC checkpoint
    cpt = torch.load(model_path, map_location="cpu")
    config = cpt["config"]
    sr_target = cpt.get("sr", config[-1])
    if isinstance(sr_target, str):
        sr_target = 40000
    else:
        sr_target = int(sr_target)
        
    # Helper to calculate ZCR and energy to detect white noise
    def analyze_audio_signal(audio, name):
        zcr = np.mean(np.abs(np.diff(np.sign(audio)))) / 2
        rms = np.sqrt(np.mean(audio**2))
        print(f"--- ANALISIS SINYAL: {name} ---")
        print(f"  Shape: {audio.shape}")
        print(f"  RMS (Volume): {rms:.6f}")
        print(f"  ZCR (Zero Crossing Rate): {zcr:.6f} (Nilai tinggi >0.2 berarti NOISE/DESIS)")
        print(f"  Min: {np.min(audio):.6f}, Max: {np.max(audio):.6f}")
        # Analyze first 5 values to see if they look like random static
        print(f"  Sampel pertama (5 values): {audio[:5]}")
        if zcr > 0.2:
            print("  WARN: Sinyal memiliki frekuensi tinggi yang sangat rapat (WHITE NOISE / DESIS!)")
        else:
            print("  OK: ZCR normal, kemungkinan besar suara manusia terstruktur.")
            
    # --- PENGUJIAN 1: DENGAN FP16 (is_half = True) DAN FAISS BLENDING ---
    print("\n--- [PENGUJIAN 1] Menggunakan CUDA FP16 + FAISS (index_rate=0.4) ---")
    try:
        hubert_model_fp16 = hubert_model.half()
        
        net_g_fp16 = SynthesizerTrnMs768NSFsid(*config, is_half=True)
        net_g_fp16.load_state_dict(cpt["weight"], strict=False)
        net_g_fp16.eval()
        net_g_fp16 = net_g_fp16.half().to(device)
        
        y_norm = (y - np.mean(y)) / (np.std(y) + 1e-5)
        input_fp16 = torch.tensor(y_norm, dtype=torch.half, device=device).unsqueeze(0)
        
        with torch.no_grad():
            feats_fp16 = hubert_model_fp16(input_fp16).last_hidden_state.squeeze(0).cpu().numpy()
            
        target_len = feats_fp16.shape[0]
        
        # FAISS blend
        if index is not None:
            feats_flat = feats_fp16.astype('float32')
            D, I = index.search(feats_flat, 1)
            db_feats = []
            for idx in I.squeeze(-1):
                db_feats.append(index.reconstruct(int(idx)))
            db_feats = np.array(db_feats).astype('float32')
            feats_fp16 = 0.4 * db_feats + 0.6 * feats_fp16
            
        # Pitch Parselmouth
        f0 = parselmouth.Sound(y, sampling_frequency=16000).to_pitch_ac(
            time_step=(len(y)/16000)/target_len, pitch_floor=65, pitch_ceiling=1100
        ).selected_array['frequency']
        
        if len(f0) > target_len:
            f0 = f0[:target_len]
        else:
            f0 = np.pad(f0, (0, target_len - len(f0)), 'constant')
        f0 = f0 * (2 ** (8 / 12.0)) # shift +8
        
        f0_mel_min = 1127 * np.log(1 + 50 / 700)
        f0_mel_max = 1127 * np.log(1 + 1100 / 700)
        f0_mel = 1127 * np.log(1 + f0 / 700)
        voiced_mask = f0_mel > 0
        f0_mel[voiced_mask] = (f0_mel[voiced_mask] - f0_mel_min) * 254 / (f0_mel_max - f0_mel_min) + 1
        f0_mel[f0_mel <= 1] = 1
        f0_mel[f0_mel > 255] = 255
        f0_coarse = np.rint(f0_mel).astype(int)
        
        phone = torch.tensor(feats_fp16, dtype=torch.half, device=device).unsqueeze(0)
        phone_lengths = torch.tensor([target_len], dtype=torch.long, device=device)
        pitch = torch.tensor(f0_coarse, dtype=torch.long, device=device).unsqueeze(0)
        pitchf = torch.tensor(f0, dtype=torch.half, device=device).unsqueeze(0)
        sid = torch.tensor([0], dtype=torch.long, device=device)
        
        with torch.no_grad():
            o, _, _ = net_g_fp16.infer(phone, phone_lengths, pitch, pitchf, sid)
            audio_fp16 = o.squeeze().cpu().float().numpy()
            
        analyze_audio_signal(audio_fp16, "FP16 + FAISS 0.4")
        sf.write(os.path.join(current_dir, "test_out_fp16.wav"), audio_fp16, sr_target)
        print("WAV FP16 disimpan sebagai test_out_fp16.wav!")
            
    except Exception as e:
        print(f"FP16 Exception: {e}")
        import traceback
        traceback.print_exc()

    # --- PENGUJIAN 2: DENGAN FP32 (is_half = False) DAN FAISS BLENDING ---
    print("\n--- [PENGUJIAN 2] Menggunakan CUDA FP32 + FAISS (index_rate=0.4) ---")
    try:
        hubert_model_fp32 = hubert_model.float()
        
        net_g_fp32 = SynthesizerTrnMs768NSFsid(*config, is_half=False)
        net_g_fp32.load_state_dict(cpt["weight"], strict=False)
        net_g_fp32.eval()
        net_g_fp32 = net_g_fp32.float().to(device)
        
        y_norm = (y - np.mean(y)) / (np.std(y) + 1e-5)
        input_fp32 = torch.tensor(y_norm, dtype=torch.float, device=device).unsqueeze(0)
        
        with torch.no_grad():
            feats_fp32 = hubert_model_fp32(input_fp32).last_hidden_state.squeeze(0).cpu().numpy()
            
        target_len = feats_fp32.shape[0]
        
        # FAISS blend
        if index is not None:
            feats_flat = feats_fp32.astype('float32')
            D, I = index.search(feats_flat, 1)
            db_feats = []
            for idx in I.squeeze(-1):
                db_feats.append(index.reconstruct(int(idx)))
            db_feats = np.array(db_feats).astype('float32')
            feats_fp32 = 0.4 * db_feats + 0.6 * feats_fp32
            
        phone = torch.tensor(feats_fp32, dtype=torch.float, device=device).unsqueeze(0)
        phone_lengths = torch.tensor([target_len], dtype=torch.long, device=device)
        pitch = torch.tensor(f0_coarse, dtype=torch.long, device=device).unsqueeze(0)
        pitchf = torch.tensor(f0, dtype=torch.float, device=device).unsqueeze(0)
        sid = torch.tensor([0], dtype=torch.long, device=device)
        
        with torch.no_grad():
            o, _, _ = net_g_fp32.infer(phone, phone_lengths, pitch, pitchf, sid)
            audio_fp32 = o.squeeze().cpu().float().numpy()
            
        analyze_audio_signal(audio_fp32, "FP32 + FAISS 0.4")
        
        # Normalisasi
        max_out = np.max(np.abs(audio_fp32))
        if max_out > 0:
            audio_fp32 = audio_fp32 / max_out * 0.95
            
        sf.write(os.path.join(current_dir, "test_out_fp32.wav"), audio_fp32, sr_target)
        print("WAV FP32 disimpan sebagai test_out_fp32.wav!")
        
    except Exception as e:
        print(f"FP32 Exception: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(test_rvc())
