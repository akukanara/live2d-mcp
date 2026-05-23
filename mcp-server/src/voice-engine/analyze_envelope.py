import os
import numpy as np
import soundfile as sf

current_dir = os.path.dirname(os.path.abspath(__file__))

def analyze_audio_envelope(filepath):
    if not os.path.exists(filepath):
        print(f"File {filepath} tidak ditemukan.")
        return
        
    y, sr = sf.read(filepath)
    print(f"\n==============================")
    print(f"ANALISIS FILE: {os.path.basename(filepath)}")
    print(f"Sample Rate: {sr} Hz, Durasi: {len(y)/sr:.2f} detik")
    print(f"Max Amplitude: {np.max(np.abs(y)):.6f}")
    
    # 1. Normalisasi
    if np.max(np.abs(y)) > 0:
        y = y / np.max(np.abs(y))
        
    # 2. Hitung RMS frame-by-frame (frame size = 20ms)
    frame_length = int(0.02 * sr)
    hop_length = int(0.01 * sr)
    rms_frames = []
    
    for i in range(0, len(y) - frame_length, hop_length):
        frame = y[i : i + frame_length]
        rms_frames.append(np.sqrt(np.mean(frame**2)))
        
    rms_frames = np.array(rms_frames)
    
    # Statistik RMS
    mean_rms = np.mean(rms_frames)
    max_rms = np.max(rms_frames)
    min_rms = np.min(rms_frames)
    std_rms = np.std(rms_frames)
    
    # Peak-to-Average Power Ratio (PAPR)
    papr = max_rms / (mean_rms + 1e-6)
    
    # Deteksi kesunyian (silence) - frame dengan volume < 10% dari max_rms
    silence_threshold = 0.10 * max_rms
    silent_frames = np.sum(rms_frames < silence_threshold)
    silent_percentage = (silent_frames / len(rms_frames)) * 100
    
    # Zero Crossing Rate (ZCR) rata-rata
    zcr = np.mean(np.abs(np.diff(np.sign(y)))) / 2
    
    print(f"Rata-rata RMS: {mean_rms:.6f}")
    print(f"Standar Deviasi RMS: {std_rms:.6f} (Variasi volume kata/suku kata)")
    print(f"PAPR (Peak-to-Average Ratio): {papr:.2f} (Speech biasanya > 2.5, noise statis mendekati 1-1.5)")
    print(f"Persentase Silence Gaps: {silent_percentage:.2f}% (Speech biasanya memiliki 10% - 40% jeda nafas/diam)")
    print(f"Zero Crossing Rate (ZCR): {zcr:.6f}")
    
    # Kesimpulan otomatis
    if zcr > 0.22:
        print("-> KESIMPULAN: WHITE NOISE / DESIS STATIS MURNI (Frekuensi tinggi mendominasi)")
    elif std_rms < 0.05:
        print("-> KESIMPULAN: SUARA BERDENGUNG / BUZZING (Volume terlalu rata tanpa dinamika suku kata)")
    elif papr < 2.0:
        print("-> KESIMPULAN: NOISE/BISING KONSTAN (Ketiadaan dinamika suku kata speech)")
    elif silent_percentage < 3.0:
        print("-> KESIMPULAN: SUARA DESIS KONSTAN TANPA JEDA KATA")
    else:
        print("-> KESIMPULAN: POSITIF SUARA MANUSIA BERSTRUKTUR (Ada jeda, dinamika suku kata, dan ZCR vokal normal!)")

if __name__ == "__main__":
    analyze_audio_envelope(os.path.join(current_dir, "test_out_fp16.wav"))
    analyze_audio_envelope(os.path.join(current_dir, "test_out_fp32.wav"))
    analyze_audio_envelope(os.path.join(current_dir, "test_infer_out.wav"))
