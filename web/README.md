# Pi Web

`@spikat/pi-web` is a local HTTPS bridge and live browser dashboard for Pi sessions. It is designed for several Pi processes running under the same operating-system user on the same machine.

## Install

```bash
pi install npm:@spikat/pi-web
```

Run this in every Pi session that should appear in the dashboard:

```text
/web on
```

The first connected session starts the shared bridge and prints a one-time URL similar to:

```text
https://localhost:8088/?token=...
```

Open that exact URL in a browser. The bridge uses a generated self-signed certificate, so the browser requires a one-time certificate warning acceptance. The URL token is exchanged for a secure local cookie and then removed from the address bar.

## Commands

```text
/web on            Connect this Pi session and start the default bridge if needed.
/web on 9000       Start a new bridge on port 9000, or join an existing bridge on that port.
/web off           Disconnect only the current Pi session.
/web status        Report whether the current session is connected.
```

The first `on` command selects the port. While a bridge has connected agents, another explicit port is rejected rather than silently splitting the dashboard into two local bridges. Use `/web on` in subsequent sessions to join it.

The bridge stops automatically a few seconds after the last connected Pi session exits or runs `/web off`. During local development, the detached bridge keeps the `server.mjs` code it loaded at startup; run `/web off` in every connected Pi session, then `/web on` again (and reload the browser) after changing dashboard code.

## Dashboard behavior

- All connected local agents are listed in one page.
- Message, tool, and agent-state events stream over WebSocket; no browser refresh is needed.
- A browser message is sent to its selected Pi agent. When that agent is busy, browser-originated messages are queued and shown as queued work until the agent settles.
- The command input offers slash-command completion from Pi's public command list.
- Agent replies are rendered as safe Markdown with headings, ordered and unordered lists, fenced and inline code, bold/emphasis, safe HTTP(S) links, block quotes, horizontal rules, and GitHub-style tables. Each reply has a **Copy** button that writes the original Markdown to the browser's local clipboard. Fenced blocks accept a language identifier such as <code>```md</code> and leading indentation. Tools and reasoning have distinct colors.
- Previewable project-file references in agent replies—including `README.md`, `docs/build.md`, `main.go`, `server.ts`, `Makefile`, and `Dockerfile`—open a right-hand split view rather than a new tab. The viewer has a close **×** control, line numbers, and lightweight source highlighting. Pi `write` and `edit` activity adds a **Changed file: name (diff)** entry: the file name opens its current full content, while **diff** compares it with the version captured immediately before Pi's latest successful edit, with old/new line numbers and syntax highlighting.
- Each agent view displays only its three most recent user prompts and subsequent responses by default. **Show agent reasoning** and **Show commands and tool output** are disabled by default; enable either only when needed.
- The transcript opens at its newest content and follows live output only while the reader is already at the bottom, like `tail -f`. Streaming changes patch only the transcript element, without rebuilding the page or changing focus; scrolling up preserves the reading position, and activity from another agent updates only that agent's tab. Selecting an agent requests a fresh session-history snapshot from its Pi process to repair any missed browser event. **Clear displayed buffer** clears only the current browser view; it never changes the Pi session or agent history.
- File previews are limited to recognized text/source formats (`.md`, `.go`, `.c`, `.ts`, `.txt`, `.cfg`, JSON, YAML, shell, and similar formats, plus `Makefile` and `Dockerfile`), are confined to the selected agent's project directory, reject binary files, and have a 512 KiB size limit.
- Slash-command suggestions appear only after typing `/` in the larger command input.
- Each agent tab has a **🔊 / 🔇** button that mutes or unmutes desktop notifications for that agent in the current browser, a pencil button for renaming its Pi session, a **❌** button that disconnects that Pi session from the dashboard and displays a terminal notification in the agent, and a collapsible agent-list rail. Tabs are blue with **🙋** when idle, yellow with **🚧** while working, orange with **🙅** while waiting for user input, and green with **🏁** after a non-selected agent completes work. Selecting a green completed agent consumes that completion marker and restores its idle blue state. Every selected tab has a thick white outline while retaining its current idle/working/waiting color.
- **Desktop notifications** is an optional browser setting. After granting the browser permission, it shows a notification when an agent becomes idle or waits for a user decision.

Pi's public extension API does not expose a generic executor for arbitrary built-in or third-party slash commands in an already-running TUI. The dashboard therefore exposes the command catalogue for completion and executes commands only when they explicitly opt into web control. This repository opts in `/gen-commit-msg`, `/gen-pr-desc`, and `/review` when their packages are loaded alongside `web`; unsupported slash commands report an error instead of being silently sent to the model. Ordinary text always remains a normal agent message. The browser never executes shell commands directly.

## Commands whitelist integration

When `@spikat/pi-commands-whitelist` and this package are both loaded in the same Pi process, shell-command and file-edit reviews are mirrored to the dashboard as well as the terminal. A waiting dialog is inserted into the live transcript after the triggering prompt and before subsequent agent output, rather than below the message composer. The first valid answer wins; the terminal dialog and browser dialog are both dismissed after that decision. The browser provides the same per-command state cycle, argument-prefix controls, Python-script restriction, validation, prompt, cancellation, and help as the terminal shell review. File-edit reviews offer one-time or persistent directory/file approval, denial, and a mirrored assistant-prompt editor.

## Security model

- The HTTPS server listens only on `127.0.0.1`.
- A random browser token and a distinct agent-registration token are generated for every bridge lifetime.
- Runtime state, tokens, and the generated key are written with owner-only permissions under `$XDG_RUNTIME_DIR/pi-web` or `~/.pi/web`.
- The token grants the ability to send messages to local Pi agents and read previewable text files inside their project directories. Do not share the initial URL.
- This is local-user security, not a multi-user or network-exposed service. Do not forward the port to a LAN or the Internet without adding authentication and a hardened reverse-proxy design.

## Limitations

This is an event-based dashboard, not an ANSI terminal mirror. It cannot universally reproduce arbitrary custom TUI dialogs supplied by unrelated extensions. It can mirror decisions implemented through its integration surface, including the `commands-whitelist` shell gate.

## Development

```bash
npm install
npm run check
npm test
npm pack --dry-run
```
