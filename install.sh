#!/usr/bin/env bash
# Install Relay CLI for the current user. No system Node.js or sudo required.

main() (
  set -euo pipefail
  umask 022

  fail() { printf 'Relay CLI: %s\n' "$*" >&2; exit 1; }
  download() { curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 "$1" -o "$2"; }

  case "${1:-}" in
    --help|-h)
      printf '%s\n' 'Install Relay CLI: bash install.sh' \
        'Optional: RMD_INSTALL_DIR, RMD_BIN_DIR, RMD_REVISION (full commit SHA).' \
        'Default locations: ~/.local/share/relay-cli and ~/.local/bin/rmd.'
      exit 0 ;;
    '') ;;
    *) fail "Unknown option: $1" ;;
  esac
  [ "$#" -le 1 ] || fail 'Unexpected arguments.'
  for command in curl tar uname mktemp; do
    command -v "$command" >/dev/null 2>&1 || fail "Install $command and try again."
  done
  if command -v sha256sum >/dev/null 2>&1; then
    checksum() { sha256sum "$1" | awk '{print $1}'; }
  elif command -v shasum >/dev/null 2>&1; then
    checksum() { shasum -a 256 "$1" | awk '{print $1}'; }
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
  launcher=$bin_dir/rmd
  if [ -e "$launcher" ] || [ -L "$launcher" ]; then
    [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$install_dir/current/rmd" ] ||
      fail "$launcher already exists and belongs to another install. Set RMD_BIN_DIR to choose another directory."
  fi
  if [ -e "$install_dir/current" ] && [ ! -L "$install_dir/current" ]; then
    fail "$install_dir/current already exists and is not an installation link."
  fi

  mkdir "$install_dir/.install-lock" 2>/dev/null ||
    fail "Another installation may be running. If it was interrupted, remove $install_dir/.install-lock and retry."
  stage=''
  link_temp=''
  cleanup() {
    [ -z "$link_temp" ] || rm -f "$link_temp"
    [ -z "$stage" ] || rm -rf "$stage"
    rmdir "$install_dir/.install-lock"
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  stage=$(mktemp -d "$install_dir/.install.XXXXXXXX")

  node_version=24.17.0
  node_archive=node-v$node_version-$platform-$architecture.tar.gz
  node_url=https://nodejs.org/dist/v$node_version
  printf 'Installing Relay CLI for %s/%s…\n' "$platform" "$architecture"
  download "$node_url/SHASUMS256.txt" "$stage/SHASUMS256.txt"
  expected=$(awk -v name="$node_archive" '$2 == name { print $1 }' "$stage/SHASUMS256.txt")
  [ "${#expected}" -eq 64 ] || fail 'The Node.js download has no matching checksum.'
  download "$node_url/$node_archive" "$stage/node.tar.gz"
  [ "$(checksum "$stage/node.tar.gz")" = "$expected" ] || fail 'Node.js download checksum mismatch.'
  mkdir "$stage/runtime" "$stage/app"
  tar -xzf "$stage/node.tar.gz" -C "$stage/runtime" --strip-components=1
  node=$stage/runtime/bin/node
  [ "$("$node" --version)" = "v$node_version" ] || fail 'The downloaded Node.js runtime could not start.'

  revision=${RMD_REVISION:-}
  if [ -z "$revision" ]; then
    download 'https://api.github.com/repos/No-Instructions/relay-cli/commits/main' "$stage/revision.json"
    revision=$("$node" -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).sha)' "$stage/revision.json")
  fi
  [ "${#revision}" -eq 40 ] || fail 'RMD_REVISION must be a full Git commit SHA.'
  case "$revision" in *[!0-9a-f]*) fail 'RMD_REVISION must be a full Git commit SHA.' ;; esac
  download "https://codeload.github.com/No-Instructions/relay-cli/tar.gz/$revision" "$stage/source.tar.gz"
  tar -xzf "$stage/source.tar.gz" -C "$stage/app" --strip-components=1
  printf 'Building Relay CLI…\n'
  (
    cd "$stage/app"
    export PATH="$stage/runtime/bin:$PATH"
    "$stage/runtime/bin/npm" ci --include=dev --no-audit --no-fund
    "$stage/runtime/bin/npm" run build:headless
  )
  "$node" --no-warnings "$stage/app/bin/rmd.js" --help >/dev/null
  printf '%s\n' "$revision" > "$stage/revision"
  rm -f "$stage/node.tar.gz" "$stage/source.tar.gz" "$stage/SHASUMS256.txt" "$stage/revision.json"
  # The launcher stays on the selected installation. Existing daemons retain
  # their old version directories, which are kept across updates.
  {
    printf '#!/usr/bin/env bash\n'
    printf 'exec %q --no-warnings %q "$@"\n' \
      "$install_dir/current/runtime/bin/node" "$install_dir/current/app/bin/rmd.js"
  } > "$stage/rmd"
  chmod 755 "$stage/rmd"

  version_dir=$install_dir/versions/$revision-${stage##*.install.}
  mv "$stage" "$version_dir"
  stage=''
  node=$version_dir/runtime/bin/node
  # rename replaces the link itself on both Linux and macOS; mv may follow a
  # destination directory symlink and put the new link inside its target.
  link_temp=$install_dir/.current-$$
  ln -s "$version_dir" "$link_temp"
  "$node" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$link_temp" "$install_dir/current"
  link_temp=''
  if [ ! -L "$launcher" ]; then
    ln -s "$install_dir/current/rmd" "$launcher"
  fi

  printf '\nInstalled Relay CLI at %s\n' "$launcher"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) printf '\nAdd this to your shell profile and run it in this terminal:\n  export PATH=%q:"$PATH"\n' "$bin_dir" ;;
  esac
  printf '\nGet started:\n  %q login\n  %q clone\n  %q start\n' "$launcher" "$launcher" "$launcher"
  printf '\nRun this installer again to update. Restart a running daemon with rmd stop, then rmd start.\n'
)

# Keeping execution at the end prevents a truncated piped download from
# executing an incomplete installer body.
main "$@"
