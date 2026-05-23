import os
import sys
import torch
import numpy as np
import librosa
import soundfile as sf
import edge_tts
import asyncio
import faiss
import parselmouth
import warnings
from scipy import signal
from typing import Optional
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn
from transformers import HubertModel

warnings.filterwarnings("ignore")

# Butterworth highpass filter to remove sub-bass noise/rumble (from Edge-TTS)
bh, ah = signal.butter(N=5, Wn=48, btype="high", fs=16000)

# Ensure voice-engine path is in search path
current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(current_dir)

from infer_pack.models import SynthesizerTrnMs768NSFsid

app = FastAPI(title="RVC Persistent Voice Service")

# 1. Preload HuBERT model on startup
print("[Service] Memuat HuBERT Model (facebook/hubert-base-ls960)...", flush=True)
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
is_half = device.type == "cuda"
if device.type == "cpu":
    # Mencegah CPU thread contention
    torch.set_num_threads(4)
    print("[Service] Menyetel CPU threads PyTorch ke 4 untuk efisiensi.", flush=True)
print(f"[Service] Menggunakan device: {device.type.upper()} (is_half={is_half})", flush=True)

hubert_model = HubertModel.from_pretrained("facebook/hubert-base-ls960")
hubert_model.eval()
hubert_model = hubert_model.to(device)
if is_half:
    hubert_model = hubert_model.half()
print("[Service] HuBERT Model berhasil dimuat!", flush=True)

# 2. Caching for RVC models
# Structure: { model_path: { "net_g": net_g, "sr": target_sr, "index": faiss_index } }
model_cache = {}

def get_voice_for_text(text):
    if any(0x3000 <= ord(c) <= 0x9FFF for c in text):
        return "ja-JP-NanamiNeural"
    return "id-ID-GadisNeural"

async def generate_base_audio(text, output_path):
    voice = get_voice_for_text(text)
    print(f"[Edge-TTS] Menghasilkan audio dasar menggunakan suara '{voice}'", flush=True)
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(output_path)
    print(f"[Edge-TTS] Audio dasar selesai disimpan.", flush=True)

def load_rvc_model_and_index(model_path, index_path=None):
    if model_path in model_cache:
        return model_cache[model_path]
        
    print(f"[RVC] Memuat model baru dari: {model_path}", flush=True)
    cpt = torch.load(model_path, map_location="cpu")
    
    config = cpt["config"]
    sr = cpt.get("sr", config[-1])
    
    if isinstance(sr, str):
        sr_lower = sr.lower()
        if "k" in sr_lower:
            sr = int(float(sr_lower.replace("k", "").strip()) * 1000)
        else:
            sr = int(sr_lower.replace("hz", "").strip())
    else:
        sr = int(sr)
        
    net_g = SynthesizerTrnMs768NSFsid(*config, is_half=is_half)
    net_g.load_state_dict(cpt["weight"], strict=False)
    net_g.eval()
    if is_half:
        net_g = net_g.half()
    else:
        net_g = net_g.float()
    net_g = net_g.to(device)
    
    # Try to load FAISS index
    index = None
    if index_path and os.path.exists(index_path):
        try:
            print(f"[FAISS] Memuat index file dari: {index_path}", flush=True)
            index = faiss.read_index(index_path)
            index.make_direct_map()
            print(f"[FAISS] Index file berhasil dimuat! Direct map diinisialisasi. Total vectors: {index.ntotal}", flush=True)
        except Exception as e:
            print(f"[FAISS Error] Gagal memuat index file: {e}", flush=True)
            
    model_cache[model_path] = {
        "net_g": net_g,
        "sr": sr,
        "index": index
    }
    print(f"[RVC] Model {os.path.basename(model_path)} berhasil dimuat ke cache!", flush=True)
    return model_cache[model_path]

def interpolate_short_gaps(f0, max_gap_len=3):
    """
    Interpolasi linear hanya pada celah nol pendek (micro-drops <= max_gap_len frame)
    agar pitch mengalir mulus tanpa gap/crackling digital, sementara jeda panjang
    (napas, kata, konsonan mati S/T/P/K) tetap senyap agar artikulasi renyah & tidak terendam.
    """
    f0 = np.array(f0)
    nz_indices = np.nonzero(f0)[0]
    if len(nz_indices) == 0:
        return f0
        
    n = len(f0)
    i = 0
    while i < n:
        if f0[i] == 0:
            start = i
            while i < n and f0[i] == 0:
                i += 1
            end = i  # exclusive
            gap_len = end - start
            
            # Jika celah senyap cukup pendek, lakukan interpolasi linear
            if gap_len <= max_gap_len:
                left_val = f0[start - 1] if start > 0 else 0
                right_val = f0[end] if end < n else 0
                
                if left_val > 0 and right_val > 0:
                    for j in range(start, end):
                        f0[j] = left_val + (right_val - left_val) * (j - start + 1) / (gap_len + 1)
        else:
            i += 1
            
    return f0

