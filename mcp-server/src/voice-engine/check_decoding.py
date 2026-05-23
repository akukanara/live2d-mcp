import os
import numpy as np
import soundfile as sf
import librosa

current_dir = os.path.dirname(os.path.abspath(__file__))

def check_decoding():
    temp_base = os.path.join(current_dir, "test_base.wav")
    if not os.path.exists(temp_base):
        print("test_base.wav tidak ditemukan.")
        return
        
    print("=== PENGECEKAN DEKODE BINARY AUDIO ===")
    
    # 1. Dekode dengan Soundfile
    try:
        y_sf, sr_sf = sf.read(temp_base)
        print(f"Soundfile:")
        print(f"  Sample Rate: {sr_sf} Hz")
        print(f"  Shape: {y_sf.shape}")
        print(f"  Max Value: {np.max(np.abs(y_sf)):.6f}")
        print(f"  RMS: {np.sqrt(np.mean(y_sf**2)):.6f}")
        print(f"  10 sampel pertama: {y_sf[:10]}")
    except Exception as e:
        print(f"Soundfile Error: {e}")
        
    # 2. Dekode dengan Librosa
    try:
        y_lr, sr_lr = librosa.load(temp_base, sr=None)
        print(f"\nLibrosa (sr=None):")
        print(f"  Sample Rate: {sr_lr} Hz")
        print(f"  Shape: {y_lr.shape}")
        print(f"  Max Value: {np.max(np.abs(y_lr)):.6f}")
        print(f"  RMS: {np.sqrt(np.mean(y_lr**2)):.6f}")
        print(f"  10 sampel pertama: {y_lr[:10]}")
    except Exception as e:
        print(f"Librosa Error: {e}")

if __name__ == "__main__":
    check_decoding()
