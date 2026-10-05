import { serverCommandHelp, serverRoots } from "./server-command.js";
import { mcpReference } from "./mcp-reference.js";

const state = `  --state-dir <directory>  Select daemon state (default: platform/XDG state directory)`;
const control = `  --control <endpoint>     Select unix:///path or loopback tcp://host:port;
                           TCP credentials come from the selected state directory`;
const json = `  --json                   Print JSON instead of human-readable output`;
const format = `${json}
  --format <text|json>      Alternative output-format selector (default: text)`;
const repo = `  --repo <folder>          Select an exact connected local folder root`;
const ipc = `${state}\n${control}`;
const query = `${repo}\n${ipc}\n${format}\n  --no-refresh             Use cached remote membership instead of refreshing it`;
const helpFlag = `  -h, --help               Show this help without performing the command`;

export const commandHelp = {
  ...Object.fromEntries(serverRoots.map(name => [name, serverCommandHelp([name])])),
  login: `Usage: relay login [options]
Sign in through OAuth, or store a supplied bearer token. Provider selection is
interactive unless --provider is given. Token input skips OAuth.

Options:
  --provider <name>         OAuth provider name (required in unattended OAuth)
  --no-open                Print the authorization URL without opening a browser
  --timeout-seconds <n>    OAuth polling deadline in seconds (default: 30)
  --token-file <path>       Read a token from this file
  --token <value>           Supply a token directly; mutually exclusive with --token-file
${state}

Example: relay login --provider google --no-open`,
  logout: `Usage: relay logout [options]
Stop the daemon for this state directory and clear its local credentials.
Server-side tokens are not revoked. Other state directories are unaffected.

Options:
${state}`,
  auth: `Usage: relay auth status [options]
Report local login status and the credential-storage backend, without printing tokens.

Options:
${state}`,
  start: `Usage: relay start [options]
Start background synchronization for connected folders. Already running is a no-op.

Options:
  --foreground             Run in this terminal instead of detaching
${ipc}

The default control endpoint is a Unix socket, or loopback TCP where unavailable.
Use tcp://127.0.0.1:0 to allocate a local port.`,
  stop: `Usage: relay stop [options]
Stop the selected daemon without deleting local files or credentials.

Options:
${ipc}`,
  init: `Usage: relay init [path] [options]
Prepare a local folder and index its Markdown files. Path defaults to the current
directory. Creates .relay metadata; does not connect unless --connect is given.

Options:
  --name <name>             Folder display name (default: directory name)
  --connect                Also register the folder for synchronization
  --relay <guid>            Relay to use with --connect; otherwise prompt interactively
${repo}
${ipc}

The query options select the runtime used for Relay selection with --connect.`,
  clone: `Usage: relay clone [path] --relay <guid> --folder <guid> [options]
Prepare and connect a local copy of an existing remote folder. Interactive use can
choose Relay/folder and derive a directory name. Unattended use requires both IDs
and a destination path. Content arrives through daemon synchronization.

Options:
  --relay <guid>            Remote Relay ID
  --folder <guid>           Remote shared-folder ID
  --name <name>             Override the local display name
  --no-connect             Prepare metadata without registering synchronization
${repo}
${ipc}

--repo selects the runtime used to discover remote folders, not the destination.`,
  connect: `Usage: relay connect [path] [options]
Register an initialized local folder for synchronization. Path defaults to the
current directory; a parent .relay folder is found when invoked from within it.
For an unassigned folder, --relay is required outside an interactive terminal.

Options:
  --relay <guid>            Relay for a folder that is not yet assigned
${repo}
${ipc}

--repo selects the runtime used for interactive Relay selection.
Run relay start to begin synchronization if the daemon is stopped.`,
  disconnect: `Usage: relay disconnect [path] [options]
Unregister a local folder and refresh the daemon. Files and .relay metadata stay.
Path defaults to the current directory; a parent .relay folder is accepted.

Options:
${ipc}`,
  status: `Usage: relay status [path] [options]
Report daemon state, connected roots, and the current folder when available.
Path defaults to the current directory. JSON includes the daemon's runtime details.

Options:
${ipc}
${json}`,
  "sync-status": `Usage: relay sync-status [path] [options]
Report indexed files' synchronization state in a connected folder. Path defaults
to the current directory. Requires the daemon; this is not an edit acknowledgement.

Options:
${ipc}
${format}`,
  logging: `Usage: relay logging <status|enable|disable> [options]
Inspect or change daemon-wide logging preferences. With no arguments, status is
selected. Requires the daemon; preferences persist in config.toml.

Options:
  --network                Enable network logging as well as debug logging, or
                           disable only network logging with the disable action
${ipc}
${format}

disable without --network disables both debug and network logging.`,
  relays: `Usage: relay relays [options]
List accessible Relays. Uses the running daemon when available, otherwise an
authenticated temporary query runtime.

Options:
  --id <id>                Filter by Relay ID
${query}`,
  folders: `Usage: relay folders [options]
List remote folders and folders in a selected local runtime. Inside a Relay folder,
that folder selects the runtime. Otherwise the default scope is remote.
Use relay documents roots to list exact connected local roots for document tools.

Options:
  --scope <local|remote|all> Choose folder scope
  --path <path>             Filter by local folder path
  --guid <guid>             Filter by shared-folder GUID
  --relay <guid>            Filter by Relay GUID
${query}`,
  documents: `Usage: relay documents <roots|list|search|read> [options]
List and read shared documents through the running daemon.

Commands:
  roots                    List exact connected local roots
  list                     List indexed shared documents
  search <query>           Search literal text, including unsaved editor content
  read <path>              Read current text; path is relative to --repo

Run relay documents <command> --help for all options and limits.`,
  "documents roots": `Usage: relay documents roots [options]
List connected local roots and runtime availability. Use these roots with --repo
or the MCP folder argument. Requires the selected daemon.

Options:
${state}
${json}`,
  "documents list": `Usage: relay documents list [options]
List indexed shared text documents and whether an editor is open.

Options:
${repo} (default: enclosing .relay root)
  --prefix <path>           Restrict paths (default: all documents)
  --offset <n>              Zero-based document offset (default: 0)
  --limit <n>               Page size, 1–200 (default: 100)
${state}
${json}

Follow nextOffset for another page. Concurrent changes can shift offsets.`,
  "documents search": `Usage: relay documents search <query> [options]
Search a literal, single-line string of 1–256 characters, not a regular expression.
Reads active editor text before disk. Results include snippets, line numbers,
UTF-16 offsets and their text source; remote synchronization may still be pending.

Options:
${repo} (default: enclosing .relay root)
  --prefix <path>           Restrict document paths (default: all documents)
  --offset <n>              Zero-based document offset (default: 0)
  --case-sensitive          Match case (default: case-insensitive)
${state}
${json}

A page scans at most 50 documents or 2 Mi characters, returns up to five matches
per document, and limits snippets to 240 characters. Follow nextOffset even for
empty pages. Skipped documents are reported; concurrent changes can shift offsets.
Example: relay documents search "open questions" --repo ~/notes --json`,
  "documents read": `Usage: relay documents read <path> [options]
Read a shared text document without joining an editor. Prefer active unsaved text,
otherwise disk. Path is relative to the selected root; traversal and .relay paths
are rejected. User-created symlinks follow the selected sync set.

Options:
${repo} (default: enclosing .relay root)
${state}
${json}

Plain output is the exact text. JSON also identifies path and text source.
Reads are limited to 128 Ki UTF-16 code units. Remote sync may still be pending.`,
  mcp: `Usage: relay mcp [options]
Serve document editing, comments, notifications and CLI commands over MCP stdio.
Document tools require a running daemon. Start it with relay start.

Options:
${repo} (default: require a folder on document calls)
${state}
  --agent <id>              Select an owned user_agents record by ID
  --agent-name <name>       Select an owned agent by name (default: MCP host name)
  --read-only               Read and follow documents and comments without editing

Register the agent first with relay agent create --name <name>. Its identity is
returned when opening a document. --agent takes precedence over --agent-name.
Tokens retain the logged-in user's permissions. Remote editing requires agent claims.
--repo scopes direct document tools; relay_cli has the ordinary CLI's administrative
authority and uses that folder as its working directory, not as a sandbox.
With --read-only, documents can be opened for presence and reading but not edited,
comments are read-only, and relay_cli runs only status, sync-status, relays,
folders, documents, version, mcp tools and help.

Commands:
  install <claude|codex>    Register with a host; see relay mcp install --help
  tools                    Print the tool reference`,
  "mcp tools": mcpReference,
  "mcp install": `Usage: relay mcp install <claude|codex> [options]
Register the stdio server using the installed host CLI. Both default to user scope
and server name relay. Existing entries are preserved. Restart/reload the host
after installing; registration does not start the daemon.

Options:
${repo} (default: all connected roots)
${state} (resolved and recorded in registration)
  --name <name>             Server registration name (default: relay)
  --agent <id>              Select an owned user_agents record by ID
  --agent-name <name>       Select an owned agent by name (default: Claude or Codex)
  --read-only               Register a server that cannot edit documents
  --scope <scope>           Claude: user, local, project; Codex: user only
  --dry-run                Print registration JSON without invoking the host CLI

Registration paths are absolute. Managed installations follow current/relay.
Remove an entry with codex mcp remove <name> or claude mcp remove --scope <scope>
<name>, or choose another --name. Configuration scope does not grant permissions.`,
  agent: `Usage: relay agent <create|list|show> [options]
Register and inspect agents owned by the logged-in user in user_agents.
These records supply the authorId for Relay Comments and agent claim for document
tokens. Commands use the selected build's auth service; no daemon is required.

Commands:
  create --name <name>      Create/reuse an owned agent and upload a seeded avatar
  list                     List owned agents
  show <id>                Inspect an owned agent

Run relay agent <command> --help for every option.`,
  "agent create": `Usage: relay agent create --name <name> [options]
Register an agent with a generated avatar. Reuse an existing agent with the same
name under the logged-in user.

Options:
  --name <name>             Required display name, 1–100 characters; no control
                           characters, quotes, or markup delimiters
${state}
${json}

JSON returns {agent,created}; agent includes id,user,name,picture,color,colorLight.
Use that id as Relay Comments authorId, or pass --agent <id> to relay mcp install.
Example: relay agent create --name Codex --json`,
  "agent list": `Usage: relay agent list [options]
List only the logged-in user's user_agents records, sorted by name and ID.

Options:
  --page <n>               One-based page (default: 1)
  --limit <n>              Page size, 1–200 (default: 100)
${state}
${json}

JSON returns agents and nextPage. No credentials are returned.`,
  "agent show": `Usage: relay agent show <id> [options]
Read one owned user_agents record and its public comment/presence profile.
Other users' IDs are rejected even if the collection permits reading them.

Options:
${state}
${json}`,
  version: `Usage: relay version [options]
Show the release version. Source checkouts report source.

Options:
${json}
  --verify                 Check build/runtime metadata and native keychain loading

Aliases: relay --version, relay -v`,
  update: `Usage: relay update [options]
Update an installer-managed release; no options selects the latest version.
Only one action may be selected. Source checkouts are updated through Git.

Options:
  --check                  Check availability without installing
  --version <version>      Install an explicit version, including a rollback
  --enable-automatic-updates  Enable scheduled update installation (default: off)
  --disable-automatic-updates Disable scheduled update installation
  --auto <on|off>           Alias for enabling/disabling automatic updates
  --pin                    Pin the currently installed version
  --unpin                  Clear the version pin

Alias: relay upgrade. Latest-version updates never silently downgrade.`,
  obsidian: `Usage: relay obsidian [options] <command> [Obsidian arguments...]
Control the running Obsidian app through its installed CLI socket client.
No Relay daemon or plugin is required for general Obsidian commands.

Options (before the command):
  --vault <name-or-id>      Target vault; forwarded first as vault=<value>
  --executable <path>       Obsidian CLI client (default: OBSIDIAN_CLI or obsidian on PATH)
  --timeout-ms <ms>         Deadline from 1 to 45000 ms (default: 30000)
  --json                   Wrap output as {ok,exitCode,stdout,stderr,...}
  --                       End Relay options; subsequent arguments pass unchanged

Arguments use Obsidian syntax: key=value parameters and bare boolean flags.
Relay options must precede the command. Without --vault, Obsidian uses the
working directory or its active vault. Use an explicit vault for mutations.

Help:
  relay obsidian help
  relay obsidian help plugin:install
  relay obsidian --vault Notes help relay

Vaults and plugins:
  relay obsidian vaults verbose
  relay obsidian --vault Notes vault
  relay obsidian --vault Notes plugins filter=community versions format=json
  relay obsidian --vault Notes plugin:install id=system3-relay enable
  relay obsidian --vault Notes plugin:install id=relay-comments enable
  relay obsidian --vault Notes plugin:reload id=system3-relay
  relay obsidian --vault Notes plugin:disable id=relay-comments
  relay obsidian --vault Notes plugin:uninstall id=relay-comments

Relay plugin:
  relay obsidian --vault Notes relay format=json
  relay obsidian --vault Notes relay:conflicts format=json
  relay obsidian --vault Notes help relay:shared-folder

Debug the running app:
  relay obsidian --vault Notes dev:errors
  relay obsidian --vault Notes dev:console limit=20 level=error
  relay obsidian --vault Notes eval 'code=app.vault.getName()'
  relay obsidian --vault Notes dev:cdp method=Runtime.getHeapUsage
  relay obsidian --vault Notes dev:screenshot path=/tmp/obsidian.png

Enable Command line interface in Obsidian Settings → General and keep the app
running with the vault open. Use its native client, not an Electron launcher.
Commands receive literal arguments and run noninteractively. Output is captured
up to 4 MiB. --json preserves the process exitCode and marks
recognized error text or Relay JSON failures with commandError:true and ok:false;
Relay exits nonzero for those failures. Other plugin output is passed through.
A timeout/cancellation may leave a change applied: inspect before retrying.
MCP relay_cli can invoke these commands, subject to its own smaller output limit.
Obsidian access has the app's full authority, including eval and plugin changes.`,
  debug: `Usage: relay debug <relay-debug|relay-cli> <method> --control <endpoint> [options]
Forward an upstream debug method or registered CLI command to the daemon.

Options:
${control}
${state}
${repo}
  --params-json <json>      Debug: JSON array (default: []); CLI: object (default: {})
  --json                   Pretty-print the full response (default: compact JSON)

Example: relay debug relay-cli relay:help --control unix:///path/to/daemon.sock`,
};

