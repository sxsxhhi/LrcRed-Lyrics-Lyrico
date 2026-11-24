# -*- coding: utf-8 -*-
"""Package, verify and optionally publish the Lyrico plugin.

Layout
------
    Lyrico/
      AGENTS.md                                   project spec
      LrcRed-Lyrics-<version>-Lyrico-Plugin.zip   published artifact
      LrcRed-Lyrics/                              working directory (this file)

Usage
-----
    python build.py              package into dist/ and verify
    python build.py --publish    run the tests first, then copy the zip to the
                                 Lyrico root and drop older release zips there

The plugin zip must carry exactly three members at its root, because the
Lyrico installer reads manifest.json / source.js / icon.png from the archive
root. Entry timestamps are pinned so repeated builds are byte-stable.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "src")
DIST = os.path.join(ROOT, "dist")
TESTS = os.path.join(ROOT, "tests", "cases.js")
BASELINE_ICON = os.path.join(ROOT, "tests", "baseline-0.1.1", "icon.png")
PUBLISH_DIR = os.path.dirname(ROOT)

MEMBERS = ["manifest.json", "source.js", "icon.png"]
FIXED_TIME = (2026, 11, 22, 0, 0, 0)
ZIP_PREFIX = "LrcRed-Lyrics-"
ZIP_SUFFIX = "-Lyrico-Plugin.zip"


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def read_manifest():
    with open(os.path.join(SRC, "manifest.json"), "r", encoding="utf-8") as fh:
        return json.load(fh)


def check_syntax():
    res = subprocess.run(["node", "--check", os.path.join(SRC, "source.js")],
                         capture_output=True, text=True)
    if res.returncode != 0:
        print("SYNTAX FAIL:\n" + res.stderr)
        return False
    return True


def run_tests():
    print("running tests ...")
    res = subprocess.run(["node", TESTS], cwd=ROOT)
    if res.returncode != 0:
        print("TESTS FAIL: publish aborted")
        return False
    return True


def package(out_path):
    os.makedirs(DIST, exist_ok=True)
    if os.path.exists(out_path):
        os.remove(out_path)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in MEMBERS:
            info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(os.path.join(SRC, name), "rb") as fh:
                zf.writestr(info, fh.read())
    return True


def verify(out_path):
    with zipfile.ZipFile(out_path) as zf:
        bad = zf.testzip()
        if bad is not None:
            print("CRC FAIL at " + bad)
            return False
        names = zf.namelist()
        if names != MEMBERS:
            print("STRUCTURE FAIL: " + repr(names))
            return False
        for n in names:
            if "/" in n or "\\" in n:
                print("NESTED PATH FAIL: " + n)
                return False
            if len(zf.read(n)) == 0:
                print("EMPTY MEMBER: " + n)
                return False

    if os.path.isfile(BASELINE_ICON):
        if sha256(os.path.join(SRC, "icon.png")) != sha256(BASELINE_ICON):
            print("WARNING: icon.png differs from the 0.1.1 baseline")
    return True


def publish(zip_path):
    target = os.path.join(PUBLISH_DIR, os.path.basename(zip_path))
    shutil.copyfile(zip_path, target)
    if sha256(zip_path) != sha256(target):
        print("PUBLISH FAIL: sha256 mismatch after copy")
        return False
    removed = []
    for name in sorted(os.listdir(PUBLISH_DIR)):
        if not name.startswith(ZIP_PREFIX) or not name.endswith(ZIP_SUFFIX):
            continue
        if name == os.path.basename(target):
            continue
        try:
            os.remove(os.path.join(PUBLISH_DIR, name))
            removed.append(name)
        except OSError as exc:
            print("WARNING: could not remove %s (%s)" % (name, exc))
    print("\npublished -> %s" % target)
    for name in removed:
        print("removed stale -> %s" % name)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--publish", action="store_true",
                    help="run tests, then copy the zip to the Lyrico root")
    args = ap.parse_args()

    if not check_syntax():
        return 1

    manifest = read_manifest()
    version = str(manifest.get("versionName") or "").strip()
    code = str(manifest.get("versionCode") or "").strip()
    if not version or not code:
        print("VERSION FAIL: manifest.versionName / versionCode missing")
        return 1

    out_name = ZIP_PREFIX + version + ZIP_SUFFIX
    out_path = os.path.join(DIST, out_name)

    if not package(out_path) or not verify(out_path):
        return 1

    print("version: %s (versionCode %s)" % (version, code))
    print("members: " + ", ".join(MEMBERS))
    for name in MEMBERS:
        print("  %-14s %7d bytes  sha256=%s" % (
            name, os.path.getsize(os.path.join(SRC, name)),
            sha256(os.path.join(SRC, name))))
    print("\nzip: dist/%s  %d bytes\nsha256=%s" % (
        out_name, os.path.getsize(out_path), sha256(out_path)))

    if not args.publish:
        print("\n(dry run; add --publish to copy it to the Lyrico root)")
        return 0

    if not run_tests():
        return 1
    return 0 if publish(out_path) else 1


if __name__ == "__main__":
    sys.exit(main())
