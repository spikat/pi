import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const RUN_TESTS = "Run all tests relevant to the changes (working branch)";
const FIX_LOCALLY = "Fix locally";
const COMMENT_ON_PR = "Comment on the PR";
const PR_URL = "https://github.com/Example/repo/pull/42";
const INTRO = "I’ll review the baseline-to-HEAD changes using committed file snapshots only. I won’t inspect working-tree changes or run tests.";
const FINDING = "### [High] Missing bounds check\nFile: parser.go:2. Out-of-range input causes a panic. Validate the index first.";
const LOW_FINDING = "### [Low] Missing regression test\nFile: parser.go:2. Add a test for invalid input.";

function assistant(text, stopReason = "stop", extraContent = []) {
	return { role: "assistant", content: [{ type: "text", text }, ...extraContent], stopReason };
}
function toolMessage() {
	return { role: "toolResult", content: [{ type: "text", text: "tool output" }] };
}

async function setup(t, choices = [SKIP_TESTS, FIX_LOCALLY], options = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-review-test-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const git = (...args) => execFileSync("git", args, {
		cwd,
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" },
		stdio: "pipe",
	}).toString().trim();
	git("init", "-b", "main");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.com");
	writeFileSync(join(cwd, "parser.go"), "package parser\n");
	git("add", "parser.go");
	git("commit", "-m", "baseline");
	git("checkout", "-b", "feature");
	writeFileSync(join(cwd, "parser.go"), "package parser\n// changed\n");
	git("add", "parser.go");
	git("commit", "-m", "change");
	await options.beforeReview?.({ cwd, git });

	const handlers = new Map();
	const commands = new Map();
	const dialogs = [];
	const notifications = [];
	const sent = [];
	const answers = [...choices];
	const inputs = [...(options.inputs ?? [])];
	const edits = [...(options.edits ?? [])];
	const ctx = {
		cwd: options.contextCwd?.(cwd) ?? cwd, mode: options.mode ?? "rpc", hasUI: options.hasUI ?? true,
		isIdle: () => true,
		waitForIdle: async () => {},
		ui: {
			select: async (prompt, options) => {
				dialogs.push({ prompt, options });
				assert.ok(answers.length > 0, `Unexpected dialog: ${prompt}`);
				const answer = answers.shift();
				assert.ok(answer === undefined || options.includes(answer), `Invalid answer: ${answer}`);
				await ctx.beforeAnswer?.(prompt, answer);
				return answer;
			},
			custom: async (factory) => new Promise((resolve) => {
				const component = factory({ requestRender() {} }, { fg: (_color, text) => text }, {}, resolve);
				dialogs.push({ prompt: component.render(80).join("\n"), custom: true });
				assert.ok(answers.length > 0, "Unexpected custom finding dialog");
				component.handleInput(answers.shift() ?? "\x1b");
			}),
			editor: async (prompt, initial) => {
				dialogs.push({ prompt, initial });
				assert.ok(edits.length > 0, `Unexpected editor: ${prompt}`);
				return edits.shift();
			},
			input: async (prompt, placeholder) => {
				dialogs.push({ prompt, placeholder });
				assert.ok(inputs.length > 0, `Unexpected input: ${prompt}`);
				return inputs.shift();
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
	const bridgeSymbol = Symbol.for("spikat.pi.web.bridge");
	const previousBridge = globalThis[bridgeSymbol];
	if (options.bridge) {
		globalThis[bridgeSymbol] = {
			...options.bridge,
			registerCommand: (name, handler) => { commands.set(`web-${name}`, handler); return () => commands.delete(`web-${name}`); },
		};
		t.after(() => {
			if (previousBridge === undefined) delete globalThis[bridgeSymbol];
			else globalThis[bridgeSymbol] = previousBridge;
		});
	}
	extension(pi);
	await handlers.get("session_start")({}, ctx);
	if (options.web) {
		const bridge = options.bridge ? globalThis[bridgeSymbol] : { registerCommand: (name, handler) => commands.set(`web-${name}`, handler) };
		for (const contribute of globalThis[contributorSymbol]) contribute(bridge);
		await commands.get("web-review")(options.args ?? "");
	} else {
		await commands.get("review").handler(options.args ?? "", ctx);
	}
	assert.equal(sent.length, options.expectedSent ?? 1, JSON.stringify(notifications));
	return {
		cwd, git, ctx, commands, dialogs, notifications, sent,
		emit: async (name, event) => handlers.get(name)?.(event, ctx),
	};
}

// A fake gh executable and Git URL rewrite keep PR tests entirely offline.
function mockPullRequest(t, { cwd, git }, options = {}) {
	const bin = mkdtempSync(join(tmpdir(), "pi-review-gh-"));
	t.after(() => rmSync(bin, { recursive: true, force: true }));
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	t.after(() => { process.env.PATH = oldPath; });
	const head = git("rev-parse", "feature");
	const base = git("rev-parse", options.baseRef ?? "main");
	const remote = options.remote ?? "git@github.com:Example/repo.git";
	git("remote", "add", "origin", remote);
	git("config", `url.${cwd}/.insteadOf`, remote);
	git("update-ref", "refs/pull/42/head", options.fetchedHead ?? head);
	const metadata = options.metadata ?? { head: { sha: head }, base: { sha: base, ref: options.baseRef ?? "main" } };
	const logPath = join(bin, "calls.jsonl");
	writeFileSync(logPath, "");
	writeFileSync(join(bin, "gh"), `#!${process.execPath}
import { readFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const post = args.includes("POST");
const input = args.includes("--input") ? readFileSync(0, "utf8") : "";
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, input }) + "\\n");
const postAttempts = readFileSync(${JSON.stringify(logPath)}, "utf8").trim().split("\\n")
  .map((line) => JSON.parse(line)).filter(({ args }) => args.includes("POST")).length;
if (${!!options.failRead} && !post || post && (${!!options.failPost} || postAttempts === ${options.failPostAt ?? 0})) {
  console.error("mock GitHub error"); process.exit(1);
}
let result = post ? { id: 1 } : ${JSON.stringify(metadata)};
const threads = ${JSON.stringify(options.threads ?? [])};
if (args.includes("graphql")) {
  const request = JSON.parse(input);
  if (request.query.startsWith("mutation")) {
    if (${!!options.failMutation}) { console.error("mutation failed"); process.exit(1); }
    result = { data: { mutation: { id: "ok" } } };
  } else result = { data: { repository: { pullRequest: { reviewThreads: { nodes: threads, pageInfo: { hasNextPage: false } } } } } };
} else if (args.some((arg) => /\\/files\\?/.test(arg))) result = ${JSON.stringify(options.files ?? [{ filename: "parser.go", patch: "@@ -1 +1,2 @@\n package parser\n+// changed" }])};
else if (args.some((arg) => /\\/(reviews|comments)\\?/.test(arg))) result = [];
else if (args[0] === "auth" && args[1] === "status") result = [{ login: "InactiveAccount", active: false, state: "success" }, { login: "Test", active: true, state: "success" }];
else if (args.includes("user")) result = { login: "Test", email: "test@example.com" };
else if (args.some((arg) => arg.startsWith("users/"))) result = { login: args.find((arg) => arg.startsWith("users/")).slice(6) };
const history = readFileSync(${JSON.stringify(logPath)}, "utf8").trim().split("\\n").map(JSON.parse);
if (${!!options.changeHeadOnRecheck} && args.includes("repos/Example/repo/pulls/42")
    && history.filter(({ args }) => args.includes("repos/Example/repo/pulls/42")).length > 1) result.head.sha = "f".repeat(40);
if (${!!options.changeThreadsOnRecheck} && args.includes("graphql") && !JSON.parse(input).query.startsWith("mutation")
    && history.filter(({ args, input }) => args.includes("graphql") && !JSON.parse(input).query.startsWith("mutation")).length > 1)
  result.data.repository.pullRequest.reviewThreads.nodes[0].isResolved = !threads[0].isResolved;
console.log(JSON.stringify(result));
`, { mode: 0o755 });
	return {
		head, base,
		calls: () => readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
	};
}

async function setupPR(t, choices = [], options = {}) {
	let mock;
	const result = await setup(t, choices, {
		args: PR_URL, ...options,
		beforeReview: async (repo) => {
			await options.beforeMock?.(repo);
			mock = mockPullRequest(t, repo, options.mock);
			await options.afterMock?.(repo, mock);
		},
	});
	return { ...result, mock };
}

test("review waits for the final assistant response, keeping the test guard active", async (t) => {
	const { dialogs, emit } = await setup(t, [SKIP_TESTS, FIX_LOCALLY, "no"]);
	const progress = assistant(INTRO, "toolUse", [{ type: "toolCall", name: "bash", arguments: { command: "git show HEAD:codereview_guideline.md" } }]);
	await emit("message_end", { message: progress });
	await emit("message_end", { message: toolMessage() });
	assert.equal(dialogs.length, 2, "Only the two setup dialogs should be shown");
	assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "go test ./..." } })).block, true);
	const final = assistant(FINDING);
	await emit("message_end", { message: final });
	assert.equal(dialogs.length, 2, "Even a finding should wait until agent_end");
	await emit("agent_end", { messages: [progress, toolMessage(), final] });
	assert.equal(dialogs.length, 3);
	assert.ok(dialogs[2].prompt.includes(FINDING));
	assert.ok(!dialogs[2].prompt.includes(INTRO));
	assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "go test ./..." } }), undefined);
});

