#!/usr/bin/env bash
set -euo pipefail

APP_NAME="EmulatorDesktopApp"
RID="osx-arm64"
CONFIG="Release"
TFM="net10.0"
ICON_SOURCE="Assets/generated/app-icon-source.png"
BUNDLE_ID="com.emulatordesktop.app"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PUBLISH_DIR="$ROOT_DIR/bin/$CONFIG/$TFM/$RID/publish"
APP_BUNDLE_DIR="$ROOT_DIR/bin/$CONFIG/$TFM/$RID/${APP_NAME}.app"
CONTENTS_DIR="$APP_BUNDLE_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
ICONSET_DIR="$RESOURCES_DIR/${APP_NAME}.iconset"
ICON_ICNS="$RESOURCES_DIR/${APP_NAME}.icns"

if [[ ! -f "$ROOT_DIR/$ICON_SOURCE" ]]; then
  echo "Generating icons..."
  python3 "$ROOT_DIR/scripts/generate_icons.py"
fi

if [[ ! -f "$ROOT_DIR/$ICON_SOURCE" ]]; then
  echo "Icon source not found after generation: $ICON_SOURCE"
  exit 1
fi

echo "Publishing $APP_NAME for macOS ($RID)..."
dotnet publish "$ROOT_DIR/${APP_NAME}.csproj" \
  -c "$CONFIG" \
  -r "$RID" \
  --self-contained true \
  /p:PublishSingleFile=true

if [[ ! -d "$PUBLISH_DIR" ]]; then
  echo "Publish output not found: $PUBLISH_DIR"
  exit 1
fi

echo "Creating app bundle: $APP_BUNDLE_DIR"
rm -rf "$APP_BUNDLE_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

echo "Copying published files into bundle..."
cp -R "$PUBLISH_DIR"/* "$MACOS_DIR/"

echo "Generating .icns from $ICON_SOURCE"
mkdir -p "$ICONSET_DIR"

for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ROOT_DIR/$ICON_SOURCE" --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$ROOT_DIR/$ICON_SOURCE" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET_DIR" -o "$ICON_ICNS"
rm -rf "$ICONSET_DIR"

cat > "$CONTENTS_DIR/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIconFile</key>
  <string>${APP_NAME}.icns</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

chmod +x "$MACOS_DIR/$APP_NAME"

echo "Done. Launch this bundle so Dock icon is used:"
echo "open \"$APP_BUNDLE_DIR\""
