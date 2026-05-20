@echo off
SETLOCAL EnableDelayedExpansion
title Vryx Worker - Windows Edition

echo  +------------------------------------------+
echo  ^|         Vryx Worker Launcher             ^|
echo  ^|            (Windows Fork)                ^|
echo  +------------------------------------------+
echo.

:: Configuration
set "MODEL_ID=Qwen/Qwen3.5-9B"
set "GRPC_PORT=50052"
set "API_PORT=3031"
set "P2P_PORT=4021"
set "BOOTSTRAP_NODE=/ip4/51.222.26.225/tcp/4001/p2p/12D3KooWLMT5gnTuCNkVewEhX8wcQ3spGFauT6XtcaBCs5N8n9Zz"
set "API_URL=https://vryx.eu"
set "USER_ID="

:parse_args
if "%~1"=="" goto done_args
if "%~1"=="--model" set "MODEL_ID=%~2" & shift & shift & goto parse_args
if "%~1"=="--grpc-port" set "GRPC_PORT=%~2" & shift & shift & goto parse_args
if "%~1"=="--port" set "GRPC_PORT=%~2" & shift & shift & goto parse_args
if "%~1"=="--api-port" set "API_PORT=%~2" & shift & shift & goto parse_args
if "%~1"=="--p2p-port" set "P2P_PORT=%~2" & shift & shift & goto parse_args
if "%~1"=="--bootstrap-node" set "BOOTSTRAP_NODE=%~2" & shift & shift & goto parse_args
if "%~1"=="--api-url" set "API_URL=%~2" & shift & shift & goto parse_args
if "%~1"=="--user-id" set "USER_ID=%~2" & shift & shift & goto parse_args
shift
goto parse_args
:done_args

if "%VRYX_WORKER_SHARD_ONLY%"=="1" if "%VRYX_RUNTIME_BACKEND%"=="" set "VRYX_RUNTIME_BACKEND=cpu"
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

echo [*] Modele : %MODEL_ID%
echo [*] Ports  : gRPC %GRPC_PORT% / API %API_PORT% / P2P %P2P_PORT%
echo [*] Backend: %VRYX_RUNTIME_BACKEND% / memoire worker %VRYX_WORKER_MEMORY_LIMIT_GB% Go (%VRYX_WORKER_MEMORY_LIMIT_PERCENT%%%)
if "%VRYX_WORKER_SHARD_ONLY%"=="1" echo [*] Mode shard-only actif : aucun telechargement/chargement direct du modele complet.
if not exist ".vryx-keys" mkdir ".vryx-keys"
if not exist "python-inference" (
    echo [!] Runtime Python introuvable: "%SCRIPT_DIR%python-inference"
    exit /b 4058
)

:: Check Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Python n'est pas installe ou pas dans le PATH.
    pause
    exit /b
)

:: Check for virtualenv
if not exist "python-inference\\venv" (
    echo [*] Creation de l'environnement virtuel Python...
    python -m venv python-inference\venv
)

echo [*] Activation de l'environnement virtuel...
call python-inference\venv\Scripts\activate.bat

echo [*] Installation des dependances...
pip install -r python-inference\requirements.txt >nul 2>&1

:: Detect usable backend on Windows
if /I "%VRYX_RUNTIME_BACKEND%"=="rocm" (
    echo [!] ROCm Windows n'est pas supporte dans cette build worker. Fallback CPU.
    set "DEVICE=cpu"
) else (
    python -c "import torch; print('CUDA disponible' if torch.cuda.is_available() else 'CUDA non disponible')" | find "CUDA disponible" >nul
    if %errorlevel% equ 0 (
        echo [^+] GPU NVIDIA détecté avec CUDA !
        set "DEVICE=cuda"
    ) else (
        echo [!] CUDA non détecté. Utilisation du CPU.
        set "DEVICE=cpu"
    )
)

set "DAEMON_BIN=bin\\win32-x64\\rust-daemon.exe"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "DAEMON_BIN=bin\\win32-arm64\\rust-daemon.exe"
if exist "%DAEMON_BIN%" (
    echo [*] Daemon Rust packagé : %DAEMON_BIN%
) else (
    if exist "target\\release\\rust-daemon.exe" (
        set "DAEMON_BIN=target\\release\\rust-daemon.exe"
        echo [*] Daemon Rust local : %DAEMON_BIN%
    ) else (
        echo [!] Daemon Rust introuvable : "%SCRIPT_DIR%%DAEMON_BIN%"
        echo [!] La build Windows livree est incomplete. Reinstalle le worker depuis un package corrige.
        exit /b 4058
    )
)

:: Lancement du serveur d'inférence en arrière-plan
echo [*] Lancement du serveur d'inférence GPU (%DEVICE%)...
start /B python python-inference/inference_server.py --port %GRPC_PORT% --stage 2 --model "%MODEL_ID%" --device %DEVICE%

:: Lancement du daemon Rust
echo [*] Lancement du daemon Rust P2P...
"%DAEMON_BIN%" --mode worker --grpc-port %GRPC_PORT% --p2p-port %P2P_PORT% --api-port %API_PORT% --bootstrap-node %BOOTSTRAP_NODE% --api-url %API_URL% --model "%MODEL_ID%" --node-key-file ".vryx-keys\worker.node.key"

pause
