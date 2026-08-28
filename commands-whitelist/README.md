# commands whitelist

`commands-whitelist` is a Pi extension that intercepts every `bash` tool call before it runs. It decomposes shell lists, lets you approve individual commands, and persists prefix-based allow/deny rules.

Command rules have two scopes:

- **project** rules are shared through the checked-out project configuration;
- **global** rules belong to the current operating-system user and apply in every project.

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
- `Space`: cycle the selected command through `🔁` (this request only), `✅` (save an allow rule for this project), `💾` (save an allow rule globally), `❌` (save a deny rule for this project), and `❌💾` (save a deny rule globally).
- `Enter`: move to the next command; on **Validate current selection**, apply the selection; in the prompt input, cancel the shell call and send the prompt to the assistant.
- `Ctrl+C`: cancel the pending call.
- `h`: open detailed help; `Esc` returns from help.

`💾` is the **globally saved** state (U+1F4BE). A Python-script entry supports only `🔁`, `❌`, and `❌💾`.

Rules from both scopes are evaluated for every command. A matching blacklist rule always wins over an allow rule, whether it is global or project-local. Thus, a project may deny a command that a global rule allows, and a global denial also blocks a project-local allow. If all parts are already allowed, execution proceeds without a dialog. If any part is already denied, execution is blocked and Pi receives the original command, blocked parts, and matching rules. Only when a review dialog is needed, the active model generates a plain-text summary (one to three sentences) explaining the command and its usefulness for the current task; it is displayed after the complete command and before the per-command choices. Unresolved `🔁` choices are allowed only for the current request and are not saved.

When a shell construct cannot be safely parsed (for example a shell function), the original complete command is shown as a single review entry.

### Python scripts

Launching a Python script (`python script.py`, `python3 script.py`, and versioned Python executables) is treated as one opaque command. Its content is never inspected or split. Its review entry supports `🔁` (allow this one execution), `❌` (deny and save for the project), and `❌💾` (deny and save globally). It cannot receive a persistent allow rule, and left/right argument editing is disabled.

## `/whitelist`

```text
/whitelist list
/whitelist project list
/whitelist global list
/whitelist allow ls foo *
/whitelist project allow ls foo *
/whitelist global allow ls foo *
/whitelist deny git push *
/whitelist global deny git push *
/whitelist block git push *
/whitelist global block git push *
/whitelist remove ls foo *
/whitelist global remove ls foo *
/whitelist rm ls foo *
/whitelist del ls foo *
/whitelist delete ls foo *
/whitelist help
/whitelist --help
/whitelist -h
```

Without a scope prefix, mutations target the current **project**. `list` without a prefix displays both scopes; `project` (or `local`) and `global` limit it to one scope. Rules without `*` receive it automatically. A wildcard is valid only once and only as the final token. Removing a blacklist rule requires confirmation.

`/whitelist` without arguments opens the interactive manager. It starts at the top of the rules and keeps the selected rule visible while `↑` / `↓` scroll through a long list; `PageUp` / `PageDown` move by one visible page, and `Home` / `End` jump to the first and last rule. Press `Space` on a selected rule to cycle its state through `✅`, `💾`, `❌`, `❌💾`, then `🔁`; `🔁` removes that rule when the menu is saved. `a`, `e`, and `d` add, rename, and remove rules from the in-memory menu. No menu changes are written immediately: they are all saved together when leaving with `q` or `Ctrl+C`.

## File edit/write protection

The extension also keeps a gate for Pi `edit` and `write` calls. It supports an allow rule for a directory and all descendants, an exact-file allow rule, denial, and sending a prompt to the assistant. Session approvals remain only in memory; persistent approvals are stored in the **project** configuration. Global command rules never grant file edit/write permissions.

## Pi Web integration

When `@spikat/pi-web` is active for the same Pi session, shell-command and file-edit permission requests are displayed in both the terminal and the local web dashboard. A waiting browser dialog is inserted into the transcript after the triggering prompt and before later agent output, rather than below the message composer. The first valid response wins atomically and closes the other view. For shell-command reviews, the generated one-to-three-sentence summary is shown between the original command and the choices in both views. The browser shell-command review exposes the same per-command controls as the terminal: the session/project/global allow and deny state cycle (`🔁`, `✅`, `💾`, `❌`, `❌💾`), literal argument-prefix adjustment, Python-script restrictions, validation, an assistant prompt, cancellation, and contextual help. Browser file-edit reviews remain project-scoped and support one-time or persistent directory/file approval, denial, and the same mirrored assistant-prompt editor as the terminal.

## Configuration

The project configuration remains at:

```text
<git root>/.pi/commands-whitelist.json
```

Outside a Git repository it is located under the current working directory. It contains command rules and persistent file-edit permissions:

```json
{
  "version": 2,
  "whitelist": ["ls foo *"],
  "blacklist": ["git push *"],
  "editDirectories": ["/absolute/project/src"],
  "editFiles": ["/absolute/project/README.md"]
}
```

The global command configuration is located at:

```text
~/.pi/agent/commands-whitelist.json
```

Pi's `PI_CODING_AGENT_DIR` environment variable changes this base directory, so the effective path is:

```text
$PI_CODING_AGENT_DIR/commands-whitelist.json
```

when that variable is set. It contains command rules only:

```json
{
  "version": 2,
  "whitelist": ["git status *"],
  "blacklist": ["git push --force *"]
}
```

Both files are written atomically and created only on the first persistent save in their scope. Existing project configuration files remain compatible. In a global file, legacy `editDirectories` and `editFiles` fields are ignored and removed on its next save. Configurations with a version lower than 2 are deleted at startup. Invalid JSON, malformed version-2 content, or future versions cause a startup error.

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

For project auto-discovery, install this directory under `.pi/extensions/commands-whitelist/` and use `/reload`. For global auto-discovery, install it under `~/.pi/agent/extensions/commands-whitelist/`.
