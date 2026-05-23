import os
import sys
import asyncio
import edge_tts

# Try importing rvc_python
try:
    from rvc_python.api import RVC
    print("Library 'rvc_python' berhasil diimpor!")
except ImportError:
    print("Library 'rvc_python' TIDAK terinstal di Python Anda.")
    sys.exit(1)

current_dir = os.path.dirname(os.path.abspath(__file__))

TEXT = "Halo! Ini adalah contoh teks yang dikonversi dari Edge TTS kemudian langsung diubah suaranya menggunakan RVC."
BASE_VOICE = "id-ID-ArdiNeural"       
RAW_TTS_OUTPUT = os.path.join(current_dir, "speech_output.mp3")  
RVC_FINAL_OUTPUT = os.path.join(current_dir, "rvc_output.wav")   

MODEL_PATH = r"M:\Users\ahmad\project\live2d-mcp\voice\HuoHuo\HuoHuo.pth"
INDEX_PATH = r"M:\Users\ahmad\project\live2d-mcp\voice\HuoHuo\added_IVF273_Flat_nprobe_1_HuoHuo_v2.index"

async def generate_tts():
    print("[1/2] Menghasilkan audio dasar dari Edge-TTS...")
    communicate = edge_tts.Communicate(TEXT, BASE_VOICE)
    await communicate.save(RAW_TTS_OUTPUT)
    print(f"-> Audio dasar berhasil disimpan di: {RAW_TTS_OUTPUT}")

def apply_rvc():
    print("[2/2] Mengonversi suara menggunakan RVC Model...")
    rvc = RVC()
    
    # Eksekusi konversi suara
    rvc.convert(
        model_path=MODEL_PATH,
        index_path=INDEX_PATH,
        input_path=RAW_TTS_OUTPUT,
        output_path=RVC_FINAL_OUTPUT,
        pitch_change=0,          # 0 untuk female-to-female natural
        f0_method="rmvpe",       
        index_rate=0.7,          
        protect_voiceless=0.33   
    )
    print(f"-> Selesai! Suara RVC final disimpan di: {RVC_FINAL_OUTPUT}")

async def main():
    await generate_tts()
    apply_rvc()

if __name__ == "__main__":
    asyncio.run(main())
