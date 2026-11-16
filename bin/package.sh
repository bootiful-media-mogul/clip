#!/usr/bin/env bash
# builds the extension for the chrome web store. the popup talks to whichever single host
# the manifest grants access to; the repo's manifest.json grants the local stack, and
# this build swaps in production (or MOGUL_SERVER, if set).
#
#   bin/package.sh [output-directory]    (default: ./dist)
#
# writes, in the output directory:
#   mogul-clip-<version>.zip    the file to upload to the store
#   mogul-clip-<version>/       the same thing unzipped, to "load unpacked" and try first
set -euo pipefail

server="${MOGUL_SERVER:-https://studio.mogul.tools}"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mkdir -p "${1:-$root/dist}" && cd "${1:-$root/dist}" && pwd)"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$root/manifest.json")"
build="$out/mogul-clip-$version"
zip="$build.zip"

rm -rf "$build" "$zip"
mkdir -p "$build/icons" "$build/fonts"
cp "$root"/popup.html "$root"/popup.css "$root"/popup.js "$build"/
cp "$root"/icons/*.png "$build/icons/"
cp "$root"/fonts/* "$build/fonts/"

python3 - "$root/manifest.json" "$build/manifest.json" "$server" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
manifest["host_permissions"] = [sys.argv[3].rstrip("/") + "/*"]
json.dump(manifest, open(sys.argv[2], "w"), indent=2)
PY

(cd "$build" && zip -qrX "$zip" .)
echo "$zip"
echo "$build"
