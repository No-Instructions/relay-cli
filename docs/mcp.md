# relay-mcp(1)

## NAME

relay-mcp — edit shared documents through MCP

## SYNOPSIS

```text
relay mcp [--repo folder] [--state-dir directory] [--agent id | --agent-name name]
relay mcp tools
relay mcp install <claude|codex> [options]
```

## DESCRIPTION

Serve MCP over standard input and output. Diagnostics go to standard error.
Document tools connect to the daemon started by `relay start`. Use the same
`--state-dir` for the daemon and MCP server.

## OPTIONS

| Option | Description |
| --- | --- |
| `--repo folder` | Restrict document calls to this connected local root. Otherwise each call supplies `folder`. |
| `--state-dir directory` | Select daemon state. |
| `--agent id` | Select an agent owned by the logged-in user. Takes precedence over `--agent-name`. |
| `--agent-name name` | Select an owned agent by name. Default: MCP client's name. |
| `-h`, `--help` | Print usage and exit. |

Register an agent with `relay agent create` before opening an editor. Each open
may override the selection with its `agent` argument. Document tokens must support
agent claims. The agent uses the logged-in user's document permissions.

## CLIENT REGISTRATION

For one Codex run, pass configuration overrides:

```sh
codex \
  -c 'mcp_servers.relay_test.command="/absolute/path/to/relay"' \
  -c 'mcp_servers.relay_test.args=["mcp","--repo","/absolute/path/to/notes","--agent-name","CommentTester"]'
```

