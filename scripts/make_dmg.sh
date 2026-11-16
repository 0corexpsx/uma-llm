#!/bin/sh
# Builds the Mac disk images (.dmg) on Windows, through WSL Ubuntu. Run from Windows:
#   wsl -u root -- sh '/mnt/d/GoogleReviewWebsite/UMA LLM Project'/scripts/make_dmg.sh
# Needs: apt-get install xorriso unzip python3 (dmg2img is only used to check the result).
#
# Each image holds "Uma LLM.app", an Applications shortcut to drag it onto, and the readme.
# The filesystem is ISO 9660 with Rock Ridge, which keeps the app's symlinks and executable bits
# (Linux cannot write HFS+ without extra tools). make_dmg.py then compresses it into a UDZO .dmg.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
release="$here/../release"
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$here/../package.json")
work=/tmp/uma-dmg

for arch in arm64 x64; do
  zip="$release/Uma-LLM-$version-mac-$arch.zip"
  [ -f "$zip" ] || { echo "missing $zip (run scripts/make_mac.py first)"; exit 1; }
  rm -rf "$work" && mkdir -p "$work/stage"
  unzip -q "$zip" -d "$work/stage"
  ln -s /Applications "$work/stage/Applications"
  cp "$release/Uma-LLM-Mac-LEGGIMI.txt" "$work/stage/LEGGIMI.txt"
  cp "$release/../LICENSE.txt" "$work/stage/LICENSE.txt"
  # -R keeps the exact modes (not -r, which drops the owner's write bit; codesign needs it after copying).
  xorrisofs -quiet -D -l -R -no-pad -V "Uma LLM" -o "$work/image.iso" "$work/stage"
  python3 "$here/make_dmg.py" "$work/image.iso" "$release/Uma-LLM-$version-mac-$arch.dmg"

  # Check: unpack the .dmg with an independent tool, compare it to the image, then mount it and
  # compare every file, symlink and mode with the staged app.
  if command -v dmg2img >/dev/null; then
    dmg2img -s "$release/Uma-LLM-$version-mac-$arch.dmg" "$work/roundtrip.iso"
    cmp "$work/image.iso" "$work/roundtrip.iso"
    mkdir -p "$work/mnt"
    mount -o loop,ro "$work/roundtrip.iso" "$work/mnt"
    trap 'umount "$work/mnt" 2>/dev/null || true' EXIT
    diff -r --no-dereference "$work/stage" "$work/mnt"
    (cd "$work/stage" && find . -printf '%y %m %p %l\n' | sort) > "$work/stage.list"
    (cd "$work/mnt" && find . -printf '%y %m %p %l\n' | sort) > "$work/mnt.list"
    diff "$work/stage.list" "$work/mnt.list"
    echo "$arch: checked $(wc -l < "$work/mnt.list") entries, $(grep -c '^l' "$work/mnt.list") symlinks"
    umount "$work/mnt"
    trap - EXIT
  fi
done
rm -rf "$work"
