# ask

A Pi extension that adds a read-only question command:

```text
/ask <prompt>
```

`/ask` lets the agent answer a question while inspecting the project when necessary. It keeps only Pi's read-only tools (`read`, `grep`, `find`, `ls`, and `bash`) active. The `bash` tool is limited to a conservative set of inspection commands such as `git status`, `git diff`, `rg`, `find`, and `ls`; shell composition and commands that could change state are blocked.

`edit`, `write`, custom tools, mutating Git subcommands, shell redirections, and other unsafe shell commands are unavailable or blocked. The agent is also explicitly instructed never to create, overwrite, delete, rename, install, stage, commit, or otherwise modify files or system state.

The original tool selection is restored once the answer has settled, unless another extension has since changed that selection. Failed prompt delivery and session changes also release the restriction. If Pi is busy when the command is entered, the extension waits for the current work and queued messages to finish before starting the read-only request.

The shell validator decodes literal quotes and escapes, but rejects shell expansion and compound commands. `git diff`, `git show`, and `git log` require `--no-ext-diff --no-textconv`; program-launching and mutating options are denied. `uniq` and `jq` are not available in this conservative policy. These guards reduce accidental mutations; they are not an OS sandbox and cannot control repository hooks, hostile executables or concurrent filesystem changes. Use operating-system isolation for a strict read-only guarantee.

## Usage

Try it temporarily:

```bash
pi -e ./ask
```

Install it in a project using auto-discovery:

```bash
mkdir -p .pi/extensions
cp -R ask .pi/extensions/
pi
```

Then ask a question:

```text
/ask Explain the trade-offs between optimistic and pessimistic locking.
```

The agent can inspect existing files and use the permitted commands, but it will explain or propose a change rather than applying it.
