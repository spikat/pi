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
	test(`Just me prefers Git email mapping via ${mode}, then falls back to gh auth status`, async () => {
		const run = async (command, args) => {
			if (command === "git") {
				if (args[1] === "github.user") throw new Error("unset");
				return mode === "noreply" ? "123+Local@users.noreply.github.com" : "local@example.com";
			}
			if (args[0] === "auth") {
				assert.equal(mode, "unmapped", "A successful Git email mapping must take priority");
				assert.deepEqual(args, ["auth", "status", "--active", "--hostname", "github.com", "--json", "hosts", "--jq", '.hosts["github.com"] | map({login,active,state})']);
				return JSON.stringify([{ login: "ActiveAccount", active: true, state: "success" }]);
			}
			const endpoint = args[3];
			if (endpoint === "user") return JSON.stringify({ login: "Authenticated", email: mode === "public" ? "local@example.com" : "other@example.com" });
			if (endpoint === "user/emails") return JSON.stringify(mode === "private" ? [{ verified: true, email: "LOCAL@example.com" }] : []);
			if (endpoint === "users/local") return JSON.stringify({ login: "Local" });
			if (endpoint.startsWith("search/users")) return JSON.stringify(mode === "search" ? { total_count: 1, items: [{ login: "Local" }] } : { total_count: 0 });
			throw new Error(`Unexpected endpoint ${endpoint}`);
		};
		assert.equal(await currentGitLogin(run, pr), mode === "unmapped" ? "ActiveAccount" : ["public", "private"].includes(mode) ? "Authenticated" : "Local");
	});
}

for (const reason of ["missing email", "private email", "API failure", "ambiguous email search"]) {
	test(`gh auth status recovers identity with ${reason} and multiple configured accounts`, async () => {
		const calls = [];
		const run = async (command, args) => {
			calls.push({ command, args });
			if (command === "git") {
				if (args[1] === "github.user" || reason === "missing email") throw new Error("unset");
				return "private@example.com";
			}
			if (args[0] === "auth") return JSON.stringify([
				{ login: "Inactive", active: false, state: "success" },
				{ login: "Active", active: true, state: "success" },
			]);
			if (reason === "API failure") throw new Error("Identity API unavailable");
			if (args[3] === "user") return JSON.stringify({ login: "Active", email: null });
			if (args[3] === "user/emails") throw new Error("No private email scope");
			return JSON.stringify({ total_count: reason === "ambiguous email search" ? 2 : 0, items: [{ login: "WrongAccount" }] });
		};
		assert.equal(await currentGitLogin(run, pr), "Active");
		assert.ok(calls.some(({ args }) => args[0] === "auth" && args[1] === "status"));
		assert.ok(calls.every(({ args }) => !args.includes("--show-token")));
		if (reason === "missing email") assert.ok(!calls.some(({ args }) => args[0] === "api"));
	});
}

for (const [name, result] of [
	["no account", []], ["inactive only", [{ login: "Inactive", active: false, state: "success" }]],
	["failed authentication", [{ login: "Expired", active: true, state: "error" }]],
	["multiple active accounts", [{ login: "One", active: true, state: "success" }, { login: "Two", active: true, state: "success" }]],
	["missing health status", [{ login: "Unknown", active: true }]], ["malformed JSON", "invalid-json"],
	["invalid login", [{ login: "not a login", active: true, state: "success" }]], ["command failure", null],
]) {
	test(`gh auth status rejects ${name} with an actionable error and no authentication output`, async () => {
		const run = async (command) => {
			if (command === "git") throw new Error("unset");
			if (result === null) throw new Error("Sensitive authentication output must not be shown");
			return typeof result === "string" ? result : JSON.stringify(result);
		};
		await assert.rejects(currentGitLogin(run, pr), (error) => {
			assert.match(error.message, /gh auth login --hostname github.com/);
			assert.ok(!error.message.includes("Sensitive authentication output"));
			return true;
		});
	});
}

test("an explicit github.user overrides the authenticated account", async () => {
	const run = async (command, args) => {
		if (command === "git") { assert.equal(args[1], "github.user"); return "Explicit"; }
		assert.equal(args[0], "api", "Must not invoke gh auth status for an explicit identity");
		assert.equal(args[3], "users/Explicit");
		return JSON.stringify({ login: "Explicit" });
	};
	assert.equal(await currentGitLogin(run, pr), "Explicit");
});

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
