# pi-extensions

A collection of personal extensions for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), designed to streamline Git workflows and make assistant actions safer.

## Available extensions

| Extension | Command | Description |
| --- | --- | --- |
| [`commit-msg`](./commit-msg) | `/gen-commit-msg` | Generates an English commit message from staged changes. |
| [`pr-description`](./pr-description) | `/gen-pr-desc` | Generates a markdown pull request description from the current branch commits. |
| [`review`](./review) | `/review` | Runs a code review on the branch and offers to apply fixes finding by finding. |
| [`commands-whitelist`](./commands-whitelist) | `/whitelist` | Asks for confirmation before assistant actions and persists whitelisted commands. |

## Quick usage

Test an extension temporarily:

```bash
pi -e ./commit-msg
pi -e ./pr-description
pi -e ./review
pi -e ./commands-whitelist
```

Install an extension in a project using pi auto-discovery:

```bash
mkdir -p .pi/extensions
cp -R commit-msg .pi/extensions/
pi
```

Replace `commit-msg` with the extension you want. If pi is already running, use `/reload` after copying it.

## Install all extensions in a project

From this repository root:

```bash
mkdir -p /path/to/project/.pi/extensions
cp -R commit-msg pr-description review commands-whitelist /path/to/project/.pi/extensions/
```

Then start pi in the target project:

```bash
cd /path/to/project
pi
```

## Detailed documentation

Each extension has its own README:

- [`commit-msg/README.md`](./commit-msg/README.md)
- [`pr-description/README.md`](./pr-description/README.md)
- [`review/README.md`](./review/README.md)
- [`commands-whitelist/README.md`](./commands-whitelist/README.md)

## License

This project is distributed under the MIT license. See [`LICENSE`](./LICENSE).
