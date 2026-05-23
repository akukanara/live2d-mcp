import os
import sys
import argparse
import asyncio
import warnings

# Abaikan warning yang tidak perlu
warnings.filterwarnings("ignore")

# Masukkan path voice-engine ke path pencarian agar relative imports di infer_pack aman
current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(current_dir)

import torch
import numpy as np
import librosa
import soundfile as sf
import edge_tts
from transformers import HubertModel

from infer_pack.models import SynthesizerTrnMs768NSFsid

def get_voice_for_text(text):
    """
    Deteksi otomatis bahasa teks dan pilih pengisi suara Edge-TTS yang sesuai.
    """
    # Jika teks mengandung huruf Jepang (Hiragana/Katakana/Kanji)
    if any(0x3000 <= ord(c) <= 0x9FFF for c in text):
        return "ja-JP-NanamiNeural"
    # Default ke bahasa Indonesia
    return "id-ID-GadisNeural"

async def generate_base_audio(text, output_path):
    """
    Hasilkan audio dasar menggunakan Edge-TTS.
    """
    voice = get_voice_for_text(text)
    print(f"[Edge-TTS] Menghasilkan audio dasar untuk teks: '{text[:30]}...' menggunakan suara '{voice}'")
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(output_path)
    print(f"[Edge-TTS] Audio dasar selesai disimpan di: {output_path}")

def load_rvc_model(model_path, device, is_half):
    """
    Memuat checkpoint RVC v2 .pth secara aman.
    """
    print(f"[RVC] Memuat model dari: {model_path} ke device: {device}")
    cpt = torch.load(model_path, map_location="cpu")
    
    # Inisialisasi Synthesizer dengan konfigurasi checkpoint
    config = cpt["config"]
    sr = cpt.get("sr", config[-1])
    
    # Parsing sr ke integer jika berupa string (seperti "48k" atau "40k")
    if isinstance(sr, str):
        sr_lower = sr.lower()
        if "k" in sr_lower:
            sr = int(float(sr_lower.replace("k", "").strip()) * 1000)
        else:
            sr = int(sr_lower.replace("hz", "").strip())
    else:
        sr = int(sr)
    
    # RVC v2 menggunakan model SynthesizerTrnMs768NSFsid
    net_g = SynthesizerTrnMs768NSFsid(*config, is_half=is_half)
    
    # Muat state dict
    net_g.load_state_dict(cpt["weight"], strict=False)
    
    # Set model ke device & precision
    net_g.eval()
    if is_half:
        net_g = net_g.half()
    else:
        net_g = net_g.float()
        
    net_g = net_g.to(device)
    print(f"[RVC] Model berhasil dimuat! SR target: {sr} Hz")
    return net_g, sr

