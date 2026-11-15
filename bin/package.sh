#!/usr/bin/env bash
# builds the zip to upload to the chrome web store: production only (no 127.0.0.1 in the
# manifest, so the popup shows no server picker), and only the files the extension uses.
#
#   bin/package.sh [output-directory]    (default: ./dist)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mkdir -p "${1:-$root/dist}" && cd "${1:-$root/dist}" && pwd)"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$root/manifest.json")"
zip="$out/mogul-clip-$version.zip"

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

cp "$root"/popup.html "$root"/popup.css "$root"/popup.js "$staging"/
mkdir -p "$staging/icons" "$staging/fonts"
cp "$root"/icons/*.png "$staging/icons/"
cp "$root"/fonts/* "$staging/fonts/"

python3 - "$root/manifest.json" "$staging/manifest.json" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
manifest["host_permissions"] = [h for h in manifest["host_permissions"] if "127.0.0.1" not in h and "localhost" not in h]
json.dump(manifest, open(sys.argv[2], "w"), indent=2)
PY

rm -f "$zip"
(cd "$staging" && zip -qrX "$zip" .)
echo "$zip"
