#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir/.."
build_root="${CARGO_TARGET_DIR:-$PWD/src-tauri/target}"
mkdir -p "$build_root"
build_root=$(CDPATH= cd -- "$build_root" && pwd)
export CARGO_TARGET_DIR="$build_root"
if [ "${AIU_BUNDLE_ONLY:-0}" = 1 ]; then
  npm run build:broker
  npx tauri bundle --config src-tauri/tauri.macos.conf.json --bundles app
else
  if [ ! -d node_modules ]; then npm ci --no-audit --no-fund; fi
  node scripts/build-desktop.mjs --config src-tauri/tauri.macos.conf.json --bundles app
fi
# Avoid Finder AppleScript during a build over SSH. hdiutil packages the same
# app with an Applications shortcut without opening a desktop window.
version=$(node -p "require('./package.json').version")
architecture=$(node -p "process.arch === 'arm64' ? 'aarch64' : 'x64'")
app="$build_root/release/bundle/macos/AI Usage.app"
# Resources can change during rebundling. Sign the final bytes before delivery.
# Preserve Node's JIT entitlements. This is a local signature, not notarization.
# Ad-hoc signatures change with every build, so macOS asks again for Keychain
# access after each update. A stable identity (a self-signed code-signing
# certificate is enough) keeps the same designated requirement across builds.
if [ -n "${AIU_MAC_SIGN_IDENTITY:-}" ] && [ -n "${AIU_MAC_SIGN_KEYCHAIN:-}" ]; then
  codesign --force --deep --keychain "$AIU_MAC_SIGN_KEYCHAIN" --sign "$AIU_MAC_SIGN_IDENTITY" --preserve-metadata=entitlements "$app"
elif [ -n "${AIU_MAC_SIGN_IDENTITY:-}" ]; then
  codesign --force --deep --sign "$AIU_MAC_SIGN_IDENTITY" --preserve-metadata=entitlements "$app"
else
  codesign --force --deep --sign - --preserve-metadata=entitlements "$app"
fi
codesign --verify --deep --strict "$app"
stage=$(mktemp -d "$build_root/dmg-stage.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
cp -R "$app" "$stage/AI Usage.app"
codesign --verify --deep --strict "$stage/AI Usage.app"
ln -s /Applications "$stage/Applications"
mkdir -p "$build_root/release/bundle/dmg"
hdiutil create -volname 'AI Usage' -srcfolder "$stage" -ov -format UDZO "$build_root/release/bundle/dmg/AI Usage_${version}_${architecture}.dmg"
hdiutil verify "$build_root/release/bundle/dmg/AI Usage_${version}_${architecture}.dmg"
