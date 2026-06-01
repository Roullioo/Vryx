param(
    [string]$InstallDir = "$env:USERPROFILE\vryx-tools\llama.cpp-b9415-cuda12.4",
    [string]$HostName = "0.0.0.0",
    [int]$Port = 50052,
    [switch]$NoFirewallRule
)

$ErrorActionPreference = "Stop"

$rpcServer = Get-ChildItem -Path $InstallDir -Recurse -Filter "rpc-server.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $rpcServer) {
    throw "rpc-server.exe introuvable. Lance scripts\install_llamacpp_cuda_worker.ps1 d'abord."
}

if (-not $NoFirewallRule) {
    try {
        $ruleName = "VRYX llama.cpp RPC $Port"
        if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null
        }
    } catch {
        Write-Warning "Firewall rule non appliquée: $($_.Exception.Message)"
    }
}

Write-Host "[llama.cpp] starting RPC server on ${HostName}:$Port"
Write-Host "[llama.cpp] binary $($rpcServer.FullName)"
& $rpcServer.FullName --host $HostName --port $Port

