import os
import numpy as np
import soundfile as sf
import librosa
import parselmouth

current_dir = os.path.dirname(os.path.abspath(__file__))

def compare_pitch():
    temp_base = os.path.join(current_dir, "test_base.wav")
    if not os.path.exists(temp_base):
        print("test_base.wav tidak ditemukan, jalankan test_rvc.py dulu.")
        return
        
    print("=== PERBANDINGAN METODE PITCH EXTRACTION ===")
    
    # Load audio
    y, sr = sf.read(temp_base)
    if len(y.shape) > 1:
        y = np.mean(y, axis=1)
        
    # Resample to 16000
    if sr != 16000:
        duration = len(y) / sr
        num_samples = int(duration * 16000)
        indices = np.linspace(0, len(y) - 1, num_samples)
        y = np.interp(indices, np.arange(len(y)), y)
        
    y = y / np.max(np.abs(y)) * 0.95
    
    # 1. Librosa pyin
    print("\n--- METODE 1: librosa.pyin (Working CLI) ---")
    f0_pyin, voiced_flag, voiced_probs = librosa.pyin(
        y, fmin=65, fmax=2093, sr=16000, frame_length=1024, hop_length=320
    )
    f0_pyin = np.nan_to_num(f0_pyin, nan=0.0)
    print(f"  Shape: {f0_pyin.shape}")
    print(f"  Max Pitch: {np.max(f0_pyin):.2f} Hz, Min: {np.min(f0_pyin):.2f} Hz, Mean: {np.mean(f0_pyin):.2f} Hz")
    print(f"  Jumlah Voiced Frames (>0): {np.sum(f0_pyin > 0)} ({np.sum(f0_pyin > 0)/len(f0_pyin)*100:.2f}%)")
    print(f"  Beberapa nilai f0 pertama: {f0_pyin[40:60]}")
    
    # 2. Parselmouth AC
    target_len = len(f0_pyin) # align length
    duration = len(y) / 16000
    time_step = duration / target_len
    
    print("\n--- METODE 2: parselmouth.Sound.to_pitch_ac (Buzzing Service) ---")
    try:
        sound = parselmouth.Sound(y, sampling_frequency=16000)
        pitch_obj = sound.to_pitch_ac(time_step=time_step, pitch_floor=65, pitch_ceiling=1100, voicing_threshold=0.6)
        f0_pm = pitch_obj.selected_array['frequency']
        
        # Align
        if len(f0_pm) > target_len:
            f0_pm = f0_pm[:target_len]
        else:
            f0_pm = np.pad(f0_pm, (0, target_len - len(f0_pm)), 'constant')
            
        print(f"  Shape: {f0_pm.shape}")
        print(f"  Max Pitch: {np.max(f0_pm):.2f} Hz, Min: {np.min(f0_pm):.2f} Hz, Mean: {np.mean(f0_pm):.2f} Hz")
        print(f"  Jumlah Voiced Frames (>0): {np.sum(f0_pm > 0)} ({np.sum(f0_pm > 0)/len(f0_pm)*100:.2f}%)")
        print(f"  Beberapa nilai f0 pertama: {f0_pm[40:60]}")
        
        # Selisih absolut rata-rata
        diff = np.abs(f0_pyin - f0_pm)
        print(f"\n  Selisih Rata-Rata: {np.mean(diff):.2f} Hz")
        
    except Exception as e:
        print(f"Error parselmouth: {e}")

if __name__ == "__main__":
    compare_pitch()
