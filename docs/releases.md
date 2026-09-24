# Release maintenance

Distributed releases are production builds compiled into a Bun executable.
Node source development continues to use `package-lock.json` and `npm ci`.
`.bun-version` pins the release runtime; changing it requires the
private unit, integration, and compiled upgrade suites as well as public builds.

## Build

Install the pinned Bun version, then run on the target platform:

```sh
npm ci
bun scripts/build-release.mjs 1.2.3
```

An optional second argument selects an output directory. The build records the
Git HEAD revision; build distributable artifacts from a clean, reviewed checkout.
It embeds the production sync runtime and platform keychain addon, disables Bun
configuration and dotenv autoloading, and executes `relay version --verify --json`.
It also downloads the pinned Bun license notices from the upstream repository.

The archive contains only `relay`, `release.json`, `LICENSE`, and third-party
licenses. It excludes the source checkout, tests, harness, and local state.
Assets are named `relay-cli-<platform>-<architecture>.tar.gz`, with `.sha256`
sidecars. `version.txt` contains the stable version without a `v` prefix.
Supported builds are Linux glibc and macOS, each on x64 and ARM64; x64 builds
use Bun's baseline CPU target. Native Windows source builds remain separate.

Test the installer without publishing:

```sh
RMD_RELEASE_DIR="$PWD/dist/releases" \
  RMD_INSTALL_DIR=/tmp/relay-cli-install \
  RMD_BIN_DIR=/tmp/relay-cli-bin sh install.sh
/tmp/relay-cli-bin/relay version --verify
```

## Prepare and publish

1. Run public builds and private unit/integration/compiled upgrade tests against
   the exact reviewed product commit. The private key belongs only in the private
   harness repository. Public workflows cannot enforce the private test gate;
   the maintainer verifies it before publishing.
2. Dispatch **Prepare release draft** at that commit with a stable version such
   as `1.2.3`. It runs the public build matrix, packages all four platforms,
   verifies checksums, and creates a draft release tagged `v1.2.3`.
3. Review the draft's target commit, all four archives and checksums, `version.txt`,
   and release notes. Replace generated notes with user-facing changes and any
   upgrade or recovery requirements. Publish only after these checks pass.

The workflow never publishes its draft automatically. Publishing a stable
release makes it eligible for installation and opt-in automatic updates. The
first stable release must exist before the release-based installer can work.
Use `RMD_VERSION=1.2.3` when running the installer to choose an explicit release;
use `relay update --pin` afterward to retain it.

Never replace assets for a published version: issue another version instead.
The installer is a small POSIX shell bootstrap. Upgrades replace the executable,
including its updater and Bun runtime, and do not rerun the installer.

## Storage

IndexedDB records use a versioned CBOR format shared by Node and Bun, encrypted
with AES-GCM. The storage format is independent of the JavaScript engine.

## Update and recovery behavior

`relay update` downloads from the fixed product GitHub release URL. It verifies
the checksum, metadata, embedded version, and runtime before stopping daemons.
HTTPS and publisher-controlled checksums provide transport and corruption
checks; these are not independent publisher signatures.

Installer, update, policy changes, and managed daemon starts share an installation
lock. Every daemon registers its state directory, process ID, and chosen control
endpoint. The updater uses authenticated control requests and waits for process
exit before switching the `current` symlink atomically. It attempts to restart
the previous version if replacement startup fails. A replacement that cannot
stop blocks recovery so two runtimes do not write the same state concurrently.

Automatic updates default off. When enabled and unpinned, a running daemon
launches a separate update worker at most daily, including after a failed check.
It waits up to a minute after startup before the first check. Restarted daemons
inherit the updater's environment. Custom key-file configurations must therefore
be available when running a manual update, and installations with different
daemon-specific environments should be updated separately.

Previous executables remain under `versions/`; updates replace the executable
and preserve synced files. A process crash or power loss can leave a stale lock or
stopped daemons. After confirming no install/update is running and all affected
daemons have stopped, remove `.install-lock`, inspect `current/relay version`, then
restart with each daemon's original state directory and environment. Use
`relay update --version <previous-version>` to select another published executable.
Releases must maintain on-disk compatibility with the previous version for
automatic recovery to work.
