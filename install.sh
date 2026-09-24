#!/bin/sh
# Install a prebuilt Relay CLI release for the current user.

main() (
  set -eu
  umask 022

  fail() { printf 'Relay CLI: %s\n' "$*" >&2; exit 1; }
  download() { curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 "$1" -o "$2"; }
  # Produce a POSIX shell literal, including embedded apostrophes and newlines.
  quote() (
    value=$1
    printf "'"
    while :; do
      case "$value" in
        *\'*)
          printf '%s%s' "${value%%\'*}" "'\"'\"'"
          value=${value#*\'} ;;
        *) printf "%s'" "$value"; break ;;
      esac
    done
  )

  case "${1:-}" in
    --help|-h)
      printf '%s\n' 'Install Relay CLI: sh install.sh' \
        'Optional: RMD_INSTALL_DIR, RMD_BIN_DIR, RMD_VERSION, RMD_RELEASE_DIR (offline artifacts).' \
        'Default locations: ~/.local/share/relay-cli and ~/.local/bin/relay.'
      exit 0 ;;
    '') ;;
    *) fail "Unknown option: $1" ;;
  esac
  [ "$#" -le 1 ] || fail 'Unexpected arguments.'
  for command in curl tar uname mktemp; do
    command -v "$command" >/dev/null 2>&1 || fail "Install $command and try again."
  done
  if command -v sha256sum >/dev/null 2>&1; then
    checksum() { sha256sum < "$1"; }
  elif command -v shasum >/dev/null 2>&1; then
    checksum() { shasum -a 256 < "$1"; }
  else
    fail 'Install sha256sum or shasum and try again.'
  fi

  case "$(uname -s)" in
    Linux) platform=linux ;;
    Darwin) platform=darwin ;;
    *) fail 'This installer supports Linux and macOS. On Windows, use WSL.' ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) architecture=x64 ;;
    aarch64|arm64) architecture=arm64 ;;
    *) fail 'This installer supports x86-64 and ARM64 machines.' ;;
  esac

  install_dir=${RMD_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/relay-cli}
  bin_dir=${RMD_BIN_DIR:-$HOME/.local/bin}
  case "$install_dir" in /*) ;; *) fail 'RMD_INSTALL_DIR must be an absolute path.' ;; esac
  case "$bin_dir" in /*) ;; *) fail 'RMD_BIN_DIR must be an absolute path.' ;; esac
  mkdir -p "$install_dir/versions" "$bin_dir"
  install_dir=$(cd "$install_dir" && pwd -P)
  bin_dir=$(cd "$bin_dir" && pwd -P)
  launcher=$bin_dir/relay
  if [ -e "$launcher" ] || [ -L "$launcher" ]; then
    [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$install_dir/current/relay" ] ||
      fail "$launcher already exists and belongs to another install. Set RMD_BIN_DIR to choose another directory."
  fi
  if [ -e "$install_dir/current" ] && [ ! -L "$install_dir/current" ]; then
    fail "$install_dir/current already exists and is not an installation link."
  fi

  mkdir "$install_dir/.install-lock" 2>/dev/null ||
    fail "Another installation may be running. If it was interrupted, remove $install_dir/.install-lock and retry."
  stage=''
  cleanup() {
    [ -z "$stage" ] || rm -rf "$stage"
    rmdir "$install_dir/.install-lock"
  }
  trap cleanup 0
  trap 'exit 130' INT
  trap 'exit 143' TERM
  stage=$(mktemp -d "$install_dir/.install.XXXXXXXX")

  release_base=https://github.com/No-Instructions/relay-cli/releases
  version=${RMD_VERSION:-}
  release_dir=${RMD_RELEASE_DIR:-}
  asset() {
    if [ -n "$release_dir" ]; then
      cp "$release_dir/$1" "$2"
    else
      download "$release_base/download/v$version/$1" "$2"
    fi
  }
  if [ -z "$version" ]; then
    if [ -n "$release_dir" ]; then
      cp "$release_dir/version.txt" "$stage/version.txt"
    else
      download "$release_base/latest/download/version.txt" "$stage/version.txt"
    fi
    version=$(cat "$stage/version.txt")
  fi
  awk -v version="$version" 'BEGIN { exit !(version ~ /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/) }' ||
    fail 'Expected a release version such as 1.2.3.'
  archive=relay-cli-$platform-$architecture.tar.gz
  printf 'Installing Relay CLI %s for %s/%s…\n' "$version" "$platform" "$architecture"
  asset "$archive.sha256" "$stage/checksum"
  expected=$(awk '{print $1}' "$stage/checksum")
  [ "${#expected}" -eq 64 ] || fail 'Invalid release checksum.'
  asset "$archive" "$stage/release.tar.gz"
  actual=$(checksum "$stage/release.tar.gz") || fail 'Could not checksum the release download.'
  [ "${actual%% *}" = "$expected" ] || fail 'Release checksum mismatch.'
  mkdir "$stage/unpacked"
  tar -xzf "$stage/release.tar.gz" -C "$stage/unpacked"
  [ "$("$stage/unpacked/relay" version --verify)" = "relay $version" ] || fail 'The downloaded CLI failed its version check.'
  version_dir=$install_dir/versions/$version-${stage##*.install.}
  mv "$stage/unpacked" "$version_dir"
  "$version_dir/relay" _activate-install "$install_dir" "$version_dir"
  if [ ! -L "$launcher" ]; then
    ln -s "$install_dir/current/relay" "$launcher"
  fi

  printf '\nInstalled Relay CLI at %s\n' "$launcher"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) printf '\nAdd this to your shell profile and run it in this terminal:\n  export PATH=%s:"$PATH"\n' "$(quote "$bin_dir")" ;;
  esac
  quoted_launcher=$(quote "$launcher")
  printf '\nGet started:\n  %s login\n  %s clone\n  %s start\n' "$quoted_launcher" "$quoted_launcher" "$quoted_launcher"
  printf '\nUpdate with relay update. Enable automatic updates with relay update --auto on.\n'
)

# Keeping execution at the end prevents a truncated piped download from
# executing an incomplete installer body.
main "$@"
