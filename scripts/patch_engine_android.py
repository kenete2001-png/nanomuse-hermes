#!/usr/bin/env python3
"""Small, targeted fixes applied to the upstream Hermes engine for this Android build.

The official Termux payload ships CPython 3.14 built for Android, where
``sys.platform`` is ``"android"`` (PEP 738), not ``"linux"``. Upstream's skill
filter (``agent/skill_utils.py::skill_matches_platform_list``) compares
``sys.platform`` against ``linux`` / ``darwin`` / ``win32``; every bundled skill
declares ``platforms: [linux, macos, windows]``, so on the phone *all* bundled
skills were hidden (« Compétences » empty or nearly empty).

Android is a Linux kernel with a Linux userland here (Termux tools), so the patch
makes the skill filter treat ``android`` as ``linux``. Nothing else changes:
macOS-only skills (Apple Notes, iMessage, Find My, Rappels) stay hidden.

Each patch is idempotent and only warns when the upstream source moved, so a new
engine version never breaks the build because of this script.

Usage: patch_engine_android.py <payload-root>   (…/usr/lib/hermes-agent)
"""
from __future__ import annotations

import sys
from pathlib import Path

MARKER = "# HERMES_ANDROID_PATCH"

PATCHES = [
    (
        "app/agent/skill_utils.py",
        "    current = sys.platform\n",
        '    current = "linux" if sys.platform == "android" else sys.platform  ' + MARKER + "\n",
    ),
]


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    root = Path(sys.argv[1])
    if not root.is_dir():
        print(f"[patch-engine] payload root not found: {root}", file=sys.stderr)
        return 1
    for rel, old, new in PATCHES:
        path = root / rel
        if not path.is_file():
            print(f"::warning title=patch-engine::{rel} absent, patch ignorée")
            continue
        text = path.read_text(encoding="utf-8")
        if MARKER in text:
            print(f"[patch-engine] {rel}: déjà patché")
            continue
        if text.count(old) != 1:
            print(f"::warning title=patch-engine::{rel}: motif introuvable ({text.count(old)}×), patch ignorée")
            continue
        path.write_text(text.replace(old, new), encoding="utf-8")
        print(f"[patch-engine] {rel}: patché")
    return 0


if __name__ == "__main__":
    sys.exit(main())
