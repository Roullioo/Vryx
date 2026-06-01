import urllib.request
import json
import ssl

def main():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    
    print("[*] 1. Interrogation de la liste des modèles publics...")
    try:
        url_models = "https://vryx.eu/api/public/models"
        req = urllib.request.Request(url_models, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, context=ctx, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))
            if data.get("ok"):
                models = data.get("models", [])
                qwen = next((m for m in models if m.get("id") == "Qwen/Qwen3.6-35B-A3B"), None)
                if qwen:
                    print(f"[+] Modèle Qwen 3.6 35B trouvé dans le catalogue.")
                    print(f"    - Workers Online : {qwen.get('workersOnline')}")
                    print(f"    - Runnable : {qwen.get('runnable')}")
                    print(f"    - Ready : {qwen.get('ready')}")
                else:
                    print("[-] Modèle Qwen 3.6 35B introuvable dans la liste des modèles publics.")
            else:
                print(f"[-] Erreur API /api/public/models : {data}")
    except Exception as e:
        print(f"[-] Erreur de requête modèles : {e}")

    print("\n[*] 2. Simulation de la planification (Scheduler Preview)...")
    try:
        url_preview = "https://vryx.eu/api/public/scheduler-preview?model=Qwen/Qwen3.6-35B-A3B&mode=auto"
        req = urllib.request.Request(url_preview, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, context=ctx, timeout=10) as response:
            res_data = json.loads(response.read().decode('utf-8'))
            print(f"[+] Réponse reçue : {json.dumps(res_data, indent=2, ensure_ascii=False)}")
    except Exception as e:
        print(f"[-] Erreur de requête preview : {e}")

if __name__ == '__main__':
    main()
