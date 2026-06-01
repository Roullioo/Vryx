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
set "API_URL_FROM_ARG="
set "USER_ID="

:parse_args
if "%~1"=="" goto done_args
if "%~1"=="--model" set "MODEL_ID=%~2" & shift & shift & goto parse_args
if "%~1"=="--grpc-port" set "GRPC_PORT=%~2" & shift & shift & goto parse_args
if "%~1"=="--port" set "GRPC_PORT=%~2" & shift & shift & goto parse_args
if "%~1"=="--api-port" set "API_PORT=%~2" & shift & shift & goto parse_args
if "%~1"=="--p2p-port" set "P2P_PORT=%~2" & shift & shift & goto parse_args
if "%~1"=="--bootstrap-node" set "BOOTSTRAP_NODE=%~2" & shift & shift & goto parse_args
if "%~1"=="--api-url" set "API_URL=%~2" & set "API_URL_FROM_ARG=1" & shift & shift & goto parse_args
if "%~1"=="--user-id" set "USER_ID=%~2" & shift & shift & goto parse_args
shift
goto parse_args
:done_args

if "%API_URL_FROM_ARG%"=="" if not "%VRYX_API_URL%"=="" set "API_URL=%VRYX_API_URL%"
if "%VRYX_API_URL%"=="" set "VRYX_API_URL=%API_URL%"
if "%VRYX_USER_ID%"=="" set "VRYX_USER_ID=%USER_ID%"
if "%VRYX_WORKER_OS%"=="" set "VRYX_WORKER_OS=win32"
set "VRYX_GRPC_PORT=%GRPC_PORT%"
if "%VRYX_WORKER_SECRET%"=="" if not "%WORKER_SECRET%"=="" set "VRYX_WORKER_SECRET=%WORKER_SECRET%"

echo [*] Modele : %MODEL_ID%
echo [*] Ports  : gRPC %GRPC_PORT% / API %API_PORT% / P2P %P2P_PORT%
echo [*] Heartbeat: %API_URL%
echo [*] Firewall: heartbeat sortant HTTPS; ouvrir P2P %P2P_PORT% si worker direct TCP.
if "%VRYX_WORKER_SHARD_ONLY%"=="1" echo [*] Mode shard-only actif : aucun telechargement/chargement direct du modele complet.
if not exist ".vryx-keys" mkdir ".vryx-keys"

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
if "%VRYX_WORKER_SHARD_ONLY%"=="1" if "%VRYX_RUNTIME_BACKEND%"=="" (
    if "%DEVICE%"=="cuda" (
        set "VRYX_RUNTIME_BACKEND=cuda"
    ) else (
        set "VRYX_RUNTIME_BACKEND=cpu"
    )
)
echo [*] Backend: %VRYX_RUNTIME_BACKEND% / memoire worker %VRYX_WORKER_MEMORY_LIMIT_GB% Go (%VRYX_WORKER_MEMORY_LIMIT_PERCENT%%%)

:: Lancement du serveur d'inférence en arrière-plan
echo [*] Lancement du serveur d'inférence GPU (%DEVICE%)...
start /B python python-inference/inference_server.py --port %GRPC_PORT% --stage 2 --model "%MODEL_ID%" --device %DEVICE%

:: Lancement du daemon Rust
echo [*] Lancement du daemon Rust P2P...
if exist "bin\win32-x64\rust-daemon.exe" (
    bin\win32-x64\rust-daemon.exe --mode worker --grpc-port %GRPC_PORT% --p2p-port %P2P_PORT% --api-port %API_PORT% --bootstrap-node %BOOTSTRAP_NODE% --api-url %API_URL% --model "%MODEL_ID%" --node-key-file ".vryx-keys\worker.node.key"
) else if exist "bin\win32-arm64\rust-daemon.exe" (
    bin\win32-arm64\rust-daemon.exe --mode worker --grpc-port %GRPC_PORT% --p2p-port %P2P_PORT% --api-port %API_PORT% --bootstrap-node %BOOTSTRAP_NODE% --api-url %API_URL% --model "%MODEL_ID%" --node-key-file ".vryx-keys\worker.node.key"
) else if exist "target\release\rust-daemon.exe" (
    target\release\rust-daemon.exe --mode worker --grpc-port %GRPC_PORT% --p2p-port %P2P_PORT% --api-port %API_PORT% --bootstrap-node %BOOTSTRAP_NODE% --api-url %API_URL% --model "%MODEL_ID%" --node-key-file ".vryx-keys\worker.node.key"
) else (
    echo [*] Compilation du daemon Rust (premiere fois)...
    cd rust-daemon && cargo run --release -- --mode worker --grpc-port %GRPC_PORT% --p2p-port %P2P_PORT% --api-port %API_PORT% --bootstrap-node %BOOTSTRAP_NODE% --api-url %API_URL% --model "%MODEL_ID%" --node-key-file "..\.vryx-keys\worker.node.key"
)

pause
