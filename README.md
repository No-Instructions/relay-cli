# Relay CLI

Keep local folders synced with [Relay](https://relay.md) from the command line,
without opening Obsidian.

## Install

On Linux (glibc) or macOS, on x86-64 or ARM64, run:

```sh
curl -fsSL https://raw.githubusercontent.com/No-Instructions/relay-cli/main/install.sh | sh
```

The installer downloads a standalone executable containing the Bun runtime.
You don't need Node.js, Bun, npm, or sudo. It installs `relay` in `~/.local/bin`; if that
directory isn't on your `PATH`, follow the instruction printed by the installer.
On Windows, use WSL or [build from source](#development).

Installation requires a published stable release with executable assets. For an
unreleased checkout, use the development instructions below.

## Sign in

```sh
relay login
```

Choose your sign-in provider and finish signing in through your browser.

## Sync an existing folder

```sh
relay clone
relay start
```

Choose your Relay and a shared folder. Relay CLI creates a local directory named
after that folder in the current directory. `relay start` starts background sync,
which keeps running after you close the terminal.

To choose the local directory yourself, use `relay clone ./notes`.

## Share a local folder

```sh
relay init ./notes --name Notes
relay connect ./notes
relay start
```

Choose the Relay to share it with. Relay CLI creates a shared folder from the
local files. If background sync is already running, you can omit `relay start`.

## Check and stop sync

```sh
relay status ./notes
relay sync-status ./notes
```

Run `relay disconnect ./notes` to stop syncing one folder, or `relay stop` to stop
background sync for all folders. `relay start` resumes sync for connected folders.
Run `relay --help` for the command list.

## Update

The installed CLI updates itself:

```sh
relay update --check
relay update
```

The updater checks the download's SHA-256 checksum and runs a verification
command before stopping sync. It waits for every daemon using this installation
to close, switches versions, and restarts those daemons with their state
directories and control endpoints. Login state and synced folders are preserved.
If replacement startup fails, it attempts to restore the previous executable
and daemons. It retains both executables if recovery needs manual attention.

Relay checks for newer releases daily and shows an update notice in interactive
terminals. These checks download only version information. Automatic installation
is off by default; we recommend enabling it to keep Relay up to date:

```sh
relay update --enable-automatic-updates
```

Automatic updates run while background sync is running. Use
`relay update --disable-automatic-updates` to turn them off.
`relay upgrade` is an alias for `relay update`, with the same options.
`relay update --pin` keeps the current
version until you run `relay update --unpin`. To select a specific published stable
version, run `relay update --version 1.2.3`. `relay version` shows the installed version.

Notices go to stderr, use yellow in supported terminals, and respect `NO_COLOR`.
They are suppressed for redirected commands, JSON output, and MCP. Version checks
are cached for a day, including failures, and have a short timeout so an offline
machine can still use the CLI. Foreground daemons also log newly discovered updates.

Executables are kept under `~/Library/Application Support/relay/versions` on
macOS, or `~/.local/share/relay-cli/versions` on Linux and WSL. Set
`RMD_INSTALL_DIR` and `RMD_BIN_DIR` to absolute paths during installation to choose
different locations. Updates discover the installation from the executable.
`XDG_DATA_HOME`, when set, changes the default data location to
`$XDG_DATA_HOME/relay-cli`.

Automatic update failures are recorded in `update.log` inside the installation
directory and retried the next day. An interrupted install or update can leave
`.install-lock` there; remove that empty directory only after confirming no
installer or updater is running. Restart stopped daemons with `relay start`, using
their original `--state-dir` and environment, including any `RMD_STORAGE_KEY_FILE`.
See [release maintenance](docs/releases.md) for recovery and packaging details.

## Preferences

User preferences live in `~/Library/Application Support/relay/config.toml` on
macOS, or `~/.config/relay/config.toml` on Linux and WSL.
`XDG_CONFIG_HOME` overrides either default with `$XDG_CONFIG_HOME/relay/config.toml`.
Defaults are:

```toml
[updates]
automatic = false
notify = true
# pinned_version = "1.2.3"

[logging]
debug = false
network = false

[security]
key_storage = "file" # opt in with "keychain"
```

The update and logging commands create or update this file. You can also edit
it directly. `updates.notify = false` disables incidental version checks and
notices; automatic installation is controlled independently by `updates.automatic`.
Preferences apply across this user's installations and daemon state directories.
Update policy is reread during checks; restart running daemons after editing
logging preferences by hand. `relay logging` applies changes immediately to the
selected daemon and saves them for future starts.

Folder identity stays in each synced folder's `.relay/config.toml`. Credentials,
connected-folder records, update timestamps, and caches are stored separately.
Daemon state lives in `~/Library/Application Support/relay/state` on macOS, or
`~/.local/state/relay` on Linux and WSL. Set `XDG_STATE_HOME` to use
`$XDG_STATE_HOME/relay`, or pass `--state-dir` to select a specific state directory.

## Automation

In non-interactive shells, pass `relay login --provider <name>` or
`relay login --token-file <path>`. Use `relay relays` and `relay folders` to find IDs,
then pass them explicitly:

```sh
relay clone ./notes --relay <relay-guid> --folder <folder-guid>
relay start
```

Login and sync use the production or staging endpoints selected when the CLI
is built. Folder metadata and saved logins are bound to that environment;
startup rejects mismatches before refreshing credentials.

## Headless Sync

`relay start` runs background sync for connected folders. `relay connect` registers
one local folder for sync. When a folder was created with `relay init`, connect
creates the remote shared folder through Relay and treats local disk as the
source of truth. `relay clone` connects to an existing remote folder and treats
the server as the source of truth during first materialization.

Relay CLI stores local folder metadata in `.relay/` inside each connected
folder. User login state and daemon state live in the user's state directory.
Symlinks and directory junctions are followed, including a linked sync root.
Their targets participate in sync under the link's local path; the link itself
is not recreated on other devices. Directory cycles and broken links are skipped.
Edits through links update their targets. Renaming or trashing a link moves the
link itself; deleting individual files inside a linked directory affects those
files. Relative links retain their stored target text when moved, just as with
filesystem rename, so moving one to a different parent may leave it broken.

The headless runtime gives Relay browser-like storage APIs backed by SQLite, so
local storage and IndexedDB state survive daemon restarts.

SQLite record values, including IndexedDB keys and values, are encrypted with
authenticated AES-256-GCM before they reach the database. By default, Relay
creates a random master key in `storage.key` in the state directory with Unix
mode `0600`. Keep that file with the database when restoring file-backed state;
losing it makes the encrypted store unreadable. Someone who obtains both files
can decrypt the stored credentials and other encrypted records.

To keep the key outside Relay's state directory, set this in your user
`config.toml` before first login:

```toml
[security]
key_storage = "keychain"
```

On macOS, this uses Keychain. On Linux and WSL, it requires `secret-tool`
(`libsecret-tools` on Debian/Ubuntu) and a running Secret Service with a persistent
default collection. Relay does not use the Linux kernel's volatile keyring.
Keychain mode stops with an error if access fails; it never falls back to a key
file. The state directory contains a non-secret `storage.keychain` identifier,
which must be preserved with the database. Restoring that state also requires
the corresponding OS keychain entry.

Choose the backend before creating state. Changing the setting does not convert
existing state: stop Relay, select a fresh state directory using `XDG_STATE_HOME`
or `--state-dir`, then log in and reconnect your folders. Preserve the original
state and its key until no longer needed. Restart daemons after changing the
setting. `relay auth status` reports the selected key backend.

Automation can provide a managed key through `RMD_STORAGE_KEY_FILE`. That file
must be owner-only and contain exactly 64 hexadecimal characters. This explicit
override takes precedence over `security.key_storage`, including keychain mode.
Relay never falls back to plaintext or generates a replacement key for an
existing database whose original key is missing.

Keychain mode protects a backup containing only Relay's encrypted state from
being decrypted on its own. It does not guarantee that credentials are absent
from a full-machine backup: OS keychains can also be backed up, and macOS
[keychain files can be copied](https://support.apple.com/en-lb/guide/keychain-access/kyca1121/mac).
Review your backup scope, protect backups with encryption, and remember that
older backups may already contain `storage.key`. Keychain storage does not
protect against a process running as your logged-in user.

## Local Data

Each synced folder has a `.relay/` directory. It stores the folder identity,
local Relay settings, and durable sync state for that folder. The daemon uses a
per-user state directory for login state, control socket metadata, and shared
browser-like storage. Login tokens are stored inside the encrypted browser
store; `--token-file` is an input mechanism for automation and is not copied to
`tokens.json`.

`relay logout` stops the daemon for the selected state directory and waits for
it to exit before clearing the local login and cached authentication records.
If the live daemon cannot be reached or stopped, logout fails without clearing
those records. Other state directories are unaffected. Logout does not revoke
server-side tokens, erase earlier backups, or remove a token supplied in your
own `--token-file`.

## Daemon

`relay start` runs a per-user background daemon. Connected folders are discovered
from daemon state, watched on disk, and synced through Relay until disconnected
or until the daemon is stopped.

TCP control requires a fresh per-daemon credential from `control.json` in the
daemon's state directory. CLI commands load it automatically. When supplying
`--control tcp://127.0.0.1:<port>`, also supply the daemon's `--state-dir` if it
uses a nondefault directory. Raw clients send the credential as `authToken` in
each JSON request. Control connections accept one newline-terminated request
of at most 1 MiB; Unix sockets use owner-only permissions.

## Development

Use Node 22.13 or newer within Node 22, or Node 24.17 or newer within Node 24.
Install a current patch release from one of these supported branches. The CLI
requires the built-in `node:sqlite` API. Node remains supported for source
development. Standalone releases use the Bun version pinned in
`.bun-version`; they include the sync runtime and native keychain addon.

From a source checkout, install dependencies and build the headless runtime:

```sh
npm ci
npm run check
node bin/relay.js --help
```

Run `npm link` to make the `relay` command available on your machine.

The default build targets production (`auth.system3.md` and `api.system3.md`).
For development against staging, run:

```sh
npm run build:staging
```

That build targets `auth.system3.dev` and `api.system3.dev`, following Relay's
build convention. Login and sync read the same built configuration. Use separate
folders and a separate `--state-dir` for staging. Stop running daemons before
switching builds, then start them using the intended build. Run `npm run build:headless`
to restore production; `npm run check` and `npm test` also rebuild production.
Endpoint selection is a build setting; `--server` and `RELAY_SERVER_URL` are
unsupported, and the build rejects the old endpoint URL environment overrides.

Unit tests in `__tests__/` use `git-crypt`. Contributors with the repository key
can unlock them and run the suite:

```sh
git-crypt unlock /path/to/relay-cli.key
npm test
```

Build checks work with encrypted tests still locked. The private development
overlay supplies integration tests and live staging tooling; these are not
required to build or run the CLI.

Public CI runs clean Node builds with locked unit tests and no private harness,
plus standalone packaging, installation, local-folder and daemon smoke checks
on Linux and macOS for both architectures. Require the
`Public build` check before merging. Maintainers
run the private unit and integration workflow against the same reviewed commit
before release. Vendored source provenance and updates are documented in
[vendor/relay/README.md](vendor/relay/README.md).
See [release maintenance](docs/releases.md) for building and publishing executables.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution and support guidance.
Report vulnerabilities privately to [security@system3.md](mailto:security@system3.md);
the supported-code and disclosure policy is in [SECURITY.md](SECURITY.md).

## License

Relay CLI's product code is [MIT licensed](LICENSE), copyright No Instructions,
LLC. Vendored components retain their own licenses and
[third-party notices](vendor/relay/THIRD_PARTY_NOTICES.md).
The encrypted unit tests and private development harness are proprietary and
are not covered by the product's MIT license.
