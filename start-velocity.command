#!/bin/bash
# VELOCITY DePIN - BULLETPROOF START (macOS)

# 1. Absolute Pathing Setup
BASEDIR=$(cd "$(dirname "$0")" && pwd)
echo "========================================"
echo "   VELOCITY DePIN - BULLETPROOF START"
echo "   Base Directory: $BASEDIR"
echo "========================================"

# 2. Aggressive Cleanup
echo "[*] Cleaning up zombie processes..."
lsof -ti:3030,50051,50052,4001,4002,4003 | xargs kill -9 2>/dev/null
pkill -f "inference_server.py" 2>/dev/null
pkill "rust-daemon" 2>/dev/null

# 3. Role Selection
echo ""
echo "Select Node Role:"
echo "1) Initiator (Chat UI, Stage 1)"
echo "2) Worker (Compute Node, Stage 2)"
read -p "Enter choice (1 or 2): " role_choice

if [ "$role_choice" == "2" ]; then
    export VELOCITY_ROLE="worker"
    export VITE_VELOCITY_ROLE="worker"
    export PY_STAGE=2
    export RUST_MODE="worker"
    export P2P_PORT=4003
else
    export VELOCITY_ROLE="initiator"
    export VITE_VELOCITY_ROLE="initiator"
    export PY_STAGE=1
    export RUST_MODE="initiator"
    export P2P_PORT=4002
fi

echo "[*] Running as $VELOCITY_ROLE..."

# 4. Process Lifecycle Management
trap "kill 0" EXIT

# 5. Python Environment Fix
echo "[*] Configuring Python Inference Engine..."
cd "$BASEDIR/nodeAndWorker/python-inference"
if [ ! -f "venv/bin/activate" ]; then
    echo "[!] venv/bin/activate not found. Creating fresh virtual environment..."
    python3 -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt
else
    source venv/bin/activate
fi
echo "[*] Starting Python Server (Stage $PY_STAGE)..."
python3 inference_server.py --port 50051 --stage $PY_STAGE &
PYTHON_PID=$!

# 6. Rust P2P Daemon Fix
echo "[*] Configuring Velocity Rust Daemon ($RUST_MODE)..."
cd "$BASEDIR/nodeAndWorker/rust-daemon"
BOOTSTRAP="/ip4/51.222.26.225/tcp/4001/p2p/12D3KooWLMT5gnTuCNkVewEhX8wcQ3spGFauT6XtcaBCs5N8n9Zz"
if [ -f "../target/release/rust-daemon" ]; then
    ../target/release/rust-daemon --grpc-port 50051 --mode $RUST_MODE --p2p-port $P2P_PORT --bootstrap-node $BOOTSTRAP &
else
    cargo run --release -- --grpc-port 50051 --mode $RUST_MODE --p2p-port $P2P_PORT --bootstrap-node $BOOTSTRAP &
fi
DAEMON_PID=$!

# 7. Repairing and starting Velocity UI
echo "[*] Starting Velocity UI..."
cd "$BASEDIR/AppMacos"
if [ ! -d "node_modules" ]; then
    npm install
fi
# Pass the Vite env var explicitly
export VITE_VELOCITY_ROLE=$VITE_VELOCITY_ROLE
npm run electron:dev

echo "[!] Velocity is shutting down..."
kill $PYTHON_PID $DAEMON_PID 2>/dev/null
