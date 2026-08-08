#!/bin/bash
# Builds a fully self-contained macOS distribution of PTZ Follow: bundles the Node server, the
# Python/OpenCV tracker, and a portable ffmpeg into one folder that needs nothing installed on
# the end user's machine - no Node, Python, pip, npm, or Homebrew required to RUN it (only to
# BUILD it, here, once).
#
# Requires on the BUILD machine only: Node.js + npm, Python 3, Homebrew (for ffmpeg and
# dylibbundler, used to make ffmpeg portable).
#
# This targets whatever CPU architecture the build machine itself is running (arm64 on Apple
# Silicon, x86_64 on Intel) - PyInstaller and dylibbundler both bundle native binaries for the
# host architecture, so a build made here only runs on Macs with the same architecture. To
# support both, run this script once on an Apple Silicon Mac and once on an Intel Mac.
set -e

cd "$(dirname "$0")/.."
PROJECT_ROOT="$(pwd)"
PACKAGING_DIR="$PROJECT_ROOT/packaging"
OUT_DIR="$PACKAGING_DIR/dist-mac"
ARCH="$(uname -m)"

echo "== PTZ Follow macOS build ($ARCH) =="
echo ""

# --- 1. Python tracker: standalone executable via PyInstaller ---
echo "-- [1/6] Building tracker executable (PyInstaller) --"
if [ ! -d "$PACKAGING_DIR/build-venv" ]; then
    python3 -m venv "$PACKAGING_DIR/build-venv"
fi
source "$PACKAGING_DIR/build-venv/bin/activate"
pip install --upgrade pip -q
pip install pyinstaller opencv-contrib-python -q
rm -rf "$PACKAGING_DIR/dist/tracker" "$PACKAGING_DIR/build/tracker"
pyinstaller --onedir --name tracker \
    --distpath "$PACKAGING_DIR/dist" \
    --workpath "$PACKAGING_DIR/build" \
    --specpath "$PACKAGING_DIR" \
    "$PROJECT_ROOT/tracker.py"
deactivate
echo ""

# --- 2. Node server: standalone executable via pkg ---
echo "-- [2/6] Building server executable (pkg) --"

# node-osc's Server.js requires '#decode' via Node's package.json "imports" field, which pkg's
# module resolver doesn't implement (it fails at runtime even when the target file is bundled).
# Patch it to a direct relative require instead - safe, idempotent, and scoped to this build
# venv/install only (a plain "npm install" for normal dev use is unaffected).
NODE_OSC_SERVER="$PROJECT_ROOT/node_modules/node-osc/dist/lib/Server.js"
if [ -f "$NODE_OSC_SERVER" ] && grep -q "require('#decode')" "$NODE_OSC_SERVER"; then
    sed -i '' "s#require('#decode')#require('./internal/decode.js')#" "$NODE_OSC_SERVER"
    echo "Patched node-osc for pkg compatibility."
fi

mkdir -p "$PACKAGING_DIR/dist-node"
rm -f "$PACKAGING_DIR/dist-node/ptz-tracker"
npx --yes @yao-pkg/pkg "$PROJECT_ROOT"
echo ""

# --- 3. Portable ffmpeg: bundle the build machine's own ffmpeg + its dylib dependencies ---
echo "-- [3/6] Bundling ffmpeg --"
if ! command -v dylibbundler >/dev/null 2>&1; then
    echo "dylibbundler not found - installing via Homebrew..."
    brew install dylibbundler
fi
FFMPEG_SRC="$(command -v ffmpeg || true)"
if [ -z "$FFMPEG_SRC" ]; then
    echo "ERROR: ffmpeg not found on PATH. Install it first (e.g. 'brew install ffmpeg') and re-run this script." >&2
    exit 1
fi
rm -rf "$PACKAGING_DIR/dist-ffmpeg"
mkdir -p "$PACKAGING_DIR/dist-ffmpeg/libs"
cp "$FFMPEG_SRC" "$PACKAGING_DIR/dist-ffmpeg/ffmpeg"
chmod +w "$PACKAGING_DIR/dist-ffmpeg/ffmpeg"
dylibbundler -od -b \
    -x "$PACKAGING_DIR/dist-ffmpeg/ffmpeg" \
    -d "$PACKAGING_DIR/dist-ffmpeg/libs" \
    -p '@executable_path/libs'
echo ""