test("plain text is never turned into a finding", async (t) => {
	const { dialogs, notifications, emit } = await setup(t);
	await emit("agent_end", { messages: [assistant(INTRO)] });
	assert.equal(dialogs.length, 2);
	assert.match(notifications.at(-1).message, /No structured review findings/);
});

test("a review without findings does not offer a fix", async (t) => {
	const { dialogs, emit } = await setup(t);
	await emit("agent_end", { messages: [assistant("No substantial findings. Recommended validation: go test ./pkg/parser.")] });
	assert.equal(dialogs.length, 2);
});

test("severity headings are processed separately in order", async (t) => {
	const { dialogs, emit } = await setup(t, [SKIP_TESTS, FIX_LOCALLY, "no", "no"]);
	await emit("agent_end", { messages: [assistant(`${INTRO}\n\n${FINDING}\n\n${LOW_FINDING}`)] });
	assert.equal(dialogs.length, 4);
	assert.match(dialogs[2].prompt, /Finding 1\/2/);
	assert.match(dialogs[3].prompt, /Finding 2\/2/);
	assert.ok(!dialogs[2].prompt.includes("Missing regression test"));
});

test("legacy severity bullets remain supported", async (t) => {
	const { dialogs, emit } = await setup(t, [SKIP_TESTS, FIX_LOCALLY, "no", "no"]);
	await emit("agent_end", { messages: [assistant("- **High**: Missing bounds check\n  Validate the index.\n- Low: Missing test\n  Add regression coverage.")] });
	assert.equal(dialogs.length, 4);
	assert.match(dialogs[2].prompt, /Missing bounds check/);
	assert.match(dialogs[3].prompt, /Missing test/);
});

test("fix validation waits until all tool calls have finished", async (t) => {
	const { dialogs, sent, emit } = await setup(t, [SKIP_TESTS, FIX_LOCALLY, "yes", "ok"]);
	await emit("agent_end", { messages: [assistant(FINDING)] });
	assert.equal(sent.length, 2);
	assert.equal(sent[1].options.deliverAs, "followUp");
	const progress = assistant("I’ll add a bounds check.", "toolUse", [{ type: "toolCall", name: "edit", arguments: {} }]);
	await emit("message_end", { message: progress });
	await emit("message_end", { message: toolMessage() });
	assert.equal(dialogs.length, 3);
	const final = assistant("Added the bounds check. Recommended validation: go test ./pkg/parser.");
	await emit("message_end", { message: final });
	assert.equal(dialogs.length, 3);
	await emit("agent_end", { messages: [progress, toolMessage(), final] });
	assert.equal(dialogs.length, 4);
	assert.equal(dialogs[3].prompt, "Fix validation 1/1");
});

for (const reason of ["error", "aborted", "toolUse"]) {
	test(`an incomplete ${reason} response is not processed as a finished review`, async (t) => {
		const { dialogs, emit } = await setup(t, [SKIP_TESTS, FIX_LOCALLY, "no"]);
		await emit("agent_end", { messages: [assistant(FINDING, reason)] });
		assert.equal(dialogs.length, 2);
		await emit("agent_end", { messages: [assistant(FINDING)] });
		assert.equal(dialogs.length, 3);
	});
}

test("requested tests remain allowed while the agent is reviewing", async (t) => {
	const { emit } = await setup(t, [RUN_TESTS, FIX_LOCALLY]);
	await emit("message_end", { message: assistant(INTRO, "toolUse") });
	assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "go test ./..." } }), undefined);
});

test("own last commit defaults to tests and local fixes", async (t) => {
	const { dialogs, sent } = await setup(t, [RUN_TESTS, FIX_LOCALLY]);
	assert.equal(dialogs[0].options[0], RUN_TESTS);
	assert.equal(dialogs[1].options[0], FIX_LOCALLY);
	assert.match(sent[0].text, /Test execution is requested/);
});

