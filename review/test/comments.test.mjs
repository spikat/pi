import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
const fixture = fileURLToPath(new URL("./fixtures/pi.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": fixture, "@earendil-works/pi-tui": fixture } });
const { loadCommentThreads, currentGitLogin, publishCommentAction, chooseCommentActions, RESOLVE, REPLY, REOPEN_REPLY, LEAVE } = await jiti.import("../comments.ts");
const pr = { owner: "Example", repo: "repo", number: 42, cwd: "/tmp", head: "a".repeat(40), base: "b".repeat(40), url: "https://github.com/Example/repo/pull/42" };
function node(id, author = "Test") {
	return { id, body: "Concern", url: `https://github.com/comment/${id}`, createdAt: "2026-01-01", updatedAt: "2026-01-01", author: { login: author }, commit: { oid: "current" }, originalCommit: { oid: "original" } };
}
function page(nodes, cursor = null) { return { nodes, pageInfo: { hasNextPage: !!cursor, endCursor: cursor } }; }
function runner(handler) {
	const calls = [];
	const run = async (command, args, cwd, input) => {
		const call = { command, args, cwd, input: input ? JSON.parse(input) : undefined };
		calls.push(call);
		return JSON.stringify(await handler(call));
	};
	return { run, calls };
}

test("loads all thread and reply pages plus paginated general reviews and issue comments", async () => {
	const { run, calls } = runner(({ args, input }) => {
		if (args.includes("graphql")) {
			if (input.variables.id) return { data: { node: { comments: page([node("reply", "Other")]) } } };
			if (input.variables.cursor) return { data: { repository: { pullRequest: { reviewThreads: page([{ id: "T2", isResolved: true, comments: page([node("second")]) }]) } } } };
			return { data: { repository: { pullRequest: { reviewThreads: page([{ id: "T1", isResolved: false, path: "file.go", comments: page([node("first")], "reply-cursor") }], "thread-cursor") } } } };
		}
		if (args.some((arg) => arg.includes("/reviews?") && arg.endsWith("page=1"))) {
			return Array.from({ length: 100 }, (_, id) => ({ id, body: id === 0 ? "General review" : "", state: "COMMENTED", user: { login: "Test" }, submitted_at: "date", html_url: "https://review" }));
		}
		if (args.some((arg) => arg.includes("/reviews?"))) return [{ id: 101, body: "Pending", state: "PENDING" }, { id: 102, body: "Next page", state: "COMMENTED", user: { login: "Other" } }];
		return [{ id: 1, body: "Issue comment", user: null, html_url: "https://issue", created_at: "date", updated_at: "date" }];
	});
	const threads = await loadCommentThreads(run, pr);
	assert.equal(threads.length, 5);
	assert.equal(threads[0].comments.length, 2);
	assert.equal(threads[0].comments[0].commit, "original");
	assert.equal(threads[1].resolved, true);
	assert.equal(threads[4].comments[0].author, "[deleted]");
	assert.equal(calls.filter(({ args }) => args.includes("graphql")).length, 3);
	assert.ok(calls.some(({ args }) => args.some((arg) => arg.includes("reviews?") && arg.endsWith("page=2"))));
});

test("GraphQL partial errors fail closed rather than silently skipping comments", async () => {
	const { run } = runner(() => ({ data: {}, errors: [{ message: "Permission denied" }] }));
	await assert.rejects(loadCommentThreads(run, pr), /Permission denied/);
});

for (const mode of ["public", "private", "noreply", "search", "unmapped"]) {
	test(`Just me resolves the local Git email via ${mode}, never gh authentication alone`, async () => {
		const run = async (command, args) => {
			if (command === "git") {
				if (args[1] === "github.user") throw new Error("unset");
				return mode === "noreply" ? "123+Local@users.noreply.github.com" : "local@example.com";
			}
			const endpoint = args[3];
			if (endpoint === "user") return JSON.stringify({ login: "Authenticated", email: mode === "public" ? "local@example.com" : "other@example.com" });
			if (endpoint === "user/emails") return JSON.stringify(mode === "private" ? [{ verified: true, email: "LOCAL@example.com" }] : []);
			if (endpoint === "users/local") return JSON.stringify({ login: "Local" });
			if (endpoint.startsWith("search/users")) return JSON.stringify(mode === "search" ? { total_count: 1, items: [{ login: "Local" }] } : { total_count: 0 });
			throw new Error(`Unexpected endpoint ${endpoint}`);
		};
		if (mode === "unmapped") await assert.rejects(currentGitLogin(run, pr), /Cannot map the local Git email/);
		else assert.equal(await currentGitLogin(run, pr), ["public", "private"].includes(mode) ? "Authenticated" : "Local");
	});
}

test("general replies reference the original URL without attempting resolve/unresolve", async () => {
	const { run, calls } = runner(() => ({ id: 1 }));
	const thread = { id: "general", kind: "general", resolved: false, comments: [{ url: "https://original-review" }] };
	await publishCommentAction(run, pr, { thread, action: "reopen-reply", body: "Edited reply" });
	assert.equal(calls.length, 1);
	assert.ok(calls[0].args.includes("repos/Example/repo/issues/42/comments"));
	assert.equal(calls[0].input.body, "Reply to https://original-review\n\nEdited reply");
});

test("resolve/unresolve uses the thread id, and reply success precedes reopening", async () => {
	const { run, calls } = runner(() => ({ data: { success: true } }));
	const thread = { id: "T1", kind: "inline", resolved: true, comments: [] };
	await publishCommentAction(run, pr, { thread, action: "reopen-reply", body: "Still not fixed" });
	assert.match(calls[0].input.query, /addPullRequestReviewThreadReply/);
	assert.match(calls[1].input.query, /unresolveReviewThread/);
	assert.equal(calls[1].input.variables.id, "T1");
});

for (const [status, resolved, reply, expected] of [
	["fixed", false, "", RESOLVE], ["fixed", true, "", LEAVE], ["discussion", false, "Draft", REPLY],
	["partial", true, "Draft", REOPEN_REPLY], ["pending", false, "", LEAVE], ["discussion", true, "", LEAVE],
]) {
	test(`recommended default for ${status}, resolved=${resolved}, draft=${!!reply}`, async () => {
		const thread = { id: "T1", kind: "inline", resolved, comments: [] };
		const ui = { isDisposed: false, decide: async (_ctx, dialog) => { assert.equal(dialog.options[0], expected); return LEAVE; } };
		assert.deepEqual(await chooseCommentActions({}, ui, [thread], [{ status, evidence: "Inspected", reply }]), []);
	});
}
