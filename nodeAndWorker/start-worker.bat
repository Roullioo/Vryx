@echo off
SETLOCAL EnableDelayedExpansion
title Vryx Worker - Windows Edition

echo  +------------------------------------------+
echo  ^|         Vryx Worker Launcher             ^|
echo  ^|            (Windows Fork)                ^|
echo  +------------------------------------------+
echo.

:: Configuration
set "GRPC_PORT=50052"
set "API_PORT=3031"
set "BOOTSTRAP_NODE=/ip4/51.222.26.225/tcp/4001/p2p/12D3KooWLMT5gnTuCNkVewEhX8wcQ3spGFauT6XtcaBCs5N8n9Zz"
set "API_URL=https://vryx.eu"

:: Check Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Python n'est pas installe ou pas dans le PATH.
    pause
    exit /b
)

:: Check for virtualenv
if not exist "venv" (
    echo [*] Creation de l'environnement virtuel Python...
    python -m venv venv
)

echo [*] Activation de l'environnement virtuel...
call venv\Scripts\activate

echo [*] Installation des dependances...
pip install torch numpy grpcio grpcio-tools transformers >nul 2>&1

:: Check for CUDA
python -c "import torch; print('CUDA disponible' if torch.cuda.is_available() else 'CUDA non disponible')" | find "CUDA disponible" >nul
if %errorlevel% equ 0 (
    echo [^+] GPU NVIDIA détecté avec CUDA !
    set "DEVICE=cuda"
) else (
    echo [!] CUDA non détecté. Utilisation du CPU (plus lent).
    set "DEVICE=cpu"
)

:: Lancement du serveur d'inférence en arrière-plan
echo [*] Lancement du serveur d'inférence GPU (%DEVICE%)...
start /B python python-inference/inference_server.py --port %GRPC_PORT% --device %DEVICE%

:: Lancement du daemon Rust
echo [*] Lancement du daemon Rust P2P...
if exist "target\release\rust-daemon.exe" (
    target\release\rust-daemon.exe --mode worker --grpc-port %GRPC_PORT% --api-port %API_PORT% --bootstrap-node %BOOTSTRAP_NODE% --api-url %API_URL%
) else (
    echo [*] Compilation du daemon Rust (premiere fois)...
    cd rust-daemon && cargo run --release -- --mode worker --grpc-port %GRPC_PORT% --api-port %API_PORT% --bootstrap-node %BOOTSTRAP_NODE% --api-url %API_URL%
)

pause
