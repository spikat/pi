# commit-msg

A Pi extension that adds the following command:

```text
/gen-commit-msg
```

It reads staged Git changes (`git diff --cached`) and asks the assistant to generate an English commit message. Once the result is generated, it offers to copy it to the clipboard.

Assistant constraints:

- at most 5 lines;
- the first line summarizes all changes;
- output is limited to the commit message, with no Markdown or explanation.

## Usage

Try it temporarily:

```bash
pi -e ./commit-msg
```

Install it in a project using auto-discovery:

```bash
mkdir -p .pi/extensions
cp -R commit-msg .pi/extensions/
pi
```

Then run:

```text
/gen-commit-msg
```

## Pi Web

When `@spikat/pi-web` is loaded in the same Pi process, `/gen-commit-msg` can also be invoked from the local dashboard. Its generated response streams into the live web transcript.
