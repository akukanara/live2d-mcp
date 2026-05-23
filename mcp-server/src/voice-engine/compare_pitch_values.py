import os
import numpy as np
import soundfile as sf
import librosa
import parselmouth

current_dir = os.path.dirname(os.path.abspath(__file__))

def compare():
    temp_base = os.path.join(current_dir, "test_base.wav")
    if not os.path.exists(temp_base):
        print("test_base.wav tidak ditemukan.")
        return
        
    y, sr = sf.read(temp_base)
    if len(y.shape) > 1:
        y = np.mean(y, axis=1)
        
    if sr != 16000:
        duration = len(y) / sr
        num_samples = int(duration * 16000)
        indices = np.linspace(0, len(y) - 1, num_samples)
        y = np.interp(indices, np.arange(len(y)), y)
    y = y / np.max(np.abs(y)) * 0.95
    
    # 1. Librosa pyin F0 Coarse
    f0_pyin, _, _ = librosa.pyin(y, fmin=65, fmax=2093, sr=16000, frame_length=1024, hop_length=320)
    f0_pyin = np.nan_to_num(f0_pyin, nan=0.0)
    
    # 2. Parselmouth F0 Coarse
    target_len = len(f0_pyin)
    sound = parselmouth.Sound(y, sampling_frequency=16000)
    f0_pm = sound.to_pitch_ac(time_step=(len(y)/16000)/target_len, pitch_floor=65, pitch_ceiling=1100, voicing_threshold=0.6).selected_array['frequency']
    if len(f0_pm) > target_len:
        f0_pm = f0_pm[:target_len]
    else:
        f0_pm = np.pad(f0_pm, (0, target_len - len(f0_pm)), 'constant')
        
    # Quantize Helper
    def quantize(f0):
        f0_mel_min = 1127 * np.log(1 + 50 / 700)
        f0_mel_max = 1127 * np.log(1 + 1100 / 700)
        f0_mel = 1127 * np.log(1 + f0 / 700)
        voiced_mask = f0_mel > 0
        f0_mel[voiced_mask] = (f0_mel[voiced_mask] - f0_mel_min) * 254 / (f0_mel_max - f0_mel_min) + 1
        f0_mel[f0_mel <= 1] = 1
        f0_mel[f0_mel > 255] = 255
        return np.rint(f0_mel).astype(int)
        
    coarse_pyin = quantize(f0_pyin)
    coarse_pm = quantize(f0_pm)
    
    print("\n=== DISTRIBUSI NILAI F0 COARSE ===")
    print("Librosa Pyin (Working CLI):")
    unique_pyin, counts_pyin = np.unique(coarse_pyin, return_counts=True)
    for v, c in zip(unique_pyin[:15], counts_pyin[:15]):
        print(f"  Nilai {v}: {c} kali")
    print(f"  Total unik: {len(unique_pyin)}")
    
    print("\nParselmouth AC (Buzzing Service):")
    unique_pm, counts_pm = np.unique(coarse_pm, return_counts=True)
    for v, c in zip(unique_pm[:15], counts_pm[:15]):
        print(f"  Nilai {v}: {c} kali")
    print(f"  Total unik: {len(unique_pm)}")
    
    print(f"\nApakah shape sama? {coarse_pyin.shape == coarse_pm.shape} (Pyin={coarse_pyin.shape}, Parselmouth={coarse_pm.shape})")
    
if __name__ == "__main__":
    compare()
