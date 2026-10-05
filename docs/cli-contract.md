# relay(1)

## NAME

relay — synchronize local folders with Relay

## SYNOPSIS

```text
relay <command> [arguments] [options]
relay help [command...]
relay help --all
```

## DESCRIPTION

Relay synchronizes selected local folders through a background daemon. `clone`
downloads an existing shared folder. `init` prepares a local folder; `connect`
registers it for synchronization. `start` runs the daemon and `stop` stops it.

When connecting a newly initialized folder, local files supply its initial
content. A clone takes its initial content from the remote folder.

## COMMANDS

| Command | Description |
| --- | --- |
| `login` | Sign in through OAuth or store a supplied token. |
| `logout` | Stop the selected daemon and clear its saved login. |
| `auth status` | Show login status and credential-storage backend. |
| `start`, `stop` | Start or stop background synchronization. |
| `init [path]` | Prepare a local folder. |
| `clone [path]` | Download and connect an existing shared folder. |
| `connect [path]` | Connect a local folder to Relay. |
| `disconnect [path]` | Stop syncing a folder and retain its files. |
| `status [path]` | Show daemon and folder status. |
| `sync-status [path]` | Show per-file synchronization status. |
| `servers` | List Relay Servers; `--relay` optionally filters by name or GUID. |
| `server [name-or-guid]` | Inspect one Relay Server. `--relay` also selects it. |
| `server create`, `server register`, `server rename` | Create a server, register a self-hosted URL, or rename a server. |
| `server roles`, `server role remove` | List or remove server members. |
| `server leave`, `server delete` | Leave a server or delete an owned server. |
| `remote folders`, `remote folder [name-or-guid]` | List or inspect server folders. |
| `remote folder roles`, `remote folder role add`, `remote folder role remove` | List or change folder access. |
| `remote folder delete` | Delete a server folder; local files remain. |
| `relays`, `folders` | List remote membership and shared folders. |
| `documents roots` | List connected local roots. |
| `documents list` | List indexed shared documents. |
| `documents search query` | Search shared text, including unsaved editor content. |
| `documents read path` | Read active editor text or disk text. |
| `agent create`, `agent list`, `agent show` | Register and inspect agent identities. |
| `mcp` | Serve document editing tools over stdio. |
| `mcp tools` | Print MCP tool arguments and results. |
| `mcp install <claude|codex>` | Register MCP with a client. |
| `obsidian command` | Run an Obsidian app or plugin command. |
| `logging status`, `logging enable`, `logging disable` | Read or change logging settings. |
| `version` | Print the installed version. Aliases: `--version`, `-v`. |
| `update` | Manage installed releases. Alias: `upgrade`. |
| `debug relay-cli command` | Run a registered command in the daemon. |
| `debug relay-debug method` | Call a daemon diagnostic method. |

Run `relay <command> --help` for its arguments, options, defaults and limits.
`relay help --all` prints the complete command reference.

Account commands (`servers`, `server`, and `remote`) use saved login credentials
without starting the sync daemon or selecting a local folder. Omitted collection
filters include all accessible servers or folders. Mutations require explicit
selectors. Collections print tab-separated rows; `--json` prints structured
results. `server register --url https://host.example` registers a self-hosted URL;
it does not generate host configuration or start a server.

These commands share their definitions and server handlers with the Obsidian
plugin. The standalone grammar uses spaces and accepts both `--relay value` and
`--relay=value`. See [shared command maintenance](shared-commands.md).

## OPTIONS

Options belong to individual commands. Common options, where supported:

| Option | Description |
| --- | --- |
| `--state-dir directory` | Select daemon state and login credentials. |
| `--control endpoint` | Select a Unix socket or authenticated loopback TCP endpoint. |
| `--repo folder` | Select a connected local root. |
| `--json` | Print structured output. |
| `-h`, `--help` | Print usage and exit. |

## EXAMPLES

Download a folder interactively:

```sh
relay login
relay clone ./notes
relay start
```

Download a known folder from a script:

```sh
relay login --token-file /path/to/token
relay clone ./notes --relay <relay-guid> --folder <folder-guid>
relay start
```

Share local files:

```sh
relay init ./notes
relay connect ./notes --relay <relay-guid>
relay start
```

Inspect synchronization and search text:

```sh
relay status ./notes
relay sync-status ./notes
relay documents search "open questions" --repo ./notes --json
```

`clone` and `connect` prompt for remote selections in interactive terminals.
Scripts must supply the relevant GUIDs. Use `relays` and `folders` to find them.

## FILES

Each connected folder contains `.relay/config.toml` with its folder identity.
Daemon state contains credentials, registrations, caches and synchronization data.
User preferences are stored separately; see [preferences](../README.md#preferences).

The default storage key is an owner-only file in the state directory. Set
`[security] key_storage = "keychain"` in preferences to use the OS keychain.
Linux keychain storage requires `secret-tool` and a persistent Secret Service.
`RMD_STORAGE_KEY_FILE` selects an explicit key file. Keychain failures do not
fall back to another key. See [storage and backup](../README.md#headless-sync).

## EXIT STATUS

Zero indicates success. Nonzero indicates invalid arguments or a command failure.
JSON output does not change error handling. MCP results additionally report
whether an edit was accepted or a local save completed; see [relay-mcp](mcp.md).

## SEE ALSO

[relay-mcp](mcp.md), [relay-agent](agents.md), [relay-obsidian](obsidian.md),
[installation and releases](releases.md)