# --- 4. App icon: build a real .icns from packaging/AppIcon.png ---
echo "-- [4/6] Building app icon --"
if [ -f "$PACKAGING_DIR/AppIcon.png" ]; then
    rm -rf "$PACKAGING_DIR/AppIcon.iconset" "$PACKAGING_DIR/AppIcon.icns"
    mkdir -p "$PACKAGING_DIR/AppIcon.iconset"
    sips -z 16 16     "$PACKAGING_DIR/AppIcon.png" --out "$PACKAGING_DIR/AppIcon.iconset/icon_16x16.png" >/dev/null
    sips -z 32 32     "$PACKAGING_DIR/AppIcon.png" --out "$PACKAGING_DIR/AppIcon.iconset/icon_16x16@2x.png" >/dev/null
    sips -z 32 32     "$PACKAGING_DIR/AppIcon.png" --out "$PACKAGING_DIR/AppIcon.iconset/icon_32x32.png" >/dev/null
    sips -z 64 64     "$PACKAGING_DIR/AppIcon.png" --out "$PACKAGING_DIR/AppIcon.iconset/icon_32x32@2x.png" >/dev/null
    sips -z 128 128   "$PACKAGING_DIR/AppIcon.png" --out "$PACKAGING_DIR/AppIcon.iconset/icon_128x128.png" >/dev/null
    sips -z 256 256   "$PACKAGING_DIR/AppIcon.png" --out "$PACKAGING_DIR/AppIcon.iconset/icon_128x128@2x.png" >/dev/null
    sips -z 256 256   "$PACKAGING_DIR/AppIcon.png" --out "$PACKAGING_DIR/AppIcon.iconset/icon_256x256.png" >/dev/null
    sips -z 512 512   "$PACKAGING_DIR/AppIcon.png" --out "$PACKAGING_DIR/AppIcon.iconset/icon_256x256@2x.png" >/dev/null
    sips -z 512 512   "$PACKAGING_DIR/AppIcon.png" --out "$PACKAGING_DIR/AppIcon.iconset/icon_512x512.png" >/dev/null
    cp "$PACKAGING_DIR/AppIcon.png" "$PACKAGING_DIR/AppIcon.iconset/icon_512x512@2x.png"
    iconutil -c icns "$PACKAGING_DIR/AppIcon.iconset" -o "$PACKAGING_DIR/AppIcon.icns"
else
    echo "No packaging/AppIcon.png found - skipping icon (app will use the generic executable icon)."
fi
echo ""

# --- 5. Native Dock launcher (Swift/AppKit) ---
# ptz-tracker (built above) is a bare pkg-built Node executable with no AppKit/Cocoa involvement,
# so it can't be CFBundleExecutable directly and still behave like a normal Mac app in the Dock -
# the Dock only stops bouncing an icon once the app signals "I'm a real GUI app and I'm ready" via
# AppKit, which a plain command-line binary never does. This tiny wrapper IS a real (windowless)
# AppKit app: it settles in the Dock normally, launches ptz-tracker as a child process, and
# forwards Cmd+Q/Dock Quit to it as a clean SIGTERM (which server.js's own gracefulShutdown()
# handles) instead of leaving those with nothing to actually terminate.
echo "-- [5/6] Building native Dock launcher (swiftc) --"
mkdir -p "$PACKAGING_DIR/dist-wrapper"
swiftc -O "$PACKAGING_DIR/AppWrapper.swift" -o "$PACKAGING_DIR/dist-wrapper/ptz-follow-launcher"
echo ""

# --- 6. Assemble the final .app bundle ---
# CFBundleExecutable points at the Swift launcher above, not ptz-tracker directly - see step 5.
# The app still has no visible Terminal window either way - its "Open Console" button (streamed
# from the server over a websocket) and Quit App button are how you see log output and stop it.
echo "-- [6/6] Assembling $OUT_DIR --"
APP_DIR="$OUT_DIR/PTZ Follow.app"
rm -rf "$OUT_DIR"
mkdir -p "$APP_DIR/Contents/MacOS/resources" "$APP_DIR/Contents/Resources"

cp "$PACKAGING_DIR/Info.plist" "$APP_DIR/Contents/Info.plist"

if [ -f "$PACKAGING_DIR/AppIcon.icns" ]; then
    cp "$PACKAGING_DIR/AppIcon.icns" "$APP_DIR/Contents/Resources/AppIcon.icns"
fi

cp "$PACKAGING_DIR/dist-node/ptz-tracker" "$APP_DIR/Contents/MacOS/ptz-tracker"
chmod +x "$APP_DIR/Contents/MacOS/ptz-tracker"

cp "$PACKAGING_DIR/dist-wrapper/ptz-follow-launcher" "$APP_DIR/Contents/MacOS/ptz-follow-launcher"
chmod +x "$APP_DIR/Contents/MacOS/ptz-follow-launcher"
# Apple Silicon refuses to run any unsigned Mach-O binary at all, even locally - ad-hoc sign it
# the same way dylibbundler's ffmpeg gets signed below, since swiftc doesn't always do this itself.
codesign --force -s - "$APP_DIR/Contents/MacOS/ptz-follow-launcher"

cp -R "$PACKAGING_DIR/dist/tracker" "$APP_DIR/Contents/MacOS/resources/tracker"
cp -R "$PACKAGING_DIR/dist-ffmpeg" "$APP_DIR/Contents/MacOS/resources/ffmpeg"

cp "$PACKAGING_DIR/README-dist.txt" "$OUT_DIR/README.txt"

echo ""
echo "== Build complete =="
echo "Distributable app: $APP_DIR"
echo "Zip $OUT_DIR and hand it to any Mac with the same CPU architecture as this one ($ARCH)."
