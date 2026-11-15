#!/usr/bin/env bash
# the extension wears the studio's icon. regenerate after the studio's icon changes.
set -euo pipefail
cd "$(dirname "$0")"
source_icon=../../client/public/android-icon-192x192.png
for size in 16 32 48 128; do
  sips -z "$size" "$size" "$source_icon" --out "icon-$size.png" >/dev/null
done
