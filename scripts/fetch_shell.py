#!/usr/bin/env python3
"""Ajoute bash et git (paquets officiels Termux) au moteur, comme outil « shell ».

1. télécharge les clés Termux depuis le dépôt GitHub termux/termux-packages ;
2. vérifie la signature de ``InRelease`` du dépôt termux-main ;
3. vérifie l'index ``Packages`` contre les empreintes signées ;
4. résout les dépendances de bash et git, télécharge chaque .deb et vérifie son SHA-256 ;
5. extrait tout dans ``<payload>/tools/shell/data/data/com.termux/files/usr``.

relocate_payload.py traite ensuite cet outil comme les autres (PATH, bibliothèques,
réécriture des chemins Termux dans les fichiers texte).

Usage : fetch_shell.py --payload-root build/deb/root/data/data/com.termux/files/usr/lib/hermes-agent
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

REPO = "https://packages-cf.termux.dev/apt/termux-main"
DIST = "stable"
ARCH = "aarch64"
KEYS_API = "https://api.github.com/repos/termux/termux-packages/contents/packages/termux-keyring"
KEYS_RAW = "https://raw.githubusercontent.com/termux/termux-packages/master/packages/termux-keyring/"
WANT = ["bash", "git"]
# Fournis par le moteur Hermes ou par Android, ou inutiles ici.
SKIP = {"termux-tools", "termux-am", "termux-exec", "termux-keyring", "termux-licenses",
        "dash", "coreutils", "busybox", "perl", "openssh", "resolv-conf", "ca-certificates",
        "command-not-found", "apt", "dpkg", "libc++"}
NESTED = "data/data/com.termux/files/usr"


def log(msg: str) -> None:
    print(f"[fetch_shell] {msg}", flush=True)


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "hermes-android-build"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                raise
            log(f"nouvel essai {url} ({e})")
    raise RuntimeError("inaccessible")


def keyring(tmp: Path) -> Path:
    import json
    names = [x["name"] for x in json.loads(fetch(KEYS_API)) if x["name"].endswith(".gpg")]
    if not names:
        raise SystemExit("aucune clé Termux trouvée")
    home = tmp / "gnupg"
    home.mkdir(mode=0o700)
    ring = tmp / "termux.kbx"
    for n in names:
        k = tmp / n
        k.write_bytes(fetch(KEYS_RAW + n))
        subprocess.run(["gpg", "--batch", "--quiet", "--homedir", str(home), "--no-default-keyring",
                        "--keyring", str(ring), "--import", str(k)], check=True)
    log(f"{len(names)} clés Termux importées")
    return ring


def verified_release(tmp: Path, ring: Path) -> str:
    inrel = tmp / "InRelease"
    inrel.write_bytes(fetch(f"{REPO}/dists/{DIST}/InRelease"))
    out = tmp / "Release"
    if shutil.which("gpgv"):
        subprocess.run(["gpgv", "--keyring", str(ring), "--output", str(out), str(inrel)], check=True)
    else:
        r = subprocess.run(["gpg", "--batch", "--homedir", str(tmp / "gnupg"), "--no-default-keyring",
                            "--keyring", str(ring), "--status-fd", "1", "--output", str(out), "--decrypt", str(inrel)],
                           capture_output=True, text=True)
        if r.returncode != 0 or "[GNUPG:] VALIDSIG" not in r.stdout:
            raise SystemExit("signature InRelease invalide")
    log("signature InRelease OK")
    return out.read_text(encoding="utf8")


def packages_index(release: str) -> str:
    rel = f"main/binary-{ARCH}/Packages.gz"
    m = re.search(r"^SHA256:\n((?: .*\n)+)", release, re.M)
    if not m:
        raise SystemExit("pas de section SHA256 dans Release")
    want = None
    for line in m.group(1).splitlines():
        h, size, name = line.split()
        if name == rel:
            want = (h, int(size))
    if not want:
        raise SystemExit(f"{rel} absent de Release")
    data = fetch(f"{REPO}/dists/{DIST}/{rel}")
    if hashlib.sha256(data).hexdigest() != want[0] or len(data) != want[1]:
        raise SystemExit("index Packages non conforme à Release")
    log("index Packages OK")
    return gzip.decompress(data).decode("utf8")


def parse(text: str) -> dict[str, dict[str, str]]:
    pkgs: dict[str, dict[str, str]] = {}
    for block in text.split("\n\n"):
        f: dict[str, str] = {}
        key = None
        for line in block.splitlines():
            if line.startswith(" ") and key:
                f[key] += "\n" + line
            elif ":" in line:
                key, _, v = line.partition(":")
                f[key] = v.strip()
        if "Package" in f:
            pkgs[f["Package"]] = f  # le dernier gagne (aptly ne publie qu'une version)
    return pkgs


def deps(field: str) -> list[str]:
    out = []
    for part in field.split(","):
        alt = part.split("|")[0].strip()
        name = re.sub(r"\s*\(.*\)", "", alt).strip()
        if name:
            out.append(name)
    return out


def closure(pkgs: dict[str, dict[str, str]]) -> list[str]:
    seen: list[str] = []
    todo = list(WANT)
    while todo:
        n = todo.pop(0)
        if n in seen or n in SKIP:
            continue
        if n not in pkgs:
            raise SystemExit(f"paquet introuvable : {n}")
        seen.append(n)
        for field in ("Depends", "Pre-Depends"):
            todo.extend(deps(pkgs[n].get(field, "")))
    return seen


def extract_deb(data: bytes, dest: Path) -> int:
    # Format ar : en-tête global puis membres de 60 octets.
    if data[:8] != b"!<arch>\n":
        raise SystemExit("deb invalide")
    pos, count = 8, 0
    while pos < len(data):
        hdr = data[pos:pos + 60]
        name = hdr[:16].decode().strip().rstrip("/")
        size = int(hdr[48:58].decode().strip())
        body = data[pos + 60:pos + 60 + size]
        pos += 60 + size + (size & 1)
        if name.startswith("data.tar"):
            if name.endswith(".xz"):
                import lzma
                raw = lzma.decompress(body)
            elif name.endswith(".gz"):
                raw = gzip.decompress(body)
            elif name.endswith(".zst"):
                raw = subprocess.run(["zstd", "-dc"], input=body, capture_output=True, check=True).stdout
            else:
                raw = body
            with tarfile.open(fileobj=io.BytesIO(raw)) as tf:
                for m in tf.getmembers():
                    p = Path(m.name.lstrip("./"))
                    if ".." in p.parts:
                        raise SystemExit(f"chemin suspect : {m.name}")
                    count += 1
                tf.extractall(dest, filter="tar") if sys.version_info >= (3, 12) else tf.extractall(dest)
    return count


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--payload-root", required=True)
    a = ap.parse_args()
    root = Path(a.payload_root)
    if not root.is_dir():
        raise SystemExit(f"moteur absent : {root}")
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        ring = keyring(tmp)
        pkgs = parse(packages_index(verified_release(tmp, ring)))
        names = closure(pkgs)
        log("paquets : " + ", ".join(f"{n} {pkgs[n]['Version']}" for n in names))
        stage = tmp / "stage"
        stage.mkdir()
        for n in names:
            f = pkgs[n]
            data = fetch(f"{REPO}/{f['Filename']}")
            if hashlib.sha256(data).hexdigest() != f["SHA256"]:
                raise SystemExit(f"SHA-256 incorrect pour {n}")
            extract_deb(data, stage)
        src = stage / NESTED
        if not (src / "bin/bash").is_file() or not (src / "bin/git").is_file():
            raise SystemExit("bash ou git manquant après extraction")
        # Allège : documentation, pages de manuel, locales, en-têtes.
        for junk in ("share/doc", "share/man", "share/info", "share/locale", "include", "share/bash-completion"):
            shutil.rmtree(src / junk, ignore_errors=True)
        dest = root / "tools" / "shell" / NESTED
        if dest.exists():
            shutil.rmtree(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dest))
        total = sum(p.stat().st_size for p in dest.rglob("*") if p.is_file() and not p.is_symlink())
        log(f"outil shell installé : {dest} ({total // 1_000_000} Mo)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
