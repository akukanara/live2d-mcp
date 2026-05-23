import os
import numpy as np
import soundfile as sf

current_dir = os.path.dirname(os.path.abspath(__file__))

def inspect_spikes(filepath):
    if not os.path.exists(filepath):
        print(f"File {filepath} tidak ditemukan.")
        return
        
    y, sr = sf.read(filepath)
    print(f"\n==============================")
    print(f"INSPEKSI SPIKE: {os.path.basename(filepath)}")
    print(f"Sample Rate: {sr} Hz, Total Sampel: {len(y)}")
    
    # Cari nilai absolut terbesar
    abs_y = np.abs(y)
    sorted_indices = np.argsort(abs_y)[::-1]
    
    print("10 Nilai Sampel Terbesar (Absolut):")
    for rank in range(10):
        idx = sorted_indices[rank]
        val = y[idx]
        time_sec = idx / sr
        print(f"  Rank {rank+1}: Nilai = {val:.6f} pada indeks {idx} (Waktu: {time_sec:.4f}s)")
        
    # Hitung distribusi amplitudo
    percentiles = [50, 90, 95, 99, 99.9, 99.99]
    print("\nPersentil Amplitudo Absolut:")
    for p in percentiles:
        p_val = np.percentile(abs_y, p)
        print(f"  Persentil {p}%: {p_val:.6f}")
        
    # Hitung RMS tanpa top 0.1% sampel terbesar (untuk mengesampingkan spike)
    threshold = np.percentile(abs_y, 99.9)
    y_filtered = y[abs_y < threshold]
    rms_filtered = np.sqrt(np.mean(y_filtered**2))
    print(f"\nRMS tanpa top 0.1% spike: {rms_filtered:.6f}")
    
    # Cek apakah ada signal yang terus-menerus bernilai nol (silent)
    zero_count = np.sum(y == 0)
    print(f"Jumlah sampel bernilai persis 0: {zero_count} ({zero_count/len(y)*100:.2f}%)")

if __name__ == "__main__":
    inspect_spikes(os.path.join(current_dir, "test_out_fp16.wav"))
    inspect_spikes(os.path.join(current_dir, "test_out_fp32.wav"))