const overview = `Relay CLI

Usage: relay <command> [options]

Commands:
  login, logout, auth status  Authentication and credential status
  start, stop                 Background synchronization
  init, clone, connect, disconnect  Select local and remote folders to sync
  status, sync-status         Daemon and per-file synchronization status
  servers, server, remote    Server administration and remote folders
  relays, folders             Remote membership and folder discovery
  documents roots|list|search|read  Discover and read live shared documents
  mcp                        Realtime document collaboration over stdio
  mcp install, mcp tools      Host setup and full tool reference
  agent create|list|show      Registered agents for Relay Comments and MCP
  obsidian                   Vaults, plugins and debugging through Obsidian's CLI
  logging status|enable|disable    Persistent logging preferences
  version                    Release version (--version, -v)
  update                     Install/check releases (alias: upgrade)
  debug                      Forward diagnostic requests

Help:
  relay <command> --help      Every option, default, argument and example
  relay help <command>       Equivalent form, including subcommands
  relay help --all           Complete command reference`;

export function helpText(topic = "") {
  if (!topic) return overview;
  if (topic === "--all") return [overview, ...Object.keys(commandHelp).map(helpText)].join("\n\n");
  if (serverRoots.includes(topic.split(" ")[0])) return serverCommandHelp(topic.split(" "));
  const canonical = topic === "upgrade" ? "update" : topic;
  const parts = canonical.split(" ");
  const parent = { auth: ["status"], logging: ["status", "enable", "disable"], debug: ["relay-cli", "relay-debug"] };
  const page = commandHelp[canonical] ?? (parts.length === 2 && parent[parts[0]]?.includes(parts[1]) ? commandHelp[parts[0]] : undefined);
  if (!page) throw new Error(`Unknown help topic: ${topic}. Run relay --help.`);
  return `${page}\n${helpFlag}`;
}

// Called before update checks, authentication, imports or command mutations.
export function requestedHelp(argv) {
  if (!argv.length) return "";
  if (argv[0] === "help") return argv.slice(1).join(" ");
  if (["--help", "-h"].includes(argv[0])) return argv.includes("--all") ? "--all" : "";
  if (!argv.some(arg => ["--help", "-h"].includes(arg))) return null;
  const command = argv[0];
  if (["mcp", "documents", "agent"].includes(command)) {
    const subcommand = argv[1];
    if (subcommand && !subcommand.startsWith("-")) return `${command} ${subcommand}`;
  }
  return command;
}