These overrides do not write a registration to Codex's config file.
See [Codex configuration overrides](https://learn.chatgpt.com/docs/config-file/config-advanced#one-off-overrides-from-the-cli).

For persistent registration:

```sh
relay mcp install codex --agent-name CommentTester --repo /absolute/path/to/notes
relay mcp install claude --agent-name CommentTester --repo /absolute/path/to/notes
```

`install` requires the selected client's CLI on `PATH`. It accepts the server
options above plus:

| Option | Description |
| --- | --- |
| `--name name` | Registration name. Default: `relay`. |
| `--scope scope` | Claude: `user`, `local`, or `project`. Codex: `user`. Default: `user`. |
| `--dry-run` | Print registration JSON and exit. |

The default agent name for `install` is `Claude` or `Codex`. Paths are resolved
before registration. Existing names cause an error; select another `--name`.
Reload the client after installation.

## TOOL ARGUMENTS

`relay mcp tools` prints the complete argument reference.

| Argument | Meaning |
| --- | --- |
| `folder` | Absolute connected local root. Optional with `--repo`. List roots with `relay documents roots`. |
| `path` | Document path relative to `folder`, using `/`. Traversal and `.relay` paths are rejected. Local symlinks are followed. |
| `sessionId` | Editor returned by `relay_open_document`, owned by this MCP connection. |
| Text offsets | UTF-16 code units. Text reads and edits are limited to 128 Ki units. |

### relay_cli

```text
relay_cli(args?)
```

Run a Relay command with literal arguments. Default: `["--help"]`.

```json
{"args":["documents","search","TODO","--repo","/home/me/notes","--json"]}
{"args":["obsidian","--vault","Notes","relay:conflicts","format=json"]}
```

Returns `exitCode`, `stdout`, and `stderr`. A nonzero exit marks the tool result
as an error. The selected daemon state is inherited unless overridden with
`--state-dir`. The working directory is `--repo`, or the MCP process's directory.
Commands run with the CLI's full authority; `--repo` does not restrict them.

Commands run noninteractively with a 60-second deadline and 256 KiB capture limit.
Returned stdout and stderr are each limited to 64 Ki characters; longer output
sets `truncated: true`. Foreground workers and nested MCP servers are rejected.
A cancelled or timed-out command may already have applied a change.

### relay_open_document

```text
relay_open_document(folder?, path, agent?)
```

Open a writable editor. Returns `sessionId`, `text`, `revision`, `peers`,
`awarenessAvailable`, and `identity`. Requires write permission. A document can
have one active editor at a time. `agent` overrides the server's agent selection
for this editor.

### relay_read_document

```text
relay_read_document(folder?, path)
relay_read_document(sessionId)
```

Read active editor text, or disk text if no editor is open. A folder/path read
returns the text source. A session read returns its current text, revision and
peers. The selectors are mutually exclusive.

### relay_apply_edits

```text
relay_apply_edits(sessionId, baseText, desiredText, cursor?, selection?)
```

Apply `desiredText` against the exact text previously read as `baseText`.
Disjoint concurrent changes are rebased. Overlaps return `applied: false` and
current text; reread before preparing another edit.

`cursor` is an offset into `desiredText`. `selection` is `{anchor,head}` using
the same offsets. Positions rebase with the text. Equal base and desired text
update presence only; `null` clears a cursor or selection. Presence is suppressed
while the document has a fork.

`persistence: "accepted-locally"` confirms acceptance by the editor.
`remoteSyncConfirmed` is `false`.

### relay_close_document

```text
relay_close_document(sessionId)
```

Save pending text and release the editor. `saveCompleted: true` confirms a local
save. `remoteSyncConfirmed` remains `false`.

### relay_comments

```text
relay_comments(action, sessionId?, folder?, path?, expectedHash?, threadId?,
               from?, to?, text?, suggestion?)
```

Read and edit Markdown discussions and suggestions. `read` accepts folder/path
or sessionId and returns `hash`, `threads`, and malformed-markup information.
Every mutation requires an owned session and `expectedHash` from the latest read.
Thread IDs apply to that snapshot. Reread after any document change.

| Action | Arguments | Effect |
| --- | --- | --- |
| `read` | `folder,path` or `sessionId` | Read discussions and suggestions. |
| `create` | `from,to,text` | Add a comment. Equal offsets create a standalone comment; a range creates a highlighted discussion. |
| `reply` | `threadId,text` | Append a comment. |
| `resolve` | `threadId` | Remove discussion. Preserve native highlights and suggested prose; unwrap CriticMarkup highlights. |
| `suggest` | `from,to,suggestion,text?` | Add an `addition`, `deletion`, or `replacement`. Additions use equal offsets. Additions and replacements require text. |
| `accept` | `threadId` | Apply a suggestion and remove its discussion. |
| `reject` | `threadId` | Discard a suggestion and remove its discussion. |

Selecting an existing native highlight preserves it. Use `reply` if it already
has a discussion. Malformed markup blocks mutations. Comment text is limited to
16 Ki UTF-16 units; documents may contain at most 1,000 review marks/items.
New comments use the session agent's `authorId`, name and an ISO timestamp.
Existing author metadata is preserved.

### relay_notifications

```text
relay_notifications(action, folder?, path?, subscriptionId?, cursor?, limit?, resumeToken?)
```

| Action | Arguments | Result |
| --- | --- | --- |
| `follow` | `folder,path` | `subscriptionId`, `cursor`, private `resumeToken`. |
| `list` | `subscriptionId,cursor?,limit?` | Events after the given cursor, or the last acknowledged cursor. Limit: 1–100; default 100. |
| `ack` | `subscriptionId,cursor` | Acknowledge delivery. Does not modify the document. |
| `unfollow` | `subscriptionId` | Release the subscription. |
| `resume` | `subscriptionId,resumeToken` | Reattach after disconnect and rotate the token. |
| `summary` | None | Current subscriptions and unread counts. |

Events include `document.changed`, `document.available`, `document.unavailable`,
and `review.changed`. They report observed changes; intermediate edits may be
combined. A removed review item does not establish why it was removed.

Retention is ten minutes after disconnect. Restarting the daemon loses the feed.
Limits: 64 followed documents, 128 subscribers, 256 events per document.
For `resyncRequired: true`, reread the document and acknowledge the reset cursor
when supplied, or follow again. Account and folder changes invalidate feeds.

`relay://notifications` exposes subscription summaries and supports MCP resource
update hints. Poll `list` to retrieve events. A hint does not guarantee an agent
turn or desktop notification.

## ERRORS

Control errors include `code`, `phase` (`connect` or `response`), `elapsedMs`, and
`requestSent`. Deadlines: 35 seconds to open an editor, 10 seconds for ordinary
calls, five seconds for heartbeat and exit cleanup.

A lost mutation reply is ambiguous. Read the document before retrying. Sessions
release on disconnect or expiry of the 60-second lease. Reopen after a daemon
restart or lease expiry.

## ACCESS

Document calls enforce the selected root and current Relay permissions. CLI and
Obsidian commands retain their full local authority. Comment metadata and peer
identities are editable data, not authentication. Keep resume tokens private.

## SEE ALSO

[relay-agent](agents.md), [relay-obsidian](obsidian.md), [relay](cli-contract.md)
