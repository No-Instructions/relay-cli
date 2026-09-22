# CLI Contract

Relay CLI runs Relay in headless mode for local folders.

The user-facing model is:

- `rmd start` starts background sync.
- `rmd stop` stops background sync.
- `rmd init <folder>` prepares a local folder for Relay.
- `rmd clone <folder>` copies an existing Relay folder to this machine.
- `rmd connect <folder>` starts syncing a local folder.
- `rmd disconnect <folder>` stops syncing a local folder without deleting files.
- `rmd status [folder]` reports background sync and folder sync state.
- `rmd sync-status [folder]` reports per-file sync status from the running
  headless runtime.
- `rmd logging [status|enable|disable] [--network]` controls daemon-wide debug
  logging through the running daemon.
- `rmd relays` lists relays available to the logged-in user.
- `rmd folders` lists remote folders, and local folders when scoped to a running
  headless runtime.

`rmd connect` is the transition from a local initialized folder to a remote
Relay folder. If the folder was created with `rmd init`, the daemon creates the
remote shared folder through upstream Relay code and treats local disk as
authoritative. `rmd clone` records an existing remote folder and auto-connects
it as server-authoritative.

In interactive terminals, `rmd connect` may prompt for a Relay when `--relay` is
omitted, and `rmd clone` may prompt for both a Relay and remote folder when
`--relay` or `--folder` are omitted. Non-interactive invocations must pass GUIDs
explicitly.

## Local Folder State

Each synced local folder has a `.relay/` directory. This stores local Relay
identity and control-plane state for that folder.

User login state and daemon state do not belong in `.relay/`. They live in the
user's state directory.

The headless runtime exposes browser-like `localStorage` and `indexedDB`
capabilities to the copied Relay plugin code. Both are backed by SQLite so
upstream y-indexeddb document updates, HSM persistence, content-addressed hash
records, PocketBase auth state, and Relay local storage survive daemon restarts.

## Background Sync

The daemon is global and per-user. It manages any folders registered with
`rmd connect` or `rmd clone`.

The daemon owns file watching, scheduling, runtime lifecycle, remote sync, and
headless Relay execution. CLI commands may update local metadata and request
daemon actions, but they do not implement sync behavior themselves.

`rmd logging` talks to the daemon control endpoint. Logging settings are stored
in daemon-wide plugin data, and the daemon applies changes to any active
headless runtimes. `--network` controls the upstream Relay network logging flag;
enabling network logging also enables debug logging.

## Headless Boundary

Relay CLI must run Relay sync logic in the headless runtime. The CLI and host
substrate must not duplicate product behavior such as:

- CRDT synthesis
- remote folder hydration
- conflict resolution
- HSM state transitions
- RelayDebugAPI method tables

RelayDebugAPI methods are opaque method names forwarded to the runtime.
Registered upstream Relay CLI handlers are also forwarded as opaque command
names; the host CLI does not keep a second table of handler methods.

## Steel Thread

The primary proof is Dropbox-like staging sync:

1. Start the daemon.
2. Log in against staging.
3. Initialize and connect local folder A.
4. Clone the same Relay folder into local folder B.
5. Edit real Markdown files on disk in folder A.
6. Wait for folder B to receive the same content through Relay.
7. Edit the file in folder B.
8. Wait for folder A to receive the change.
9. Verify through CLI/control APIs, not direct database reads.
10. Clean up the remote staging folder.

The broader staging suite keeps the same black-box contract and extends it with
nested folders, binary assets, raw filesystem moves, delete propagation, daemon
restart, and offline changes created while the daemon is stopped.
