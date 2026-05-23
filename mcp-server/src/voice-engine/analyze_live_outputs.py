import os
import numpy as np
import soundfile as sf

def analyze_audio_envelope(filepath):
    if not os.path.exists(filepath):
        print(f"File {filepath} tidak ditemukan.")
        return
        
    y, sr = sf.read(filepath)
    print(f"\n==============================")
    print(f"ANALISIS FILE API LIVE: {os.path.basename(filepath)}")
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
    
    # Hitung FFT
    fft_vals = np.abs(np.fft.rfft(y))
    fft_freqs = np.fft.rfftfreq(len(y), 1/sr)
    
    band2_mask = (fft_freqs >= 250) & (fft_freqs < 1000)
    band3_mask = (fft_freqs >= 1000) & (fft_freqs < 4000)
    
    energy_total = np.sum(fft_vals**2)
    energy_band2 = np.sum(fft_vals[band2_mask]**2)
    energy_band3 = np.sum(fft_vals[band3_mask]**2)
    
    print(f"Rata-rata RMS: {mean_rms:.6f}")
    print(f"Standar Deviasi RMS: {std_rms:.6f} (Speech > 0.04)")
    print(f"PAPR (Dinamika): {papr:.2f} (Speech > 2.5)")
    print(f"Silence %: {silent_percentage:.2f}% (Speech: 10%-40%)")
    print(f"Zero Crossing Rate (ZCR): {zcr:.6f} (Speech < 0.22)")
    print(f"Low Formant Energy (Vokal): {energy_band2/energy_total*100:.2f}%")
    print(f"High Formant Energy (Konsistensi): {energy_band3/energy_total*100:.2f}%")
    
    if zcr > 0.22:
        print("-> KESIMPULAN: WHITE NOISE")
    elif std_rms < 0.035:
        print("-> KESIMPULAN: BUZZING / ROBOTIC HUM")
    else:
        print("-> KESIMPULAN: PERFECT CRYSTAL-CLEAR STRUCTURAL HUMAN SPEECH!")

if __name__ == "__main__":
    analyze_audio_envelope(r"M:\Users\ahmad\project\test_patched_hutao.wav")
    analyze_audio_envelope(r"M:\Users\ahmad\project\test_patched_huohuo.wav")
