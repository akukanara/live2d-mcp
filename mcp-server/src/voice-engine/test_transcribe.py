import os
import sys

def attempt_transcription():
    print("=== PENGUJIAN TRANSKRIPSI ELEMEN SUARA ===")
    
    huohuo_path = r"m:\Users\ahmad\project\live2d-mcp\test_huohuo.wav"
    hutao_path = r"m:\Users\ahmad\project\live2d-mcp\test_hutao.wav"
    
    # Coba gunakan speech_recognition jika terinstall
    try:
        import speech_recognition as sr
        print("Library 'speech_recognition' ditemukan. Memulai proses transkripsi...")
        
        r = sr.Recognizer()
        
        for name, path in [("HuoHuo", huohuo_path), ("HuTao", hutao_path)]:
            if not os.path.exists(path):
                print(f"File {name} tidak ditemukan di {path}")
                continue
                
            with sr.AudioFile(path) as source:
                audio_data = r.record(source)
                try:
                    # Coba kenali dengan google speech recognition (bahasa Indonesia)
                    text = r.recognize_google(audio_data, language="id-ID")
                    print(f"  [SUKSES] Transkripsi {name}: \"{text}\"")
                except sr.UnknownValueError:
                    print(f"  [GAGAL] Google tidak bisa mendeteksi kata-kata dari audio {name} (Suara tidak jelas/noise murni)")
                except sr.RequestError as e:
                    print(f"  [ERROR] Gagal menghubungi layanan Google Speech: {e}")
                    
    except ImportError:
        print("Library 'speech_recognition' tidak terinstall di Python global.")
        print("Mencoba menggunakan alternative whisper jika terinstall...")
        try:
            import whisper
            print("Library 'whisper' ditemukan! Memulai proses transkripsi...")
            model = whisper.load_model("tiny")
            
            for name, path in [("HuoHuo", huohuo_path), ("HuTao", hutao_path)]:
                if not os.path.exists(path):
                    continue
                result = model.transcribe(path, language="id")
                print(f"  [SUKSES] Whisper {name}: \"{result['text']}\"")
        except ImportError:
            print("Library 'whisper' tidak terinstall.")

if __name__ == "__main__":
    attempt_transcription()
