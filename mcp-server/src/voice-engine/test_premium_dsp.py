"""
Pengujian live ke persistent RVC service dengan parameter DSP premium baru.
Menguji: Butterworth highpass, rms_mix_rate, protect, filter_radius
"""
import os
import sys
import time
import json
import urllib.request
import soundfile as sf
import numpy as np

SERVICE_URL = "http://127.0.0.1:5001/tts"
current_dir = os.path.dirname(os.path.abspath(__file__))

VOICE_DIR = r"M:\Users\ahmad\project\live2d-mcp\voice"

def find_voice_model(char_name):
    char_dir = os.path.join(VOICE_DIR, char_name)
    pth = None
    idx = None
    for f in os.listdir(char_dir):
        if f.endswith(".pth"):
            pth = os.path.join(char_dir, f)
        if f.endswith(".index"):
            idx = os.path.join(char_dir, f)
    return pth, idx

def analyze_audio(filepath):
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
    silent_pct = (silent_frames / len(rms_frames)) * 100
    zcr = np.mean(np.abs(np.diff(np.sign(y)))) / 2
    print(f"  DSP Check -> PAPR: {papr:.2f} | Silence: {silent_pct:.1f}% | ZCR: {zcr:.4f}")
    passed = papr > 2.5 and silent_pct > 30
    print(f"  Status: {'[OK] SPEECH TERDETEKSI' if passed else '[FAIL] PERIKSA OUTPUT'}")
    return passed

def send_request(payload, output_path):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        SERVICE_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=60) as resp:
            elapsed = time.time() - t0
            result = json.loads(resp.read())
            print(f"  Response ({elapsed:.2f}s): success={result.get('success')}, fallback={result.get('fallback')}")
            return result.get("success", False)
    except Exception as e:
        print(f"  ERROR: {e}")
        return False

def test_character(char_name, text):
    print(f"\n{'='*55}")
    print(f"[TEST] Pengujian karakter: {char_name}")
    print(f"   Teks: \"{text[:50]}\"")
    print(f"{'='*55}")
    
    pth, idx = find_voice_model(char_name)
    if not pth:
        print(f"  [FAIL] Model .pth tidak ditemukan untuk {char_name}")
        return

    output_path = os.path.join(current_dir, f"test_premium_{char_name.lower()}.wav")
    
    payload = {
        "text": text,
        "model_path": pth,
        "index_path": idx,
        "output_wav": output_path,
        "pitch_change": 0,
        "index_rate": 0.4,
        "rms_mix_rate": 0.5,  # Premium: Volume envelope matching
        "protect": 0.33,       # Premium: Consonant protection
        "filter_radius": 3     # Premium: Median pitch smoothing
    }
    
    print(f"  Parameters: rms_mix_rate=0.5, protect=0.33, filter_radius=3")
    
    ok = send_request(payload, output_path)
    if ok and os.path.exists(output_path):
        size_kb = os.path.getsize(output_path) / 1024
        print(f"  Output: {os.path.basename(output_path)} ({size_kb:.1f} KB)")
        analyze_audio(output_path)
    else:
        print("  [FAIL] File output tidak ditemukan!")

if __name__ == "__main__":
    text_indonesia = "Halo! Saya siap membantu Anda hari ini. Apakah ada yang bisa saya lakukan?"
    
    # Test HuoHuo
    test_character("HuoHuo", text_indonesia)
    
    # Test HuTao
    test_character("HuTao", text_indonesia)
    
    print(f"\n{'='*55}")
    print("Pengujian selesai! Cek file test_premium_*.wav")
