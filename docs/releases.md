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

## CI setup

The public **Release** workflow has two manually dispatched operations:
`prepare` creates a draft; `publish` publishes the reviewed draft's existing
assets. Both require a stable version and the full reviewed product commit SHA.
No push or tag automatically publishes a release.

Enable **Immutable releases** in the product repository's release settings
before publishing. This locks published assets and tags and makes GitHub generate
a [release attestation](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).
Only an administrator can query or change this setting; the release workflow
uses the ordinary repository token and verifies immutability after publication.
Keep the setting enabled. A failed post-publication check does not unpublish a
release.

The workflow uses GitHub's built-in repository token to upload and publish assets,
and GitHub Actions OIDC to sign build provenance. No additional token, signing
key, private repository access, or test-workflow dispatch is required.

## Prepare and publish

1. Commit and push reviewed source to `main` and record its full commit SHA.
2. Dispatch **Release** from `main`, choosing `prepare`, the version, and the
   same full SHA. Preparation refuses to proceed if `main` has moved since review.
3. Review the draft's target commit and release notes. Replace generated notes
   with user-facing changes and any upgrade or recovery requirements.
4. Dispatch **Release** again, choosing `publish` with the same version and SHA.
   This downloads and verifies the draft's existing assets before publishing;
   it does not rebuild. `main` can advance between preparation and publication.

For example, after setting `reviewed_sha` to the reviewed full commit ID:

```sh
gh workflow run release.yml --repo No-Instructions/relay-cli --ref main \
  -f operation=prepare -f release_version=1.2.3 -f product_commit="$reviewed_sha"

# After reviewing the resulting draft and editing its notes:
gh workflow run release.yml --repo No-Instructions/relay-cli --ref main \
  -f operation=publish -f release_version=1.2.3 -f product_commit="$reviewed_sha"
```

Preparation runs the public Node build matrix and builds and smoke-tests all
four standalone binaries. It checks each platform's checksum, version, source
revision, production target, architecture, and pinned Bun version before merging
artifacts. It then generates signed SLSA build provenance using GitHub Actions
OIDC and uploads the archives, checksums, `version.txt`, and
`release-provenance.sigstore.json` to a draft. The workflow verifies signatures
against this repository, `release.yml`, `main`, the reviewed SHA, and GitHub-hosted
runners, then downloads the uploaded assets and verifies them again.

Publication verifies the draft assets and their provenance. It publishes the draft,
checks that GitHub made the release immutable and its tag points to the reviewed
SHA, and verifies GitHub's release attestation and every attached asset. Publishing
a stable release makes it eligible for installation and opt-in automatic updates.
The first stable release must exist before the release-based installer can work.

Use **Re-run failed jobs** for an interrupted preparation. Draft upload retries
fill missing assets and reject any existing asset with different bytes. A fresh
preparation of an existing version is rejected. Rerunning `publish` verifies an
already published release without changing its assets. Never replace a published
version: issue another version instead. Signing or publication-service outages
fail the workflow; there is no unsigned fallback.

Use `RMD_VERSION=1.2.3` when running the installer to choose an explicit release;
use `relay update --pin` afterward to retain it. The installer is a small POSIX
shell bootstrap. Upgrades replace the executable, including its updater and Bun
runtime, and do not rerun the installer.

## Verify a download

With a current GitHub CLI, verify a downloaded archive's build provenance and
its membership in the immutable release:

```sh
gh attestation verify relay-cli-linux-x64.tar.gz \
  --repo No-Instructions/relay-cli \
  --signer-workflow No-Instructions/relay-cli/.github/workflows/release.yml \
  --source-ref refs/heads/main --source-digest "$reviewed_sha" \
  --deny-self-hosted-runners

gh release verify v1.2.3 --repo No-Instructions/relay-cli
gh release verify-asset v1.2.3 relay-cli-linux-x64.tar.gz \
  --repo No-Instructions/relay-cli
```

Obtain the expected full SHA from the release's reviewed source commit. Add
`--bundle release-provenance.sigstore.json` to `gh attestation verify` to use the
attached provenance bundle instead of fetching it from GitHub's attestation API.
The installer and built-in updater validate checksums and release metadata;
they do not run these signature checks or require GitHub CLI.

## Storage

IndexedDB records use a versioned CBOR format shared by Node and Bun, encrypted
with AES-GCM. The storage format is independent of the JavaScript engine.

## Update and recovery behavior

`relay update` downloads from the fixed product GitHub release URL. It verifies
the checksum, metadata, embedded version, and runtime before stopping daemons.
HTTPS and publisher-controlled checksums provide transport and corruption
checks; these are not independent publisher signatures.

Installer, update, update-policy commands, and managed daemon starts share an installation
lock. User preference writes also share a config-file lock. Every daemon registers its state directory, process ID, and chosen control
endpoint. The updater uses authenticated control requests and waits for process
exit before switching the `current` symlink atomically. It attempts to restart
the previous version if replacement startup fails. A replacement that cannot
stop blocks recovery so two runtimes do not write the same state concurrently.

Version checks run daily by default and only fetch `version.txt`. Results and
failed attempts are cached in `update-check.json`, separately from installation
policy. Interactive commands allow up to 1.5 seconds for a due check, then show
an available-update notice on stderr. Notices use yellow when supported and
respect `NO_COLOR`; redirected commands, JSON output, and MCP skip these checks
and notices. Daemons check in the background and log each new notice once.
Pinned installations still receive notices explaining how to unpin.

Preferences live in `~/Library/Application Support/relay/config.toml` on macOS
and `~/.config/relay/config.toml` on Linux and WSL. `XDG_CONFIG_HOME` overrides
either default with `$XDG_CONFIG_HOME/relay/config.toml`.
The `[updates]` table holds `automatic`, `notify`, and optional `pinned_version`;
the `[logging]` table holds `debug` and `network`. They apply across the user's
installations. `notify = false` disables incidental version checks and notices.
CLI preference changes preserve unrelated TOML values and rewrite the document
with normalized formatting; comments are not retained. Invalid configuration
is reported without overwriting the file. Attempt timestamps stay in each
installation's `update-state.json`; notification cache data stays in
`update-check.json`. Neither file is a preference source.

Automatic installation defaults off. We recommend opting in with
`relay update --enable-automatic-updates`; use `--disable-automatic-updates` to
turn it off. `relay upgrade` accepts all the same options as `relay update`.
When enabled and unpinned, a running daemon
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
