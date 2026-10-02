import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "../index.js";

type Completion = ExtensionContext["modelRegistry"]["complete"];
type Model = NonNullable<ExtensionContext["model"]>;
type RequestContext = Parameters<Completion>[1];
type RequestOptions = Parameters<Completion>[2] & { reasoning?: string; reasoningEffort?: string };
type Response = Awaited<ReturnType<Completion>>;
type Handler = (event: { toolName: string; input: { command: string } }, ctx: ExtensionContext) => Promise<unknown>;
const model = { provider: "test", id: "reasoning-model", reasoning: true } as Model;
const response = (content: unknown, stopReason = "stop") => ({ content, stopReason }) as Response;
const textResponse = (text: string) => response([{ type: "text", text }]);

async function review(t: TestContext, options: {
	modern?: boolean;
	model?: Model | null;
	signal?: AbortSignal;
	complete?: (model: Model, context: RequestContext, options: RequestOptions) => Promise<Response>;
	allowed?: boolean;
	denied?: boolean;
	web?: boolean;
} = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "cw-gate-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	t.after(async () => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		await rm(cwd, { recursive: true, force: true });
	});
	if (options.allowed || options.denied) {
		await mkdir(join(cwd, ".pi"));
		await writeFile(join(cwd, ".pi", "commands-whitelist.json"), JSON.stringify({ version: 2, whitelist: options.allowed ? ["echo *"] : [], blacklist: options.denied ? ["echo *"] : [], editDirectories: [], editFiles: [] }));
	}
	let handler: Handler | undefined;
	extension({
		on(name: string, fn: Handler) { if (name === "tool_call") handler = fn; },
		registerCommand() {},
	} as unknown as ExtensionAPI);
	const requests: { model: Model; context: RequestContext; options: RequestOptions }[] = [];
	const complete = async (model: Model, context: RequestContext, requestOptions: RequestOptions) => {
		requests.push({ model, context, options: requestOptions });
		return options.complete ? options.complete(model, context, requestOptions) : textResponse("Affiche un message pour vérifier le terminal.");
	};
	const renders: string[][] = [];
	const dialogs: { data?: Record<string, unknown> }[] = [];
	if (options.web) {
		const symbol = Symbol.for("spikat.pi.web.bridge");
		const globals = globalThis as Record<symbol, unknown>;
		const previous = globals[symbol];
		globals[symbol] = { active: true, openDecision(dialog: { data?: Record<string, unknown> }) {
			dialogs.push(dialog);
			return { promise: Promise.resolve({ action: "block" }), resolve() {} };
		} };
		t.after(() => { if (previous === undefined) delete globals[symbol]; else globals[symbol] = previous; });
	}
	const ctx = {
		cwd, mode: options.web ? "rpc" : "tui", hasUI: true,
		model: options.model === null ? undefined : options.model ?? model,
		signal: options.signal,
		sessionManager: { getBranch: () => [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "Vérifie le terminal." }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Not a user task" }] } },
		] },
		modelRegistry: options.modern ? {
			// Virtual models need not have auth on their own provider; let the
			// runtime route and resolve credentials rather than preempting it.
			hasConfiguredAuth: () => false,
			complete: () => { throw new Error("Raw API must not be used"); },
			streamSimple: (model: Model, context: RequestContext, options: RequestOptions) => ({ result: () => complete(model, context, options) }),
		} : { hasConfiguredAuth: () => true, complete },
		ui: { custom: (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => new Promise((resolve) => {
			const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
			const component = factory({ requestRender() {} } as never, theme as never, {} as never, resolve);
			if (component instanceof Promise) throw new Error("Unexpected async component");
			for (const width of [120, 32]) {
				const lines = component.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				renders.push(lines);
			}
			component.handleInput!("\x03");
		}) },
	} as unknown as ExtensionContext;
	const result = await handler!({ toolName: "bash", input: { command: "echo test" } }, ctx);
	return { result, requests, renders, dialogs };
}