def extract_pitch_parselmouth(y, sr, target_len, pitch_change, filter_radius=3):
    # Praat Parselmouth pitch tracker dengan Autocorrelation (to_pitch_ac)
    # Hop length matches 320 for 16000Hz standard sampling rate
    duration = len(y) / sr
    time_step = duration / target_len
    
    # sound requires float64 double array, parselmouth converts it automatically
    sound = parselmouth.Sound(y, sampling_frequency=sr)
    # Lower voicing_threshold to 0.45 (from 0.6) for smoother syllable voice tracking
    pitch_obj = sound.to_pitch_ac(time_step=time_step, pitch_floor=65, pitch_ceiling=1100, voicing_threshold=0.45)
    f0 = pitch_obj.selected_array['frequency']
    
    # Align length with target_len exactly
    if len(f0) > target_len:
        f0 = f0[:target_len]
    elif len(f0) < target_len:
        f0 = np.pad(f0, (0, target_len - len(f0)), 'constant')
        
    # Pitch shifting in semitones
    if pitch_change != 0:
        factor = 2 ** (pitch_change / 12.0)
        f0 = f0 * factor
        print(f"[Pitch] Menggeser pitch sebesar {pitch_change} semitone", flush=True)
        
    # Median filtering jika filter_radius > 2
    if filter_radius > 2:
        from scipy.signal import medfilt
        kernel_size = filter_radius if filter_radius % 2 == 1 else filter_radius + 1
        f0 = medfilt(f0, kernel_size)
        print(f"[Pitch] Menerapkan median filter dengan kernel={kernel_size}", flush=True)
        
    # Interpolasi linear HANYA pada celah senyap mikro untuk melindungi konsonan mati (S/T/P/K)
    f0 = interpolate_short_gaps(f0, max_gap_len=3)
        
    # Quantize F0 to 1-255 (Mel scale)
    f0_mel_min = 1127 * np.log(1 + 50 / 700)
    f0_mel_max = 1127 * np.log(1 + 1100 / 700)
    
    f0_mel = 1127 * np.log(1 + f0 / 700)
    voiced_mask = f0_mel > 0
    f0_mel[voiced_mask] = (f0_mel[voiced_mask] - f0_mel_min) * 254 / (f0_mel_max - f0_mel_min) + 1
    f0_mel[f0_mel <= 1] = 1
    f0_mel[f0_mel > 255] = 255
    f0_coarse = np.rint(f0_mel).astype(int)
    
    return f0, f0_coarse

