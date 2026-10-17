#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m venv .venv
.venv/bin/python -m pip install --cache-dir /tmp/karaoke-pip-cache 'torch==2.5.1+cpu' 'torchaudio==2.5.1+cpu' --index-url https://download.pytorch.org/whl/cpu
.venv/bin/python -m pip install --cache-dir /tmp/karaoke-pip-cache -r requirements-ai.txt
TORCH_HOME="$PWD/.models" OMP_NUM_THREADS=2 .venv/bin/python scripts/separate.py --prepare
