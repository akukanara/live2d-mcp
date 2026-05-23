import os
import sys
import torch
import numpy as np
import soundfile as sf
import asyncio
import parselmouth
import librosa

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
    print(f"  PAPR: {papr:.2f} (Speech > 2.5)")
    print(f"  Silence %: {silent_percentage:.2f}%")
    print(f"  ZCR: {zcr:.6f} (High-frequency konsonan)")

def interpolate_short_gaps(f0, max_gap_len=3):
    f0 = np.array(f0)
    nz_indices = np.nonzero(f0)[0]
    if len(nz_indices) == 0:
        return f0
    n = len(f0)
    i = 0
    while i < n:
        if f0[i] == 0:
            start = i
            while i < n and f0[i] == 0:
                i += 1
            end = i
            gap_len = end - start
            if gap_len <= max_gap_len:
                left_val = f0[start - 1] if start > 0 else 0
                right_val = f0[end] if end < n else 0
                if left_val > 0 and right_val > 0:
                    for j in range(start, end):
                        f0[j] = left_val + (right_val - left_val) * (j - start + 1) / (gap_len + 1)
        else:
            i += 1
    return f0

async def run_final_pipeline():
    model_path = r"M:\Users\ahmad\project\live2d-mcp\voice\HuTao\HuTao48000_e399_s12369 L28.pth"
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    
    temp_base = os.path.join(current_dir, "test_base.wav")
    y_raw, sr_orig = sf.read(temp_base)
    if len(y_raw.shape) > 1:
        y_raw = np.mean(y_raw, axis=1)
        
    y_16k = librosa.resample(y_raw, orig_sr=sr_orig, target_sr=16000)
    y_16k = y_16k / np.max(np.abs(y_16k)) * 0.95
    
    # 1. PRE-PROCESSING: Soft Noise Gate untuk memotong desis latar belakang
    print("[Pre-processing] Menerapkan soft Noise Gate...")
    frame_len = 320
    gated_count = 0
    for i in range(0, len(y_16k), frame_len):
        frame = y_16k[i : i + frame_len]
        rms = np.sqrt(np.mean(frame**2))
        if rms < 0.005:  # -46 dB threshold
            y_16k[i : i + frame_len] = 0.0
            gated_count += 1
    print(f"  Gated frames: {gated_count} dari {len(y_16k)//frame_len} total frames.")
    
    # Models
    hubert_model = HubertModel.from_pretrained("facebook/hubert-base-ls960").to(device).eval().half()
    cpt = torch.load(model_path, map_location="cpu")
    config = cpt["config"]
    sr_target = 48000
    net_g = SynthesizerTrnMs768NSFsid(*config, is_half=True).to(device).eval().half()
    net_g.load_state_dict(cpt["weight"], strict=False)
    
    # Extract HuBERT raw
    y_norm = (y_16k - np.mean(y_16k)) / (np.std(y_16k) + 1e-5)
    input_tensor = torch.tensor(y_norm, dtype=torch.half, device=device).unsqueeze(0)
    with torch.no_grad():
        feats = hubert_model(input_tensor).last_hidden_state.squeeze(0).cpu().numpy()
    target_len = feats.shape[0]
    
    # Pitch extraction (Parselmouth AC with voicing threshold 0.45)
    f0 = parselmouth.Sound(y_16k, sampling_frequency=16000).to_pitch_ac(
        time_step=(len(y_16k)/16000)/target_len, pitch_floor=65, pitch_ceiling=1100, voicing_threshold=0.45
    ).selected_array['frequency']
    if len(f0) > target_len:
        f0 = f0[:target_len]
    else:
        f0 = np.pad(f0, (0, target_len - len(f0)), 'constant')
        
    # Interpolate short gaps
    f0 = interpolate_short_gaps(f0, max_gap_len=3)
    
    # Quantize
    f0_mel_min = 1127 * np.log(1 + 50 / 700)
    f0_mel_max = 1127 * np.log(1 + 1100 / 700)
    f0_mel = 1127 * np.log(1 + f0 / 700)
    voiced_mask = f0_mel > 0
    f0_mel[voiced_mask] = (f0_mel[voiced_mask] - f0_mel_min) * 254 / (f0_mel_max - f0_mel_min) + 1
    f0_mel[f0_mel <= 1] = 1
    f0_mel[f0_mel > 255] = 255
    f0_coarse = np.rint(f0_mel).astype(int)
    
    phone_lengths = torch.tensor([target_len], dtype=torch.long, device=device)
    sid = torch.tensor([0], dtype=torch.long, device=device)
    phone = torch.tensor(feats, dtype=torch.half, device=device).unsqueeze(0)
    pitch = torch.tensor(f0_coarse, dtype=torch.long, device=device).unsqueeze(0)
    pitchf = torch.tensor(f0, dtype=torch.half, device=device).unsqueeze(0)
    
    # Inference
    print("[RVC Generator] Sintesis audio...")
    with torch.no_grad():
        o, _, _ = net_g.infer(phone, phone_lengths, pitch, pitchf, sid)
        audio = o.squeeze().cpu().float().numpy()
        
    # 2. POST-PROCESSING: Subtle Treble Boost (Pre-emphasis filter)
    # y[i] = y[i] - 0.12 * y[i-1]
    print("[Post-processing] Menerapkan subtle High Shelf EQ boost...")
    audio_eq = np.copy(audio)
    audio_eq[1:] = audio[1:] - 0.12 * audio[:-1]
    
    # Normalisasi akhir
    audio_eq = audio_eq / np.max(np.abs(audio_eq)) * 0.95
    
    fn = os.path.join(current_dir, "test_creative_pipeline.wav")
    sf.write(fn, audio_eq, sr_target)
    analyze_audio_envelope(fn)
    print("Selesai! Hasil akhir disimpan di test_creative_pipeline.wav")

if __name__ == "__main__":
    asyncio.run(run_final_pipeline())
