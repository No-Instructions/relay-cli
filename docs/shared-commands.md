# Shared server commands

The Relay repository owns the command schema in `src/cli/schema.ts` and the
server command tree and handlers in `src/cli/server.ts`. Each server command
carries `requires: "server"`; Obsidian commands that need a vault use
`requires: "vault"`. Descriptions and option definitions live beside handlers.

`src/server-command.js` adapts the shared tree to space-separated paths, Node's
built-in option parser, generated help, exit status, and text or JSON output.
`src/headless/ServerAccount.ts` supplies authenticated account metadata without
creating a sync engine. Optional local-state callbacks supply Obsidian's vault
projection; the standalone account adapter omits them.

Refresh the vendored tree from a Relay checkout:

```sh
node scripts/vendor-cli.mjs /path/to/Relay
```

The script bundles only the portable command graph into
`vendor/relay-cli/server.js`, copies its MIT license, and records source and
bundle hashes in `SOURCE.json`. It rejects runtime imports outside `src/cli`.
The existing `vendor/relay` snapshot supplies the account implementation and
sync runtime separately. Changing command definitions requires regenerating the
portable bundle; changing the account API also requires checking compatibility
with that snapshot.

The generated module uses no option-parser dependency. Both adapters consume the
same command metadata and server handlers; platform-specific parsing and local
folder behavior belong to their host adapters.
