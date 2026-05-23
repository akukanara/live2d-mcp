import os
import numpy as np
import soundfile as sf

def check_segments(filepath):
    if not os.path.exists(filepath):
        print(f"File {filepath} tidak ditemukan.")
        return
        
    y, sr = sf.read(filepath)
    print(f"\n==============================")
    print(f"INSPEKSI DINAMIKA SEGMEN: {os.path.basename(filepath)}")
    print(f"Sample Rate: {sr} Hz, Total Sampel: {len(y)}")
    
    # Bagi audio menjadi 10 segmen sama besar
    segments = np.array_split(y, 10)
    
    for idx, seg in enumerate(segments):
        seg_max = np.max(np.abs(seg))
        seg_rms = np.sqrt(np.mean(seg**2))
        time_start = (idx * len(seg)) / sr
        time_end = ((idx + 1) * len(seg)) / sr
        print(f"  Segmen {idx+1} ({time_start:.2f}s - {time_end:.2f}s): RMS = {seg_rms:.6f}, Max Abs = {seg_max:.6f}")

if __name__ == "__main__":
    check_segments(r"m:\Users\ahmad\project\live2d-mcp\test_huohuo.wav")
    check_segments(r"m:\Users\ahmad\project\live2d-mcp\test_hutao.wav")
