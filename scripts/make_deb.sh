#!/bin/sh
# Builds the Debian/Ubuntu packages (.deb) for amd64 and arm64, through WSL Ubuntu. Run from Windows:
#   wsl -u root -- sh '/mnt/d/GoogleReviewWebsite/UMA LLM Project'/scripts/make_deb.sh /mnt/c/Users/<you>/AppData/Local/electron/Cache/<hash>
# The argument is the folder holding electron-v<version>-linux-{x64,arm64}.zip (download them with
# @electron/get). Reuses release/win-unpacked/resources/app.asar, so run the Windows build first,
# and the icons in build/linux-icons (made from build/icon.png).
#
# Layout, as electron-builder makes it: the app in /opt/uma-llm, a uma-llm command in /usr/bin,
# a menu entry and icons in /usr/share. postinst makes chrome-sandbox setuid root and installs an
# AppArmor profile where AppArmor would otherwise block Chromium's sandbox (Ubuntu 23.10 and later).
set -eu
cache=${1:?pass the folder with the Electron Linux zips}
here=$(cd "$(dirname "$0")" && pwd)
project="$here/.."
release="$project/release"
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$project/package.json")
electron=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$project/node_modules/electron/package.json")
work=/tmp/uma-deb

for arch in x64 arm64; do
  case $arch in x64) debarch=amd64 ;; arm64) debarch=arm64 ;; esac
  zip="$cache/electron-v$electron-linux-$arch.zip"
  [ -f "$zip" ] || { echo "missing $zip"; exit 1; }
  rm -rf "$work" && mkdir -p "$work/root/opt/uma-llm" "$work/root/DEBIAN"
  root="$work/root"

  unzip -q "$zip" -d "$root/opt/uma-llm"
  mv "$root/opt/uma-llm/electron" "$root/opt/uma-llm/uma-llm"
  rm -f "$root/opt/uma-llm/resources/default_app.asar"
  cp "$release/win-unpacked/resources/app.asar" "$root/opt/uma-llm/resources/app.asar"
  # The skill library, when it has been built (scripts/make_skill_library.cjs).
  if [ -f "$release/../build/skill-library.asar" ]; then cp "$release/../build/skill-library.asar" "$root/opt/uma-llm/resources/skill-library.asar"; fi

  cat > "$root/opt/uma-llm/resources/apparmor-profile" <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile uma-llm /opt/uma-llm/uma-llm flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/uma-llm>
}
EOF

  mkdir -p "$root/usr/bin" "$root/usr/share/applications" "$root/usr/share/doc/uma-llm"
  ln -s /opt/uma-llm/uma-llm "$root/usr/bin/uma-llm"
  cat > "$root/usr/share/applications/uma-llm.desktop" <<'EOF'
[Desktop Entry]
Name=Uma LLM
GenericName=Local AI assistant
Comment=A private AI assistant that runs local models on your own PC
Exec=/opt/uma-llm/uma-llm %U
Icon=uma-llm
Terminal=false
Type=Application
Categories=Development;Utility;
StartupWMClass=Uma LLM
EOF
  for size in 16 24 32 48 64 128 256 512; do
    mkdir -p "$root/usr/share/icons/hicolor/${size}x${size}/apps"
    cp "$project/build/linux-icons/$size.png" "$root/usr/share/icons/hicolor/${size}x${size}/apps/uma-llm.png"
  done
  cp "$root/opt/uma-llm/LICENSE" "$root/usr/share/doc/uma-llm/copyright"

  # Normal permissions everywhere, executables kept; chrome-sandbox gets its setuid bit in postinst.
  find "$root" -type d -exec chmod 755 {} +
  find "$root" -type f -exec chmod go-w,a+r {} +

  size=$(du -sk --exclude=DEBIAN "$root" | cut -f1)
  cat > "$root/DEBIAN/control" <<EOF
Package: uma-llm
Version: $version
Architecture: $debarch
Maintainer: Ocorex
Installed-Size: $size
Depends: libgtk-3-0t64 | libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0t64 | libatspi2.0-0, libuuid1, libsecret-1-0, libgbm1, libasound2t64 | libasound2, libdrm2, libxkbcommon0
Recommends: libvulkan1, pciutils
Section: utils
Priority: optional
Description: Private AI assistant that runs local models on your own PC
 Uma LLM by Ocorex, with Genesys Labs. Chats with and works on your files using
 llama.cpp models that run entirely on this computer, on the GPU (Vulkan or
 CUDA) or the CPU. It can also pool the GPUs of other PCs on your network.
EOF

  cat > "$root/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
# Chromium's sandbox helper must be setuid root where unprivileged user namespaces are not allowed.
chown root:root /opt/uma-llm/chrome-sandbox || true
chmod 4755 /opt/uma-llm/chrome-sandbox || true

# Ubuntu 23.10 and later only allow user namespaces to apps with an AppArmor profile. Older
# AppArmor (Debian 12) cannot read this profile and does not need it, so it is skipped there.
if command -v apparmor_parser >/dev/null 2>&1 && [ -d /etc/apparmor.d ]; then
  if apparmor_parser --skip-kernel-load --debug /opt/uma-llm/resources/apparmor-profile >/dev/null 2>&1; then
    cp -f /opt/uma-llm/resources/apparmor-profile /etc/apparmor.d/uma-llm
    if ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }; then
      apparmor_parser --replace --write-cache --skip-read-cache /etc/apparmor.d/uma-llm || true
    fi
  fi
fi

if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true; fi
EOF

  cat > "$root/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = remove ] || [ "$1" = purge ]; then
  if [ -f /etc/apparmor.d/uma-llm ]; then
    if command -v apparmor_parser >/dev/null 2>&1; then apparmor_parser -R /etc/apparmor.d/uma-llm 2>/dev/null || true; fi
    rm -f /etc/apparmor.d/uma-llm
  fi
fi
EOF
  chmod 755 "$root/DEBIAN/postinst" "$root/DEBIAN/postrm"

  out="$release/uma-llm_${version}_${debarch}.deb"
  dpkg-deb --root-owner-group -Zxz --build "$root" "$out" >/dev/null
  echo "wrote $out ($(du -m "$out" | cut -f1) MB)"
  dpkg-deb --info "$out" | sed -n 's/^ \(Package\|Version\|Architecture\|Installed-Size\): /  \1: /p'
done
rm -rf "$work"
