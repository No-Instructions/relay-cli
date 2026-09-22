# Contributing to Relay CLI

Relay CLI's product code is MIT licensed so users can inspect and audit the
code they run. Start with the [Relay Discord](https://discord.system3.md) to
discuss an idea before opening a large pull request or changing behavior.

Small documentation fixes and focused bug fixes with clear reproduction steps
are easiest to review. Describe the change and how you validated it. Discuss
new features, large refactors, server changes, and changes to sync, merge,
authentication, permissions, or data durability before starting work.

## Development and testing

Follow the source installation and build instructions in
[README.md](README.md#development). Run `npm run check` and
`node bin/rmd.js --help` before submitting a change.

The development harness and test suite are proprietary. Unit tests stored in
this repository are encrypted; the private overlay holds integration tests
and development tooling. Maintainers run those suites for reviewed changes.
Contact us in Discord if you are interested in licensing the technology.

## Support and security

Use the [Relay Discord](https://discord.system3.md) for support and design
discussion. Send security reports privately to
[security@system3.md](mailto:security@system3.md), following [SECURITY.md](SECURITY.md).

## License

By submitting product code or documentation, you agree that your contribution
may be distributed under the repository's [MIT license](LICENSE).
