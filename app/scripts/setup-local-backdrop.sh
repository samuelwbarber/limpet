#!/usr/bin/env bash
# One-time install of the local generative-backdrop generator and model on
# macOS and Linux: the Unix twin of setup-local-backdrop.ps1 (same pinned
# stable-diffusion.cpp release, same model, same file layout, so the app's
# progress reader and backendStatus() see the same things).
#
#   bash scripts/setup-local-backdrop.sh [--force] [--local-root <dir>]
#
# Downloads resume: a partial file is kept as <file>.partial and continued on
# the next run. A failure ends in one plain line on stderr (the app shows it
# as the reason) with exit 1; "no build for this machine" exits 2.
set -u

fail() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }
trap 'fail "backdrop setup failed at line $LINENO"' ERR
set -E

force=0
localRoot=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --force|-Force) force=1 ;;
    --local-root|-LocalRoot) shift; localRoot=${1:-} ;;
    --local-root=*) localRoot=${1#--local-root=} ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

appRoot=$(cd "$(dirname "$0")/.." && pwd)
[ -n "$localRoot" ] || localRoot="$appRoot/local-ai"
binDir="$localRoot/bin"
modelDir="$localRoot/models"
downloadDir="$localRoot/downloads"
exe="$binDir/sd-cli"
model="$modelDir/sdxs-512-tinySDdistilled_Q8_0.gguf"
modelBytes=682847200
release='https://github.com/leejet/stable-diffusion.cpp/releases/download/master-841-6b3edaa'
modelUrl='https://huggingface.co/concedo/sdxs-512-tinySDdistilled-GGUF/resolve/main/sdxs-512-tinySDdistilled_Q8_0.gguf'
modelSha256='409ab23582ee074c6b9d5395784fc0741b0599fb9d138686c69087c71678eb6a'

# The pinned release has one macOS build (Apple silicon, Metal) and one Linux
# CPU build (x86_64). Anything else has nothing to install.
os=$(uname -s)
arch=$(uname -m)
case "$os/$arch" in
  Darwin/arm64)
    generatorArchive='sd-master-6b3edaa-bin-Darwin-macOS-26.5.2-arm64.zip'
    generatorSha256='1c7d0ddc18752cd88c084e0a636444697a0caea96763dcebdc08089ecf57b72f' ;;
  Darwin/*)
    fail "the local image generator has no build for Intel Macs (only Apple silicon); the Generative background isn't available on this machine" 2 ;;
  Linux/x86_64)
    generatorArchive='sd-master-6b3edaa-bin-Linux-Ubuntu-24.04-x86_64.zip'
    generatorSha256='66998807a8b21b6d00358310a23791c67d2e68f7e1820d99d5c9ac12738d882e' ;;
  *)
    fail "the local image generator has no build for $os/$arch" 2 ;;
esac

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else fail 'neither shasum nor sha256sum is available to verify downloads'; fi
}

download() { # url destination
  local partial="$2.partial" args=(-L --fail --retry 4 --retry-delay 3)
  [ -f "$partial" ] && args+=(--continue-at -)
  curl "${args[@]}" --output "$partial" "$1" || fail "download failed with curl exit code $?"
  mv -f "$partial" "$2"
}

mkdir -p "$binDir" "$modelDir" "$downloadDir"
command -v curl >/dev/null 2>&1 || fail 'curl is required to download the generator and model'
command -v unzip >/dev/null 2>&1 || fail 'unzip is required to unpack the generator'

if [ "$force" = 1 ] || [ ! -x "$exe" ]; then
  echo 'Fetching the pinned stable-diffusion.cpp build...'
  zip="$downloadDir/$generatorArchive"
  download "$release/$generatorArchive" "$zip"
  [ "$(sha256 "$zip")" = "$generatorSha256" ] || fail 'stable-diffusion.cpp archive checksum mismatch.'
  extractDir="$localRoot/.extract-$$"
  rm -rf "$extractDir"
  mkdir -p "$extractDir"
  unzip -q -o "$zip" -d "$extractDir" || fail 'could not unpack the stable-diffusion.cpp archive'
  found=$(find "$extractDir" -type f \( -name sd-cli -o -name sd \) | head -n 1)
  [ -n "$found" ] || fail 'sd-cli was not present in the downloaded archive.'
  # The executable and the shared libraries beside it.
  cp -R "$(dirname "$found")"/. "$binDir"/
  [ -f "$binDir/sd-cli" ] || mv "$binDir/$(basename "$found")" "$exe"
  chmod +x "$exe" 2>/dev/null || true
  # Downloaded binaries carry a quarantine flag on macOS; the app runs them, so clear it.
  if [ "$os" = Darwin ] && command -v xattr >/dev/null 2>&1; then xattr -dr com.apple.quarantine "$binDir" 2>/dev/null || true; fi
  rm -rf "$extractDir"
else
  echo 'stable-diffusion.cpp is already installed.'
fi

modelOk=0
if [ -f "$model" ]; then
  size=$(wc -c < "$model" | tr -d ' ')
  [ "$size" = "$modelBytes" ] && [ "$(sha256 "$model")" = "$modelSha256" ] && modelOk=1
fi
if [ "$modelOk" = 0 ]; then
  freeKb=$(df -k "$localRoot" | awk 'NR==2 {print $4}')
  [ -n "$freeKb" ] && [ "$freeKb" -lt 2097152 ] && fail 'At least 2 GB of free disk space is required for the local backdrop model.'
  echo 'Downloading the 651 MB local one-step image model (one time only)...'
  download "$modelUrl" "$model"
  echo 'Verifying model checksum...'
  [ "$(sha256 "$model")" = "$modelSha256" ] || fail 'Local image model checksum mismatch.'
else
  echo 'Local image model is already installed.'
fi

echo
echo 'Local Limpet backdrops are ready.'
echo "  Generator: $exe"
echo "  Model    : $model"
echo 'No API key or network connection is used during generation.'
