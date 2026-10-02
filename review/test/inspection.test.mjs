import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { isSnapshotInspection } = await createJiti(import.meta.url, { fsCache: false }).import("../inspection.ts");
test("PR inspection denies mutations, shell expansion and external diff drivers", () => {
	for (const command of ["rm protected", "gh api graphql", "git show HEAD:file --textconv", "git diff --output=bad", "git diff --out'put'=bad", "git -c alias.show=evil show HEAD", "git show HEAD; touch bad", "git cat-file --filters HEAD:file", "git diff HEAD"]) assert.equal(isSnapshotInspection(command), false, command);
	for (const command of ["git show --no-ext-diff --no-textconv HEAD:file", "git diff --no-ext-diff --no-textconv --exit-code --quiet HEAD", "git -C '/path with spaces' ls-tree HEAD", "git cat-file -p HEAD:file"]) assert.equal(isSnapshotInspection(command), true, command);
});