test("review displays a task-aware explanation before choices using the simple API", async (t) => {
	const { requests, renders } = await review(t, { modern: true });
	assert.equal(requests.length, 1);
	assert.equal(requests[0]!.options!.reasoning, "minimal");
	assert.equal(requests[0]!.options!.maxTokens, 2048);
	assert.equal(requests[0]!.options!.cacheRetention, "none");
	const prompt = JSON.stringify(requests[0]!.context);
	assert.match(prompt, /Vérifie le terminal/);
	assert.match(prompt, /echo test/);
	assert.doesNotMatch(prompt, /Not a user task/);
	const lines = renders[0]!;
	const summaryIndex = lines.findIndex((line) => line.startsWith("Summary:"));
	assert.match(lines[summaryIndex]!, /Affiche un message/);
	assert.ok(summaryIndex > lines.findIndex((line) => line.startsWith("Original:")));
	assert.ok(summaryIndex < lines.findIndex((line) => line.includes("echo test *")));
});

test("legacy registries receive enough budget and low reasoning", async (t) => {
	const { requests, renders } = await review(t);
	assert.equal(requests[0]!.options!.reasoningEffort, "low");
	assert.equal(requests[0]!.options!.maxTokens, 2048);
	assert.match(renders[0]!.join("\n"), /Summary: Affiche un message/);
});

test("legacy non-reasoning models do not receive reasoning options", async (t) => {
	const { requests } = await review(t, { model: { ...model, reasoning: false } });
	assert.equal(requests[0]!.options!.reasoningEffort, undefined);
});

test("explanations remain short and exclude thinking blocks", async (t) => {
	const { renders } = await review(t, { complete: async () => response([
		{ type: "thinking", thinking: "Private reasoning" },
		{ type: "text", text: "Première phrase. Deuxième phrase. Troisième phrase. Quatrième phrase." },
	]) });
	assert.match(renders[0]!.join("\n"), /Summary: Première phrase. Deuxième phrase. Troisième phrase./);
	assert.doesNotMatch(renders[0]!.join("\n"), /Quatrième|Private reasoning/);
});

for (const [label, complete, reason] of [
	["empty text", async () => textResponse("  "), "the model returned no explanation"],
	["thinking-only output", async () => response([{ type: "thinking", thinking: "No visible text" }], "length"), "the model returned no explanation"],
	["error response", async () => response([{ type: "text", text: "Incomplete misleading text" }], "error"), "the model request failed"],
	["thrown error", async () => { throw new Error("Secret provider payload"); }, "the model request failed"],
	["abort response", async () => response([], "aborted"), "generation cancelled"],
] as const) {
	test(`review shows an explicit status for ${label} without changing the approval decision`, async (t) => {
		const { renders, result } = await review(t, { modern: true, complete });
		const lines = renders[0]!.join("\n");
		assert.ok(lines.includes(`Summary: Explanation unavailable: ${reason}.`));
		assert.match(lines, /Validate current selection/);
		assert.doesNotMatch(lines, /Incomplete misleading text|Secret provider payload/);
		assert.deepEqual(result, { block: true, reason: "commands whitelist: cancelled by user" });
	});
}

test("no active model produces a visible status without a request", async (t) => {
	const { requests, renders } = await review(t, { model: null });
	assert.equal(requests.length, 0);
	assert.match(renders[0]!.join("\n"), /Explanation unavailable: no active model/);
});

test("an already aborted turn denies without opening a dialog or requesting an explanation", async (t) => {
	const { requests, renders, result } = await review(t, { signal: AbortSignal.abort() });
	assert.equal(requests.length, 0); assert.equal(renders.length, 0);
	assert.deepEqual(result, { block: true, reason: "commands whitelist: cancelled by user" });
});

test("the web dialog receives the same explanation", async (t) => {
	const { dialogs } = await review(t, { modern: true, web: true });
	assert.equal(dialogs[0]!.data!.summary, "Affiche un message pour vérifier le terminal.");
});

test("the web dialog also reports explanation generation failures", async (t) => {
	const { dialogs } = await review(t, { modern: true, web: true, complete: async () => textResponse("") });
	assert.equal(dialogs[0]!.data!.summary, "Explanation unavailable: the model returned no explanation.");
});

for (const state of ["allowed", "denied"] as const) {
	test(`already ${state} commands do not generate explanations or show a dialog`, async (t) => {
		const { requests, renders, result } = await review(t, { [state]: true });
		assert.equal(requests.length, 0);
		assert.equal(renders.length, 0);
		if (state === "allowed") assert.equal(result, undefined);
		else assert.match(JSON.stringify(result), /blocked command/);
	});
}
