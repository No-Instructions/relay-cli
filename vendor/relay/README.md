# Vendored Relay

Source: [No-Instructions/Relay](https://github.com/No-Instructions/Relay).
The exact revision is recorded in [UPSTREAM_COMMIT](UPSTREAM_COMMIT):
`8c43b00a7e065942115884c1613343aebd0b2e3b` (plugin version 0.8.12).

This snapshot contains the complete upstream `src/` tree, `manifest.json`,
`styles.css`, and `tsconfig.json`. Those 293 files match the recorded revision
byte for byte. [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
are also copied verbatim from that revision. Preserve these notices and the
licenses inside `src/client/`, `src/storage/`, and `src/y-codemirror.next/`.
This README and `UPSTREAM_COMMIT` are repository-maintained metadata.

There are no source patches inside the vendored snapshot. The CLI adaptations
live in `../../src/headless/`: the filesystem-backed Obsidian shim, browser
storage, auth binding, editor sessions, logging, and CLI handler adapter.
`../../scripts/build-headless.mjs` aliases the `obsidian` import to the shim,
resolves Yjs internals, and supplies Relay's build constants. npm dependencies
come from the CLI's root package manifest and lockfile.

## Refreshing the snapshot

Start with a clean worktree and choose a reviewed upstream commit. Extract it
into a temporary directory, inspect the upstream diff, and replace the selected
files as a complete set so removed upstream files do not linger. For example:

```sh
upstream_checkout=/path/to/Relay
upstream_revision=<full-commit-sha>
vendor_candidate=$(mktemp -d)
git -C "$upstream_checkout" archive "$upstream_revision" \
  src manifest.json styles.css tsconfig.json LICENSE THIRD_PARTY_NOTICES.md \
  | tar -x -C "$vendor_candidate"
diff -ru vendor/relay/src "$vendor_candidate/src"
```

After reviewing the changes, replace `vendor/relay/src/` and the five copied
root files from the candidate. Keep this README, update `UPSTREAM_COMMIT`, and
review the resulting Git diff. Compare the copied tree with the candidate;
document any intentional local deviations here instead of silently changing
upstream source. Check added dependencies against the root lockfile and review
all upstream license and notice changes.

Run `npm ci`, `npm run check`, and `npm test` with the unit-test key available.
Maintainers also run `npm --prefix .claude test` in the private overlay and
review its `specs/folder-sync.md` requirements. Those private requirements need
fresh conformance review after each update; do not replay old vendor patches
without checking their assumptions. Live staging tests require explicit
environment configuration and are run separately from local validation.

Finally, verify that a public checkout builds with locked tests and without the
private overlay, and commit the snapshot, revision marker, host adaptations,
dependency updates, and relevant regression tests together.
