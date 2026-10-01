# review

A Pi extension that adds the following command:

```text
/review
/review https://github.com/DataDog/datadog-agent/pull/55843
```

In local-fix mode, it runs a code review of the current branch by analyzing only:

- committed changes on the current branch compared with a detected baseline (`origin/HEAD`, `origin/main`, `origin/master`, `main`, then `master`);
- staged index changes, applied on top of `HEAD`.

Unstaged and untracked working-tree changes are intentionally excluded from both the Git input and the review scope. The command stops rather than reviewing a committed range when it cannot determine a baseline.

## Review options

Without an argument, an interactive `/review` asks for two independent choices:

1. **Tests:** run all tests relevant to the in-scope changes, or skip test execution.
2. **Finding handling:** `Fix locally` (the existing fix/validation workflow), or `Comment on the PR` (asks for a GitHub PR URL).

The first item in each dialog is the default. If the last commit's author matches the current Git user, the defaults are **run tests + fix locally**. Otherwise, the defaults are **skip tests + comment on the PR**. Identity is compared using the last commit's author email and `git config user.email` (case-insensitive), falling back to the author name and `user.name` when email comparison is unavailable. Both choices remain independently overridable.

Passing a PR URL directly bypasses both setup dialogs and selects **skip tests + comment on the PR** automatically:

```text
/review https://github.com/DataDog/datadog-agent/pull/55843
```

When tests are selected, the review asks the agent to determine and run every relevant test, then report each command and outcome. When skipped, the agent may inspect test files and recommend validation, but it must not run tests; recognized test-runner commands are also blocked while the review is generated. Without a terminal/RPC UI or an active Pi Web connection, `/review` defaults to skipped tests and local mode; a PR URL still selects PR mode, but no comments are posted without interactive finding selection.

## PR comment mode

This mode requires the **GitHub CLI (`gh`)**, authenticated for `github.com` with permission to read the PR and submit a review, plus working Git access to the repository. Run the command inside a checkout with a GitHub remote matching the repository in the PR URL. HTTPS and SSH remotes are supported, including PRs whose source branch is in a fork.

The extension reads the PR head and target branch from GitHub, runs `git fetch` against the matching remote to retrieve the PR head and target, and reviews the PR head against its merge base with the target branch—not the locally detected default branch. If the current checkout is not already at the PR head, it runs `git checkout --detach` at that commit. Commit or stash staged or unstaged changes to tracked files first. Unrelated untracked files do not block the checkout and are preserved; Git refuses the checkout if a file from the PR would overwrite an untracked file. The extension never forces the checkout or cleans local files. The checkout is left at the reviewed commit; return to your previous branch with `git switch -` when needed.

Only committed PR changes are in scope. Staged, unstaged, and untracked changes are excluded, even when already on the PR head. The agent is instructed not to modify files or publish comments; direct `edit` and `write` tool calls are blocked during the PR review.

After the agent finishes, each structured finding is presented with a `yes`/`no` choice to post a PR comment rather than generate a fix. Nothing is sent while these decisions are being collected. Once every finding has been processed, the extension publishes **one separate comment per selected finding**, in selection order. Each comment is submitted as its own GitHub `COMMENT` review tied to the reviewed commit, with one API call per issue. Findings are never combined into a single comment. These are general review comments, not inline comments, approvals, or requests for changes.

If no findings are selected, nothing is posted. Cancelling a finding dialog discards the entire pending batch. Publication is sequential, not atomic: if a submission fails, the extension stops, reports which comment failed and how many preceding comments were confirmed posted, and leaves subsequent comments unattempted. It never automatically retries, to avoid duplicates; check the PR before retrying, since the failed request may still have reached GitHub.

Diffs are rendered per file (up to 12,000 characters per file and 50,000 characters per change set), while the full changed-file list is retained. When a limit is reached, patches are prioritized for `pkg/security/`, tests, build constraints, Go module metadata, rules, and configuration files. The prompt also includes a change-surface summary: added, deleted, renamed, test, Go-module, and build-constraint changes.

