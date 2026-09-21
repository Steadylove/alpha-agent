"""Verify the adopted range method before generating new research records."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
METHOD_PATH = Path('research/options/range-method-v1.json')


def verify_method(root=ROOT):
    root = Path(root)
    method = json.loads((root / METHOD_PATH).read_text())
    for label, artifact in method['locked_artifacts'].items():
        path = root / artifact['path']
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != artifact['sha256']:
            raise ValueError(
                f"Frozen range method mismatch: {label}. "
                "Keep v1 unchanged and create a new method version for algorithm or parameter changes."
            )
    return {**method, 'verification': 'passed',
            'method_file_sha256': hashlib.sha256((root / METHOD_PATH).read_bytes()).hexdigest()}
