$BootstrapNode = "/ip4/51.222.26.225/tcp/4001/p2p/12D3KooWHNoWUtd7kqWGFzN9hpkF3pysmRMoVXnYqG5vQk7RMveK"
$Stage1Port = 50051
$Stage2Port = 50052
$P2PPortA = 4002
$P2PPortB = 4003
$P2PPortC = 4004

Write-Host "`n" + ("=" * 50) -ForegroundColor Yellow
Write-Host " VRYX DePIN FAULT TOLERANCE & RETRY TEST " -ForegroundColor Yellow
Write-Host ("=" * 50) + "`n" -ForegroundColor Yellow

$RootDir = Get-Location

# 1. Start Workers
Write-Host "[*] Starting Python Workers..." -ForegroundColor Cyan
$PythonExe = Join-Path $RootDir "python-inference\venv\Scripts\python.exe"
$WorkerA = Start-Process $PythonExe -ArgumentList "inference_server.py --port $Stage1Port --stage 1" -WorkingDirectory "$RootDir\python-inference" -PassThru -NoNewWindow
$WorkerB = Start-Process $PythonExe -ArgumentList "inference_server.py --port $Stage2Port --stage 2" -WorkingDirectory "$RootDir\python-inference" -PassThru -NoNewWindow

Start-Sleep -Seconds 5

# 2. Start Rust Daemons
Write-Host "[*] Starting Rust Daemon B (Worker 1 - Target for Failure)..." -ForegroundColor Green
$DaemonB = Start-Process "cargo" -ArgumentList "run -- --grpc-port $Stage2Port --mode worker --p2p-port $P2PPortB --bootstrap-node $BootstrapNode" -WorkingDirectory "$RootDir\rust-daemon" -PassThru -NoNewWindow

Write-Host "[*] Starting Rust Daemon C (Worker 2 - Fallback Node)..." -ForegroundColor Green
$DaemonC = Start-Process "cargo" -ArgumentList "run -- --grpc-port $Stage2Port --mode worker --p2p-port $P2PPortC --bootstrap-node $BootstrapNode" -WorkingDirectory "$RootDir\rust-daemon" -PassThru -NoNewWindow

Start-Sleep -Seconds 5

# 3. Start Initiator
Write-Host "[*] Starting Rust Daemon A (Initiator)..." -ForegroundColor Green
$DaemonA = Start-Process "cargo" -ArgumentList "run -- --grpc-port $Stage1Port --mode initiator --p2p-port $P2PPortA --bootstrap-node $BootstrapNode" -WorkingDirectory "$RootDir\rust-daemon" -PassThru -NoNewWindow

# 4. Simulation Logic
Write-Host "`n[!] Simulation: Waiting 1.5 seconds then killing Daemon B..." -ForegroundColor Yellow
Start-Sleep -Seconds 1.5
Write-Host "[!] KILLING DAEMON B NOW!" -ForegroundColor Red
# Kill Daemon B and its children
Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $DaemonB.Id } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Stop-Process -Id $DaemonB.Id -Force -ErrorAction SilentlyContinue

try {
    while ($true) {
        if ($DaemonA.HasExited) { 
            Write-Host "[√] Test finished." -ForegroundColor Green
            break 
        }
        Start-Sleep -Seconds 1
    }
} catch {
    Write-Host "[!] Interrupted." -ForegroundColor Red
} finally {
    Write-Host "`n[*] Cleaning up..." -ForegroundColor Red
    $processes = @($WorkerA, $WorkerB, $DaemonA, $DaemonB, $DaemonC)
    foreach ($p in $processes) {
        if ($p -and -not $p.HasExited) {
            Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $p.Id } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