The review looks for, among other things:

- bugs and correctness issues;
- regressions or behavior changes;
- performance problems;
- security or data-loss risks;
- maintainability, test coverage, and other relevant concerns.

For every repository, also assess:

- **Function comments and documentation:** comments on added or modified functions must remain accurate and concise, and explain non-obvious intent, invariants, preconditions, or concurrency assumptions where needed. Do not request comments that merely restate clear code.
- **Test value:** added or modified tests should protect project-specific behavior, contracts, edge cases, or plausible regressions. Flag redundant tests that only mirror the implementation or re-test a standard collection (for example trivial Add/Get wrappers around an array), without dismissing simple tests that guard a real contract.

These criteria must lead to evidence-based findings, not automatic demands for more comments or tests.

## Datadog Agent mode

For a checkout with any configured remote ending in `datadog/datadog-agent` (SSH and HTTPS forms are supported), the extension adds these Agent-wide checks when relevant:

- **Runtime observability:** assess whether new logic (such as a cache or resolver) needs metrics beyond existing instrumentation to answer concrete operational questions. Consider hits/misses, evictions, occupancy, resolution failures, or latency, while avoiding duplicate metrics, unbounded label cardinality, and excessive hot-path overhead.
- **Event field exposure:** when an event changes, assess whether added or changed fields should be serialized in reported events and/or exposed to SECL rules for downstream consumers. Respect intentional internal-only or sensitive fields, and check applicable serializers, model tags, generated accessors, documentation, tests, and compatibility.

These two checks are specific to Datadog Agent; they are not added for other repositories. They ask whether instrumentation or field exposure is useful, rather than requiring it systematically.

The extension also appends the following `pkg/security/`-specific checklist. Detection is performed through Git, so it works from any subdirectory or worktree of that repository.

> For changes under `pkg/security/`, additionally review:
>
> - **Event-pipeline correctness**
>   - Verify that an event remains correct from collection (eBPF, ptracer, or audit) through decoding, resolvers, SECL/rule evaluation, serialization, and reporting.
>   - Check timestamps, process/container identity, cgroup context, namespaces, file paths, and event fields for consistency across this pipeline.
>   - Look for silent event loss, duplicated events, incorrect ordering, or changes that create false positives or false negatives.
> - **Policy and detection semantics**
>   - Review changes to rules, filters, discarders, suppression, activity dumps, and security profiles for unintended changes in detection coverage.
>   - Pay particular attention to bypasses caused by filtering too early, over-broad discarder rules, or mismatched field semantics.
>   - Verify backward compatibility of serialized event schemas, rule fields, remote configuration, and persisted profiles when applicable.
> - **Kernel, eBPF, and ptracer safety**
>   - Check all map lookups and kernel-derived pointers for nil checks, bounds, alignment, endianness, and lifetime issues.
>   - Identify verifier-risky changes, unbounded work in hot paths, unsafe map access, architecture-specific assumptions, and incorrect per-CPU map handling.
>   - Verify behavior on supported architectures and feature variants (linux/windows, amd64/arm64, eBPF/eBPF-less) as applicable.
> - **Runtime safety and lifecycle**
>   - Look for goroutine, file descriptor, socket, pinned-map, or subscription leaks.
>   - Review start/stop/reload paths for races, double cleanup, missed cleanup, blocked shutdown, and use-after-close behavior.
>   - Check concurrent access to caches, resolvers, probes, and reloaded policies.
> - **Performance and resilience under load**
>   - Treat event handling as a hot path: flag avoidable allocations, locks, blocking I/O, expensive path resolution, or repeated parsing per event.
>   - Check boundedness of queues, caches, maps, telemetry labels, and retry loops.
>   - Verify rate limiting and backpressure behavior: overload must not cause unbounded memory use, prolonged event-loop stalls, or unexpected event loss.
> - **Cross-platform and generated artifacts**
>   - Check build tags and platform-specific files for missing implementations, diverging behavior, or compilation regressions on unsupported platforms.
>   - Verify that changes requiring generated serializers, easyjson output, protobuf artifacts, or mocks update their generated counterparts.
> - **Validation**
>   - Identify the smallest relevant test command(s), including focused Go tests and, when event semantics change, functional/integration security tests.
>   - Explicitly call out meaningful missing coverage: kernel feature variants, architecture coverage, reload paths, overload behavior, and regression tests for false-positive/false-negative scenarios.

