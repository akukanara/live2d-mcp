import os
import numpy as np
import soundfile as sf

def analyze_audio_envelope(filepath):
    if not os.path.exists(filepath):
        print(f"File {filepath} tidak ditemukan.")
        return
        
    y, sr = sf.read(filepath)
    print(f"\n==============================")
    print(f"ANALISIS USER FILE: {os.path.basename(filepath)}")
    print(f"Sample Rate: {sr} Hz, Durasi: {len(y)/sr:.2f} detik")
    print(f"Max Value: {np.max(np.abs(y)):.6f}")
    
    # Check if dead or silent
    if np.max(np.abs(y)) == 0:
        print("  -> RESULT: SILENCE MURNI (Semua nilai nol!)")
        return
        
    # Normalisasi
    y = y / np.max(np.abs(y))
    
    # Hitung RMS frame-by-frame (frame size = 20ms)
    frame_length = int(0.02 * sr)
    hop_length = int(0.01 * sr)
    rms_frames = []
    
    for i in range(0, len(y) - frame_length, hop_length):
        frame = y[i : i + frame_length]
        rms_frames.append(np.sqrt(np.mean(frame**2)))
        
    rms_frames = np.array(rms_frames)
    
    mean_rms = np.mean(rms_frames)
    max_rms = np.max(rms_frames)
    std_rms = np.std(rms_frames)
    papr = max_rms / (mean_rms + 1e-6)
    
    silence_threshold = 0.10 * max_rms
    silent_frames = np.sum(rms_frames < silence_threshold)
    silent_percentage = (silent_frames / len(rms_frames)) * 100
    
    zcr = np.mean(np.abs(np.diff(np.sign(y)))) / 2
    
    print(f"Rata-rata RMS: {mean_rms:.6f}")
    print(f"Standar Deviasi RMS: {std_rms:.6f}")
    print(f"PAPR: {papr:.2f}")
    print(f"Silence %: {silent_percentage:.2f}%")
    print(f"Zero Crossing Rate (ZCR): {zcr:.6f}")
    
    if zcr > 0.22:
        print("-> KESIMPULAN: WHITE NOISE / DESIS STATIS MURNI (Bising statik)")
    elif std_rms < 0.05:
        print("-> KESIMPULAN: SUARA BERDENGUNG / BUZZING (Robotic hum konstan)")
    elif papr < 2.0:
        print("-> KESIMPULAN: NOISE/BISING KONSTAN")
    else:
        print("-> KESIMPULAN: PERFECT STRUCTURAL HUMAN SPEECH!")

if __name__ == "__main__":
    analyze_audio_envelope(r"m:\Users\ahmad\project\live2d-mcp\test_huohuo.wav")
    analyze_audio_envelope(r"m:\Users\ahmad\project\live2d-mcp\test_hutao.wav")
