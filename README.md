# pi-extensions

A collection of personal extensions for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), designed to streamline Git workflows and make assistant actions safer.

## Available extensions

| Extension | Command | Description |
| --- | --- | --- |
| [`commit-msg`](./commit-msg) | `/gen-commit-msg` | Generates an English commit message from staged changes. |
| [`pr-description`](./pr-description) | `/gen-pr-desc` | Generates a markdown pull request description from the current branch commits. |
| [`review`](./review) | `/review` | Runs a code review on the branch and offers to apply fixes finding by finding. |
| [`commands-whitelist`](./commands-whitelist) | `/whitelist` | Asks for confirmation before assistant actions and persists whitelisted commands. |

## Install from npm

Install one or more extensions with Pi:

```bash
pi install npm:@spikat/pi-commit-msg
pi install npm:@spikat/pi-pr-description
pi install npm:@spikat/pi-review
pi install npm:@spikat/pi-commands-whitelist
```

Run the relevant command for each extension you want to install. Use `pi update --extensions` to update installed packages.

## Local development

Test an extension from a local checkout:

```bash
pi -e ./commit-msg
pi -e ./pr-description
pi -e ./review
pi -e ./commands-whitelist
```

For project auto-discovery, copy an extension into `.pi/extensions/`:

```bash
mkdir -p .pi/extensions
cp -R commit-msg .pi/extensions/
pi
```

Replace `commit-msg` with the extension you want. If Pi is already running, use `/reload` after copying it.

## Detailed documentation

Each extension has its own README:

- [`commit-msg/README.md`](./commit-msg/README.md)
- [`pr-description/README.md`](./pr-description/README.md)
- [`review/README.md`](./review/README.md)
- [`commands-whitelist/README.md`](./commands-whitelist/README.md)

## License

This project is distributed under the MIT license. See [`LICENSE`](./LICENSE).
