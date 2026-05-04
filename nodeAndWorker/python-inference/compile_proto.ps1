# Compile Protobuf for Python
python -m grpc_tools.protoc -I../proto --python_out=. --grpc_python_out=. ../proto/vryx.proto
Write-Host "Protobuf compiled successfully for Python."
