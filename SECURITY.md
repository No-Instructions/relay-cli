# Security policy

Report suspected vulnerabilities privately to [security@system3.md](mailto:security@system3.md).
Please avoid public issues or pull requests that disclose an unpatched vulnerability.

Include the affected commit, Node version, operating system, reproduction steps,
and the impact you observed. Share a minimal example using synthetic data;
remove login tokens, storage keys, private notes, and other credentials from
logs or attachments.

## Supported code

Relay CLI is developed from source. Security fixes target the latest commit on
`main`; older commits and forks do not receive separate security backports.
Use a Node version supported in [README.md](README.md#development).

After a fix is available, maintainers coordinate public disclosure with the
reporter. Ordinary support questions and feature discussions belong in the
[Relay Discord](https://discord.system3.md).
