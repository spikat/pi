---
name: review-generic
description: Review committed Git branch changes against a baseline plus staged changes, while deliberately excluding unstaged and untracked files. Use for focused, evidence-based code reviews in any repository.
license: MIT
compatibility: Requires Git and an agent or tool that can inspect command output without changing the repository.
---

# Generic Git Code Review

Perform a focused review of only the committed branch range and the staged index. Do not edit files or apply fixes as part of the review; present findings for the user to decide on individually.

## Scope and baseline

1. Determine the repository root and current branch.
2. Resolve a baseline by trying, in order: `origin/HEAD`, `origin/main`, `origin/master`, `main`, then `master`. Use the merge-base of `HEAD` and the first available candidate.
3. If no baseline can be determined, stop and ask the user to provide one. Do not guess a baseline or review the committed range against an arbitrary commit.
4. Review exactly these two inputs:
   - committed changes in `<baseline>..HEAD`;
   - staged changes in the index, relative to `HEAD`.

Staged changes are applied on top of the current `HEAD`. Do **not** inspect, mention, or draw conclusions from unstaged or untracked working-tree changes. Do not use `git status`, `git diff` without a range or `--cached`, or `git ls-files --others` as review input.

## Collect review context

For the committed range and the staged index separately, collect:

- changed files with `git diff --name-status`;
- change statistics with `git diff --stat --no-color`;
- a no-color patch with rename/copy detection and the histogram diff algorithm.

Also collect non-merge commit subjects and bodies for `<baseline>..HEAD`.

Build a change-surface summary for each set that identifies:

- files added, deleted, and renamed;
- test files added, deleted, modified, or renamed;
- Go module metadata (`go.mod`, `go.sum`, `go.work`, `go.work.sum`) changed;
- Go dependencies added or updated when this can be inferred from `go.mod`;
- Go build constraints changed (`//go:build` or legacy `// +build`).

Keep the changed-file list exhaustive. Render patches per file, with at most 12,000 characters per file and 50,000 characters per change set. If a limit is reached, retain the full file list, state which patches were omitted or truncated, and prioritize files under `pkg/security/`, tests, build constraints, Go module metadata, rules, and configuration files.

## What to review

Analyze the in-scope changes for:

- bugs and correctness issues;
- regressions or unintended behavior changes;
- performance problems;
- security or data-loss risks;
- maintainability, test coverage, and other relevant concerns.

Use the diff, change surface, and commit context as evidence. Do not manufacture a finding merely because a category exists in this checklist.

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
