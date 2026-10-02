# review

A Pi extension that adds the following command:

```text
/review
/review https://github.com/DataDog/datadog-agent/pull/55843
/review check https://github.com/DataDog/datadog-agent/pull/55843
/review check https://github.com/DataDog/datadog-agent/pull/55843 --just-me
```

In local-fix mode, it runs a code review of the current branch by analyzing only:

- committed changes on the current branch compared with a detected baseline (`origin/HEAD`, `origin/main`, `origin/master`, `main`, then `master`);
- staged index changes, applied on top of `HEAD`.

Unstaged and untracked working-tree changes are intentionally excluded from both the Git input and the review scope. The command stops rather than reviewing a committed range when it cannot determine a baseline.

## Review options

Without an argument, an interactive `/review` starts with:

1. **Tests / mode:** run all tests relevant to the in-scope changes, skip test execution, or **Check comments**.
2. For a new review, **finding handling:** `Fix locally` (the existing fix/validation workflow), or `Comment on the PR` (asks for a GitHub PR URL).

**Check comments** instead asks for a PR URL and a scope: **All authors** (default) or **Just me**. It does not run tests or generate local fixes.

The first item in each dialog is the default. If the last commit's author matches the current Git user, the defaults are **run tests + fix locally**. Otherwise, the defaults are **skip tests + comment on the PR**. Identity is compared using the last commit's author email and `git config user.email` (case-insensitive), falling back to the author name and `user.name` when email comparison is unavailable. Local review can override the test choice. PR comment mode is always inspection-only and forces skipped test execution, even if run-tests was selected before choosing that mode.

Passing a PR URL directly bypasses both setup dialogs and selects **skip tests + comment on the PR** automatically:

```text
/review https://github.com/DataDog/datadog-agent/pull/55843
```

For local review, `/review --base <ref>` selects an explicit baseline (merge-base with HEAD). Git collection disables external diff/textconv drivers and has a 30-second subprocess deadline. Committed diffs use a captured commit ID, path lists use NUL-separated output, and index metadata is checked before and after collection. A changed index stops preparation. This detects races but is not an atomic filesystem snapshot.

When tests are selected in local mode, the review asks the agent to determine and run every relevant test, then report each command and outcome. When skipped, the agent may inspect test files and recommend validation, but it must not run tests; recognized test-runner commands are also blocked while the review is generated. This recognition is best-effort, not a sandbox: opaque scripts and wrappers may escape it. PR inspection blocks every tool except `read` and literal snapshot Git commands; `git show/diff/log` require `--no-ext-diff --no-textconv`. Without a terminal/RPC UI or an active Pi Web connection, `/review` defaults to skipped tests and local mode; a PR URL still selects PR mode, but no comments are posted without interactive finding selection.

## Check existing PR comments

```text
/review check https://github.com/owner/repo/pull/123
/review check https://github.com/owner/repo/pull/123 --just-me
```

The first command asks for **All authors** or **Just me**; `--just-me` bypasses that choice. `/review check` without a URL prompts for one. The same workflow is available through **Check comments** in the first `/review` menu, in terminal, RPC, and Pi Web.

This mode uses the same GitHub CLI authentication, matching repository remote, fetch, and safe PR-head checkout as PR comment mode below. It reads **every page** of inline threads and replies, including already resolved or outdated threads, plus general PR review bodies and conversation comments (including those posted by `/review`). Resolved threads are included deliberately so an incomplete fix can be reopened. Pending, unpublished reviews are excluded.

Each initial comment is assessed against the **latest committed PR code**, its original commit/diff hunk, and the replies. The agent checks whether the code actually addresses the initial concern, whether someone replied without a relevant code change, and whether the discussion requires a response or is awaiting someone else. It must not treat “resolved” or “outdated” as proof of a fix. Inspection is read-only; tests and publication tools are blocked during analysis. Comments are treated as untrusted input, not instructions.

After all comments have been assessed, each is displayed with the discussion, analysis, and proposed reply. The most appropriate action is first/selected by default:

1. **Fixed — resolve if still open**, for a completely addressed inline thread.
2. **Discussion — edit and send a reply**, when the discussion needs a response.
3. **Not fully fixed — edit reply and unresolve if resolved**, for an incomplete correction.
4. **Leave unchanged / skip**, including already resolved complete fixes, unanswered unchanged concerns, and discussions where no useful response is needed.

Replies open a multiline editor prefilled with the draft, followed by an explicit **Send / Leave unchanged** confirmation. No actions are sent until the entire set of choices has been collected. Cancelling a dialog discards the pending batch. The extension rechecks the PR head and comment/resolution snapshot before publishing, and refuses stale assessments. Publication is sequential, not atomic: a failure stops subsequent actions, reports confirmed progress, and never retries automatically. A reply may have been sent even if reopening its thread subsequently fails; inspect GitHub before retrying.

**Just me** means threads **initiated** by your selected GitHub identity, not every thread you replied to. An explicit `git config github.user` takes priority. Otherwise, the local `git config user.email` is mapped through a GitHub noreply address, a matching public/verified email, or an unambiguous GitHub email search. If the email is missing/private/unmapped or identity lookup fails, the extension automatically uses the **healthy active account for `github.com` reported by `gh auth status`**. Inactive accounts are ignored, and authentication tokens are never requested or displayed. The selected login appears in the check notification. To choose a different authenticated account, run `gh auth switch --hostname github.com`; to explicitly override the identity used for filtering, configure:

```bash
git config github.user YOUR_GITHUB_LOGIN
```

