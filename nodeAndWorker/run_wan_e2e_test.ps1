$BootstrapNode = "/ip4/51.222.26.225/tcp/4001/p2p/12D3KooWHNoWUtd7kqWGFzN9hpkF3pysmRMoVXnYqG5vQk7RMveK"
$Stage1Port = 50051
$Stage2Port = 50052
$P2PPortA = 4002
$P2PPortB = 4003

Write-Host "`n" + ("=" * 50) -ForegroundColor Yellow
Write-Host " VRYX DePIN WAN E2E ORCHESTRATION TEST " -ForegroundColor Yellow
Write-Host ("=" * 50) + "`n" -ForegroundColor Yellow

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
Write-Host "[*] Starting Rust Daemon B (Worker mode, Port $Stage2Port, P2P $P2PPortB)..." -ForegroundColor Green
$DaemonB = Start-Process "cargo" -ArgumentList "run -- --grpc-port $Stage2Port --mode worker --p2p-port $P2PPortB --bootstrap-node $BootstrapNode" -WorkingDirectory "$RootDir\rust-daemon" -PassThru -NoNewWindow

Start-Sleep -Seconds 3

# 4. Start Daemon A (Initiator)
Write-Host "[*] Starting Rust Daemon A (Initiator mode, Port $Stage1Port, P2P $P2PPortA)..." -ForegroundColor Green
$DaemonA = Start-Process "cargo" -ArgumentList "run -- --grpc-port $Stage1Port --mode initiator --p2p-port $P2PPortA --bootstrap-node $BootstrapNode" -WorkingDirectory "$RootDir\rust-daemon" -PassThru -NoNewWindow

Write-Host "`n[!] Running WAN test... discovery via VPS Bootstrap Node.`n" -ForegroundColor White

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
            Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $p.Id } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Host "[√] Cleanup finished." -ForegroundColor Red
}
