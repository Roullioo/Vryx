param(
    [string]$Version = "b9415",
    [string]$Cuda = "12.4",
    [string]$InstallDir = "$env:USERPROFILE\vryx-tools\llama.cpp-b9415-cuda12.4"
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$baseUrl = "https://github.com/ggml-org/llama.cpp/releases/download/$Version"
$archives = @(
    "llama-$Version-bin-win-cuda-$Cuda-x64.zip",
    "cudart-llama-bin-win-cuda-$Cuda-x64.zip"
)

foreach ($archive in $archives) {
    $url = "$baseUrl/$archive"
    $target = Join-Path $InstallDir $archive
    if (-not (Test-Path $target)) {
        Write-Host "[llama.cpp] downloading $url"
        Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing
    } else {
        Write-Host "[llama.cpp] cache hit $target"
    }
    Expand-Archive -Path $target -DestinationPath $InstallDir -Force
}

$rpcServer = Get-ChildItem -Path $InstallDir -Recurse -Filter "rpc-server.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
$llamaBench = Get-ChildItem -Path $InstallDir -Recurse -Filter "llama-bench.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
$llamaServer = Get-ChildItem -Path $InstallDir -Recurse -Filter "llama-server.exe" -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $rpcServer) {
    throw "rpc-server.exe introuvable dans $InstallDir"
}

Write-Host "[llama.cpp] installed"
Write-Host "  rpc-server: $($rpcServer.FullName)"
if ($llamaBench) { Write-Host "  llama-bench: $($llamaBench.FullName)" }
if ($llamaServer) { Write-Host "  llama-server: $($llamaServer.FullName)" }

