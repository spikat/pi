# commit-msg

A Pi extension that adds the following command:

```text
/gen-commit-msg
```

It reads staged Git changes (`git diff --cached`) and asks the assistant to generate an English commit message. Only a final successful response from the matching generation/session is offered for copying, after the agent settles. Tool-call introductions, errors and aborted responses are not copied. Generation is serialized and tools are blocked during the owned run. Session shutdown/reload removes web registrations.

Assistant constraints:

- at most 5 lines;
- the first line summarizes all changes;
- output is limited to the commit message, with no Markdown or explanation.

Git subprocesses have a 30-second deadline, disable external diff/textconv drivers and stream output into bounded sections (60,000 diff characters and 8,000 characters each for file metadata/stat). Index metadata is checked before and after collection; changes cause a retry diagnostic. File-name fields use NUL-separated Git output. This detects collection races but is not an atomic filesystem snapshot.

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

## Development

Run `npm install --legacy-peer-deps` and `npm test`. Tests use temporary Git repositories and mocked Pi/clipboard APIs; no model credentials are required.
