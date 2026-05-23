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

def analyze_audio_envelope(filepath):
    y, sr = sf.read(filepath)
    frame_length = int(0.02 * sr)
    hop_length = int(0.01 * sr)
    rms_frames = []
    for i in range(0, len(y) - frame_length, hop_length):
        frame = y[i : i + frame_length]
        rms_frames.append(np.sqrt(np.mean(frame**2)))
    rms_frames = np.array(rms_frames)
    mean_rms = np.mean(rms_frames)
    max_rms = np.max(rms_frames)
    papr = max_rms / (mean_rms + 1e-6)
    silence_threshold = 0.10 * max_rms
    silent_frames = np.sum(rms_frames < silence_threshold)
    silent_percentage = (silent_frames / len(rms_frames)) * 100
    zcr = np.mean(np.abs(np.diff(np.sign(y)))) / 2
    
    print(f"ANALISIS {os.path.basename(filepath)}:")
    print(f"  Max Amplitude: {np.max(np.abs(y)):.6f}")
    print(f"  PAPR: {papr:.2f}")
    print(f"  Silence %: {silent_percentage:.2f}%")
    print(f"  ZCR: {zcr:.6f}")
    if zcr > 0.22:
        print("  -> RESULT: WHITE NOISE")
    elif np.std(rms_frames) < 0.05:
        print("  -> RESULT: BUZZING / ROBOTIC HUM")
    else:
        print("  -> RESULT: PERFECT STRUCTURAL HUMAN SPEECH!")

async def test_faiss_effect():
    model_path = r"M:\Users\ahmad\project\live2d-mcp\voice\HuoHuo\HuoHuo.pth"
    index_path = r"M:\Users\ahmad\project\live2d-mcp\voice\HuoHuo\added_IVF273_Flat_nprobe_1_HuoHuo_v2.index"
    
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    
    # Base audio
    temp_base = os.path.join(current_dir, "test_base.wav")
    y, sr_orig = sf.read(temp_base)
    if len(y.shape) > 1:
        y = np.mean(y, axis=1)
    if sr_orig != 16000:
        duration = len(y) / sr_orig
        num_samples = int(duration * 16000)
        indices = np.linspace(0, len(y) - 1, num_samples)
        y = np.interp(indices, np.arange(len(y)), y)
    y = y / np.max(np.abs(y)) * 0.95
    
    # Load Models (FP32 for CUDA stability)
    hubert_model = HubertModel.from_pretrained("facebook/hubert-base-ls960").to(device).eval()
    cpt = torch.load(model_path, map_location="cpu")
    config = cpt["config"]
    sr_val = cpt.get("sr", 40000)
    if isinstance(sr_val, str):
        sr_val_lower = sr_val.lower()
        if "k" in sr_val_lower:
            sr_target = int(float(sr_val_lower.replace("k", "").strip()) * 1000)
        else:
            sr_target = int(sr_val_lower.replace("hz", "").strip())
    else:
        sr_target = int(sr_val)
    
    net_g = SynthesizerTrnMs768NSFsid(*config, is_half=False).to(device).eval()
    net_g.load_state_dict(cpt["weight"], strict=False)
    
    # Extract HuBERT raw
    y_norm = (y - np.mean(y)) / (np.std(y) + 1e-5)
    input_tensor = torch.tensor(y_norm, dtype=torch.float, device=device).unsqueeze(0)
    with torch.no_grad():
        feats_raw = hubert_model(input_tensor).last_hidden_state.squeeze(0).cpu().numpy()
        
    target_len = feats_raw.shape[0]
    
    # Pitch extraction (Parselmouth)
    f0 = parselmouth.Sound(y, sampling_frequency=16000).to_pitch_ac(
        time_step=(len(y)/16000)/target_len, pitch_floor=65, pitch_ceiling=1100
    ).selected_array['frequency']
    if len(f0) > target_len:
        f0 = f0[:target_len]
    else:
        f0 = np.pad(f0, (0, target_len - len(f0)), 'constant')
    f0 = f0 * (2 ** (8 / 12.0))
    
    f0_mel_min = 1127 * np.log(1 + 50 / 700)
    f0_mel_max = 1127 * np.log(1 + 1100 / 700)
    f0_mel = 1127 * np.log(1 + f0 / 700)
    voiced_mask = f0_mel > 0
    f0_mel[voiced_mask] = (f0_mel[voiced_mask] - f0_mel_min) * 254 / (f0_mel_max - f0_mel_min) + 1
    f0_mel[f0_mel <= 1] = 1
    f0_mel[f0_mel > 255] = 255
    f0_coarse = np.rint(f0_mel).astype(int)
    
    phone_lengths = torch.tensor([target_len], dtype=torch.long, device=device)
    pitch = torch.tensor(f0_coarse, dtype=torch.long, device=device).unsqueeze(0)
    pitchf = torch.tensor(f0, dtype=torch.float, device=device).unsqueeze(0)
    sid = torch.tensor([0], dtype=torch.long, device=device)
    
    # 1. PENGUJIAN TANPA FAISS (index_rate = 0.0)
    print("\n--- PENGUJIAN 1: TANPA FAISS (index_rate = 0.0) ---")
    phone_raw = torch.tensor(feats_raw, dtype=torch.float, device=device).unsqueeze(0)
    with torch.no_grad():
        o, _, _ = net_g.infer(phone_raw, phone_lengths, pitch, pitchf, sid)
        audio_no_faiss = o.squeeze().cpu().float().numpy()
    audio_no_faiss = audio_no_faiss / np.max(np.abs(audio_no_faiss)) * 0.95
    fn_no_faiss = os.path.join(current_dir, "test_effect_no_faiss.wav")
    sf.write(fn_no_faiss, audio_no_faiss, sr_target)
    analyze_audio_envelope(fn_no_faiss)
    
    # 2. PENGUJIAN DENGAN FAISS (index_rate = 0.4)
    print("\n--- PENGUJIAN 2: DENGAN FAISS (index_rate = 0.4) ---")
    index = faiss.read_index(index_path)
    index.make_direct_map()
    
    feats_flat = feats_raw.astype('float32')
    _, I = index.search(feats_flat, 1)
    db_feats = []
    for idx in I.squeeze(-1):
        db_feats.append(index.reconstruct(int(idx)))
    db_feats = np.array(db_feats).astype('float32')
    feats_faiss = 0.4 * db_feats + 0.6 * feats_raw
    
    phone_faiss = torch.tensor(feats_faiss, dtype=torch.float, device=device).unsqueeze(0)
    with torch.no_grad():
        o, _, _ = net_g.infer(phone_faiss, phone_lengths, pitch, pitchf, sid)
        audio_faiss = o.squeeze().cpu().float().numpy()
    audio_faiss = audio_faiss / np.max(np.abs(audio_faiss)) * 0.95
    fn_faiss = os.path.join(current_dir, "test_effect_with_faiss.wav")
    sf.write(fn_faiss, audio_faiss, sr_target)
    analyze_audio_envelope(fn_faiss)

if __name__ == "__main__":
    asyncio.run(test_faiss_effect())
