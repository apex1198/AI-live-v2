#!/usr/bin/env python3
"""Download and verify the S3FD face detector before avatar training starts."""

import argparse
import hashlib
import os
from pathlib import Path

from torch.hub import download_url_to_file


S3FD_URL = "https://www.adrianbulat.com/downloads/python-fan/s3fd-619a316812.pth"
S3FD_SHA256 = "619a31681264d3f7f7fc7a16a42cbbe8b23f31a256f75a366e5a1bcd59b33543"
S3FD_SIZE = 89_843_225


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_ready(path: Path) -> bool:
    return path.is_file() and path.stat().st_size == S3FD_SIZE and sha256(path) == S3FD_SHA256


def prefetch(target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if is_ready(target):
        print(f"S3FD face detector ready: {target}")
        return

    partial = target.with_suffix(target.suffix + ".download")
    partial.unlink(missing_ok=True)
    try:
        download_url_to_file(S3FD_URL, str(partial), hash_prefix=S3FD_SHA256, progress=True)
        if not is_ready(partial):
            raise RuntimeError("Downloaded S3FD file failed size or checksum validation")
        os.replace(partial, target)
    finally:
        partial.unlink(missing_ok=True)

    print(f"S3FD face detector downloaded: {target}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True, type=Path)
    args = parser.parse_args()
    prefetch(args.target.expanduser().resolve())


if __name__ == "__main__":
    main()
