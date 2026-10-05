# relay-agent(1)

## NAME

relay-agent — register and inspect agent identities

## SYNOPSIS

```text
relay agent create --name name [--state-dir directory] [--json]
relay agent list [--page n] [--limit n] [--state-dir directory] [--json]
relay agent show id [--state-dir directory] [--json]
```

## DESCRIPTION

Manage agents owned by the logged-in user. Each agent supplies an ID, display
name and avatar for document presence and Relay Comments. Run `relay login`
first. A running daemon is not required for registration.

`create` generates an avatar and a 15-character ID. An existing agent with the
same user and name is returned unchanged. `list` sorts by name and ID. `show`
rejects records owned by another user.

## OPTIONS

| Option | Description |
| --- | --- |
| `--name name` | Required for create. 1–100 characters; no control characters, quotes, or markup delimiters. |
| `--page n` | One-based list page. Default: 1. |
| `--limit n` | List page size, 1–200. Default: 100. |
| `--state-dir directory` | Select the login state directory. |
| `--json` | Print structured output. |
| `-h`, `--help` | Print usage and exit. |

## OUTPUT

`create --json` returns `{agent,created}`. `show --json` returns `{agent}`.
`list --json` returns `{agents,nextPage}`; `nextPage` is null at the end.

Agent fields: `id`, `user`, `name`, `picture`, `color`, `colorLight`.
Credentials are excluded.

## EXAMPLES

```sh
relay agent create --name CommentTester --json
relay agent list --json
relay agent show <agent-id> --json
relay mcp --agent <agent-id>
```

To register through MCP, call `relay_cli`:

```json
{"args":["agent","create","--name","CommentTester","--json"]}
```

Check `exitCode`, parse `stdout`, and pass `agent.id` to `relay_open_document` as
its `agent` argument. The selection applies to that editor immediately.

## RELAY COMMENTS

Read a thread with `relay_comments(action: "read")`. Reply with the returned
hash as `expectedHash`, its `threadId`, and the open editor's `sessionId`.
Replies preserve existing metadata and use the registered agent's ID and name:

```markdown
==Check this claim.=={{authorId="human-id" author="Human" date="2026-09-26T00:00:00Z">>Source?<<}}{{authorId="<agent-id>" author="CommentTester" date="<ISO timestamp>">>Added a source.<<}}
```

## ERRORS AND ACCESS

Registration requires create/read access to owned `user_agents` records and SVG
uploads to their `avatar` field. The collection's unique `(user,name)` constraint
prevents duplicates. After a lost creation reply, the command reads the name
again instead of repeating the write.

Document access uses the signed-in user's permissions. The CLI verifies agent
ownership; the token endpoint currently carries the agent claim without its own
delegation check. Comment metadata is editable attribution.

The returned avatar URL is available to MCP clients. Display in Relay Comments
requires its identity directory to include agent records; the current user-only
directory does not resolve those avatars.

## COMMENT ROUND TRIP

Use a throwaway Markdown note in a Relay shared folder. Keep that folder open in
Obsidian with Relay and Relay Comments enabled. Use a separate downloaded copy
for the headless CLI, so this exercises synchronization between the two clients.

The following commands use isolated demo state. Replace `/tmp/relay-comment-copy`
if necessary; the directory should not already be an Obsidian vault's shared
folder. Use the same state directory on every command:

```sh
relay login --state-dir /tmp/relay-comment-state
relay agent create --name CommentTester --state-dir /tmp/relay-comment-state --json
relay clone /tmp/relay-comment-copy --state-dir /tmp/relay-comment-state
relay start --state-dir /tmp/relay-comment-state
relay sync-status /tmp/relay-comment-copy --state-dir /tmp/relay-comment-state
```

During `clone`, choose the same remote shared folder that is open in Obsidian.
After sync completes, start Codex with Relay for this run. Replace the executable
path with the binary you are testing:

```sh
codex \
  -c 'mcp_servers.relay_comment_test.command="/absolute/path/to/relay"' \
  -c 'mcp_servers.relay_comment_test.args=["mcp","--repo","/tmp/relay-comment-copy","--state-dir","/tmp/relay-comment-state","--agent-name","CommentTester"]'
```

This does not write a global MCP registration. Agent creation writes a real
record under the signed-in Relay account.

1. In Obsidian, create `mcp-comment-loop.md` in that shared folder. Add a sentence,
   select part of it, and use Relay Comments to add **“Please reply to this.”**
2. Ask the agent in the configured MCP host:

   > Use relay_comment_test to open mcp-comment-loop.md. Follow its notifications,
   > read its Relay Comments, and reply to my thread with “Agent received it.”
   > Keep my comment and the thread intact. Leave the editor open for my reply.

3. Verify in Obsidian that the reply appears in the same thread, attributed to
   **CommentTester**, with the original human comment and highlighted text intact.
   Agent avatar display depends on the plugin directory support described above.
4. Reply in Obsidian with **“Human received it.”** Then ask the agent to poll its
   notification subscription and reread the comments. It should see both replies.
   Notifications do not guarantee that an idle agent wakes without another turn.
5. Ask the agent to acknowledge the notification, unfollow, and close its editor.
   Verify the final thread remains visible after the editor closes.

The underlying sequence is `relay_open_document` → `relay_notifications(follow)`
→ `relay_comments(read)` → `relay_comments(reply)` using the returned `hash` and
`threadId`. After the human response: `relay_notifications(list)` → a fresh
`relay_comments(read)` → `relay_notifications(ack)` → `unfollow` →
`relay_close_document`. Each write requires the latest snapshot; stale hashes
must produce a reread instead of a blind retry.

Closing confirms a local save. The Obsidian-side observation is what verifies
that the reply actually arrived at the other client. Stop the demo daemon with
`relay stop --state-dir /tmp/relay-comment-state` when finished.
