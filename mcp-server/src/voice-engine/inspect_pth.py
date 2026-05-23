import os
import torch

def inspect_model_pth(filepath):
    if not os.path.exists(filepath):
        print(f"File {filepath} tidak ditemukan.")
        return
        
    print(f"\n==============================")
    print(f"INSPEKSI PTH: {os.path.basename(filepath)}")
    try:
        cpt = torch.load(filepath, map_location="cpu")
        print("Keys di dalam checkpoint:", cpt.keys())
        
        # Ambil info target sr dan config
        config = cpt.get("config", [])
        sr = cpt.get("sr", "Tidak ada")
        print(f"Sample Rate: {sr}")
        print("Config:", config)
        
        # Periksa dimensi bobot generator voice-matching
        weight = cpt.get("weight", {})
        print(f"Total layers di 'weight': {len(weight)}")
        
        # Periksa layer text/feature encoder (enc_p.emb)
        emb_key = "enc_p.emb.weight"
        if emb_key in weight:
            shape = weight[emb_key].shape
            print(f"Shape dari '{emb_key}': {shape}")
            if shape[1] == 256:
                print("-> KESIMPULAN DIMENSI: 256 (Model ini adalah RVC V1!)")
            elif shape[1] == 768:
                print("-> KESIMPULAN DIMENSI: 768 (Model ini adalah RVC V2!)")
            else:
                print(f"-> KESIMPULAN DIMENSI: {shape[1]} (Kustom/Tidak dikenal)")
        else:
            print(f"Layer '{emb_key}' tidak ditemukan di weight! Mencari layer emb alternatif...")
            for k in weight.keys():
                if "emb" in k or "enc" in k:
                    print(f"  Ditemukan layer: {k} dengan shape {weight[k].shape}")
                    break
                    
    except Exception as e:
        print(f"Gagal memuat checkpoint: {e}")

if __name__ == "__main__":
    inspect_model_pth(r"M:\Users\ahmad\project\live2d-mcp\voice\HuoHuo\HuoHuo.pth")
    # Cari model lain di folder voice jika ada
    voice_dir = r"M:\Users\ahmad\project\live2d-mcp\voice"
    if os.path.exists(voice_dir):
        for root, dirs, files in os.walk(voice_dir):
            for file in files:
                if file.endswith(".pth") and "HuoHuo" not in file:
                    inspect_model_pth(os.path.join(root, file))