def process_voice_conversion(model_path, input_wav, output_wav, pitch_change, device_arg=None):
    """
    Menjalankan proses konversi suara RVC v2 secara utuh.
    """
    # 1. Konfigurasi Device & Presisi (Akselerasi CUDA GPU)
    if device_arg:
        device = torch.device(device_arg)
    else:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        
    is_half = device.type == "cuda"
    
    print(f"[System] Menjalankan inferensi pada: {device.type.upper()} (is_half={is_half})")
    
    # 2. Muat Model RVC
    net_g, target_sr = load_rvc_model(model_path, device, is_half)
    
    # 3. Muat Audio Input & Resample ke 16kHz (Standard HuBERT)
    print(f"[Audio] Memuat dan me-resample audio input: {input_wav}")
    y, sr = librosa.load(input_wav, sr=16000)
    
    # 4. Ekstraksi Pitch (F0) dengan librosa.pyin (hop_length=320 untuk 50Hz frame rate)
    print(f"[Pitch] Mengekstrak fundamental frequency (F0) menggunakan librosa.pyin...")
    f0, voiced_flag, voiced_probs = librosa.pyin(
        y,
        fmin=65,
        fmax=2093,
        sr=16000,
        frame_length=1024,
        hop_length=320
    )
    # Ganti NaN (unvoiced frame) dengan 0.0
    f0 = np.nan_to_num(f0, nan=0.0)
    
    # Terapkan pergeseran pitch semitone
    if pitch_change != 0:
        factor = 2 ** (pitch_change / 12.0)
        f0 = f0 * factor
        print(f"[Pitch] Pitch digeser sebesar {pitch_change} semitone (faktor={factor:.4f})")
        
    # Quantize F0 ke rentang 1-255 (Mel scale binning)
    print(f"[Pitch] Melakukan kuantisasi F0...")
    f0_mel_min = 1127 * np.log(1 + 50 / 700)
    f0_mel_max = 1127 * np.log(1 + 1100 / 700)
    
    f0_mel = 1127 * np.log(1 + f0 / 700)
    # Mask untuk frame yang bersuara (f0 > 0)
    voiced_mask = f0_mel > 0
    f0_mel[voiced_mask] = (f0_mel[voiced_mask] - f0_mel_min) * 254 / (f0_mel_max - f0_mel_min) + 1
    f0_mel[f0_mel <= 1] = 1
    f0_mel[f0_mel > 255] = 255
    f0_coarse = np.rint(f0_mel).astype(int)
    
    # 5. Ekstraksi Fitur dengan HuBERT (facebook/hubert-base-ls960)
    print(f"[HuBERT] Memuat model facebook/hubert-base-ls960...")
    hubert_model = HubertModel.from_pretrained("facebook/hubert-base-ls960")
    hubert_model.eval()
    hubert_model = hubert_model.to(device)
    if is_half:
        hubert_model = hubert_model.half()
        
    # Normalisasi amplitudo audio untuk HuBERT
    y_norm = (y - np.mean(y)) / (np.std(y) + 1e-5)
    input_values = torch.tensor(y_norm).unsqueeze(0).to(device)
    if is_half:
        input_values = input_values.half()
    else:
        input_values = input_values.float()
        
    print(f"[HuBERT] Mengekstrak representasi konten (hidden states)...")
    with torch.no_grad():
        outputs = hubert_model(input_values)
        feats = outputs.last_hidden_state # Shape: [1, seq_len, 768]
        
    # 6. Penyelarasan Panjang Frame (F0 & Feats)
    target_len = feats.shape[1]
    current_f0_len = len(f0)
    print(f"[Align] Menyelaraskan frame: HuBERT={target_len}, F0={current_f0_len}")
    
    if current_f0_len > target_len:
        f0 = f0[:target_len]
        f0_coarse = f0_coarse[:target_len]
    elif current_f0_len < target_len:
        f0 = np.pad(f0, (0, target_len - current_f0_len), 'constant')
        f0_coarse = np.pad(f0_coarse, (0, target_len - current_f0_len), 'constant', constant_values=1)
        
    # 7. Jalankan Sintesis Generator RVC
    phone = feats # Shape: [1, seq_len, 768]
    phone_lengths = torch.tensor([target_len], dtype=torch.long, device=device)
    pitch = torch.tensor(f0_coarse, dtype=torch.long, device=device).unsqueeze(0)
    pitchf = torch.tensor(f0, dtype=torch.float, device=device).unsqueeze(0)
    if is_half:
        pitchf = pitchf.half()
    sid = torch.tensor([0], dtype=torch.long, device=device)
    
    print(f"[Synthesizer] Menjalankan inferensi model generator RVC...")
    with torch.no_grad():
        o, x_mask, _ = net_g.infer(phone, phone_lengths, pitch, pitchf, sid)
        audio_out = o.squeeze().cpu().float().numpy()
        
    # 8. Simpan File Output WAV
    print(f"[Audio] Menyimpan audio hasil konversi ke: {output_wav}")
    sf.write(output_wav, audio_out, target_sr)
    print(f"[System] Konversi RVC sukses!")

def main():
    parser = argparse.ArgumentParser(description="Mesin Inferensi RVC v2 Lokal untuk Live2D TTS")
    parser.add_argument("--model_path", type=str, default="", help="Path ke berkas model .pth RVC")
    parser.add_argument("--text", type=str, default="", help="Teks yang akan diucapkan (Edge-TTS)")
    parser.add_argument("--input_wav", type=str, default="", help="Path ke berkas input wav (jika ada)")
    parser.add_argument("--output_wav", type=str, required=True, help="Path untuk menyimpan berkas output wav")
    parser.add_argument("--pitch_change", type=int, default=0, help="Perubahan pitch dalam semitone (e.g. +12, -5)")
    parser.add_argument("--device", type=str, default=None, help="Device pemrosesan ('cpu' atau 'cuda')")
    
    args = parser.parse_args()
    
    # Validasi argumen teks vs input_wav
    if not args.text and not args.input_wav:
        print("Eror: Anda harus menyertakan --text atau --input_wav!")
        sys.exit(1)
        
    temp_base = None
    
    try:
        # Jika teks disematkan, buat audio dasar dengan Edge-TTS terlebih dahulu
        if args.text:
            if not args.model_path or args.model_path.lower() == "none":
                # Fallback langsung simpan ke output_wav tanpa RVC
                asyncio.run(generate_base_audio(args.text, args.output_wav))
                print("[System] Menggunakan fallback Edge-TTS murni karena model_path tidak disediakan.")
            else:
                temp_base = os.path.join(current_dir, f"temp_base_{os.getpid()}.wav")
                asyncio.run(generate_base_audio(args.text, temp_base))
                input_file = temp_base
                
                # Jalankan konversi suara RVC
                process_voice_conversion(
                    model_path=args.model_path,
                    input_wav=input_file,
                    output_wav=args.output_wav,
                    pitch_change=args.pitch_change,
                    device_arg=args.device
                )
        else:
            input_file = args.input_wav
            # Jalankan konversi suara RVC jika ada input_wav
            process_voice_conversion(
                model_path=args.model_path,
                input_wav=input_file,
                output_wav=args.output_wav,
                pitch_change=args.pitch_change,
                device_arg=args.device
            )
            
    finally:
        # Hapus berkas basis sementara jika dibuat
        if temp_base and os.path.exists(temp_base):
            try:
                os.remove(temp_base)
                print(f"[Cleanup] Menghapus audio sementara: {temp_base}")
            except Exception as e:
                print(f"[Cleanup] Gagal menghapus audio sementara: {e}")

if __name__ == "__main__":
    main()
