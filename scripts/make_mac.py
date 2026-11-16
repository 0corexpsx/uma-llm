"""Builds the macOS app zips on any OS, from the official Electron macOS release and our app.asar.

electron-builder only builds Mac apps on a Mac, so this does what it would: renames Electron.app to
"Uma LLM.app", writes the name, version and icon into Info.plist, and puts the app in Resources.
It copies every other zip entry unchanged, keeping file modes and the framework symlinks that macOS
needs. The helper apps keep their "Electron Helper" names, which Electron looks for first.

Run after the Windows build (it reuses release/win-unpacked/resources/app.asar):
  node -e "..."  (download electron-vX-darwin-<arch>.zip with @electron/get), then
  python scripts/make_mac.py <electron-darwin-arm64.zip> <electron-darwin-x64.zip>
Writes release/Uma-LLM-<version>-mac-<arch>.zip.
"""
import copy
import json
import plistlib
import re
import sys
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
package = json.loads((root / "package.json").read_text(encoding="utf-8"))
version = package["version"]
name = package["productName"]
app_asar = (root / "release" / "win-unpacked" / "resources" / "app.asar").read_bytes()
icon = (root / "build" / "icon.icns").read_bytes()
# The skill library (see scripts/make_skill_library.cjs). An app without it has an empty library.
library_file = root / "build" / "skill-library.asar"
skill_library = library_file.read_bytes() if library_file.exists() else None
FILE_MODE = 0o100644 << 16


def new_entry(path, like):
    info = zipfile.ZipInfo(path, date_time=like.date_time)
    info.create_system = 3  # Unix, so macOS reads the mode bits
    info.external_attr = FILE_MODE
    info.compress_type = zipfile.ZIP_DEFLATED
    return info


def build(source_zip):
    arch = re.search(r"darwin-(arm64|x64)", source_zip).group(1)
    target = root / "release" / f"Uma-LLM-{version}-mac-{arch}.zip"
    with zipfile.ZipFile(source_zip) as src, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as out:
        plist_info = src.getinfo("Electron.app/Contents/Info.plist")
        for info in src.infolist():
            if not info.filename.startswith("Electron.app/"):
                continue  # LICENSE files go inside the app below
            rest = info.filename[len("Electron.app/"):]
            if rest in ("Contents/Resources/default_app.asar", "Contents/Resources/electron.icns", "Contents/Info.plist"):
                continue
            if rest == "Contents/MacOS/Electron":
                rest = f"Contents/MacOS/{name}"
            entry = copy.copy(info)
            entry.filename = f"{name}.app/{rest}"
            entry.orig_filename = entry.filename
            out.writestr(entry, src.read(info), compress_type=zipfile.ZIP_DEFLATED)

        plist = plistlib.loads(src.read(plist_info))
        plist.update({
            "CFBundleDisplayName": name,
            "CFBundleName": name,
            "CFBundleExecutable": name,
            "CFBundleIdentifier": "com.ocorex.uma-llm",
            "CFBundleIconFile": "icon.icns",
            "CFBundleShortVersionString": version,
            "CFBundleVersion": version,
            "LSApplicationCategoryType": "public.app-category.developer-tools",
            "NSHumanReadableCopyright": "Copyright (C) 2026 Ocorex. Free software under the GNU GPL v3.",
        })
        resources = f"{name}.app/Contents/Resources"
        out.writestr(new_entry(f"{name}.app/Contents/Info.plist", plist_info), plistlib.dumps(plist))
        out.writestr(new_entry(f"{resources}/app.asar", plist_info), app_asar)
        out.writestr(new_entry(f"{resources}/icon.icns", plist_info), icon)
        if skill_library:
            out.writestr(new_entry(f"{resources}/skill-library.asar", plist_info), skill_library)
        for source_name, license_name in (("LICENSE", "LICENSE.electron.txt"), ("LICENSES.chromium.html", "LICENSES.chromium.html")):
            out.writestr(new_entry(f"{resources}/{license_name}", plist_info), src.read(source_name))
        # Uma's own licence and the notices for the open-source parts.
        for own in ("LICENSE.txt", "THIRD-PARTY-NOTICES.txt"):
            out.writestr(new_entry(f"{resources}/{own}", plist_info), (root / own).read_bytes())
    print("wrote", target, f"({target.stat().st_size / 1048576:.1f} MB)")


for path in sys.argv[1:]:
    build(path)