test("another author's last commit defaults to no tests and PR comments", async (t) => {
	const { dialogs } = await setup(t, [SKIP_TESTS, FIX_LOCALLY], {
		beforeReview: ({ git }) => git("config", "user.email", "other@example.com"),
	});
	assert.equal(dialogs[0].options[0], SKIP_TESTS);
	assert.equal(dialogs[1].options[0], COMMENT_ON_PR);
});

for (const choices of [[undefined], [SKIP_TESTS, undefined]]) {
	test(`cancelling setup at step ${choices.length} starts no review`, async (t) => {
		const { notifications } = await setup(t, choices, { expectedSent: 0 });
		assert.match(notifications.at(-1).message, /Review cancelled/);
	});
}

test("non-interactive local review skips tests without asking questions", async (t) => {
	const { dialogs, sent } = await setup(t, [], { hasUI: false });
	assert.equal(dialogs.length, 0);
	assert.match(sent[0].text, /Test execution is intentionally disabled/);
});

test("PR URL argument skips setup, fetches and checks out the PR head", async (t) => {
	const { dialogs, git, sent, mock, emit } = await setupPR(t, [], {
		afterMock: ({ git }) => git("checkout", "main"),
	});
	assert.equal(dialogs.length, 0);
	assert.equal(git("rev-parse", "HEAD"), mock.head);
	assert.equal(git("branch", "--show-current"), "");
	assert.equal(git("rev-parse", "refs/remotes/pi-review/Example/repo/pr-42/head"), mock.head);
	assert.match(sent[0].text, /PR comment mode/);
	assert.match(sent[0].text, /Test execution is intentionally disabled/);
	assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "go test ./..." } })).block, true);
	assert.equal((await emit("tool_call", { toolName: "edit", input: {} })).block, true);
	assert.equal((await emit("tool_call", { toolName: "write", input: {} })).block, true);
	assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "rm protected" } })).block, true);
	assert.equal((await emit("tool_call", { toolName: "publish_custom", input: {} })).block, true);
});

test("interactive PR mode asks for URL and stays read-only even when tests were requested", async (t) => {
	const { dialogs, sent, emit } = await setupPR(t, [RUN_TESTS, COMMENT_ON_PR], { args: "", inputs: [PR_URL] });
	assert.equal(dialogs.length, 3);
	assert.match(dialogs[2].prompt, /PR URL/);
	assert.match(sent[0].text, /Test execution is intentionally disabled/);
	assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "go test ./..." } })).block, true);
	assert.equal((await emit("tool_call", { toolName: "edit", input: {} })).block, true);
});

test("inline PR threads are posted separately after all decisions and never generate fixes", async (t) => {
	const { dialogs, sent, mock, emit, ctx, notifications } = await setupPR(t, ["yes", "no", "yes"]);
	ctx.beforeAnswer = () => assert.equal(mock.calls().filter(({ args }) => args.includes("POST")).length, 0);
	const third = "### [Nit] Unclear name\nFile: parser.go:2. Rename this variable.";
	await emit("agent_end", { messages: [assistant(`${FINDING}\n\n${LOW_FINDING}\n\n${third}`)] });
	assert.equal(dialogs.length, 3);
	assert.ok(dialogs.every(({ prompt }) => prompt.includes("Post an inline thread on the PR")));
	assert.ok(dialogs.every(({ prompt }) => prompt.includes("Inline thread: parser.go:2 (RIGHT)")));
	assert.equal(sent.length, 1, "No fix or validation follow-up");
	const posts = mock.calls().filter(({ args }) => args.includes("POST"));
	assert.equal(posts.length, 2);
	assert.ok(posts.every(({ args }) => args.includes("repos/Example/repo/pulls/42/comments")));
	assert.deepEqual(posts.map(({ input }) => JSON.parse(input)), [
		{ commit_id: mock.head, body: FINDING, path: "parser.go", line: 2, side: "RIGHT" },
		{ commit_id: mock.head, body: third, path: "parser.go", line: 2, side: "RIGHT" },
	]);
	assert.match(notifications.at(-1).message, /Posted 2 separate inline PR thread/);
	await emit("agent_end", { messages: [assistant(FINDING)] });
	assert.equal(mock.calls().filter(({ args }) => args.includes("POST")).length, 2, "Cannot post twice");
});

for (const [name, choices, text] of [
	["all issues declined", ["no", "no"], `${FINDING}\n\n${LOW_FINDING}`],
	["cancel after one selection", ["yes", undefined], `${FINDING}\n\n${LOW_FINDING}`],
	["no findings", [], "No substantial findings."],
]) {
	test(`PR review sends nothing with ${name}`, async (t) => {
		const { mock, emit } = await setupPR(t, choices);
		await emit("agent_end", { messages: [assistant(text)] });
		assert.equal(mock.calls().filter(({ args }) => args.includes("POST")).length, 0);
	});
}

test("PR mode uses the PR target merge base rather than the default branch", async (t) => {
	const { sent, mock } = await setupPR(t, [], {
		beforeMock: ({ cwd, git }) => {
			git("checkout", "-b", "release", "main");
			writeFileSync(join(cwd, "release.go"), "package release\n");
			git("add", "release.go");
			git("commit", "-m", "release baseline");
			git("checkout", "feature");
			git("rebase", "release");
		},
		mock: { baseRef: "release" },
	});
	assert.ok(sent[0].text.includes(`Baseline commit: ${mock.base}`));
	assert.ok(!sent[0].text.includes("release.go"));
});

test("PR review excludes staged and unstaged changes when already on PR head", async (t) => {
	const { sent, git } = await setupPR(t, [], {
		afterMock: ({ cwd, git }) => {
			writeFileSync(join(cwd, "staged.go"), "package staged\n// LOCAL_ONLY_STAGED\n");
			git("add", "staged.go");
			writeFileSync(join(cwd, "parser.go"), "// LOCAL_ONLY_UNSTAGED\n");
		},
	});
	assert.ok(!sent[0].text.includes("LOCAL_ONLY"));
	assert.ok(!sent[0].text.includes("staged.go"));
	assert.match(git("status", "--porcelain"), /staged.go/);
});