def change_rms(data1, sr1, data2, sr2, rate):
    """Kedua array HARUS memiliki sample rate yang sama agar frame_length konsisten."""
    rms1 = librosa.feature.rms(y=data1, frame_length=sr1 // 2 * 2, hop_length=sr1 // 2)
    rms2 = librosa.feature.rms(y=data2, frame_length=sr2 // 2 * 2, hop_length=sr2 // 2)
    
    rms1 = torch.from_numpy(rms1)
    rms1 = torch.nn.functional.interpolate(
        rms1.unsqueeze(0), size=data2.shape[0], mode="linear"
    ).squeeze()
    
    rms2 = torch.from_numpy(rms2)
    rms2 = torch.nn.functional.interpolate(
        rms2.unsqueeze(0), size=data2.shape[0], mode="linear"
    ).squeeze()
    
    rms2 = torch.max(rms2, torch.zeros_like(rms2) + 1e-6)
    
    rate_tensor = torch.tensor(rate, dtype=torch.float32)
    scaling = torch.pow(rms1, 1 - rate_tensor) * torch.pow(rms2, rate_tensor - 1)
    
    data2 = data2 * scaling.numpy()
    return data2

def apply_presence_boost(audio, sr, gain_db=1.5, freq=4000):
    """
    FIX 1: Proper high-shelf presence boost untuk clarity vokal.
    Berbeda dari pre-emphasis 0.12 yang terlalu agresif di 48kHz —
    filter ini hanya boost +1.5dB di atas 4kHz tanpa memotong low-end.
    """
    nyq = sr / 2.0
    norm_freq = freq / nyq
    if norm_freq >= 1.0:
        return audio
    b, a = signal.butter(2, norm_freq, btype='high')
    high_band = signal.filtfilt(b, a, audio)
    gain_linear = 10 ** (gain_db / 20.0)
    return audio + (gain_linear - 1.0) * high_band

def soft_noise_gate(audio, threshold_rms=0.002, frame_len=512):
    """
    FIX 2 (output): Soft noise gate dengan envelope follower pada output RVC.
    Threshold -54dB (0.002) lebih halus dari -46dB (0.005) sebelumnya.
    Menggunakan gain ramping bertahap — tidak tiba-tiba zero.
    """
    out = audio.copy().astype(np.float64)
    gain = 1.0
    attack = 0.1
    release = 0.02
    for i in range(0, len(out) - frame_len, frame_len):
        frame = out[i:i + frame_len]
        rms = np.sqrt(np.mean(frame**2))
        target_gain = 1.0 if rms >= threshold_rms else (rms / threshold_rms) ** 2
        if target_gain > gain:
            gain = gain * (1 - release) + target_gain * release
        else:
            gain = gain * (1 - attack) + target_gain * attack
        out[i:i + frame_len] *= gain
    return out.astype(np.float32)

def match_features_faiss(feats, index, index_rate=0.4):
    if index is None or index_rate <= 0:
        return feats
    
    try:
        # feats shape: [target_len, 768]
        feats_flat = feats.astype('float32')
        # D: distances, I: indices of shape [target_len, 1]
        D, I = index.search(feats_flat, 1)
        
        # Reconstruct nearest-neighbor vectors
        db_feats = []
        for idx in I.squeeze(-1):
            vector = index.reconstruct(int(idx))
            db_feats.append(vector)
            
        db_feats = np.array(db_feats).astype('float32')
        # Blend original features and matched database features
        blended_feats = index_rate * db_feats + (1 - index_rate) * feats
        return blended_feats
    except Exception as e:
        print(f"[FAISS Warning] Gagal melakukan pencocokan index: {e}", flush=True)
        return feats

class TTSRequest(BaseModel):
    text: str
    model_path: str
    index_path: Optional[str] = None
    output_wav: str
    pitch_change: int = 0
    index_rate: float = 0.4
    rms_mix_rate: float = 0.5
    protect: float = 0.33
    filter_radius: int = 3

@app.post("/tts")
async def tts_endpoint(req: TTSRequest):
    temp_base = os.path.join(current_dir, f"temp_base_{os.getpid()}.wav")
    try:
        # 1. Generate base audio with Edge-TTS
        await generate_base_audio(req.text, temp_base)
        
        # 2. Check if model path is none (fallback to pure edge-tts)
        if not req.model_path or req.model_path.lower() == "none" or not os.path.exists(req.model_path):
            if os.path.exists(temp_base):
                # Copy temp_base to output_wav
                if os.path.exists(req.output_wav):
                    os.remove(req.output_wav)
                os.rename(temp_base, req.output_wav)
                print("[System] Menggunakan fallback Edge-TTS murni.", flush=True)
                return {"success": True, "fallback": True}
            raise HTTPException(status_code=500, detail="Gagal menghasilkan audio dasar Edge-TTS.")
            
        # 3. Load RVC Model and Index
        model_info = load_rvc_model_and_index(req.model_path, req.index_path)
        net_g = model_info["net_g"]
        target_sr = model_info["sr"]
        faiss_index = model_info["index"]
        
        # 4. Load & Resample ke 16kHz via Soundfile + NumPy interp (Bebas Bug Librosa/MediaFoundation!)
        print("[Audio] Memuat audio input dengan soundfile...", flush=True)
        y, sr_orig = sf.read(temp_base)
        # Jika stereo (2 channel), ubah ke mono dengan merata-ratakan channel
        if len(y.shape) > 1:
            y = np.mean(y, axis=1)
            
        print(f"[Audio] Resampling dari {sr_orig}Hz ke 16000Hz via librosa.resample...", flush=True)
        if sr_orig != 16000:
            y = librosa.resample(y, orig_sr=sr_orig, target_sr=16000)
            
        # Apply Butterworth Highpass filter to remove sub-bass rumble
        print("[Audio] Menerapkan Butterworth Highpass Filter (48Hz)...", flush=True)
        y = signal.filtfilt(bh, ah, y)
            
        # Peak Normalization untuk audio input
        max_val = np.max(np.abs(y))
        if max_val > 0:
            y = y / max_val * 0.95
            print("[Audio] Peak normalization input audio selesai (scale=0.95).", flush=True)
        
        # FIX 2: Input noise gate DIHAPUS — dipindah ke post-RVC sebagai soft gate
        # Hard noise gate sebelum HuBERT merusak context temporal & memotong konsonan halus (s, h, napas)
        
        # 5. Extract HuBERT Features
        print("[HuBERT] Mengekstrak hidden states...", flush=True)
        y_norm = (y - np.mean(y)) / (np.std(y) + 1e-5)
        input_values = torch.tensor(y_norm).unsqueeze(0).to(device)
        if is_half:
            input_values = input_values.half()
        else:
            input_values = input_values.float()
            
        with torch.no_grad():
            outputs = hubert_model(input_values)
            feats = outputs.last_hidden_state.squeeze(0).cpu().numpy() # [seq_len, 768]
            
        target_len = feats.shape[0]
        
        # Simpan original features sebelum FAISS blending untuk Consonant Protection
        feats0 = torch.tensor(feats, dtype=torch.float if not is_half else torch.half, device=device).unsqueeze(0)
        
        # 6. FAISS Index Feature Retrieval Blending for perfect clarity!
        if faiss_index is not None and req.index_rate > 0:
            print("[FAISS] Melakukan pencocokan fitur suara untuk memulihkan kejernihan...", flush=True)
            feats = match_features_faiss(feats, faiss_index, req.index_rate)
            
        feats_tensor = torch.tensor(feats, dtype=torch.float if not is_half else torch.half, device=device).unsqueeze(0)
        
        # 7. Parselmouth Pitch Extraction (Super fast!)
        print("[Pitch] Mengekstrak pitch intonasi dengan Praat Parselmouth...", flush=True)
        f0, f0_coarse = extract_pitch_parselmouth(y, 16000, target_len, req.pitch_change, req.filter_radius)
        
        # Consonant Protection blending
        if req.protect < 0.5 and f0 is not None:
            print(f"[Synthesizer] Mengaplikasikan consonant protection (protect={req.protect})...", flush=True)
            pitchf_tensor = torch.tensor(f0, dtype=torch.float if not is_half else torch.half, device=device).unsqueeze(0)
            pitchff = pitchf_tensor.clone()
            pitchff[pitchf_tensor > 0] = 1.0
            pitchff[pitchf_tensor <= 0] = req.protect
            pitchff = pitchff.unsqueeze(-1) # [1, target_len, 1]
            feats_tensor = feats_tensor * pitchff + feats0 * (1.0 - pitchff)
        
        # 8. Infer voice conversion
        print("[Synthesizer] Sintesis RVC Generator...", flush=True)
        phone = feats_tensor
        phone_lengths = torch.tensor([target_len], dtype=torch.long, device=device)
        pitch = torch.tensor(f0_coarse, dtype=torch.long, device=device).unsqueeze(0)
        pitchf = torch.tensor(f0, dtype=torch.float if not is_half else torch.half, device=device).unsqueeze(0)
        sid = torch.tensor([0], dtype=torch.long, device=device)
        
        with torch.no_grad():
            o, x_mask, _ = net_g.infer(phone, phone_lengths, pitch, pitchf, sid)
            audio_out = o.squeeze().cpu().float().numpy()
            
        # 8.5 Post-processing: Soft Noise Gate pada output RVC (FIX 2 - pindah ke sini)
        print("[Audio] Menerapkan soft noise gate pada output RVC (-54dB)...", flush=True)
        audio_out = soft_noise_gate(audio_out, threshold_rms=0.002)
        
        # FIX 1: Proper presence boost (high-shelf +1.5dB @4kHz) — bukan pre-emphasis 0.12 yang metalik
        print("[Audio] Menerapkan presence boost (+1.5dB @4kHz) untuk clarity vokal...", flush=True)
        audio_out = apply_presence_boost(audio_out, target_sr, gain_db=1.5, freq=4000)
            
        # FIX 3: Volume envelope matching — gunakan domain 16kHz agar frame_length konsisten
        if req.rms_mix_rate != 1.0:
            print(f"[Audio] Menyelaraskan volume envelope (rms_mix_rate={req.rms_mix_rate})...", flush=True)
            audio_out_16k = librosa.resample(audio_out.astype(np.float32), orig_sr=target_sr, target_sr=16000)
            audio_out_16k = change_rms(y, 16000, audio_out_16k, 16000, req.rms_mix_rate)
            audio_out = librosa.resample(audio_out_16k, orig_sr=16000, target_sr=target_sr)
            
        # FIX 5: Peak Normalization 0.92 + hard clip untuk headroom aman pasca EQ
        max_out = np.max(np.abs(audio_out))
        if max_out > 0:
            audio_out = audio_out / max_out * 0.92
        audio_out = np.clip(audio_out, -1.0, 1.0)
        print("[Audio] Peak normalization output audio selesai (scale=0.92, clipped).", flush=True)
            
        # 9. Save file
        print(f"[Audio] Menyimpan audio hasil konversi RVC...", flush=True)
        sf.write(req.output_wav, audio_out, target_sr)
        print("[System] Konversi RVC sukses!", flush=True)
        
        return {"success": True, "fallback": False}
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[Error] Terjadi kesalahan: {e}", flush=True)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(temp_base):
            try:
                os.remove(temp_base)
            except:
                pass

if __name__ == "__main__":
    print("[Service] Memulai RVC Service pada port 5001...", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=5001, log_level="warning")
