import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/pi.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": fixture,
	"@earendil-works/pi-tui": fixture,
} });
const { ReviewUI } = await jiti.import("../web-ui.ts");

function bridgeFor(t) {
	const dialogs = [], closed = [], statuses = [];
	const bridge = {
		active: true,
		update: ({ status }) => statuses.push(status),
		openDecision: (dialog) => {
			let resolve, settled = false;
			const promise = new Promise((done) => { resolve = done; });
			const decision = { dialog, promise, resolve(value) {
				if (settled) return;
				settled = true;
				closed.push(value);
				resolve(value);
			} };
			dialogs.push(decision);
			return decision;
		},
	};
	const symbol = Symbol.for("spikat.pi.web.bridge"), old = globalThis[symbol];
	globalThis[symbol] = bridge;
	t.after(() => { if (old === undefined) delete globalThis[symbol]; else globalThis[symbol] = old; });
	return { bridge, dialogs, closed, statuses };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const kind of ["select", "input"]) {
	test(`a browser answer dismisses the native ${kind} without replacing the answer with cancellation`, async (t) => {
		const web = bridgeFor(t), ui = new ReviewUI();
		let cancelled = false, nativeAnswer;
		const ctx = { hasUI: true, mode: "tui", ui: {
			[kind]: (_title, _options, { signal }) => new Promise((resolve) => {
				nativeAnswer = resolve;
				signal.addEventListener("abort", () => { cancelled = true; resolve(undefined); });
			}),
		} };
		const answer = kind === "select" ? ui.select(ctx, "Fix this issue?", ["yes", "no"]) : ui.input(ctx, "PR URL", "https://github.com/owner/repo/pull/123");
		const value = kind === "select" ? "yes" : "https://github.com/owner/repo/pull/123";
		await tick();
		web.dialogs[0].resolve(value);
		assert.equal(await answer, value);
		assert.equal(cancelled, true);
		nativeAnswer("Late terminal response");
		await tick();
		assert.deepEqual(web.closed, [value]);
		assert.deepEqual(web.statuses, ["waiting", "busy"]);
	});
}

test("a terminal answer dismisses the browser dialog and ignores a later browser answer", async (t) => {
	const web = bridgeFor(t), ui = new ReviewUI();
	let nativeAnswer;
	const ctx = { hasUI: true, mode: "tui", ui: { select: () => new Promise((resolve) => { nativeAnswer = resolve; }) } };
	const answer = ui.select(ctx, "Fix this issue?", ["yes", "no"]);
	await tick();
	nativeAnswer("no");
	assert.equal(await answer, "no");
	web.dialogs[0].resolve("yes");
	assert.deepEqual(web.closed, ["no"]);
});

test("an inactive web bridge preserves the standalone terminal workflow", async (t) => {
	const web = bridgeFor(t), ui = new ReviewUI();
	web.bridge.active = false;
	const ctx = { hasUI: true, mode: "rpc", ui: { select: async () => "yes" } };
	assert.equal(await ui.select(ctx, "Fix this issue?", ["yes", "no"]), "yes");
	assert.equal(web.dialogs.length, 0);
	assert.deepEqual(web.statuses, []);
});

test("browser-only sessions do not invoke unavailable terminal UI", async (t) => {
	const web = bridgeFor(t), ui = new ReviewUI();
	const ctx = { hasUI: false, mode: "print", ui: { input() { assert.fail("No terminal UI available"); } } };
	const answer = ui.input(ctx, "GitHub PR URL", "https://github.com/owner/repo/pull/123");
	web.dialogs[0].resolve("https://github.com/owner/repo/pull/123");
	assert.equal(await answer, "https://github.com/owner/repo/pull/123");
});

test("unknown browser selections are cancellation, never consent to a fix or comment", async (t) => {
	const web = bridgeFor(t), ui = new ReviewUI();
	const ctx = { hasUI: false, mode: "print" };
	for (const value of ["allow everything", { value: "yes" }, true]) {
		const answer = ui.select(ctx, "Post a comment?", ["yes", "no"]);
		web.dialogs.at(-1).resolve(value);
		assert.equal(await answer, undefined);
	}
});

test("multiline browser iteration prompts close the custom terminal editor", async (t) => {
	const web = bridgeFor(t), ui = new ReviewUI();
	let done, component;
	const ctx = { hasUI: true, mode: "tui", ui: {
		editor() { assert.fail("The uncancellable native editor must not be opened"); },
		custom: (factory) => new Promise((resolve) => {
			done = resolve;
			component = factory({ requestRender() {} }, { fg: (_color, text) => text }, {}, resolve);
		}),
	} };
	const answer = ui.editor(ctx, "Iteration prompt");
	await tick();
	assert.equal(web.dialogs[0].dialog.data.multiline, true);
	component.focused = true;
	assert.equal(component.focused, true);
	web.dialogs[0].resolve("First instruction\nSecond instruction");
	assert.equal(await answer, "First instruction\nSecond instruction");
	done("Late terminal instruction");
	await tick();
	assert.deepEqual(web.closed, ["First instruction\nSecond instruction"]);
});

test("abort and session shutdown cancel pending decisions in both views", async (t) => {
	const web = bridgeFor(t), ui = new ReviewUI(), abort = new AbortController();
	const ctx = { hasUI: false, mode: "print", signal: abort.signal };
	const first = ui.select(ctx, "Post?", ["yes", "no"]);
	abort.abort();
	assert.equal(await first, undefined);
	const second = ui.select({ hasUI: false, mode: "print" }, "Post?", ["yes", "no"]);
	ui.dispose();
	assert.equal(await second, undefined);
	assert.deepEqual(web.closed, [undefined, undefined]);
	assert.equal(await ui.select(ctx, "Should stay closed", ["yes", "no"]), undefined);
	assert.equal(web.dialogs.length, 2);
});