test("PR checkout allows unrelated untracked files with a clean tracked tree", async (t) => {
	const { cwd, git, mock, sent } = await setupPR(t, [], {
		afterMock: ({ cwd, git }) => {
			git("checkout", "main");
			writeFileSync(join(cwd, "untracked.txt"), "keep me\n");
			assert.equal(git("status", "-suno"), "");
			assert.match(git("status", "--porcelain"), /\?\? untracked.txt/);
		},
	});
	assert.equal(git("rev-parse", "HEAD"), mock.head);
	assert.equal(readFileSync(join(cwd, "untracked.txt"), "utf8"), "keep me\n");
	assert.ok(!sent[0].text.includes("untracked.txt"));
});

for (const staged of [false, true]) {
	test(`PR checkout refuses ${staged ? "staged" : "unstaged"} tracked changes without changing HEAD`, async (t) => {
		const { cwd, notifications, git, mock } = await setupPR(t, [], {
			expectedSent: 0,
			afterMock: ({ cwd, git }) => {
				git("checkout", "main");
				writeFileSync(join(cwd, "parser.go"), "// keep tracked changes\n");
				if (staged) git("add", "parser.go");
			},
		});
		assert.equal(git("rev-parse", "HEAD"), mock.base);
		assert.equal(readFileSync(join(cwd, "parser.go"), "utf8"), "// keep tracked changes\n");
		assert.match(notifications.at(-1).message, /Commit or stash tracked local changes/);
	});
}

test("PR checkout refuses to overwrite a conflicting untracked file", async (t) => {
	const { cwd, notifications, git, mock } = await setupPR(t, [], {
		expectedSent: 0,
		beforeMock: ({ cwd, git }) => {
			writeFileSync(join(cwd, "pr-only.go"), "package pr\n");
			git("add", "pr-only.go");
			git("commit", "-m", "file added by PR");
		},
		afterMock: ({ cwd, git }) => {
			git("checkout", "main");
			writeFileSync(join(cwd, "pr-only.go"), "// keep untracked content\n");
			assert.equal(git("status", "-suno"), "");
		},
	});
	assert.equal(git("rev-parse", "HEAD"), mock.base);
	assert.equal(readFileSync(join(cwd, "pr-only.go"), "utf8"), "// keep untracked content\n");
	assert.equal(notifications.at(-1).level, "error");
	assert.match(notifications.at(-1).message, /pr-only.go/);
});

test("PR head changing during fetch stops the review", async (t) => {
	const { notifications } = await setupPR(t, [], {
		expectedSent: 0,
		mock: { metadata: { head: { sha: "a".repeat(40) }, base: { ref: "main", sha: "b".repeat(40) } } },
	});
	assert.match(notifications.at(-1).message, /PR changed while fetching/);
});

test("PR publication failure is reported and never automatically retried", async (t) => {
	const { emit, notifications, mock, sent } = await setupPR(t, ["yes"], { mock: { failPost: true } });
	await emit("agent_end", { messages: [assistant(FINDING)] });
	assert.equal(notifications.at(-1).level, "error");
	assert.match(notifications.at(-1).message, /Check the PR before retrying/);
	await emit("agent_end", { messages: [assistant(FINDING)] });
	assert.equal(mock.calls().filter(({ args }) => args.includes("POST")).length, 1);
	assert.equal(sent.length, 1);
});

