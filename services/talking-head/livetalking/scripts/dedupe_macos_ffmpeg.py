#!/usr/bin/env python3
"""Use one libavdevice image when PyAV and OpenCV bundle the same FFmpeg ABI."""

import os
import site
import sys
from pathlib import Path


def main() -> None:
    if sys.platform != "darwin":
        return
    roots = [Path(value) for value in site.getsitepackages()]
    for root in roots:
        av_dir = root / "av" / ".dylibs"
        cv_dir = root / "cv2" / ".dylibs"
        if not av_dir.is_dir() or not cv_dir.is_dir():
            continue
        for av_library in av_dir.glob("libavdevice.*.dylib"):
            cv_library = cv_dir / av_library.name
            if not cv_library.is_file():
                continue
            if av_library.is_symlink() and av_library.resolve() == cv_library.resolve():
                return
            backup = av_library.with_suffix(av_library.suffix + ".bundled")
            if av_library.exists() and not backup.exists():
                av_library.replace(backup)
            elif av_library.exists() or av_library.is_symlink():
                av_library.unlink()
            av_library.symlink_to(Path(os.path.relpath(cv_library, av_dir)))
            print(f"Shared macOS FFmpeg device library: {cv_library.name}")
            return


if __name__ == "__main__":
    main()
