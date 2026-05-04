#!/bin/bash

# Vryx DePIN macOS Setup Script
echo "========================================"
echo "   VRYX DePIN macOS SETUP"
echo "========================================"

# 1. Python Environment
echo "[*] Creating Python virtual environment..."
cd python-inference
python3 -m venv venv
source venv/bin/activate

echo "[*] Installing dependencies (this may take a while)..."
pip install --upgrade pip
pip install -r requirements.txt

# 2. Protobuf Compilation
echo "[*] Compiling Protobuf definitions..."
python3 -m grpc_tools.protoc -I../proto --python_out=. --grpc_python_out=. ../proto/vryx.proto

echo "========================================"
echo "[√] Setup complete!"
echo "To start the worker:"
echo "source venv/bin/activate && python3 inference_server.py --port 50051 --stage 1"
echo "========================================"
