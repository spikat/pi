# pr-description

A Pi extension that adds the following command:

```text
/gen-pr-desc
```

It compares the current branch commits with a detected base branch (`origin/HEAD`, `origin/main`, `origin/master`, `main`, then `master`) and asks the assistant to generate an English Markdown pull request description.

The following template is used:

```markdown
### What does this PR do?

### Motivation

### Describe how you validated your changes

### Additional Notes
```

Once the description is generated, the extension offers to copy the Markdown to the clipboard.

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

When `@spikat/pi-web` is loaded in the same Pi process, `/gen-pr-desc` can also be invoked from the local dashboard. Its generated response streams into the live web transcript.
