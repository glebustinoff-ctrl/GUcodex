"""CPU Demucs separator. All model files retain upstream checksum verification."""
import argparse
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault('TORCH_HOME', str(ROOT / '.models'))
os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('MKL_NUM_THREADS', '2')

parser = argparse.ArgumentParser()
parser.add_argument('--prepare', action='store_true')
parser.add_argument('input', nargs='?')
parser.add_argument('output', nargs='?')
args = parser.parse_args()

import torch
from demucs.pretrained import get_model
torch.set_num_threads(2)

# Check the trusted upstream checksum even on a previously downloaded cache file.
checkpoint = Path(os.environ['TORCH_HOME']) / 'hub/checkpoints/955717e8-8726e21a.th'
if checkpoint.exists():
    with checkpoint.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if not digest.startswith('8726e21a'):
        raise RuntimeError('HTDemucs checkpoint checksum mismatch. Replace it from the official source.')

if args.prepare:
    model = get_model('htdemucs')  # Upstream downloader also uses check_hash=True.
    ready = ROOT / '.models/ready.json'
    ready.parent.mkdir(parents=True, exist_ok=True)
    ready.write_text(json.dumps({'model': 'htdemucs', 'checksum': '8726e21a'}))
    print('HTDemucs ready; official model checksum verified.')
else:
    if not args.input or not args.output:
        parser.error('input and output are required')
    from demucs.separate import main
    main(['-n', 'htdemucs', '-d', 'cpu', '--two-stems', 'vocals', '--shifts', '0',
          '--segment', '7', '-j', '1', '--filename', '{stem}.{ext}', '-o', args.output, args.input])
