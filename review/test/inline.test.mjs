import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { parseInlineFinding, commentableLines, validateInlineFindings, postInlineFinding } = await jiti.import("../inline.ts");
const pr = { owner: "Example", repo: "repo", number: 42, cwd: "/tmp", head: "a".repeat(40), base: "b".repeat(40), url: "https://github.com/Example/repo/pull/42" };
const body = "### [High] Bounds check\nPlease validate the index.";
const anchor = (location) => `${body}\n<!-- pi-review-inline ${JSON.stringify(location)} -->`;
const location = { path: "parser.go", line: 12, side: "RIGHT" };
const patch = "@@ -10,3 +10,4 @@ function\n context\n-old code\n+new code\n+more code\n final context\n\\ No newline at end of file\n@@ -50 +51 @@\n-removed\n+replacement";

function fake(files, changeHead = false) {
	const calls = [];
	const run = async (command, args, cwd, input) => {
		calls.push({ command, args, cwd, input });
		if (args.includes("POST")) return JSON.stringify({ id: 1 });
		const endpoint = args.at(-1);
		if (endpoint.includes("/files?")) {
			const page = Number(endpoint.match(/page=(\d+)$/)[1]);
			return JSON.stringify(files[page - 1] ?? []);
		}
		const reads = calls.filter(({ args }) => args.at(-1) === "repos/Example/repo/pulls/42").length;
		return JSON.stringify({ head: { sha: changeHead && reads > 1 ? "f".repeat(40) : pr.head } });
	};
	return { run, calls };
}

test("parses explicit LEFT/RIGHT anchors and strips only metadata from the published body", () => {
	for (const side of ["LEFT", "RIGHT"]) {
		assert.deepEqual(parseInlineFinding(anchor({ ...location, side })), { body, ...location, side });
	}
});

test("legacy output accepts one explicit File location as RIGHT, not arbitrary prose", () => {
	const text = "### [High] Bounds check\nFile: dir/file name.go:12. Fix it.";
	assert.deepEqual(parseInlineFinding(text), { body: text, path: "dir/file name.go", line: 12, side: "RIGHT" });
	assert.throws(() => parseInlineFinding(`${text}\nFile: second.go:3.`), /ambiguous/);
	assert.throws(() => parseInlineFinding("A problem near file.go:12"), /Missing/);
});

for (const [name, value] of [
	["missing path", { line: 1, side: "RIGHT" }], ["absolute path", { ...location, path: "/tmp/file.go" }],
	["traversal", { ...location, path: "../file.go" }], ["newline", { ...location, path: "file\ngo" }],
	["zero line", { ...location, line: 0 }], ["fractional line", { ...location, line: 1.5 }],
	["string line", { ...location, line: "12" }], ["invalid side", { ...location, side: "OLD" }], ["null", null],
]) {
	test(`rejects invalid inline anchor: ${name}`, () => assert.throws(() => parseInlineFinding(anchor(value)), /Invalid inline location/));
}

test("malformed or duplicate metadata cannot fall back to a File label", () => {
	assert.throws(() => parseInlineFinding(`${body}\nFile: parser.go:12\n<!-- pi-review-inline invalid -->`), /Invalid pi-review-inline JSON/);
	assert.throws(() => parseInlineFinding(`${anchor(location)}\n<!-- pi-review-inline ${JSON.stringify(location)} -->`), /exactly one/);
});

test("maps multiple hunks, replacements, context and newline markers to the correct diff side", () => {
	const lines = commentableLines(patch);
	assert.deepEqual([...lines.LEFT], [11, 50]);
	assert.deepEqual([...lines.RIGHT], [10, 11, 12, 13, 51]);
	assert.equal(lines.LEFT.has(10), false, "Context is anchored on RIGHT");
	assert.equal(lines.RIGHT.has(50), false);
});

test("maps additions/deletions at line 1 and implicit hunk lengths", () => {
	assert.deepEqual([...commentableLines("@@ -0,0 +1 @@\n+added").RIGHT], [1]);
	assert.deepEqual([...commentableLines("@@ -1 +0,0 @@\n-removed").LEFT], [1]);
	assert.equal(commentableLines("Binary files differ").RIGHT.size, 0);
});

test("validates paginated files, renamed destination paths and deleted-line anchors", async () => {
	const first = Array.from({ length: 100 }, (_, index) => ({ filename: `unrelated-${index}.go`, patch: "@@ -1 +1 @@\n-old\n+new" }));
	const { run, calls } = fake([first, [{ filename: "renamed.go", previous_filename: "old.go", patch }]]);
	await validateInlineFindings(run, pr, [{ body, path: "renamed.go", line: 11, side: "LEFT" }, { body, path: "renamed.go", line: 12, side: "RIGHT" }]);
	assert.ok(calls.some(({ args }) => args.at(-1).endsWith("files?per_page=100&page=2")));
	assert.equal(calls.filter(({ args }) => args.at(-1) === "repos/Example/repo/pulls/42").length, 2);
	assert.ok(calls.every(({ args }) => !args.includes("POST")));
});

for (const [name, value, files] of [
	["outside hunk", { ...location, line: 20 }, [[{ filename: "parser.go", patch }]]],
	["wrong side", { ...location, line: 12, side: "LEFT" }, [[{ filename: "parser.go", patch }]]],
	["old rename path", { ...location, path: "old.go" }, [[{ filename: "parser.go", previous_filename: "old.go", patch }]]],
	["missing patch", location, [[{ filename: "parser.go" }]]],
	["binary diff", location, [[{ filename: "parser.go", patch: "Binary files differ" }]]],
]) {
	test(`rejects ${name} without publication or a general-comment fallback`, async () => {
		const { run, calls } = fake(files);
		await assert.rejects(validateInlineFindings(run, pr, [{ body, ...value }]), /not a commentable line/);
		assert.ok(calls.every(({ args }) => !args.includes("POST")));
	});
}

test("rejects a head change while loading the PR diff", async () => {
	const { run } = fake([[{ filename: "parser.go", patch }]], true);
	await assert.rejects(validateInlineFindings(run, pr, [{ body, ...location }]), /PR head changed/);
});

test("creates a root inline comment per finding rather than a general COMMENT review or reply", async () => {
	const { run, calls } = fake([]);
	await postInlineFinding(run, pr, { body, path: "renamed.go", line: 11, side: "LEFT" });
	assert.deepEqual(calls[0].args, ["api", "--hostname", "github.com", "--method", "POST", "repos/Example/repo/pulls/42/comments", "--input", "-"]);
	assert.deepEqual(JSON.parse(calls[0].input), { commit_id: pr.head, body, path: "renamed.go", line: 11, side: "LEFT" });
});