GitHub has no resolve/unresolve flag or explicit reply relationship for general review bodies and conversation comments. Those are assessed with the general PR discussion as context, without inventing a thread association; a validated response is posted in the PR conversation referencing the original comment URL. Only inline threads can be resolved or reopened. Unknown or unavailable original code must be reported as uncertainty, not as a confirmed fix. An interactive UI is required for this mode.

## PR comment mode

This mode requires the **GitHub CLI (`gh`)**, authenticated for `github.com` with permission to read the PR and submit a review, plus working Git access to the repository. Run the command inside a checkout with a GitHub remote matching the repository in the PR URL. HTTPS and SSH remotes are supported, including PRs whose source branch is in a fork.

The extension reads the PR head and target branch from GitHub, runs `git fetch` against the matching remote to retrieve the PR head and target, and reviews the PR head against its merge base with the target branch—not the locally detected default branch. If the current checkout is not already at the PR head, it runs `git checkout --detach` at that commit. Commit or stash staged or unstaged changes to tracked files first. Unrelated untracked files do not block the checkout and are preserved; Git refuses the checkout if a file from the PR would overwrite an untracked file. The extension never forces the checkout or cleans local files. The checkout is left at the reviewed commit; return to your previous branch with `git switch -` when needed.

Only committed PR changes are in scope. Staged, unstaged, and untracked changes are excluded, even when already on the PR head. The agent is instructed not to modify files or publish comments; direct `edit` and `write` tool calls are blocked during the PR review.

After the agent finishes, each structured finding is presented with a `yes`/`no` choice to post an **inline PR thread** rather than generate a fix. The dialog shows the target file, line, and diff side. Nothing is sent while these decisions are being collected. Once every finding has been processed, the extension publishes **one separate inline review thread per selected finding**, in selection order, tied to the reviewed commit. Each is a new GitHub review comment attached to a diff line, with one API call per issue—not a general review body, approval, or request for changes. These threads can subsequently be resolved or reopened with `/review check`.

The agent provides one location marker inside each finding:

```text
<!-- pi-review-inline {"path":"pkg/example.go","line":123,"side":"RIGHT"} -->
```

`RIGHT` uses the new-side line number for added/context lines; `LEFT` uses the old-side number for deleted lines. Renamed files use the destination path on both sides. The marker is stripped from the posted body. For compatibility, a single explicit `File: relative/path:line` is also accepted as a `RIGHT` anchor; ambiguous prose is never used to guess a location.

Before sending anything, the extension validates **all selected locations** against the paginated GitHub PR file patches and checks that the PR head still matches the reviewed commit. Missing/invalid anchors, unavailable patches (for example binary or very large diffs), or a changed head stop the entire batch before publication. Unpublishable findings remain visible in the conversation and can be declined in the selection dialog. There is **no fallback to general PR comments**.

Cancelling a local finding, fix validation or iteration editor stops the local workflow, rather than skipping ahead or accepting a fix. Web command registrations are owned and removed on session shutdown/reload.

If no findings are selected, nothing is posted. Cancelling a finding dialog discards the entire pending batch. Publication is sequential, not atomic: if a submission fails, the extension stops, reports which comment failed and how many preceding comments were confirmed posted, and leaves subsequent comments unattempted. It never automatically retries, to avoid duplicates; check the PR before retrying, since the failed request may still have reached GitHub.

Diffs are rendered per file (up to 12,000 characters per file and 50,000 characters per change set), with changed-file lists capped at 20,000 characters, stats at 12,000 and the commit log at 20,000. Truncation is explicitly marked; the review must state missing coverage. When a limit is reached, patches are prioritized for `pkg/security/`, tests (including root JS/TS, Python and Rust test paths), build constraints, Go module metadata, rules, and configuration files. The prompt also includes a change-surface summary: added, deleted, renamed, test, Go-module, and build-constraint changes.

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

With `@spikat/pi-web` **0.1.6 or later** loaded in the same Pi process and `/web on` enabled, `/review` (including a PR URL argument) can be invoked from the dashboard. All decisions are available in the browser: test execution or checking existing comments, local fixes versus PR comments, the PR URL, author scope, each finding or existing thread, editable reply drafts, resolution actions, fix validation, and multiline iteration prompts. Findings retain their Markdown formatting.

In TUI mode, dialogs are mirrored to the terminal and browser. The first answer or cancellation closes both views; a late response cannot trigger a second fix or comment. In RPC or browser-only modes, an active web connection uses browser dialogs without leaving an unanswered RPC dialog behind. Without an active web connection, the existing standalone terminal/RPC behavior is unchanged.

Status icons follow the full workflow: working during Git preparation, review/fix generation, and comment publication; waiting while a question is open; idle/completed afterward. A model completion or metadata refresh cannot clear the waiting state while a decision is still pending. Browser dialog drafts survive dashboard redraws.

After updating the packages, reload Pi. If the dashboard server was already running, run `/web off` in **all connected Pi sessions**, wait a few seconds for the shared server to stop, then run `/web on` and reload the browser so the new dashboard code is loaded.

## Development tests

From the `review/` directory:

```bash
npm ci --legacy-peer-deps
npm test
```

The tests use temporary Git repositories, mocked Pi dialogs, and an offline fake GitHub CLI. They cover both modes, author-based defaults, PR fetch/checkout and target-branch scope, separate inline threads per finding, inline metadata and diff-side validation, cancellation, partial publication failures, the existing fix/validation lifecycle, routing of generic versus Datadog-specific review criteria, browser-driven decisions, terminal/browser races, multiline iteration, and cancellation cleanup. Comment-check tests additionally cover paginated threads/replies/general comments, Git-to-GitHub identity mapping and active-account fallback via `gh auth status`, resolved threads, recommended actions, editable replies, reopening, read-only guards, stale assessments, browser drafts, and batch cancellation. No running Pi session, GitHub access, or host peer installation is required.
