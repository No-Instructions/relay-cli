# relay-obsidian(1)

## NAME

relay-obsidian — run commands in Obsidian

## SYNOPSIS

```text
relay obsidian [options] <command> [arguments...]
```

## DESCRIPTION

Run the installed Obsidian CLI client. Obsidian must be running with **Command
line interface** enabled in General settings. A Relay daemon is not required.

Options precede the command. Subsequent arguments use Obsidian syntax:
`key=value` parameters and bare boolean flags. Arguments pass literally.
Without a vault selector, Obsidian uses the working directory or active vault.

## OPTIONS

| Option | Description |
| --- | --- |
| `--vault name-or-id` | Target vault. Passed as the first `vault=` argument. |
| `--executable path` | CLI executable. Default: `OBSIDIAN_CLI`, then `obsidian` on `PATH`. |
| `--timeout-ms ms` | Deadline: 1–45000 milliseconds. Default: 30000. |
| `--json` | Wrap output as `{ok,exitCode,stdout,stderr,...}`. |
| `--` | End Relay options. |
| `-h`, `--help` | Print adapter usage and exit. |

`format=json` is an Obsidian argument, separate from Relay's `--json` option.

## COMMANDS

```sh
relay obsidian help
relay obsidian help plugin:install
relay obsidian --vault Notes help relay:shared-folder
```

The installed app and plugins define available commands and arguments.
`relay` and `relay:*` address the Obsidian Relay plugin; `relay debug` addresses
Relay's headless daemon.

## EXAMPLES

List vaults and installed plugins:

```sh
relay obsidian vaults verbose
relay obsidian --vault Notes vault
relay obsidian --vault Notes plugins filter=community versions format=json
```

Install, reload, disable, or uninstall plugins:

```sh
relay obsidian --vault Notes plugin:install id=system3-relay enable
relay obsidian --vault Notes plugin:install id=relay-comments enable
relay obsidian --vault Notes plugin:reload id=system3-relay
relay obsidian --vault Notes plugin:disable id=relay-comments
relay obsidian --vault Notes plugin:uninstall id=relay-comments
```

Installation uses Obsidian's community-plugin catalog and restricted-mode rules.

Inspect Relay and the running app:

```sh
relay obsidian --vault Notes relay format=json
relay obsidian --vault Notes relay:conflicts format=json
relay obsidian --vault Notes dev:errors
relay obsidian --vault Notes dev:console limit=20 level=error
relay obsidian --vault Notes eval 'code=app.vault.getName()'
relay obsidian --vault Notes dev:cdp method=Runtime.getHeapUsage
relay obsidian --vault Notes dev:screenshot path=/tmp/obsidian.png
```

Through the MCP `relay_cli` tool:

```json
{"args":["obsidian","--vault","Notes","relay:conflicts","format=json"]}
```

## EXIT STATUS

Zero indicates success. Nonzero indicates a client failure, execution limit, or
recognized error response. Some Obsidian/plugin versions print errors with status
zero. Relay detects operational error text in plugin management, `eval`, help,
and Relay commands, plus Relay JSON containing `ok:false`.

With `--json`, `exitCode` preserves the client's status and `commandError:true`
identifies a recognized response error. Other output passes unchanged.

## LIMITS

Commands run noninteractively. Output capture is limited to 4 MiB. The MCP
`relay_cli` tool applies its own smaller limits; save screenshots to a path.
A timeout or cancellation may occur after a change is applied. Inspect the vault
before retrying. Commands are not retried automatically.

Obsidian commands have the app's authority, including plugin changes and `eval`.
The MCP `--repo` setting does not restrict Obsidian vault access.

## SEE ALSO

[Obsidian CLI](https://help.obsidian.md/cli), [relay-mcp](mcp.md)
