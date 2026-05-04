@echo off
setlocal enabledelayedexpansion
echo ========================================
echo   VELOCITY DePIN - BULLETPROOF START
echo ========================================

:: 1. Aggressive Cleanup
echo [*] Cleaning up zombie processes...
taskkill /F /IM "rust-daemon.exe" /T 2>nul
taskkill /F /IM "python.exe" /FI "WINDOWTITLE eq VelocityInference*" /T 2>nul
for %%p in (3030, 50051, 4002, 4003) do (
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr :%%p ^| findstr LISTENING') do (
        taskkill /F /PID %%a 2>nul
    )
)

:: 2. Role Selection
echo.
echo Select Node Role:
echo 1) Initiator (Chat UI, Stage 1)
echo 2) Worker (Compute Node, Stage 2)
set /p role_choice="Enter choice (1 or 2): "

if "%role_choice%"=="2" (
    set VELOCITY_ROLE=worker
    set VITE_VELOCITY_ROLE=worker
    set PY_STAGE=2
    set RUST_MODE=worker
    set P2P_PORT=4003
) else (
    set VELOCITY_ROLE=initiator
    set VITE_VELOCITY_ROLE=initiator
    set PY_STAGE=1
    set RUST_MODE=initiator
    set P2P_PORT=4002
)

echo [*] Running as %VELOCITY_ROLE%...

:: 3. Check Dependencies
echo [*] Checking Frontend dependencies...
cd AppMacos
if not exist node_modules (
    echo [!] node_modules not found. Running npm install...
    call npm install
)
cd ..

:: 4. Start Python Inference Worker
echo [*] Starting Python Inference Engine (Stage %PY_STAGE%)...
cd nodeAndWorker\python-inference
if not exist venv (
    echo [!] Python venv not found. Please run setup first.
    pause
    exit /b
)
start "VelocityInference" /B venv\Scripts\python.exe inference_server.py --port 50051 --stage %PY_STAGE%
cd ..\..

:: 5. Start Rust P2P Daemon
echo [*] Starting Velocity Rust Daemon (%RUST_MODE%)...
cd nodeAndWorker\rust-daemon
set BOOTSTRAP=/ip4/51.222.26.225/tcp/4001/p2p/12D3KooWLMT5gnTuCNkVewEhX8wcQ3spGFauT6XtcaBCs5N8n9Zz
if exist ..\target\release\rust-daemon.exe (
    start "VelocityDaemon" /B ..\target\release\rust-daemon.exe --grpc-port 50051 --mode %RUST_MODE% --p2p-port %P2P_PORT% --bootstrap-node %BOOTSTRAP%
) else (
    start "VelocityDaemon" /B cargo run --release -- --grpc-port 50051 --mode %RUST_MODE% --p2p-port %P2P_PORT% --bootstrap-node %BOOTSTRAP%
)
cd ..\..

:: 6. Start Electron GUI
echo [*] Starting Velocity Desktop UI...
cd AppMacos
:: Ensure role is passed to Vite
set VITE_VELOCITY_ROLE=%VITE_VELOCITY_ROLE%
call npm run electron:dev
cd ..

echo [!] Velocity is shutting down...
taskkill /F /IM "rust-daemon.exe" /T 2>nul
taskkill /F /FI "WINDOWTITLE eq VelocityInference*" /T 2>nul
pause
