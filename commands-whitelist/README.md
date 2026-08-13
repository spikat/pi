# commands whitelist

`commands-whitelist` is a Pi extension that intercepts every `bash` tool call before it runs. It decomposes shell lists, lets you approve individual commands, and persists prefix-based allow/deny rules.

## Behaviour

Before a shell call is executed, the extension splits `|`, `|&`, `;`, `&&`, `||`, `&`, and newlines. Redirections and comments are ignored for rule matching but remain intact in the command Pi executes. It recursively examines command substitutions, process substitutions, shell control blocks, and `<shell> -c "..."` commands. Quoted or escaped separators are not split.

For example:

```sh
find /path -name "*.go" | grep -v test | sort | xargs grep -i func 2>/dev/null | uniq -c | wc -l
```

is reviewed as:

```text
🔁 find /path -name *.go *
🔁 grep -v test *
🔁 sort *
🔁 xargs grep -i func *
🔁 uniq -c *
🔁 wc -l *
```

`*` is a final prefix wildcard: `ls foo *` permits `ls foo`, `ls foo bar`, and `ls foo bar baz`, but not `ls baz`. Literal shell globs such as `*.go` stay literal. Variables and otherwise dynamic arguments collapse the remainder of a rule to one `*`.

### Review keyboard controls

- `↑` / `↓`: select a command, **Validate current selection**, or the assistant prompt input.
- `←` / `→`: remove/add literal arguments in the selected rule.
- `Space`: cycle `🔁` (session only), `✅` (persist allow), and `❌` (persist deny).
- `Enter`: move to the next command; on **Validate current selection**, apply the selection; in the prompt input, cancel the shell call and send the prompt to the assistant.
- `Ctrl+C`: cancel the pending call.
- `h`: open detailed help; `Esc` returns from help.

A stored blacklist always wins over an allow rule. If all parts are already allowed, execution proceeds without a dialog. If any part is already denied, execution is blocked and Pi receives the original command, blocked parts, and matching rules. Unresolved `🔁` choices are allowed only for the current request and are not saved.

When a shell construct cannot be safely parsed (for example a shell function), the original complete command is shown as a single review entry.

### Python scripts

Launching a Python script (`python script.py`, `python3 script.py`, and versioned Python executables) is treated as one opaque command. Its content is never inspected or split. Its review entry only supports `🔁` (allow this one execution) and `❌` (deny and persist a blacklist rule); it cannot receive a persistent `✅` allow rule, and left/right argument editing is disabled.

## `/whitelist`

```text
/whitelist list
/whitelist allow ls foo *
/whitelist add ls foo *
/whitelist deny git push *
/whitelist block git push *
/whitelist remove ls foo *
/whitelist rm ls foo *
/whitelist del ls foo *
/whitelist delete ls foo *
/whitelist help
/whitelist --help
/whitelist -h
```

Rules without `*` receive it automatically. A wildcard is valid only once and only as the final token. `list` prints rules alphabetically as `✅ | rule` or `❌ | rule`. Removing a blacklist rule requires confirmation.

## File edit/write protection

The extension also keeps a gate for Pi `edit` and `write` calls. It supports an allow rule for a directory and all descendants, an exact-file allow rule, denial, and sending a prompt to the assistant. Session approvals remain only in memory; persistent approvals are stored in the configuration.

## Pi Web integration

When `@spikat/pi-web` is active for the same Pi session, shell-command and file-edit permission requests are displayed in both the terminal and the local web dashboard. A waiting browser dialog is inserted into the transcript after the triggering prompt and before later agent output, rather than below the message composer. The first valid response wins atomically and closes the other view. The browser shell-command review exposes the same per-command controls as the terminal: session-only/persistent allow and deny states, literal argument-prefix adjustment, Python-script restrictions, validation, an assistant prompt, cancellation, and contextual help. Browser file-edit reviews support one-time or persistent directory/file approval, denial, and the same mirrored assistant-prompt editor as the terminal.

## Configuration

The configuration is located at:

```text
<git root>/.pi/commands-whitelist.json
```

Outside a Git repository it is located under the current working directory. It is written atomically and created only on first persistent save:

```json
{
  "version": 2,
  "whitelist": ["ls foo *"],
  "blacklist": ["git push *"],
  "editDirectories": ["/absolute/project/src"],
  "editFiles": ["/absolute/project/README.md"]
}
```

Configurations with a version lower than 2 are deleted at startup. Invalid JSON, malformed version-2 content, or future versions cause a startup error.

## Development

```sh
npm install
npm test
npm run check
```

Use it temporarily with:

```sh
pi -e ./index.ts
```

For project auto-discovery, install this directory under `.pi/extensions/commands-whitelist/` and use `/reload`.
