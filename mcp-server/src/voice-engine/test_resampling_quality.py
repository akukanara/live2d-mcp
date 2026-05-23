import os
import sys
import torch
import numpy as np
import soundfile as sf
import asyncio
import edge_tts
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
    print(f"  RMS Volume Rata-rata: {mean_rms:.6f}")
    print(f"  RMS Volume StdDev: {np.std(rms_frames):.6f}")
    print(f"  PAPR: {papr:.2f}")
    print(f"  Silence %: {silent_percentage:.2f}%")
    print(f"  ZCR: {zcr:.6f}")
    if zcr > 0.22:
        print("  -> RESULT: WHITE NOISE")
    elif np.std(rms_frames) < 0.05:
        print("  -> RESULT: BUZZING / ROBOTIC HUM")
    else:
        print("  -> RESULT: PERFECT STRUCTURAL HUMAN SPEECH!")

async def test_resampling():
    model_path = r"M:\Users\ahmad\project\live2d-mcp\voice\HuoHuo\HuoHuo.pth"
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    
    temp_base = os.path.join(current_dir, "test_base.wav")
    y_raw, sr_orig = sf.read(temp_base)
    if len(y_raw.shape) > 1:
        y_raw = np.mean(y_raw, axis=1)
        
    # Load Models
    hubert_model = HubertModel.from_pretrained("facebook/hubert-base-ls960").to(device).eval()
    cpt = torch.load(model_path, map_location="cpu")
    config = cpt["config"]
    sr_target = 40000
    net_g = SynthesizerTrnMs768NSFsid(*config, is_half=True).to(device).eval().half()
    hubert_model = hubert_model.half()
    
    # ----------------------------------------------------
    # METODE A: NumPy Linear Interpolation Resample (BUZZING?)
    # ----------------------------------------------------
    print("\n--- METODE A: NumPy Linear Interpolation Resampling ---")
    duration = len(y_raw) / sr_orig
    num_samples = int(duration * 16000)
    indices = np.linspace(0, len(y_raw) - 1, num_samples)
    y_a = np.interp(indices, np.arange(len(y_raw)), y_raw)
    y_a = y_a / np.max(np.abs(y_a)) * 0.95
    
    y_norm_a = (y_a - np.mean(y_a)) / (np.std(y_a) + 1e-5)
    input_tensor_a = torch.tensor(y_norm_a, dtype=torch.half, device=device).unsqueeze(0)
    with torch.no_grad():
        feats_a = hubert_model(input_tensor_a).last_hidden_state.squeeze(0).cpu().numpy()
    target_len_a = feats_a.shape[0]
    
    f0_a = parselmouth.Sound(y_a, sampling_frequency=16000).to_pitch_ac(
        time_step=(len(y_a)/16000)/target_len_a, pitch_floor=65, pitch_ceiling=1100
    ).selected_array['frequency']
    if len(f0_a) > target_len_a:
        f0_a = f0_a[:target_len_a]
    else:
        f0_a = np.pad(f0_a, (0, target_len_a - len(f0_a)), 'constant')
    f0_a = f0_a * (2 ** (8 / 12.0))
    
    # Quantize
    f0_mel_min = 1127 * np.log(1 + 50 / 700)
    f0_mel_max = 1127 * np.log(1 + 1100 / 700)
    f0_mel_a = 1127 * np.log(1 + f0_a / 700)
    voiced_mask_a = f0_mel_a > 0
    f0_mel_a[voiced_mask_a] = (f0_mel_a[voiced_mask_a] - f0_mel_min) * 254 / (f0_mel_max - f0_mel_min) + 1
    f0_mel_a[f0_mel_a <= 1] = 1
    f0_mel_a[f0_mel_a > 255] = 255
    f0_coarse_a = np.rint(f0_mel_a).astype(int)
    
    phone_lengths_a = torch.tensor([target_len_a], dtype=torch.long, device=device)
    pitch_a = torch.tensor(f0_coarse_a, dtype=torch.long, device=device).unsqueeze(0)
    pitchf_a = torch.tensor(f0_a, dtype=torch.half, device=device).unsqueeze(0)
    sid = torch.tensor([0], dtype=torch.long, device=device)
    
    phone_a = torch.tensor(feats_a, dtype=torch.half, device=device).unsqueeze(0)
    with torch.no_grad():
        o, _, _ = net_g.infer(phone_a, phone_lengths_a, pitch_a, pitchf_a, sid)
        audio_a = o.squeeze().cpu().float().numpy()
        
    audio_a = audio_a / np.max(np.abs(audio_a)) * 0.95
    fn_a = os.path.join(current_dir, "test_resample_linear.wav")
    sf.write(fn_a, audio_a, sr_target)
    analyze_audio_envelope(fn_a)
    
    # ----------------------------------------------------
    # METODE B: Librosa High-Quality Sinc Resample (CLEAN?)
    # ----------------------------------------------------
    print("\n--- METODE B: Librosa Sinc Resampling ---")
    y_b = librosa.resample(y_raw, orig_sr=sr_orig, target_sr=16000)
    y_b = y_b / np.max(np.abs(y_b)) * 0.95
    
    y_norm_b = (y_b - np.mean(y_b)) / (np.std(y_b) + 1e-5)
    input_tensor_b = torch.tensor(y_norm_b, dtype=torch.half, device=device).unsqueeze(0)
    with torch.no_grad():
        feats_b = hubert_model(input_tensor_b).last_hidden_state.squeeze(0).cpu().numpy()
    target_len_b = feats_b.shape[0]
    
    f0_b = parselmouth.Sound(y_b, sampling_frequency=16000).to_pitch_ac(
        time_step=(len(y_b)/16000)/target_len_b, pitch_floor=65, pitch_ceiling=1100
    ).selected_array['frequency']
    if len(f0_b) > target_len_b:
        f0_b = f0_b[:target_len_b]
    else:
        f0_b = np.pad(f0_b, (0, target_len_b - len(f0_b)), 'constant')
    f0_b = f0_b * (2 ** (8 / 12.0))
    
    # Quantize
    f0_mel_b = 1127 * np.log(1 + f0_b / 700)
    voiced_mask_b = f0_mel_b > 0
    f0_mel_b[voiced_mask_b] = (f0_mel_b[voiced_mask_b] - f0_mel_min) * 254 / (f0_mel_max - f0_mel_min) + 1
    f0_mel_b[f0_mel_b <= 1] = 1
    f0_mel_b[f0_mel_b > 255] = 255
    f0_coarse_b = np.rint(f0_mel_b).astype(int)
    
    phone_lengths_b = torch.tensor([target_len_b], dtype=torch.long, device=device)
    pitch_b = torch.tensor(f0_coarse_b, dtype=torch.long, device=device).unsqueeze(0)
    pitchf_b = torch.tensor(f0_b, dtype=torch.half, device=device).unsqueeze(0)
    
    phone_b = torch.tensor(feats_b, dtype=torch.half, device=device).unsqueeze(0)
    with torch.no_grad():
        o, _, _ = net_g.infer(phone_b, phone_lengths_b, pitch_b, pitchf_b, sid)
        audio_b = o.squeeze().cpu().float().numpy()
        
    audio_b = audio_b / np.max(np.abs(audio_b)) * 0.95
    fn_b = os.path.join(current_dir, "test_resample_sinc.wav")
    sf.write(fn_b, audio_b, sr_target)
    analyze_audio_envelope(fn_b)

if __name__ == "__main__":
    asyncio.run(test_resampling())
