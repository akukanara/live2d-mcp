import os
import numpy as np
import soundfile as sf

def inspect_frequency_distribution(filepath):
    if not os.path.exists(filepath):
        print(f"File {filepath} tidak ditemukan.")
        return
        
    y, sr = sf.read(filepath)
    print(f"\n==============================")
    print(f"ANALISIS FREKUENSI: {os.path.basename(filepath)}")
    
    if np.max(np.abs(y)) == 0:
        print("File hening/bisu.")
        return
        
    # Hitung FFT (Fast Fourier Transform) untuk melihat spektrum frekuensi
    fft_vals = np.abs(np.fft.rfft(y))
    fft_freqs = np.fft.rfftfreq(len(y), 1/sr)
    
    # Bagi spektrum menjadi 4 band:
    # 1. Bass / Pitch (0 - 250 Hz)
    # 2. Formant Vokal Rendah (250 - 1000 Hz)
    # 3. Formant Vokal Tinggi / Konsonan (1000 - 4000 Hz)
    # 4. Desis / Treble Tinggi (4000 Hz - Nyquist)
    
    band1_mask = (fft_freqs >= 0) & (fft_freqs < 250)
    band2_mask = (fft_freqs >= 250) & (fft_freqs < 1000)
    band3_mask = (fft_freqs >= 1000) & (fft_freqs < 4000)
    band4_mask = (fft_freqs >= 4000)
    
    energy_total = np.sum(fft_vals**2)
    energy_band1 = np.sum(fft_vals[band1_mask]**2)
    energy_band2 = np.sum(fft_vals[band2_mask]**2)
    energy_band3 = np.sum(fft_vals[band3_mask]**2)
    energy_band4 = np.sum(fft_vals[band4_mask]**2)
    
    print(f"Distribusi Energi Spektral:")
    print(f"  1. Bass/Fundamental (0-250Hz): {energy_band1/energy_total*100:.2f}% (Tinggi pada pria/dengung)")
    print(f"  2. Low Formant (250-1000Hz): {energy_band2/energy_total*100:.2f}% (Penting untuk huruf vokal)")
    print(f"  3. High Formant (1000-4000Hz): {energy_band3/energy_total*100:.2f}% (Sangat krusial untuk kejelasan kata)")
    print(f"  4. Treble/Desis (4000Hz+): {energy_band4/energy_total*100:.2f}% (Konsonan s/t/p/k, desis bising)")
    
    # Cari frekuensi dominan (puncak spektrum)
    peak_idx = np.argmax(fft_vals)
    peak_freq = fft_freqs[peak_idx]
    print(f"Frekuensi Dominan (Puncak): {peak_freq:.2f} Hz")
    
    # Deteksi keparahan dengung konstan
    # Jika energi menumpuk > 95% hanya di area bass/fundamental, suara dipastikan robotik konstan
    if energy_band1 / energy_total > 0.85:
        print("-> KESIMPULAN: ENERGY SPECTRUM COLLAPSED! Suara terjebak sebagai DENGUNG/HUM frekuensi rendah.")
    elif energy_band4 / energy_total > 0.80:
        print("-> KESIMPULAN: SPECTRUM DOMINATED BY HIGH NOISE! Suara berupa desis/noise bising putih.")
    else:
        print("-> KESIMPULAN: SPECTRUM SPEECH NORMAL (Ada energi formant vokal & konsonan yang merata!).")

if __name__ == "__main__":
    inspect_frequency_distribution(r"m:\Users\ahmad\project\live2d-mcp\test_huohuo.wav")
    inspect_frequency_distribution(r"m:\Users\ahmad\project\live2d-mcp\test_hutao.wav")
