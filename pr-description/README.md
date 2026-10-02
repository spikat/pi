# pr-description

A Pi extension that adds the following command:

```text
/gen-pr-desc
```

It compares the current branch with an explicit base (`/gen-pr-desc --base release`) or a detected base branch (`origin/HEAD`, `origin/main`, `origin/master`, `main`, `master`, then upstream as a fallback). The chosen reference and merge-base are shown in the generation input. No automatic fetch is performed; local refs may be stale. Detached HEAD is explicitly labelled. Merge commits are included, so merges-only ranges are not silently discarded.

The following template is used:

```markdown
### What does this PR do?

### Motivation

### Describe how you validated your changes

### Additional Notes
```

Only a final successful response from the matching generation/session is offered for copying after the agent settles, and the expected headings are checked first. Tool-call introductions, errors and aborted responses are not copied. Generations are serialized, tools are blocked during the owned run, and session shutdown/reload removes web registrations.

Git subprocesses have a 30-second deadline and disable external diff/textconv drivers. Output is streamed into bounded sections: 60,000 diff characters, 20,000 commit-log characters and 8,000 characters each for path fields/stat. File-name fields use NUL-separated Git output. The diff/log use immutable commit IDs; a changed HEAD during collection causes a retry diagnostic.

## Usage

Try it temporarily:

```bash
pi -e ./pr-description
```

Install it in a project using auto-discovery:

```bash
mkdir -p .pi/extensions
cp -R pr-description .pi/extensions/
pi
```

Then run:

```text
/gen-pr-desc
```

## Pi Web

When `@spikat/pi-web` is loaded in the same Pi process, `/gen-pr-desc` can also be invoked from the local dashboard. Its generated response streams into the live web transcript, including the optional `--base <ref>` argument.

## Development

Run `npm install --legacy-peer-deps` and `npm test`. Tests use temporary Git repositories and mocked Pi/clipboard APIs; no model credentials are required.
