# review

A Pi extension that adds the following command:

```text
/review
```

It runs a code review of the current branch by analyzing:

- commits on the current branch compared with a detected base branch (`origin/HEAD`, `origin/main`, `origin/master`, `main`, then `master`);
- staged changes;
- unstaged changes.

The review looks for, among other things:

- bugs and correctness issues;
- regressions or behavior changes;
- performance problems;
- security or data-loss risks;
- maintainability, test coverage, and other relevant concerns.

Findings are requested in severity order (`Critical`, `High`, `Medium`, `Low`, `Nit`), with a recommended fix where possible.

Once the review is generated, the extension processes findings one at a time:

1. choose `yes` or `no` to generate a targeted fix;
2. if you choose `yes`, the assistant generates and applies a fix only for that finding;
3. after the fix, choose `ok` or `iterate with a prompt`;
4. when you choose `ok`, the extension moves to the next finding.

You retain control over each decision.

## Usage

Try it temporarily:

```bash
pi -e ./review
```

Install it in a project using auto-discovery:

```bash
mkdir -p .pi/extensions
cp -R review .pi/extensions/
pi
```

Then run:

```text
/review
```

## Pi Web

When `@spikat/pi-web` is loaded in the same Pi process, `/review` can also be invoked from the local dashboard. The review output streams to the dashboard; the finding-by-finding fix decisions continue to use Pi's terminal UI.
