import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const fixture = fileURLToPath(new URL("./fixtures/pi.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": fixture,
		"@earendil-works/pi-tui": fixture,
	},
});
const extension = await jiti.import("../index.ts", { default: true });
const SKIP_TESTS = "Skip test execution (branch already validated in CI)";
const INTRO = "I’ll review the baseline-to-HEAD changes using committed file snapshots only. I won’t inspect working-tree changes or run tests.";
const FINDING = "### [High] Missing bounds check\nFile: parser.go:12. Out-of-range input causes a panic. Validate the index first.";

function assistant(text, stopReason = "stop", extraContent = []) {
	return { role: "assistant", content: [{ type: "text", text }, ...extraContent], stopReason };
}
function toolMessage() {
	return { role: "toolResult", content: [{ type: "text", text: "tool output" }] };
}

async function setup(t, choices = [SKIP_TESTS]) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-review-test-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const git = (...args) => execFileSync("git", args, {
		cwd,
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" },
		stdio: "pipe",
	});
	git("init", "-b", "main");
	writeFileSync(join(cwd, "parser.go"), "package parser\n");
	git("add", "parser.go");
	git("commit", "-m", "baseline");
	git("checkout", "-b", "feature");
	writeFileSync(join(cwd, "parser.go"), "package parser\n// changed\n");
	git("add", "parser.go");
	git("commit", "-m", "change");

	const handlers = new Map();
	const commands = new Map();
	const dialogs = [];
	const notifications = [];
	const sent = [];
	const answers = [...choices];
	const ctx = {
		cwd, mode: "rpc", hasUI: true,
		waitForIdle: async () => {},
		ui: {
			select: async (prompt, options) => {
				dialogs.push({ prompt, options });
				assert.ok(answers.length > 0, `Unexpected dialog: ${prompt}`);
				const answer = answers.shift();
				assert.ok(options.includes(answer), `Invalid answer: ${answer}`);
				return answer;
			},
			notify: (message, level) => notifications.push({ message, level }),
		},
	};
	const pi = {
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		sendUserMessage: (text, options) => sent.push({ text, options }),
	};
	// Keep global web-command registrations isolated between extension instances.
	const contributorSymbol = Symbol.for("spikat.pi.web.command-contributors");
	const previousContributors = globalThis[contributorSymbol];
	globalThis[contributorSymbol] = new Set();
	t.after(() => {
		if (previousContributors === undefined) delete globalThis[contributorSymbol];
		else globalThis[contributorSymbol] = previousContributors;
	});
	extension(pi);
	await commands.get("review").handler("", ctx);
	assert.equal(sent.length, 1);
	return {
		dialogs, notifications, sent,
		emit: async (name, event) => handlers.get(name)?.(event, ctx),
	};
}

test("review waits for the final assistant response, keeping the test guard active", async (t) => {
	const { dialogs, emit } = await setup(t, [SKIP_TESTS, "no"]);
	const progress = assistant(INTRO, "toolUse", [{ type: "toolCall", name: "bash", arguments: { command: "git show HEAD:codereview_guideline.md" } }]);
	await emit("message_end", { message: progress });
	await emit("message_end", { message: toolMessage() });
	assert.equal(dialogs.length, 1, "Only the test-execution dialog should be shown");
	assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "go test ./..." } })).block, true);
	const final = assistant(FINDING);
	await emit("message_end", { message: final });
	assert.equal(dialogs.length, 1, "Even a finding should wait until agent_end");
	await emit("agent_end", { messages: [progress, toolMessage(), final] });
	assert.equal(dialogs.length, 2);
	assert.ok(dialogs[1].prompt.includes(FINDING));
	assert.ok(!dialogs[1].prompt.includes(INTRO));
	assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "go test ./..." } }), undefined);
});

test("plain text is never turned into a finding", async (t) => {
	const { dialogs, notifications, emit } = await setup(t);
	await emit("agent_end", { messages: [assistant(INTRO)] });
	assert.equal(dialogs.length, 1);
	assert.match(notifications.at(-1).message, /No structured review findings/);
});

test("a review without findings does not offer a fix", async (t) => {
	const { dialogs, emit } = await setup(t);
	await emit("agent_end", { messages: [assistant("No substantial findings. Recommended validation: go test ./pkg/parser.")] });
	assert.equal(dialogs.length, 1);
});

test("severity headings are processed separately in order", async (t) => {
	const { dialogs, emit } = await setup(t, [SKIP_TESTS, "no", "no"]);
	await emit("agent_end", { messages: [assistant(`${INTRO}\n\n${FINDING}\n\n### [Low] Missing regression test\nAdd a test for invalid input.`)] });
	assert.equal(dialogs.length, 3);
	assert.match(dialogs[1].prompt, /Finding 1\/2/);
	assert.match(dialogs[2].prompt, /Finding 2\/2/);
	assert.ok(!dialogs[1].prompt.includes("Missing regression test"));
});

test("legacy severity bullets remain supported", async (t) => {
	const { dialogs, emit } = await setup(t, [SKIP_TESTS, "no", "no"]);
	await emit("agent_end", { messages: [assistant("- **High**: Missing bounds check\n  Validate the index.\n- Low: Missing test\n  Add regression coverage.")] });
	assert.equal(dialogs.length, 3);
	assert.match(dialogs[1].prompt, /Missing bounds check/);
	assert.match(dialogs[2].prompt, /Missing test/);
});

test("fix validation waits until all tool calls have finished", async (t) => {
	const { dialogs, sent, emit } = await setup(t, [SKIP_TESTS, "yes", "ok"]);
	await emit("agent_end", { messages: [assistant(FINDING)] });
	assert.equal(sent.length, 2);
	assert.equal(sent[1].options.deliverAs, "followUp");
	const progress = assistant("I’ll add a bounds check.", "toolUse", [{ type: "toolCall", name: "edit", arguments: {} }]);
	await emit("message_end", { message: progress });
	await emit("message_end", { message: toolMessage() });
	assert.equal(dialogs.length, 2);
	const final = assistant("Added the bounds check. Recommended validation: go test ./pkg/parser.");
	await emit("message_end", { message: final });
	assert.equal(dialogs.length, 2);
	await emit("agent_end", { messages: [progress, toolMessage(), final] });
	assert.equal(dialogs.length, 3);
	assert.equal(dialogs[2].prompt, "Fix validation 1/1");
});

for (const reason of ["error", "aborted", "toolUse"]) {
	test(`an incomplete ${reason} response is not processed as a finished review`, async (t) => {
		const { dialogs, emit } = await setup(t, [SKIP_TESTS, "no"]);
		await emit("agent_end", { messages: [assistant(FINDING, reason)] });
		assert.equal(dialogs.length, 1);
		await emit("agent_end", { messages: [assistant(FINDING)] });
		assert.equal(dialogs.length, 2);
	});
}

test("requested tests remain allowed while the agent is reviewing", async (t) => {
	const { emit } = await setup(t, ["Run all tests relevant to the changes (working branch)"]);
	await emit("message_end", { message: assistant(INTRO, "toolUse") });
	assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "go test ./..." } }), undefined);
});
