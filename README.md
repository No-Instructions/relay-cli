# Relay CLI

Relay CLI runs Relay in headless mode.

Use it to keep local folders synced with Relay from the command line, without
opening Obsidian. It is built for background sync on servers, developer
machines, scripts, and AI workflows that edit Markdown files directly.

## Commands

```text
rmd login
rmd start
rmd init ./notes --name Notes
rmd connect ./notes --relay <relay-guid>
rmd status ./notes
rmd sync-status ./notes
rmd relays
rmd folders
rmd disconnect ./notes
rmd stop
```

`rmd login` prompts for an OAuth provider in an interactive terminal. In
non-interactive shells, pass `--provider <name>` or `--token-file <path>`.
Login and sync use the production or staging endpoints selected when the CLI
is built. Folder metadata and saved logins are bound to that environment;
startup rejects mismatches before refreshing credentials.

To copy an existing Relay folder to this machine:

```text
rmd clone ./notes --relay <relay-guid> --folder <folder-guid>
```

When run from an interactive terminal, `rmd connect` can prompt for a Relay and
`rmd clone` can prompt for both the Relay and remote folder. In scripts, pass the
GUIDs explicitly.

## Headless Sync

`rmd start` runs background sync for connected folders. `rmd connect` starts
syncing one local folder. When a folder was created with `rmd init`, connect
creates the remote shared folder through Relay and treats local disk as the
source of truth. `rmd clone` connects to an existing remote folder and treats
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
authenticated AES-256-GCM before they reach the database. Interactive installs
keep the random storage master key in the operating system keychain. If the
keychain is unavailable when a fresh store is created, Relay CLI automatically
creates `storage.key` in the state directory with mode `0600`. Back up this file
with the state directory; losing it makes the encrypted store unreadable.

Headless servers can instead provide a managed key through
`RMD_STORAGE_KEY_FILE`; the file must be owner-only and contain exactly 64
hexadecimal characters. An explicit key file takes precedence over both the
automatic file and the system keychain. Relay CLI never falls back to plaintext
storage.

If an encrypted database already exists without `storage.key`, a missing or
temporarily unavailable keychain causes startup to stop. Relay CLI will not
silently create a replacement key that cannot decrypt existing data.

Plaintext databases from builds that predate storage encryption are rejected
rather than migrated. Remove `browser.db`, `browser.db-wal`, and
`browser.db-shm` from the state directory and run `rmd login` again to create a
fresh encrypted store.

## Local Data

Each synced folder has a `.relay/` directory. It stores the folder identity,
local Relay settings, and durable sync state for that folder. The daemon uses a
per-user state directory for login state, control socket metadata, and shared
browser-like storage. Login tokens are stored inside the encrypted browser
store; `--token-file` is an input mechanism for automation and is not copied to
`tokens.json`.

## Daemon

`rmd start` runs a per-user background daemon. Connected folders are discovered
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
requires the built-in `node:sqlite` API. Linux is the validated runtime platform;
the public CI build matrix also targets macOS and Windows, whose runtime behavior
has not yet been validated.

From a source checkout, install dependencies and build the headless runtime:

```sh
npm ci
npm run check
node bin/rmd.js --help
```

Run `npm link` to make the `rmd` command available on your machine.

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

Public CI runs clean builds and a CLI help check with locked unit tests and no
private harness. Require the `Public build` check before merging. Maintainers
run the private unit and integration workflow against the same reviewed commit
before release. Vendored source provenance and updates are documented in
[vendor/relay/README.md](vendor/relay/README.md).

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
