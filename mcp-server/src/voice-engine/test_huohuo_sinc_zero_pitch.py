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
    print(f"  Max Value: {np.max(np.abs(y)):.6f}")
    print(f"  RMS StdDev: {np.std(rms_frames):.6f} (Speech >0.05)")
    print(f"  PAPR: {papr:.2f} (Speech > 2.5)")
    print(f"  Silence %: {silent_percentage:.2f}% (Speech: 10%-40%)")
    print(f"  ZCR: {zcr:.6f}")
    if zcr > 0.22:
        print("  -> RESULT: WHITE NOISE")
    elif np.std(rms_frames) < 0.05:
        print("  -> RESULT: BUZZING / ROBOTIC HUM")
    else:
        print("  -> RESULT: PERFECT STRUCTURAL HUMAN SPEECH!")

async def run_test():
    model_path = r"M:\Users\ahmad\project\live2d-mcp\voice\HuoHuo\HuoHuo.pth"
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    
    temp_base = os.path.join(current_dir, "test_base.wav")
    y_raw, sr_orig = sf.read(temp_base)
    if len(y_raw.shape) > 1:
        y_raw = np.mean(y_raw, axis=1)
        
    y_16k = librosa.resample(y_raw, orig_sr=sr_orig, target_sr=16000)
    y_16k = y_16k / np.max(np.abs(y_16k)) * 0.95
    
    hubert_model = HubertModel.from_pretrained("facebook/hubert-base-ls960").to(device).eval().half()
    cpt = torch.load(model_path, map_location="cpu")
    config = cpt["config"]
    sr_target = 40000
    net_g = SynthesizerTrnMs768NSFsid(*config, is_half=True).to(device).eval().half()
    net_g.load_state_dict(cpt["weight"], strict=False)
    
    # Extract HuBERT raw
    y_norm = (y_16k - np.mean(y_16k)) / (np.std(y_16k) + 1e-5)
    input_tensor = torch.tensor(y_norm, dtype=torch.half, device=device).unsqueeze(0)
    with torch.no_grad():
        feats = hubert_model(input_tensor).last_hidden_state.squeeze(0).cpu().numpy()
    target_len = feats.shape[0]
    
    # Raw Parselmouth pitch
    f0 = parselmouth.Sound(y_16k, sampling_frequency=16000).to_pitch_ac(
        time_step=(len(y_16k)/16000)/target_len, pitch_floor=65, pitch_ceiling=1100
    ).selected_array['frequency']
    if len(f0) > target_len:
        f0 = f0[:target_len]
    else:
        f0 = np.pad(f0, (0, target_len - len(f0)), 'constant')
        
    phone_lengths = torch.tensor([target_len], dtype=torch.long, device=device)
    sid = torch.tensor([0], dtype=torch.long, device=device)
    phone = torch.tensor(feats, dtype=torch.half, device=device).unsqueeze(0)
    
    # Test pitch shift = 0 semitone
    print("\n--- Menguji HuoHuo dengan Pitch Shift = 0 semitone ---")
    
    # Quantize
    f0_mel_min = 1127 * np.log(1 + 50 / 700)
    f0_mel_max = 1127 * np.log(1 + 1100 / 700)
    f0_mel = 1127 * np.log(1 + f0 / 700)
    voiced_mask = f0_mel > 0
    f0_mel[voiced_mask] = (f0_mel[voiced_mask] - f0_mel_min) * 254 / (f0_mel_max - f0_mel_min) + 1
    f0_mel[f0_mel <= 1] = 1
    f0_mel[f0_mel > 255] = 255
    f0_coarse = np.rint(f0_mel).astype(int)
    
    pitch = torch.tensor(f0_coarse, dtype=torch.long, device=device).unsqueeze(0)
    pitchf = torch.tensor(f0, dtype=torch.half, device=device).unsqueeze(0)
    
    with torch.no_grad():
        o, _, _ = net_g.infer(phone, phone_lengths, pitch, pitchf, sid)
        audio = o.squeeze().cpu().float().numpy()
        
    audio = audio / np.max(np.abs(audio)) * 0.95
    fn = os.path.join(current_dir, "test_huohuo_sinc_shift_0.wav")
    sf.write(fn, audio, sr_target)
    analyze_audio_envelope(fn)

if __name__ == "__main__":
    asyncio.run(run_test())
