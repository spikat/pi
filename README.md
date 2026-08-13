# pi-extensions

A collection of personal extensions for [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), designed to streamline Git workflows, make assistant actions safer, and expose local Pi sessions through a browser dashboard.

## Available extensions

| Extension | Command | Description |
| --- | --- | --- |
| [`commit-msg`](./commit-msg) | `/gen-commit-msg` | Generates an English commit message from staged changes. |
| [`pr-description`](./pr-description) | `/gen-pr-desc` | Generates a markdown pull request description from the current branch commits. |
| [`review`](./review) | `/review` | Runs a code review on the branch and offers to apply fixes finding by finding. |
| [`commands-whitelist`](./commands-whitelist) | `/whitelist` | Asks for confirmation before assistant actions and persists whitelisted commands. |
| [`web`](./web) | `/web on` | Connects Pi sessions to a local HTTPS live dashboard. |

## Install from npm

Install one or more extensions with Pi:

```bash
pi install npm:@spikat/pi-commit-msg
pi install npm:@spikat/pi-pr-description
pi install npm:@spikat/pi-review
pi install npm:@spikat/pi-commands-whitelist
pi install npm:@spikat/pi-web
```

Run the relevant command for each extension you want to install. Use `pi update --extensions` to update installed packages.

## Pi Web at a glance

`@spikat/pi-web` is deliberately local-only: its HTTPS bridge listens on `127.0.0.1` and connects only Pi processes running as the same operating-system user. Run `/web on` in each local Pi session, then open the one-time `https://localhost:…/?token=…` URL printed by Pi and accept the generated self-signed certificate.

The dashboard offers live multi-session output, tail-style reading, Markdown previews, browser-local notifications, and browser controls for extensions that explicitly opt in. When installed alongside `@spikat/pi-commands-whitelist`, its permission dialogs are mirrored to the browser and terminal; the first valid answer wins. See [`web/README.md`](./web/README.md) for the security model, limitations, and full behavior.

## Local development

Test an extension from a local checkout:

```bash
pi -e ./commit-msg
pi -e ./pr-description
pi -e ./review
pi -e ./commands-whitelist
pi -e ./web
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
- [`web/README.md`](./web/README.md)

## License

This project is distributed under the MIT license. See [`LICENSE`](./LICENSE).
