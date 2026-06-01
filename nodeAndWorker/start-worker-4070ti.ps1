param(
    [switch]$PythonOnly,
    [switch]$DaemonOnly,
    [switch]$Detached
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$ModelId = "meta-llama/Meta-Llama-3-70B-Instruct"
$GrpcPort = "50054"
$ApiPort = "3034"
$P2pPort = "4024"
$BootstrapNode = "/ip4/51.222.26.225/tcp/4001/p2p/12D3KooWLMT5gnTuCNkVewEhX8wcQ3spGFauT6XtcaBCs5N8n9Zz"
$ApiUrl = "https://vryx.eu"

function Quote-WindowsArg {
    param([Parameter(Mandatory = $true)][string]$Value)
    '"' + ($Value -replace '"', '\"') + '"'
}

function Start-VryxDetachedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$CommandLine,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )
    if (-not ("VryxDetachedLauncher" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class VryxDetachedLauncher {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO {
    public UInt32 cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public UInt32 dwX; public UInt32 dwY; public UInt32 dwXSize; public UInt32 dwYSize;
    public UInt32 dwXCountChars; public UInt32 dwYCountChars; public UInt32 dwFillAttribute;
    public UInt32 dwFlags; public UInt16 wShowWindow; public UInt16 cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess; public IntPtr hThread; public UInt32 dwProcessId; public UInt32 dwThreadId;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CreateProcessW(
    string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes,
    IntPtr lpThreadAttributes, bool bInheritHandles, UInt32 dwCreationFlags,
    IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo,
    out PROCESS_INFORMATION lpProcessInformation);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr hObject);
  public static UInt32 Launch(string commandLine, string cwd) {
    STARTUPINFO si = new STARTUPINFO();
    si.cb = (UInt32)Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    UInt32 flags = 0x01000000 | 0x00000010 | 0x00000200; // BREAKAWAY_FROM_JOB | NEW_CONSOLE | NEW_PROCESS_GROUP
    bool ok = CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, cwd, ref si, out pi);
    if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return pi.dwProcessId;
  }
}
"@
    }
    [VryxDetachedLauncher]::Launch($CommandLine, $WorkingDirectory)
}

if ($Detached) {
    New-Item -ItemType Directory -Force -Path "$Root\logs" | Out-Null
    $args = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", (Quote-WindowsArg $PSCommandPath)
    )
    if ($PythonOnly) { $args += "-PythonOnly" }
    if ($DaemonOnly) { $args += "-DaemonOnly" }
    $childPid = Start-VryxDetachedProcess -CommandLine ("powershell.exe " + ($args -join " ")) -WorkingDirectory $Root
    "[$(Get-Date -Format o)] Detached launch pid=$childPid PythonOnly=$PythonOnly DaemonOnly=$DaemonOnly" |
        Out-File -FilePath "$Root\logs\4070-worker-launch.log" -Append -Encoding utf8
    Write-Host "Detached VRYX 4070 Ti worker started pid=$childPid"
    exit 0
}

$env:PYTHONUNBUFFERED = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:VRYX_API_URL = $ApiUrl
$env:VRYX_GRPC_PORT = $GrpcPort
$env:VRYX_WORKER_MODEL = $ModelId
$env:VRYX_DIST_MODEL = $ModelId
$env:VRYX_WORKER_SHARD_ONLY = "1"
$env:VRYX_CUDA_DIRECT = "0"
$env:VRYX_CUDA_DRAFT_MODEL = ""
$env:VRYX_CUDA_PREWARM = "0"
$env:VRYX_RUNTIME_BACKEND = if ($env:VRYX_RUNTIME_BACKEND) { $env:VRYX_RUNTIME_BACKEND } else { "llama_cpp_cuda" }
$env:VRYX_WORKER_DEVICE = "cuda"
$env:VRYX_WEIGHT_QUANTIZATION = "q4"
$env:VRYX_SUPPORTS_Q4_WEIGHTS = "1"
$env:VRYX_SUPPORTS_VLLM = "0"
$env:VRYX_WORKER_MEMORY_LIMIT_GB = "11"
$env:VRYX_WORKER_MEMORY_LIMIT_PERCENT = "82"
$env:VRYX_WORKER_ROLES = "shard_worker,llama_cpp_cuda_q4,experimental_cuda_proof"
$env:VRYX_WORKER_VERSION = "4070ti-llamacpp-cuda-q4-worker"
$env:VRYX_FORCE_ALL_WORKERS_SHARD = "1"
$env:VRYX_EXPERIMENTAL_MULTI_BACKEND_SHARD = "1"
$env:VRYX_DISABLE_PYTORCH_FALLBACK = "1"
$env:VRYX_CHAIN_STREAM = "1"
$env:VRYX_CHAIN_RESULT_DIRECT = "1"
$env:VRYX_PIPELINE_STREAM = "1"
$env:VRYX_HIDDEN_TRANSPORT = "fp16"
$env:PATH = "$env:USERPROFILE\.cargo\bin;C:\TDM-GCC-64\bin;C:\ProgramData\chocolatey\bin;$env:PATH"

New-Item -ItemType Directory -Force -Path "$Root\logs", "$Root\.vryx-keys-4070" | Out-Null
if (-not $env:VRYX_WORKER_SECRET) {
    "[WARN] VRYX_WORKER_SECRET is not set; heartbeat registration will be rejected by production VPS." |
        Out-File -FilePath "$Root\logs\4070-worker-launch.log" -Append -Encoding utf8
}
"[$(Get-Date -Format o)] Launch request PythonOnly=$PythonOnly DaemonOnly=$DaemonOnly" |
    Out-File -FilePath "$Root\logs\4070-worker-launch.log" -Append -Encoding utf8

if (-not $DaemonOnly) {
    Start-Process -FilePath "$Root\venv\Scripts\python.exe" `
        -ArgumentList @("python-inference\inference_server.py", "--port", $GrpcPort, "--stage", "2", "--model", $ModelId, "--device", "cuda") `
        -WorkingDirectory $Root `
        -RedirectStandardOutput "$Root\logs\4070-inference.out.log" `
        -RedirectStandardError "$Root\logs\4070-inference.err.log" `
        -WindowStyle Hidden
}

if (-not $PythonOnly) {
    Start-Sleep -Seconds 4
    Start-Process -FilePath "$Root\target\release\rust-daemon.exe" `
        -ArgumentList @("--mode", "worker", "--grpc-port", $GrpcPort, "--p2p-port", $P2pPort, "--api-port", $ApiPort, "--bootstrap-node", $BootstrapNode, "--api-url", $ApiUrl, "--model", $ModelId, "--node-key-file", ".vryx-keys-4070\worker.node.key") `
        -WorkingDirectory $Root `
        -RedirectStandardOutput "$Root\logs\4070-daemon.out.log" `
        -RedirectStandardError "$Root\logs\4070-daemon.err.log" `
        -WindowStyle Hidden
}
