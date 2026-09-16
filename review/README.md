# review

A Pi extension that adds the following command:

```text
/review
```

It runs a code review of the current branch by analyzing only:

- committed changes on the current branch compared with a detected baseline (`origin/HEAD`, `origin/main`, `origin/master`, `main`, then `master`);
- staged index changes, applied on top of `HEAD`.

Unstaged and untracked working-tree changes are intentionally excluded from both the Git input and the review scope. The command stops rather than reviewing a committed range when it cannot determine a baseline.

## Test execution

At the start of every interactive review, the extension asks whether to:

- run all tests relevant to the in-scope changes (typically when reviewing your own working branch); or
- skip test execution (typically when reviewing someone else's branch that CI has already validated).

When tests are selected, the review asks the agent to determine and run every relevant test, then report each command and outcome. When skipped, the agent may inspect test files and recommend validation, but it must not run tests; recognized test-runner commands are also blocked while the review is generated. In non-interactive modes, test execution defaults to skipped.

Diffs are rendered per file (up to 12,000 characters per file and 50,000 characters per change set), while the full changed-file list is retained. When a limit is reached, patches are prioritized for `pkg/security/`, tests, build constraints, Go module metadata, rules, and configuration files. The prompt also includes a change-surface summary: added, deleted, renamed, test, Go-module, and build-constraint changes.

The review looks for, among other things:

- bugs and correctness issues;
- regressions or behavior changes;
- performance problems;
- security or data-loss risks;
- maintainability, test coverage, and other relevant concerns.

## Datadog Agent mode

For a checkout with any configured remote ending in `datadog/datadog-agent` (SSH and HTTPS forms are supported), the extension appends the following `pkg/security/`-specific checklist to the review prompt. Detection is performed through Git, so it works from any subdirectory or worktree of that repository.

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

Once the review is generated, the extension processes findings one at a time:

1. choose `yes` or `no` to generate a targeted fix;
2. if you choose `yes`, the assistant generates and applies a fix only for that finding;
3. after the fix, choose `ok` or `iterate with a prompt`;
4. when you choose `ok`, the extension moves to the next finding.

You retain control over each decision.

## Standalone skills

Tool-agnostic Agent Skills equivalents are available for review workflows outside Pi:

- [`skills/review-generic/SKILL.md`](skills/review-generic/SKILL.md) for any Git repository;
- [`skills/review-datadog-agent/SKILL.md`](skills/review-datadog-agent/SKILL.md) for `datadog/datadog-agent`, including the `pkg/security/` checklist.

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

When `@spikat/pi-web` is loaded in the same Pi process, `/review` can also be invoked from the local dashboard. The review output streams to the dashboard; the finding-by-finding fix decisions continue to use Pi's terminal UI.
