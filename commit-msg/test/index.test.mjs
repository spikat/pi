import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
const fixture = fileURLToPath(new URL("./fixtures/pi.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { fsCache: false, alias: { "@earendil-works/pi-coding-agent": fixture } });
const extension = await jiti.import("../index.ts", { default: true });
const commandName = "gen-commit-msg";
const finalText = "Fix bounds checking";

async function setup(t) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-generator-")); t.after(() => rm(cwd, { recursive: true, force: true }));
	const git = (...args) => execFileSync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } }).toString().trim();
	git("init", "-b", "main"); await writeFile(join(cwd, "file.txt"), "base\n"); git("add", "."); git("commit", "-m", "base");
	git("checkout", "-b", "feature"); await writeFile(join(cwd, "file.txt"), "change\n"); git("add", ".");
	if (commandName === "gen-pr-desc") git("commit", "-m", "change");
	const handlers = new Map(), commands = new Map(), sent = [], confirmations = [], notifications = [];
	const globals = globalThis, key = Symbol.for("spikat.pi.web.command-contributors"), bridgeKey = Symbol.for("spikat.pi.web.bridge");
	const old = globals[key], oldBridge = globals[bridgeKey]; globals[key] = new Set(); delete globals[bridgeKey];
	t.after(() => { if (old === undefined) delete globals[key]; else globals[key] = old; if (oldBridge !== undefined) globals[bridgeKey] = oldBridge; });
	extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command), sendUserMessage: prompt => sent.push(prompt) });
	const ctx = { cwd, hasUI: true, isIdle: () => true, waitForIdle: async () => {}, sessionManager: { getSessionId: () => "session" }, ui: { notify: (...args) => notifications.push(args), confirm: async (...args) => { confirmations.push(args); return false; } } };
	await handlers.get("session_start")({}, ctx);
	const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
	const generate = args => commands.get(commandName).handler(args ?? "", ctx);
	return { cwd, git, ctx, sent, confirmations, notifications, emit, generate, globals, key };
}
const message = (text, stopReason = "stop") => ({ message: { role: "assistant", stopReason, content: [{ type: "text", text }] } });

test("only the final successful result of the matching run is offered after settle", async t => {
	const s = await setup(t); await s.generate(); assert.equal(s.sent.length, 1);
	await s.emit("before_agent_start", { prompt: s.sent[0] });
	await s.emit("message_end", message("I will inspect the diff first.", "toolUse")); assert.equal(s.confirmations.length, 0);
	await s.emit("message_end", message(finalText)); assert.equal(s.confirmations.length, 0);
	await s.emit("agent_settled"); assert.equal(s.confirmations.length, 1);
	await s.emit("agent_settled"); assert.equal(s.confirmations.length, 1);
});

test("parallel invocations prepare and send exactly once", async t => {
	const s = await setup(t); await Promise.all([s.generate(), s.generate()]); assert.equal(s.sent.length, 1);
});

for (const stopReason of ["error", "aborted"]) test(`a ${stopReason} result cannot capture a later unrelated reply`, async t => {
	const s = await setup(t); await s.generate(); await s.emit("before_agent_start", { prompt: s.sent[0] });
	await s.emit("message_end", message("partial", stopReason)); await s.emit("message_end", message(finalText)); await s.emit("agent_settled"); assert.equal(s.confirmations.length, 0);
});

test("a different prompt or session invalidates the pending result", async t => {
	const s = await setup(t); await s.generate(); await s.emit("before_agent_start", { prompt: "unrelated" }); await s.emit("message_end", message(finalText)); await s.emit("agent_settled"); assert.equal(s.confirmations.length, 0);
	await s.generate(); await s.emit("session_shutdown"); assert.equal(s.globals[s.key].size, 0);
	await s.emit("session_start"); assert.equal(s.globals[s.key].size, 1);
});

test("tools are blocked only during the owned generation", async t => {
	const s = await setup(t); await s.generate(); assert.equal(await s.emit("tool_call", { toolName: "write" }), undefined);
	await s.emit("before_agent_start", { prompt: s.sent[0] }); assert.equal((await s.emit("tool_call", { toolName: "write" })).block, true);
	await s.emit("agent_settled"); assert.equal(await s.emit("tool_call", { toolName: "write" }), undefined);
});
