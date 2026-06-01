@echo off
SETLOCAL EnableDelayedExpansion

cd /d "%~dp0"

set "MODEL_ID=meta-llama/Meta-Llama-3-70B-Instruct"
set "GRPC_PORT=50054"
set "API_PORT=3034"
set "P2P_PORT=4024"
set "BOOTSTRAP_NODE=/ip4/51.222.26.225/tcp/4001/p2p/12D3KooWLMT5gnTuCNkVewEhX8wcQ3spGFauT6XtcaBCs5N8n9Zz"
set "API_URL=https://vryx.eu"

set "PYTHONUNBUFFERED=1"
set "PYTHONIOENCODING=utf-8"
set "VRYX_API_URL=%API_URL%"
set "VRYX_GRPC_PORT=%GRPC_PORT%"
set "VRYX_WORKER_MODEL=%MODEL_ID%"
set "VRYX_DIST_MODEL=%MODEL_ID%"
set "VRYX_WORKER_SHARD_ONLY=1"
set "VRYX_CUDA_DIRECT=0"
set "VRYX_CUDA_DRAFT_MODEL="
set "VRYX_CUDA_PREWARM=0"
if not defined VRYX_RUNTIME_BACKEND set "VRYX_RUNTIME_BACKEND=llama_cpp_cuda"
set "VRYX_WORKER_DEVICE=cuda"
set "VRYX_WEIGHT_QUANTIZATION=q4"
set "VRYX_SUPPORTS_Q4_WEIGHTS=1"
set "VRYX_SUPPORTS_VLLM=0"
set "VRYX_WORKER_MEMORY_LIMIT_GB=11"
set "VRYX_WORKER_MEMORY_LIMIT_PERCENT=82"
set "VRYX_WORKER_ROLES=shard_worker,llama_cpp_cuda_q4,experimental_cuda_proof"
set "VRYX_WORKER_VERSION=4070ti-llamacpp-cuda-q4-worker"
set "VRYX_FORCE_ALL_WORKERS_SHARD=1"
set "VRYX_EXPERIMENTAL_MULTI_BACKEND_SHARD=1"
set "VRYX_DISABLE_PYTORCH_FALLBACK=1"
set "VRYX_CHAIN_STREAM=1"
set "VRYX_CHAIN_RESULT_DIRECT=1"
set "VRYX_PIPELINE_STREAM=1"
set "VRYX_HIDDEN_TRANSPORT=fp16"

if not exist "logs" mkdir "logs"
if not exist ".vryx-keys-4070" mkdir ".vryx-keys-4070"

echo [%DATE% %TIME%] Starting inference server on %GRPC_PORT% > logs\4070-worker-launch.log
if not defined VRYX_WORKER_SECRET echo [%DATE% %TIME%] WARN VRYX_WORKER_SECRET is not set; heartbeat registration will fail on production VPS. >> logs\4070-worker-launch.log
start "Vryx 4070Ti inference" /B cmd /c "venv\Scripts\python.exe python-inference\inference_server.py --port %GRPC_PORT% --stage 2 --model "%MODEL_ID%" --device cuda >> logs\4070-inference.log 2>&1"

ping -n 5 127.0.0.1 >nul

echo [%DATE% %TIME%] Starting rust daemon on API %API_PORT% / P2P %P2P_PORT% >> logs\4070-worker-launch.log
set "PATH=%USERPROFILE%\.cargo\bin;C:\TDM-GCC-64\bin;C:\ProgramData\chocolatey\bin;%PATH%"
target\release\rust-daemon.exe ^
  --mode worker ^
  --grpc-port %GRPC_PORT% ^
  --p2p-port %P2P_PORT% ^
  --api-port %API_PORT% ^
  --bootstrap-node %BOOTSTRAP_NODE% ^
  --api-url %API_URL% ^
  --model "%MODEL_ID%" ^
  --node-key-file ".vryx-keys-4070\worker.node.key" ^
  >> logs\4070-daemon.log 2>&1
