---
name: review-datadog-agent
description: Review committed and staged changes in DataDog/datadog-agent, with an additional security-review checklist for pkg/security event collection, eBPF, policies, lifecycle, and validation.
license: MIT
compatibility: Requires Git and an agent or tool that can inspect command output without changing the repository.
---

# DataDog Agent Code Review

Use this skill for a checkout of `DataDog/datadog-agent`. It is designed to work from any subdirectory or Git worktree. Perform a focused review only; do not edit files or apply fixes as part of the review.

## Scope and baseline

1. Determine the repository root and current branch. Confirm that a configured Git remote identifies `datadog/datadog-agent` when practical.
2. Resolve a baseline by trying, in order: `origin/HEAD`, `origin/main`, `origin/master`, `main`, then `master`. Use the merge-base of `HEAD` and the first available candidate.
3. If no baseline can be determined, stop and ask the user to provide one. Do not guess a baseline or review the committed range against an arbitrary commit.
4. Review exactly these two inputs:
   - committed changes in `<baseline>..HEAD`;
   - staged changes in the index, relative to `HEAD`.

Staged changes are applied on top of the current `HEAD`. Do **not** inspect, mention, or draw conclusions from unstaged or untracked working-tree changes. Do not use `git status`, `git diff` without a range or `--cached`, or `git ls-files --others` as review input.

## Collect review context

For the committed range and the staged index separately, collect changed files (`--name-status`), statistics (`--stat --no-color`), and a no-color patch with rename/copy detection and the histogram diff algorithm. Also collect non-merge commit subjects and bodies for `<baseline>..HEAD`.

Build a change-surface summary for each set that identifies files added, deleted, and renamed; test files added, deleted, modified, or renamed; changed Go module metadata; Go dependencies added or updated when inferable from `go.mod`; and changed Go build constraints (`//go:build` or legacy `// +build`).

Keep the changed-file list exhaustive. Render patches per file, with at most 12,000 characters per file and 50,000 characters per change set. If a limit is reached, retain the full file list, state which patches were omitted or truncated, and prioritize `pkg/security/`, tests, build constraints, Go module metadata, rules, and configuration files.

## General review criteria

Analyze the in-scope changes for:

- bugs and correctness issues;
- regressions or unintended behavior changes;
- performance problems;
- security or data-loss risks;
- maintainability, test coverage, and other relevant concerns.

## Additional `pkg/security/` review criteria

For changes under `pkg/security/`, additionally review:

- **Event-pipeline correctness**
  - Verify that an event remains correct from collection (eBPF, ptracer, or audit) through decoding, resolvers, SECL/rule evaluation, serialization, and reporting.
  - Check timestamps, process/container identity, cgroup context, namespaces, file paths, and event fields for consistency across this pipeline.
  - Look for silent event loss, duplicated events, incorrect ordering, or changes that create false positives or false negatives.
- **Policy and detection semantics**
  - Review changes to rules, filters, discarders, suppression, activity dumps, and security profiles for unintended changes in detection coverage.
  - Pay particular attention to bypasses caused by filtering too early, over-broad discarder rules, or mismatched field semantics.
  - Verify backward compatibility of serialized event schemas, rule fields, remote configuration, and persisted profiles when applicable.
- **Kernel, eBPF, and ptracer safety**
  - Check all map lookups and kernel-derived pointers for nil checks, bounds, alignment, endianness, and lifetime issues.
  - Identify verifier-risky changes, unbounded work in hot paths, unsafe map access, architecture-specific assumptions, and incorrect per-CPU map handling.
  - Verify behavior on supported architectures and feature variants (linux/windows, amd64/arm64, eBPF/eBPF-less) as applicable.
- **Runtime safety and lifecycle**
  - Look for goroutine, file descriptor, socket, pinned-map, or subscription leaks.
  - Review start/stop/reload paths for races, double cleanup, missed cleanup, blocked shutdown, and use-after-close behavior.
  - Check concurrent access to caches, resolvers, probes, and reloaded policies.
- **Performance and resilience under load**
  - Treat event handling as a hot path: flag avoidable allocations, locks, blocking I/O, expensive path resolution, or repeated parsing per event.
  - Check boundedness of queues, caches, maps, telemetry labels, and retry loops.
  - Verify rate limiting and backpressure behavior: overload must not cause unbounded memory use, prolonged event-loop stalls, or unexpected event loss.
- **Cross-platform and generated artifacts**
  - Check build tags and platform-specific files for missing implementations, diverging behavior, or compilation regressions on unsupported platforms.
  - Verify that changes requiring generated serializers, easyjson output, protobuf artifacts, or mocks update their generated counterparts.
- **Validation**
  - Identify the smallest relevant test command(s), including focused Go tests and, when event semantics change, functional/integration security tests.
  - Explicitly call out meaningful missing coverage: kernel feature variants, architecture coverage, reload paths, overload behavior, and regression tests for false-positive/false-negative scenarios.

## Required output

- Sort findings by severity: `Critical`, `High`, `Medium`, `Low`, then `Nit`.
- Use one third-level heading per finding, exactly: `### [Severity] Short title`.
- For every finding, include:
  - affected file(s) and line(s), when they can be inferred;
  - concrete evidence from the in-scope change;
  - impact;
  - confidence: `High`, `Medium`, or `Low`;
  - trigger or preconditions;
  - a recommended fix when possible;
  - specific validation to run.
- Label applicable findings with one or more of: `false negative`, `false positive`, `event loss`, `privilege/security boundary`, `performance under load`.
- Do not rate a speculative concern `Critical` or `High` without concrete evidence and a plausible execution path.
- If a patch was omitted or truncated, explicitly state that the review may be incomplete and identify relevant unreviewed files from the exhaustive file list.
- Do not apply fixes automatically.
- If there are no substantial findings, say so clearly and mention residual risks or missing validation.
- Be concise, specific, and avoid generic praise.
