#!/usr/bin/env bash
# Build the coresim-capture helper.
#
# CoreSimulator is a private framework with no module map, so we do NOT link it
# at build time. main.swift resolves every CoreSimulator class/selector at
# runtime via the Objective-C runtime (dlopen + NSClassFromString). We only link
# the public frameworks the encoder needs.
#
# Output: ./coresim-capture
#
# No pipes are used below, so we avoid `set -o pipefail` (unsupported by plain
# /bin/sh) to keep the script runnable via either `bash build.sh` or `sh build.sh`.
set -eu

cd "$(dirname "$0")"

OUT="coresim-capture"
SRC="main.swift"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "error: swiftc not found. Install Xcode command line tools." >&2
  exit 1
fi

# Detect host arch.
ARCH_TARGET="arm64-apple-macosx11.0"
case "$(uname -m)" in
  x86_64) ARCH_TARGET="x86_64-apple-macosx11.0" ;;
esac

echo "Building ${OUT} ..."
swiftc \
  -O \
  -target "${ARCH_TARGET}" \
  -framework Foundation \
  -framework CoreVideo \
  -framework VideoToolbox \
  -framework CoreMedia \
  -framework IOSurface \
  -o "${OUT}" \
  "${SRC}"

chmod +x "${OUT}"
echo "Built $(pwd)/${OUT}"
echo "Smoke test: ./${OUT} --udid <booted-sim-udid> --probe"
