$Stage1Port = 50051
$Stage2Port = 50052

Write-Host "`n" + ("=" * 50) -ForegroundColor Yellow
Write-Host " VRYX DePIN E2E ORCHESTRATION & TELEMETRY TEST " -ForegroundColor Yellow
Write-Host ("=" * 50) + "`n" -ForegroundColor Yellow

# Ensure we are in the root directory
$RootDir = Get-Location

# 1. Start Stage 1 Python Worker
Write-Host "[*] Starting Stage 1 Python Worker (Port $Stage1Port)..." -ForegroundColor Cyan
$PythonExe = Join-Path $RootDir "python-inference\venv\Scripts\python.exe"
$WorkerA = Start-Process $PythonExe -ArgumentList "inference_server.py --port $Stage1Port --stage 1" -WorkingDirectory "$RootDir\python-inference" -PassThru -NoNewWindow

# 2. Start Stage 2 Python Worker
Write-Host "[*] Starting Stage 2 Python Worker (Port $Stage2Port)..." -ForegroundColor Cyan
$WorkerB = Start-Process $PythonExe -ArgumentList "inference_server.py --port $Stage2Port --stage 2" -WorkingDirectory "$RootDir\python-inference" -PassThru -NoNewWindow

Write-Host "[*] Waiting for Workers to initialize model..." -ForegroundColor Gray
Start-Sleep -Seconds 5

# 3. Start Daemon B (Worker)
Write-Host "[*] Starting Rust Daemon B (Worker mode, Port $Stage2Port)..." -ForegroundColor Green
$DaemonB = Start-Process "cargo" -ArgumentList "run -- --grpc-port $Stage2Port --mode worker" -WorkingDirectory "$RootDir\rust-daemon" -PassThru -NoNewWindow

Start-Sleep -Seconds 3

# 4. Start Daemon A (Initiator)
Write-Host "[*] Starting Rust Daemon A (Initiator mode, Port $Stage1Port)..." -ForegroundColor Green
$DaemonA = Start-Process "cargo" -ArgumentList "run -- --grpc-port $Stage1Port --mode initiator" -WorkingDirectory "$RootDir\rust-daemon" -PassThru -NoNewWindow

Write-Host "`n[!] Running test... Press Ctrl+C to stop manually if it hangs.`n" -ForegroundColor White

# Monitor Daemon A for exit (the test prints the report then we can stop)
try {
    while ($true) {
        if ($DaemonA.HasExited) { 
            Write-Host "[√] Test completed." -ForegroundColor Green
            break 
        }
        Start-Sleep -Seconds 1
    }
} catch {
    Write-Host "[!] Interrupted." -ForegroundColor Red
} finally {
    Write-Host "`n[*] Cleaning up processes..." -ForegroundColor Red
    $processes = @($WorkerA, $WorkerB, $DaemonA, $DaemonB)
    foreach ($p in $processes) {
        if ($p -and -not $p.HasExited) {
            # Kill child processes as well (cargo run starts a child)
            Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $p.Id } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Host "[√] Cleanup finished." -ForegroundColor Red
}
