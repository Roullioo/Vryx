import paramiko
from scp import SCPClient
import tarfile
import os
import sys

# Configuration
HOST = "51.222.26.225"
USER = "ubuntu"
PASS = "Galippette0312"
P2P_PORT = 4001

def create_tarball(output_filename, source_dirs):
    print(f"[*] Creating tarball {output_filename}...")
    with tarfile.open(output_filename, "w:gz") as tar:
        for source_dir in source_dirs:
            if not os.path.exists(source_dir):
                print(f"[!] Warning: {source_dir} not found.")
                continue
            for root, dirs, files in os.walk(source_dir):
                if "target" in dirs:
                    dirs.remove("target")
                if ".git" in dirs:
                    dirs.remove(".git")
                for file in files:
                    full_path = os.path.join(root, file)
                    tar.add(full_path, arcname=os.path.relpath(full_path, os.getcwd()))

def execute_cmd(ssh, cmd, use_sudo=False):
    if use_sudo:
        final_cmd = f"echo '{PASS}' | sudo -S {cmd}"
    else:
        final_cmd = cmd
    
    print(f"[>] Executing: {cmd}")
    stdin, stdout, stderr = ssh.exec_command(final_cmd)
    
    # Wait and stream output
    while not stdout.channel.exit_status_ready():
        if stdout.channel.recv_ready():
            out = stdout.channel.recv(1024).decode('utf-8', 'replace')
            try:
                print(out, end="", flush=True)
            except UnicodeEncodeError:
                print(out.encode('ascii', 'replace').decode(), end="", flush=True)
        if stdout.channel.recv_stderr_ready():
            err = stdout.channel.recv_stderr(1024).decode('utf-8', 'replace')
            try:
                print(err, end="", flush=True, file=sys.stderr)
            except UnicodeEncodeError:
                print(err.encode('ascii', 'replace').decode(), end="", flush=True, file=sys.stderr)
    
    # Final output
    out = stdout.read().decode('utf-8', 'replace')
    try:
        print(out, end="", flush=True)
    except UnicodeEncodeError:
        print(out.encode('ascii', 'replace').decode(), end="", flush=True)
    
    err = stderr.read().decode('utf-8', 'replace')
    try:
        print(err, end="", flush=True, file=sys.stderr)
    except UnicodeEncodeError:
        print(err.encode('ascii', 'replace').decode(), end="", flush=True, file=sys.stderr)
    
    return stdout.channel.recv_exit_status()

def deploy():
    # 1. Package code
    create_tarball("vryx-deploy.tar.gz", ["rust-daemon", "proto"])

    # 2. SSH connection
    print(f"[*] Connecting to {HOST}...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, username=USER, password=PASS)

    try:
        # 3. Transfer code
        print("[*] Transferring tarball...")
        with SCPClient(ssh.get_transport()) as scp:
            scp.put("vryx-deploy.tar.gz", "vryx-deploy.tar.gz")

        # 4. Remote commands
        commands = [
            ("tar -xzvf vryx-deploy.tar.gz", False),
            ("apt update", True),
            ("apt install -y build-essential pkg-config libssl-dev protobuf-compiler", True),
            # Install Rust (only if not present)
            ("curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y", False),
            # Build
            ("$HOME/.cargo/bin/cargo build --release --manifest-path rust-daemon/Cargo.toml", False),
            # Systemd Service
            (f"""bash -c 'cat <<EOF > /etc/systemd/system/vryx-bootstrap.service
[Unit]
Description=Vryx DePIN Bootstrap Node
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/rust-daemon
ExecStart=/home/ubuntu/rust-daemon/target/release/rust-daemon --mode bootstrap --p2p-port {P2P_PORT}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF'""", True),
            ("systemctl daemon-reload", True),
            ("systemctl enable vryx-bootstrap", True),
            ("systemctl restart vryx-bootstrap", True),
            # Firewall
            ("ufw allow 22/tcp", True),
            (f"ufw allow {P2P_PORT}/tcp", True),
            ("ufw --force enable", True),
            # Verification
            ("journalctl -u vryx-bootstrap.service -n 50", True)
        ]

        for cmd, sudo in commands:
            status = execute_cmd(ssh, cmd, use_sudo=sudo)
            if status != 0:
                print(f"[!] Command failed with status {status}")
                if "apt" not in cmd: # Ignore minor apt issues
                    break

    finally:
        ssh.close()
        print("[+] Deployment session closed.")

if __name__ == "__main__":
    deploy()
