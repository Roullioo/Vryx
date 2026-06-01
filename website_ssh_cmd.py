import os
import sys
import paramiko

HOST = "51.222.26.225"
USER = "ubuntu"
PASS = "Galippette0312"

def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(hostname=HOST, username=USER, password=PASS)
        
        cmd = """
        echo "=== Trouver le .env du serveur ==="
        find /home/ubuntu/apps/vryx -name ".env" 2>/dev/null | xargs ls -la 2>/dev/null
        
        echo ""
        echo "=== .env contents ==="
        find /home/ubuntu/apps/vryx -name ".env" -exec cat {} \\; 2>/dev/null | grep -E "DB|MYSQL|DATABASE|NODE|PORT" | head -20
        
        echo ""
        echo "=== Redémarrer le serveur Node.js avec le nouveau code ==="
        # Copier le fichier index.js modifié puis restart le serveur
        ls /home/ubuntu/apps/vryx/website/server/src/index.js 2>/dev/null && echo "Server file exists"
        
        echo ""
        echo "=== Quel service gère le serveur Node.js ==="
        systemctl list-units | grep vryx | grep -v inference | grep -v initiator | head -10
        pm2 list 2>/dev/null | head -10 || echo "pm2 not found"
        """
        
        stdin, stdout, stderr = client.exec_command(cmd)
        out = stdout.read().decode('utf-8')
        print(out)
        
        err = stderr.read().decode('utf-8')
        if err:
            print("=== STDERR ===")
            print(err)
            
    except Exception as e:
        print(f"[-] Erreur : {e}")
    finally:
        client.close()

if __name__ == '__main__':
    main()
