# Repository instructions

This repository contains independent npm/Pi packages in `ask/`,
`commands-whitelist/`, `commit-msg/`, `pr-description/`, `review/`, and `web/`.
Each directory has its own `package.json`; there is no shared package version.

## Required package version updates

Whenever you modify a package (code, skills, documentation, tests, dependencies,
or package configuration), update that package's version before completing the
work. Apply this automatically; do not wait for the user to request a bump.

- Bump only the affected package(s), never unrelated packages.
- Use semantic versioning:
  - **patch** by default for fixes, refactoring, documentation, tests, and internal
    changes that preserve the public interface;
  - **minor** for new backward-compatible features or commands;
  - **major** for breaking changes.
  - Follow any explicit version requested by the user instead.
- Bump once per coherent change set, not once per file, tool call, or follow-up
  message. Before bumping, compare the working-tree version with the version in
  `HEAD` and inspect existing changes. If the pending change set already includes
  an appropriate bump, keep it; only adjust it if the new changes require a higher
  release level. Never decrease an already prepared version.
- Keep `package.json` and any existing `package-lock.json` synchronized: update
  both the lockfile's top-level version and `packages[""].version` where present.
  Do not create a lockfile for a package that does not already have one, and do
  not change locked dependency versions merely to bump the package version.
- For a fresh bump, you may run inside the affected package:

  ```bash
  npm version patch --no-git-tag-version --ignore-scripts
  # Use minor or major instead when appropriate.
  ```

  Alternatively, edit the manifest and existing lockfile versions directly.
- Run the affected package's existing tests when available, check the version
  fields agree, and verify new runtime files are included in its npm package
  (for example with `npm pack --dry-run`).
- Mention the affected package and its old/new versions in the final response.
- Do not publish, create commits, or create Git tags unless explicitly asked.

Changes confined to repository-level files (such as this `AGENTS.md`, the root
`README.md`, or tooling) do not by themselves require every package to be bumped.
If shared changes affect a package's behavior or published contents, bump that
package as above.

These are instructions for coding agents, not a filesystem watcher or Git hook:
manual edits are not versioned automatically outside an agent following them.
