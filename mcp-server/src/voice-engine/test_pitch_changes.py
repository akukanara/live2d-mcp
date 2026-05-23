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
    print(f"  PAPR (Kejelasan Dinamika): {papr:.2f} (Speech ideal > 2.5)")
    print(f"  Silence %: {silent_percentage:.2f}%")
    print(f"  ZCR: {zcr:.6f}")

async def run_pitch_matrix():
    model_path = r"M:\Users\ahmad\project\live2d-mcp\voice\HuTao\HuTao48000_e399_s12369 L28.pth"
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    
    temp_base = os.path.join(current_dir, "test_base.wav")
    y_raw, sr_orig = sf.read(temp_base)
    if len(y_raw.shape) > 1:
        y_raw = np.mean(y_raw, axis=1)
        
    y_16k = librosa.resample(y_raw, orig_sr=sr_orig, target_sr=16000)
    y_16k = y_16k / np.max(np.abs(y_16k)) * 0.95
    
    # Models
    hubert_model = HubertModel.from_pretrained("facebook/hubert-base-ls960").to(device).eval().half()
    cpt = torch.load(model_path, map_location="cpu")
    config = cpt["config"]
    sr_target = 48000
    net_g = SynthesizerTrnMs768NSFsid(*config, is_half=True).to(device).eval().half()
    
    # Extract HuBERT raw
    y_norm = (y_16k - np.mean(y_16k)) / (np.std(y_16k) + 1e-5)
    input_tensor = torch.tensor(y_norm, dtype=torch.half, device=device).unsqueeze(0)
    with torch.no_grad():
        feats = hubert_model(input_tensor).last_hidden_state.squeeze(0).cpu().numpy()
    target_len = feats.shape[0]
    
    # Raw Parselmouth pitch
    f0_base = parselmouth.Sound(y_16k, sampling_frequency=16000).to_pitch_ac(
        time_step=(len(y_16k)/16000)/target_len, pitch_floor=65, pitch_ceiling=1100
    ).selected_array['frequency']
    if len(f0_base) > target_len:
        f0_base = f0_base[:target_len]
    else:
        f0_base = np.pad(f0_base, (0, target_len - len(f0_base)), 'constant')
        
    phone_lengths = torch.tensor([target_len], dtype=torch.long, device=device)
    sid = torch.tensor([0], dtype=torch.long, device=device)
    phone = torch.tensor(feats, dtype=torch.half, device=device).unsqueeze(0)
    
    # Test pitch shifts: 0, 4, 8, 12
    for shift in [0, 4, 8, 12]:
        print(f"\n--- Menguji Pitch Shift: {shift} semitone ---")
        f0 = f0_base * (2 ** (shift / 12.0))
        
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
        fn = os.path.join(current_dir, f"test_shift_{shift}.wav")
        sf.write(fn, audio, sr_target)
        analyze_audio_envelope(fn)

if __name__ == "__main__":
    asyncio.run(run_pitch_matrix())