test("four selected issues produce four separate inline threads, never one combined body", async (t) => {
	const findings = [FINDING, LOW_FINDING, "### [Low] Third issue\nFile: parser.go:2. Third issue details.", "### [Nit] Fourth issue\nFile: parser.go:2. Fourth issue details."];
	const { emit, mock } = await setupPR(t, ["yes", "yes", "yes", "yes"]);
	await emit("agent_end", { messages: [assistant(findings.join("\n\n"))] });
	const posts = mock.calls().filter(({ args }) => args.includes("POST"));
	assert.equal(posts.length, 4);
	assert.deepEqual(posts.map(({ input }) => JSON.parse(input).body), findings);
	assert.ok(posts.every(({ input }) => JSON.parse(input).body.match(/^### \[/gm).length === 1));
});

test("partial publication stops at the failed comment and reports confirmed progress without retrying", async (t) => {
	const third = "### [Nit] Third issue\nFile: parser.go:2. Third issue details.";
	const { emit, notifications, mock, sent } = await setupPR(t, ["yes", "yes", "yes"], { mock: { failPostAt: 2 } });
	await emit("agent_end", { messages: [assistant(`${FINDING}\n\n${LOW_FINDING}\n\n${third}`)] });
	const posts = mock.calls().filter(({ args }) => args.includes("POST"));
	assert.equal(posts.length, 2, "The third issue must not be attempted after an error");
	assert.deepEqual(posts.map(({ input }) => JSON.parse(input).body), [FINDING, LOW_FINDING]);
	assert.equal(notifications.at(-1).level, "error");
	assert.match(notifications.at(-1).message, /Could not confirm PR comment 2\/3/);
	assert.match(notifications.at(-1).message, /1 comment\(s\) confirmed posted/);
	assert.match(notifications.at(-1).message, /Check the PR before retrying/);
	await emit("agent_end", { messages: [assistant(FINDING)] });
	assert.equal(mock.calls().filter(({ args }) => args.includes("POST")).length, 2);
	assert.equal(sent.length, 1);
});

test("GitHub API failure starts no review", async (t) => {
	const { notifications } = await setupPR(t, [], { expectedSent: 0, mock: { failRead: true } });
	assert.match(notifications.at(-1).message, /mock GitHub error/);
});

test("a PR from another repository is refused", async (t) => {
	const { notifications, mock } = await setupPR(t, [], {
		expectedSent: 0, mock: { remote: "git@github.com:Elsewhere/repo.git" },
	});
	assert.match(notifications.at(-1).message, /Open a checkout of Example\/repo/);
	assert.equal(mock.calls().length, 0);
});

for (const args of ["not-a-url", "https://github.com/Example/repo/issues/42", "https://evil.example/Example/repo/pull/42", `${PR_URL} ; touch pwned`]) {
	test(`invalid PR argument is rejected: ${args}`, async (t) => {
		const { dialogs, notifications } = await setup(t, [], { args, expectedSent: 0 });
		assert.equal(dialogs.length, 0);
		assert.match(notifications.at(-1).message, /Expected a GitHub PR URL/);
	});
}

test("cancelling the PR URL prompt starts no review", async (t) => {
	const { notifications } = await setup(t, [SKIP_TESTS, COMMENT_ON_PR], { inputs: [undefined], expectedSent: 0 });
	assert.match(notifications.at(-1).message, /Review cancelled/);
});

test("non-interactive PR review never posts without finding selection", async (t) => {
	const { emit, mock, dialogs } = await setupPR(t, [], { hasUI: false });
	await emit("agent_end", { messages: [assistant(FINDING)] });
	assert.equal(dialogs.length, 0);
	assert.equal(mock.calls().filter(({ args }) => args.includes("POST")).length, 0);
});

test("web command forwards the PR URL argument", async (t) => {
	const { dialogs, sent } = await setupPR(t, [], { web: true });
	assert.equal(dialogs.length, 0);
	assert.match(sent[0].text, /https:\/\/github.com\/Example\/repo\/pull\/42/);
});

test("TUI PR finding dialog renders markdown and asks to comment, not fix", async (t) => {
	const { dialogs, emit, mock } = await setupPR(t, ["yes"], { mode: "tui" });
	await emit("agent_end", { messages: [assistant(FINDING)] });
	assert.equal(dialogs[0].custom, true);
	assert.match(dialogs[0].prompt, /Post an inline thread on the PR/);
	assert.ok(dialogs[0].prompt.includes(FINDING));
	assert.ok(!dialogs[0].prompt.includes("Generate a fix"));
	assert.equal(mock.calls().filter(({ args }) => args.includes("POST")).length, 1);
});

test("TUI cancellation discards the pending PR review", async (t) => {
	const { emit, mock } = await setupPR(t, [undefined], { mode: "tui" });
	await emit("agent_end", { messages: [assistant(FINDING)] });
	assert.equal(mock.calls().filter(({ args }) => args.includes("POST")).length, 0);
});

test("PR checkout and posting work if the original working subdirectory disappears", async (t) => {
	const { emit, mock, git } = await setupPR(t, ["yes"], {
		contextCwd: (cwd) => join(cwd, "vanishing"),
		afterMock: ({ cwd, git }) => {
			git("checkout", "main");
			mkdirSync(join(cwd, "vanishing"));
			writeFileSync(join(cwd, "vanishing", "file.go"), "package main\n");
			git("add", ".");
			git("commit", "-m", "directory not present in PR");
		},
	});
	assert.equal(git("rev-parse", "HEAD"), mock.head);
	await emit("agent_end", { messages: [assistant(FINDING)] });
	assert.equal(mock.calls().filter(({ args }) => args.includes("POST")).length, 1);
});

for (const remote of ["https://github.com/Example/repo.git", "ssh://git@github.com/Example/repo.git"]) {
	test(`PR fetch uses the configured remote: ${remote}`, async (t) => {
		const { git, mock } = await setupPR(t, [], { mock: { remote } });
		assert.equal(git("rev-parse", "HEAD"), mock.head);
	});
}

test("a hostname suffix cannot impersonate a GitHub remote", async (t) => {
	const { notifications, mock } = await setupPR(t, [], {
		expectedSent: 0, mock: { remote: "https://notgithub.com/Example/repo.git" },
	});
	assert.match(notifications.at(-1).message, /Open a checkout/);
	assert.equal(mock.calls().length, 0);
});

test("an explicitly restarted review works after an aborted agent run", async (t) => {
	const { commands, ctx, sent, emit } = await setup(t, [SKIP_TESTS, FIX_LOCALLY, RUN_TESTS, FIX_LOCALLY]);
	await emit("agent_end", { messages: [assistant("Interrupted", "aborted")] });
	await commands.get("review").handler("", ctx);
	assert.equal(sent.length, 2);
	assert.match(sent[1].text, /Test execution is requested/);
});

test("a second command does not overwrite an active review", async (t) => {
	const { commands, ctx, sent, notifications } = await setup(t);
	await commands.get("review").handler(PR_URL, ctx);
	assert.equal(sent.length, 1);
	assert.match(notifications.at(-1).message, /already in progress/);
});

function browserAnswers(values) {
	const answers = [...values], dialogs = [], closed = [], statuses = [];
	const bridge = {
		active: true,
		update: ({ status }) => statuses.push(status),
		openDecision: (dialog) => {
			let settled = false, resolve;
			const promise = new Promise((done) => { resolve = done; });
			const decision = { promise, resolve(value) {
				if (settled) return;
				settled = true;
				closed.push(dialog);
				resolve(value);
			} };
			dialogs.push(dialog);
			assert.ok(answers.length, `Unexpected browser dialog: ${dialog.title}`);
			queueMicrotask(() => decision.resolve(answers.shift()));
			return decision;
		},
	};
	return { bridge, dialogs, closed, statuses };
}

test("browser answers cover setup, finding decisions, fix validation, and multiline iteration", async (t) => {
	const prompt = "Keep the bounds check.\nAdd regression coverage for negative indexes.";
	const browser = browserAnswers([SKIP_TESTS, FIX_LOCALLY, "yes", "iterate with a prompt", prompt, "ok"]);
	const { dialogs, sent, emit } = await setup(t, [], { bridge: browser.bridge, web: true });
	assert.equal(browser.statuses[0], "busy");
	await emit("agent_end", { messages: [assistant(FINDING)] });
	assert.equal(sent.length, 2);
	assert.match(browser.dialogs[2].detail, /Missing bounds check/);
	assert.equal(browser.dialogs[2].data.markdown, true);
	await emit("agent_end", { messages: [assistant("Applied the fix.")] });
	assert.equal(sent.length, 3);
	assert.ok(sent[2].text.includes(prompt));
	assert.equal(browser.dialogs[4].kind, "input");
	assert.equal(browser.dialogs[4].data.multiline, true);
	await emit("agent_end", { messages: [assistant("Updated the fix.")] });
	assert.equal(dialogs.length, 0, "No terminal/RPC dialog should be left pending");
	assert.equal(browser.closed.length, 6);
	assert.ok(browser.statuses.includes("waiting"));
	assert.equal(browser.statuses.at(-1), "idle");
});

test("browser-only PR reviews collect the URL and publish only selected findings", async (t) => {
	const browser = browserAnswers([SKIP_TESTS, COMMENT_ON_PR, PR_URL, "yes", "no"]);
	const { dialogs, mock, emit } = await setupPR(t, [], {
		args: "", hasUI: false, web: true, bridge: browser.bridge,
	});
	await emit("agent_end", { messages: [assistant(`${FINDING}\n\n${LOW_FINDING}`)] });
	assert.equal(browser.dialogs[2].title, "GitHub PR URL");
	assert.equal(dialogs.length, 0);
	const posts = mock.calls().filter(({ args }) => args.includes("POST"));
	assert.equal(posts.length, 1);
	assert.equal(JSON.parse(posts[0].input).body, FINDING);
	assert.equal(browser.closed.length, 5);
	assert.equal(browser.statuses.at(-1), "idle");
});

test("cancelling setup in the browser restores idle without starting the agent", async (t) => {
	const browser = browserAnswers([undefined]);
	const { sent } = await setup(t, [], { bridge: browser.bridge, web: true, expectedSent: 0 });
	assert.equal(sent.length, 0);
	assert.equal(browser.closed.length, 1);
	assert.equal(browser.statuses.at(-1), "idle");
});

test("a new session can use browser review dialogs after the previous session shuts down", async (t) => {
	const browser = browserAnswers([SKIP_TESTS, FIX_LOCALLY, SKIP_TESTS, FIX_LOCALLY]);
	const { commands, ctx, sent, emit } = await setup(t, [], { bridge: browser.bridge });
	await emit("session_shutdown", {});
	await emit("session_start", {});
	await commands.get("review").handler("", ctx);
	assert.equal(sent.length, 2);
	assert.equal(browser.dialogs.length, 4);
});

test("a browser review startup error restores idle without opening dialogs", async (t) => {
	const browser = browserAnswers([]);
	await setup(t, [], { bridge: browser.bridge, web: true, args: "invalid-pr", expectedSent: 0 });
	assert.equal(browser.dialogs.length, 0);
	assert.deepEqual(browser.statuses, ["busy", "idle"]);
});

function assertGenericReviewQuality(text) {
	assert.match(text, /comments and docstrings on every added or modified function/);
	assert.match(text, /accuracy and concision/);
	assert.match(text, /non-obvious intent, invariants, preconditions, and concurrency assumptions/);
	assert.match(text, /project-specific behavior, contracts, edge cases, or plausible regressions/);
	assert.match(text, /Add\/Get wrappers that directly forward to an array/);
	assert.match(text, /Simple tests are still valuable when they protect real project logic/);
}

function assertDatadogReviewQuality(text) {
	assert.match(text, /Runtime observability/);
	assert.match(text, /new logic such as a cache or resolver/);
	assert.match(text, /existing metrics/);
	assert.match(text, /label cardinality bounded and hot-path overhead low/);
	assert.match(text, /Event field exposure/);
	assert.match(text, /serialized in reported events and\/or exposed to SECL rules/);
	assert.match(text, /intentional internal-only or sensitive fields/);
	assert.match(text, /Do not require serialization or SECL exposure without a concrete consumer need/);
}

for (const mode of ["local", "PR"]) {
	test(`${mode} reviews include generic quality checks but not Datadog-specific requirements in other repositories`, async (t) => {
		const result = mode === "PR" ? await setupPR(t) : await setup(t, undefined, {
			beforeReview: ({ git }) => git("remote", "add", "origin", "https://github.com/Example/repo.git"),
		});
		const prompt = result.sent[0].text;
		assertGenericReviewQuality(prompt);
		assert.ok(!prompt.includes("Runtime observability"));
		assert.ok(!prompt.includes("Event field exposure"));
		assert.ok(!prompt.includes("SECL"));
	});
}

for (const remote of ["https://github.com/DataDog/datadog-agent.git", "git@github.com:datadog/datadog-agent.git"]) {
	test(`Datadog reviews include Agent-wide criteria outside pkg/security via ${remote}`, async (t) => {
		const { sent } = await setup(t, undefined, {
			contextCwd: (cwd) => join(cwd, "subdir"),
			beforeReview: ({ cwd, git }) => {
				mkdirSync(join(cwd, "subdir"));
				git("remote", "add", "origin", "https://github.com/Example/repo.git");
				git("remote", "add", "upstream", remote);
			},
		});
		const prompt = sent[0].text;
		assertGenericReviewQuality(prompt);
		assertDatadogReviewQuality(prompt);
		assert.ok(prompt.indexOf("Runtime observability") < prompt.indexOf("For changes under pkg/security/"), "Agent-wide checks must not be limited to the security checklist");
	});
}

test("standalone skills preserve the generic/Datadog criteria boundary", () => {
	const generic = readFileSync(new URL("../skills/review-generic/SKILL.md", import.meta.url), "utf8");
	const datadog = readFileSync(new URL("../skills/review-datadog-agent/SKILL.md", import.meta.url), "utf8");
	assertGenericReviewQuality(generic);
	assertGenericReviewQuality(datadog);
	assertDatadogReviewQuality(datadog);
	assert.ok(!generic.includes("Runtime observability"));
	assert.ok(!generic.includes("Event field exposure"));
	assert.ok(!generic.includes("SECL"));
	assert.ok(datadog.indexOf("Runtime observability") < datadog.indexOf("## Additional `pkg/security/` review criteria"));
});

const CHECK = "Check comments";
const ALL = "All authors";
const ME = "Just me";
const RESOLVE_COMMENT = "1 / Fixed — resolve if still open";
const REPLY_COMMENT = "2 / Discussion — edit and send a reply";
const REOPEN_COMMENT = "3 / Not fully fixed — edit reply and unresolve if resolved";
const LEAVE_COMMENT = "Leave unchanged / skip";
function ghThread(id = "T1", author = "Test", resolved = false) {
	return { id, isResolved: resolved, isOutdated: resolved, path: "parser.go", line: 2,
		comments: { nodes: [{ id: `${id}-C1`, author: { login: author }, body: "Please fix the bounds check", url: `${PR_URL}#discussion_${id}`,
			createdAt: "2026-01-01", updatedAt: "2026-01-01", diffHunk: "@@ parser @@", commit: { oid: "a".repeat(40) } },
			{ id: `${id}-C2`, author: { login: "Other" }, body: "Updated, please check", url: `${PR_URL}#reply_${id}`, createdAt: "2026-01-02", updatedAt: "2026-01-02" }],
			pageInfo: { hasNextPage: false } } };
}
function checked(id, status, reply = "") {
	return assistant(`\`\`\`json\n${JSON.stringify({ threadId: id, status, evidence: "parser.go:2 — inspected the current committed code and replies", reply })}\n\`\`\``);
}
function mutations(mock) {
	return mock.calls().filter(({ args, input }) => args.includes("graphql") && JSON.parse(input).query.startsWith("mutation"))
		.map(({ input }) => JSON.parse(input));
}

test("check is offered in the first menu, requests URL and scope, and resolves after analysis", async (t) => {
	const { dialogs, emit, sent, mock } = await setupPR(t, [CHECK, ALL, RESOLVE_COMMENT], {
		args: "", inputs: [PR_URL], mock: { threads: [ghThread()] },
	});
	assert.ok(dialogs[0].options.includes(CHECK));
	assert.equal(dialogs[2].prompt, "Whose comments should be checked?");
	assert.match(sent[0].text, /Check PR comments: 1\/1/);
	assert.match(sent[0].text, /original comment's commit\/diffHunk/);
	await emit("agent_end", { messages: [checked("T1", "fixed")] });
	assert.equal(dialogs[3].options[0], RESOLVE_COMMENT);
	assert.match(dialogs[3].prompt, /Updated, please check/);
	assert.match(mutations(mock)[0].query, /resolveReviewThread/);
});

test("check URL analyzes all authors and resolved threads, batches edited replies and unresolve", async (t) => {
	const { emit, mock, dialogs, sent, ctx } = await setupPR(t, [ALL, REPLY_COMMENT, "Send", REOPEN_COMMENT, "Send"], {
		args: `check ${PR_URL}`, edits: ["Edited first reply", "Edited second reply"],
		mock: { threads: [ghThread("T1", "SomeoneElse"), ghThread("T2", "Test", true)] },
	});
	assert.match(sent[0].text, /SomeoneElse/);
	await emit("agent_end", { messages: [checked("T1", "discussion", "First draft")] });
	assert.equal(sent.length, 2);
	assert.equal(dialogs.length, 1, "No action dialogs before every comment was assessed");
	assert.match(sent[1].text, /Check PR comments: 2\/2/);
	ctx.beforeAnswer = () => assert.equal(mutations(mock).length, 0);
	await emit("agent_end", { messages: [checked("T2", "partial", "Second draft")] });
	assert.equal(dialogs[1].options[0], REPLY_COMMENT);
	assert.equal(dialogs[2].initial, "First draft");
	assert.equal(dialogs[4].options[0], REOPEN_COMMENT);
	const changes = mutations(mock);
	assert.equal(changes.length, 3);
	assert.deepEqual(changes.slice(0, 2).map(({ variables }) => variables.body), ["Edited first reply", "Edited second reply"]);
	assert.match(changes[2].query, /unresolveReviewThread/);
	assert.equal(changes[2].variables.id, "T2");
});

test("just me uses the Git identity and only initial thread authors, not reply authors", async (t) => {
	const own = ghThread("T1", "test", true), other = ghThread("T2", "SomeoneElse");
	other.comments.nodes[1].author.login = "Test";
	const { emit, sent, mock, dialogs } = await setupPR(t, [LEAVE_COMMENT], {
		args: `check ${PR_URL} --just-me`, mock: { threads: [own, other] },
	});
	assert.equal(dialogs.length, 0);
	assert.match(sent[0].text, /GitHub @Test/);
	assert.match(sent[0].text, /Check PR comments: 1\/1/);
	assert.ok(!sent[0].text.includes("SomeoneElse"));
	await emit("agent_end", { messages: [checked("T1", "fixed")] });
	assert.equal(dialogs[0].options[0], LEAVE_COMMENT, "Already resolved fixed threads default to no action");
	assert.equal(mutations(mock).length, 0);
});

test("the Just me dialog can map an explicitly configured GitHub login", async (t) => {
	const { sent } = await setupPR(t, [ME], {
		args: `check ${PR_URL}`, mock: { threads: [ghThread("T1", "CustomLogin")] },
		afterMock: ({ git }) => git("config", "github.user", "CustomLogin"),
	});
	assert.match(sent[0].text, /GitHub @CustomLogin/);
});

test("check mode guards tests, writes, publishing tools, and shell mutations but allows git inspection", async (t) => {
	const { emit } = await setupPR(t, [ALL], { args: `check ${PR_URL}`, mock: { threads: [ghThread()] } });
	for (const command of ["go test ./...", "gh api graphql", "git show HEAD; touch bad", "git diff --output=bad", "git diff --out'put'=bad", "git cat-file --filters HEAD:parser.go", "git checkout main"]) {
		assert.equal((await emit("tool_call", { toolName: "bash", input: { command } })).block, true);
	}
	for (const toolName of ["write", "edit", "github_publish", "powershell"]) {
		assert.equal((await emit("tool_call", { toolName, input: {} })).block, true);
	}
	for (const command of ["git show --no-ext-diff --no-textconv HEAD:parser.go", "git diff --no-ext-diff --no-textconv HEAD~1 HEAD -- parser.go", "git log --no-ext-diff --no-textconv -p -- parser.go", "git -C '/tmp/checkout with spaces' show --no-ext-diff --no-textconv HEAD:parser.go"]) {
		assert.equal(await emit("tool_call", { toolName: "bash", input: { command } }), undefined);
	}
});

test("cancelling any check decision discards the whole pending batch", async (t) => {
	const { emit, mock, notifications } = await setupPR(t, [ALL, RESOLVE_COMMENT, undefined], {
		args: `check ${PR_URL}`, mock: { threads: [ghThread("T1"), ghThread("T2")] },
	});
	await emit("agent_end", { messages: [checked("T1", "fixed")] });
	await emit("agent_end", { messages: [checked("T2", "fixed")] });
	assert.equal(mutations(mock).length, 0);
	assert.match(notifications.at(-1).message, /cancelled; no GitHub actions/);
});

test("invalid model JSON or a mismatched thread id never triggers actions", async (t) => {
	const { emit, mock, notifications, dialogs } = await setupPR(t, [ALL], { args: `check ${PR_URL}`, mock: { threads: [ghThread()] } });
	await emit("agent_end", { messages: [checked("unknown", "fixed")] });
	assert.equal(mutations(mock).length, 0);
	assert.equal(dialogs.length, 1);
	assert.match(notifications.at(-1).message, /Invalid comment assessment/);
});

test("check failure stops mutations without retrying and reports progress", async (t) => {
	const { emit, mock, notifications } = await setupPR(t, [ALL, RESOLVE_COMMENT], {
		args: `check ${PR_URL}`, mock: { threads: [ghThread()], failMutation: true },
	});
	await emit("agent_end", { messages: [checked("T1", "fixed")] });
	assert.match(notifications.at(-1).message, /0\/1 action\(s\) confirmed/);
	await emit("agent_end", { messages: [checked("T1", "fixed")] });
	assert.equal(mutations(mock).length, 1);
});

test("browser comment checking preserves reply drafts and Markdown and sends the edited response", async (t) => {
	const browser = browserAnswers([ALL, REPLY_COMMENT, "Browser edited reply\nMore details", "Send"]);
	const { emit, mock, dialogs } = await setupPR(t, [], {
		args: `check ${PR_URL}`, hasUI: false, web: true, bridge: browser.bridge, mock: { threads: [ghThread()] },
	});
	await emit("agent_end", { messages: [checked("T1", "discussion", "Proposed reply")] });
	assert.equal(browser.dialogs[1].data.markdown, true);
	assert.equal(browser.dialogs[2].initial, "Proposed reply");
	assert.equal(mutations(mock)[0].variables.body, "Browser edited reply\nMore details");
	assert.equal(dialogs.length, 0);
	assert.equal(browser.statuses.at(-1), "idle");
});

for (const change of ["changeHeadOnRecheck", "changeThreadsOnRecheck"]) {
	test(`stale check (${change}) publishes nothing`, async (t) => {
		const { emit, mock, notifications } = await setupPR(t, [ALL, RESOLVE_COMMENT], {
			args: `check ${PR_URL}`, mock: { threads: [ghThread()], [change]: true },
		});
		await emit("agent_end", { messages: [checked("T1", "fixed")] });
		assert.equal(mutations(mock).length, 0);
		assert.match(notifications.at(-1).message, /changed; run \/review check again/);
	});
}

test("empty PR comment lists finish without starting the agent", async (t) => {
	const { notifications } = await setupPR(t, [ALL], { args: `check ${PR_URL}`, expectedSent: 0 });
	assert.match(notifications.at(-1).message, /No matching PR comments/);
});

function inlineFinding(body, path = "parser.go", line = 2, side = "RIGHT") {
	return `${body}\n<!-- pi-review-inline ${JSON.stringify({ path, line, side })} -->`;
}

test("PR review requests inline anchors; publication strips metadata and anchors deleted lines on LEFT", async (t) => {
	const body = "### [High] Deleted guard\nRestore this validation.";
	const { sent, emit, mock, dialogs } = await setupPR(t, ["yes"], {
		mock: { files: [{ filename: "renamed parser.go", previous_filename: "parser.go", patch: "@@ -1,2 +1 @@\n package parser\n-// guard" }] },
	});
	assert.match(sent[0].text, /pi-review-inline/);
	assert.match(sent[0].text, /separate inline review threads/);
	await emit("agent_end", { messages: [assistant(inlineFinding(body, "renamed parser.go", 2, "LEFT"))] });
	assert.match(dialogs[0].prompt, /Inline thread: renamed parser.go:2 \(LEFT\)/);
	assert.ok(!dialogs[0].prompt.includes("pi-review-inline"));
	const posts = mock.calls().filter(({ args }) => args.includes("POST"));
	assert.equal(posts.length, 1);
	assert.deepEqual(JSON.parse(posts[0].input), { commit_id: mock.head, body, path: "renamed parser.go", line: 2, side: "LEFT" });
	assert.ok(!mock.calls().some(({ args }) => args.includes("repos/Example/repo/pulls/42/reviews")));
});

for (const [name, invalid] of [
	["missing location", "### [Low] Unanchored issue\nNo file specified."],
	["non-diff line", inlineFinding("### [Low] Bad line\nDetails.", "parser.go", 50)],
	["wrong side", inlineFinding("### [Low] Bad side\nDetails.", "parser.go", 2, "LEFT")],
]) {
	test(`invalid selected finding (${name}) stops the entire inline batch before any post`, async (t) => {
		const { emit, mock, notifications } = await setupPR(t, ["yes", "yes"]);
		await emit("agent_end", { messages: [assistant(`${FINDING}\n\n${invalid}`)] });
		assert.equal(mock.calls().filter(({ args }) => args.includes("POST")).length, 0);
		assert.match(notifications.at(-1).message, /No PR comments sent/);
	});
}

test("an invalid declined finding does not prevent valid inline threads from being posted", async (t) => {
	const { emit, mock } = await setupPR(t, ["yes", "no"]);
	await emit("agent_end", { messages: [assistant(`${FINDING}\n\n### [Low] Unanchored issue\nNo location.`)] });
	assert.equal(mock.calls().filter(({ args }) => args.includes("POST")).length, 1);
});

test("PR head changing before inline publication rejects all selected findings", async (t) => {
	const { emit, mock, notifications } = await setupPR(t, ["yes"], { mock: { changeHeadOnRecheck: true } });
	await emit("agent_end", { messages: [assistant(FINDING)] });
	assert.equal(mock.calls().filter(({ args }) => args.includes("POST")).length, 0);
	assert.match(notifications.at(-1).message, /PR head changed/);
});

test("Just me starts a comment check using gh auth status when the Git email cannot be mapped", async (t) => {
	const { emit, mock, sent, notifications } = await setupPR(t, [LEAVE_COMMENT], {
		args: `check ${PR_URL} --just-me`, mock: { threads: [ghThread("T1", "Test"), ghThread("T2", "InactiveAccount")] },
		afterMock: ({ git }) => git("config", "user.email", "unmapped-private@example.com"),
	});
	assert.match(sent[0].text, /GitHub @Test/);
	assert.match(sent[0].text, /Checking 1 comments/);
	assert.ok(!sent[0].text.includes("InactiveAccount"));
	assert.ok(mock.calls().some(({ args }) => args[0] === "auth" && args[1] === "status"));
	assert.match(notifications.at(-1).message, /opened by @Test/);
	await emit("agent_end", { messages: [checked("T1", "fixed")] });
	assert.equal(mutations(mock).length, 0);
});

test("cancelling a local finding stops instead of opening the next finding", async t => {
	const { emit, dialogs, notifications } = await setup(t, [SKIP_TESTS, FIX_LOCALLY, undefined]);
	await emit("agent_end", { messages: [assistant(`${FINDING}\n\n${LOW_FINDING}`)] });
	assert.equal(dialogs.length, 3); assert.match(notifications.at(-1).message, /Review cancelled/);
	await emit("agent_end", { messages: [assistant(LOW_FINDING)] }); assert.equal(dialogs.length, 3);
});

test("cancelling fix validation stops rather than accepting the fix", async t => {
	const { emit, dialogs, notifications, sent } = await setup(t, [SKIP_TESTS, FIX_LOCALLY, "yes", undefined]);
	await emit("agent_end", { messages: [assistant(`${FINDING}\n\n${LOW_FINDING}`)] });
	assert.equal(sent.length, 2);
	await emit("agent_end", { messages: [assistant("Fixed")] });
	assert.equal(dialogs.length, 4); assert.match(notifications.at(-1).message, /Review cancelled/);
});

test("local review accepts an explicit base and reports generic test files", async t => {
	const { sent } = await setup(t, [SKIP_TESTS, FIX_LOCALLY], { args: "--base main", beforeReview: ({cwd, git}) => {
		writeFileSync(join(cwd, "bounds.test.ts"), "test('bounds', () => {});\n"); git("add", "."); git("commit", "-m", "tests");
	} });
	assert.match(sent[0].text, /Baseline reference: main/); assert.match(sent[0].text, /Test files added \(1\): bounds.test.ts/);
});