Findings are requested in severity order (`Critical`, `High`, `Medium`, `Low`, `Nit`). Each finding should include affected file(s)/line(s) where available, evidence, impact, confidence, trigger conditions, a recommended fix, and concrete validation. Relevant findings are labeled as false negative, false positive, event loss, privilege/security boundary, or performance under load. Speculative concerns cannot be rated `Critical` or `High` without evidence and a plausible execution path.

The extension waits for the agent to finish the review before opening finding dialogs. Interim commentary and tool calls are not findings. Only severity-labeled findings in the final response are offered for correction or publication; unstructured output remains visible in the conversation without being turned into an issue.

In local-fix mode, once the review is generated, the extension processes findings one at a time:

1. choose `yes` or `no` to generate a targeted fix;
2. if you choose `yes`, the assistant generates and applies a fix only for that finding;
3. after the agent finishes applying the fix (including its tool calls), choose `ok` or `iterate with a prompt`;
4. when you choose `ok`, the extension moves to the next finding.

You retain control over each decision.

## Standalone skills

Tool-agnostic Agent Skills equivalents are available for review workflows outside Pi:

- [`skills/review-generic/SKILL.md`](skills/review-generic/SKILL.md) for any Git repository;
- [`skills/review-datadog-agent/SKILL.md`](skills/review-datadog-agent/SKILL.md) for `datadog/datadog-agent`, including the Agent-wide observability and event-field checks plus the `pkg/security/` checklist.

Copy the relevant skill directory into the skill location used by your agent harness, or provide its `SKILL.md` as the review instructions. Both skills require only Git and deliberately exclude unstaged and untracked changes from their review scope.

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

With `@spikat/pi-web` **0.1.6 or later** loaded in the same Pi process and `/web on` enabled, `/review` (including a PR URL argument) can be invoked from the dashboard. All decisions are available in the browser: test execution, local fixes versus PR comments, the PR URL, each finding, fix validation, and multiline iteration prompts. Findings retain their Markdown formatting.

In TUI mode, dialogs are mirrored to the terminal and browser. The first answer or cancellation closes both views; a late response cannot trigger a second fix or comment. In RPC or browser-only modes, an active web connection uses browser dialogs without leaving an unanswered RPC dialog behind. Without an active web connection, the existing standalone terminal/RPC behavior is unchanged.

Status icons follow the full workflow: working during Git preparation, review/fix generation, and comment publication; waiting while a question is open; idle/completed afterward. A model completion or metadata refresh cannot clear the waiting state while a decision is still pending. Browser dialog drafts survive dashboard redraws.

After updating the packages, reload Pi. If the dashboard server was already running, run `/web off` in **all connected Pi sessions**, wait a few seconds for the shared server to stop, then run `/web on` and reload the browser so the new dashboard code is loaded.

## Development tests

From the `review/` directory:

```bash
npm ci --legacy-peer-deps
npm test
```

The tests use temporary Git repositories, mocked Pi dialogs, and an offline fake GitHub CLI. They cover both modes, author-based defaults, PR fetch/checkout and target-branch scope, separate comments per finding, cancellation, partial publication failures, the existing fix/validation lifecycle, routing of generic versus Datadog-specific review criteria, browser-driven decisions, terminal/browser races, multiline iteration, and cancellation cleanup. No running Pi session, GitHub access, or host peer installation is required.
