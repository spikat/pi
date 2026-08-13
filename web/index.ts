import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { LocalWebBridge, applyWebCommandContributors, installWebBridge, type AgentMetadata } from "./bridge.js";
import { BROWSER_QUEUE_MAX_CHARS, BROWSER_QUEUE_MAX_ITEMS, HISTORY_ENTRY_MAX_CHARS, HISTORY_MAX_CHARS, HISTORY_MAX_ENTRIES, HISTORY_PROMPT_LIMIT, canQueueBrowserInput, compactForTransport } from "./core.js";
import { DEFAULT_PORT, readBridgeState } from "./runtime.js";

const execFileAsync = promisify(execFile);
const bridge = new LocalWebBridge();
installWebBridge(bridge);
applyWebCommandContributors(bridge);

type ToolPath = { path: string; toolName: string };

const PREVIEW_EXTENSIONS = new Set([".md", ".txt", ".go", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".py", ".rb", ".rs", ".java", ".kt", ".sh", ".bash", ".zsh", ".fish", ".sql", ".html", ".css", ".scss", ".xml", ".dockerfile"]);
const PREVIEW_BASENAMES = new Set(["makefile", "dockerfile", "cmakelists.txt", ".gitignore", ".dockerignore", ".editorconfig"]);
const EVENT_MAX_CHARS = 64 * 1024;

function plain(value: unknown, maxChars = EVENT_MAX_CHARS): unknown { return compactForTransport(value, maxChars); }
function serializedLength(value: unknown): number { try { return JSON.stringify(value).length; } catch { return Number.POSITIVE_INFINITY; } }

function history(ctx: ExtensionContext): unknown[] {
	const entries = ctx.sessionManager.getEntries().flatMap((entry) => {
		const candidate = entry as { type?: unknown; id?: unknown; message?: unknown };
		return candidate.type === "message" && candidate.message ? [{ id: candidate.id, message: candidate.message }] : [];
	});
	const prompts = entries.map((entry, index) => (entry.message as { role?: unknown }).role === "user" ? index : -1).filter((index) => index >= 0);
	const start = prompts.length ? prompts[Math.max(0, prompts.length - HISTORY_PROMPT_LIMIT)]! : Math.max(0, entries.length - 6);
	let remaining = HISTORY_MAX_CHARS;
	const retained: unknown[] = [];
	for (let index = entries.length - 1; index >= start && retained.length < HISTORY_MAX_ENTRIES && remaining > 0; index--) {
		const entry = entries[index]!;
		const item = { id: entry.id, message: plain(entry.message, Math.min(HISTORY_ENTRY_MAX_CHARS, remaining)) };
		const length = serializedLength(item);
		if (length > remaining) continue;
		remaining -= length;
		retained.unshift(item);
	}
	return retained;
}

function metadata(pi: ExtensionAPI, ctx: ExtensionContext): AgentMetadata {
	return {
		id: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		sessionFile: ctx.sessionManager.getSessionFile(),
		name: pi.getSessionName() ?? basename(ctx.cwd),
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		status: ctx.isIdle() ? "idle" : "busy",
		commands: pi.getCommands().map((command) => ({ name: command.name, description: command.description, source: command.source })),
		history: history(ctx),
	};
}

function previewPathFromArgs(cwd: string, value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = (value as { path?: unknown }).path;
	if (typeof raw !== "string") return undefined;
	const path = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw.startsWith("@") ? raw.slice(1) : raw);
	return PREVIEW_EXTENSIONS.has(extname(path).toLowerCase()) || PREVIEW_BASENAMES.has(basename(path).toLowerCase()) ? path : undefined;
}

async function hasGitDiff(cwd: string, path: string): Promise<boolean> {
	const pathInRepository = relative(resolve(cwd), path);
	if (pathInRepository.startsWith("..") || isAbsolute(pathInRepository)) return false;
	try {
		const repository = await execFileAsync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
		if (repository.stdout.trim() !== "true") return false;
		await execFileAsync("git", ["-C", cwd, "diff", "--quiet", "--no-ext-diff", "--no-textconv", "--", pathInRepository]);
		return false;
	} catch (error) {
		return (error as { code?: unknown }).code === 1;
	}
}

export default function (pi: ExtensionAPI) {
	let current: ExtensionContext | undefined;
	let enabled = false;
	let dispatching = false;
	const pendingInputs: string[] = [];
	let pendingInputChars = 0;
	const writePaths = new Map<string, ToolPath>();
	const emitQueue = () => bridge.emit("queue", { pending: pendingInputs.length, characters: pendingInputChars, maxPending: BROWSER_QUEUE_MAX_ITEMS, maxCharacters: BROWSER_QUEUE_MAX_CHARS });
	const clearPendingInputs = () => { const count = pendingInputs.length; pendingInputs.length = 0; pendingInputChars = 0; emitQueue(); return count; };

	const dispatchNext = () => {
		if (!enabled || dispatching || !current || !pendingInputs.length || !current.isIdle()) return;
		dispatching = true;
		const text = pendingInputs.shift()!;
		pendingInputChars = Math.max(0, pendingInputChars - text.length);
		emitQueue();
		try { pi.sendUserMessage(text); }
		catch (error) { bridge.emit("error", { message: error instanceof Error ? error.message : String(error) }); dispatching = false; dispatchNext(); }
	};

	bridge.onRename((name) => { if (enabled) pi.setSessionName(name.trim()); });
	bridge.onDisconnect(() => {
		if (!enabled) return;
		enabled = false; pendingInputs.length = 0; pendingInputChars = 0; bridge.disconnect();
		current?.ui.notify("Disconnected from Pi Web by a browser client.", "warning");
	});
	bridge.onClearQueue(() => {
		if (!enabled) return;
		const count = clearPendingInputs();
		if (count) bridge.emit("status", { message: `Discarded ${count} queued browser prompt${count === 1 ? "" : "s"}.` });
	});

	bridge.onSync(() => { if (enabled && current) bridge.update({ history: history(current) }); });

	bridge.onInput((text) => {
		if (!enabled || !current) return;
		if (!text.trim()) return;
		if (text.startsWith("/")) { bridge.emit("error", { message: `This agent cannot execute ${text.split(/\s+/, 1)[0]} through Pi Web. It is listed for completion, but only commands that explicitly opt into Pi Web can be invoked remotely.` }); return; }
		if (!canQueueBrowserInput(pendingInputs.length, pendingInputChars, text)) { bridge.emit("error", { message: `Browser prompt queue is full (maximum ${BROWSER_QUEUE_MAX_ITEMS} prompts or ${BROWSER_QUEUE_MAX_CHARS} characters). Drop queued prompts before sending more.` }); emitQueue(); return; }
		pendingInputs.push(text); pendingInputChars += text.length;
		emitQueue();
		dispatchNext();
	});

	pi.registerCommand("web", {
		description: "Connect this Pi session to the local HTTPS web dashboard",
		handler: async (args, ctx) => {
			const [command = "on", portArgument] = args.trim() ? args.trim().split(/\s+/, 2) : [];
			if (command === "on") {
				const requestedPort = portArgument === undefined ? undefined : Number(portArgument);
				if (requestedPort !== undefined && (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535)) { ctx.ui.notify("Usage: /web on [port], where port is between 1 and 65535", "warning"); return; }
				current = ctx;
				try {
					await bridge.connect(metadata(pi, ctx), requestedPort, requestedPort !== undefined);
					enabled = true;
					const state = await readBridgeState();
					ctx.ui.notify(`Open https://localhost:${state?.port ?? DEFAULT_PORT}/?token=${state?.browserToken ?? "unavailable"}`, "info");
					bridge.emit("status", { message: "Agent connected to Pi Web" });
				} catch (error) { ctx.ui.notify(`Unable to start Pi Web: ${error instanceof Error ? error.message : String(error)}`, "error"); }
				return;
			}
			if (command === "off") { enabled = false; pendingInputs.length = 0; pendingInputChars = 0; bridge.disconnect(); ctx.ui.notify("This Pi session disconnected from the web dashboard", "info"); return; }
			if (command === "status") { ctx.ui.notify(enabled ? "This Pi session is connected to Pi Web." : "This Pi session is not connected to Pi Web.", "info"); return; }
			ctx.ui.notify("Usage: /web [on [port]|off|status]", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => { current = ctx; });
	pi.on("session_shutdown", async () => { enabled = false; pendingInputs.length = 0; pendingInputChars = 0; bridge.disconnect(); current = undefined; });
	pi.on("session_info_changed", async (_event, ctx) => { if (enabled) bridge.update(metadata(pi, ctx)); });
	pi.on("model_select", async (_event, ctx) => { if (enabled) bridge.update(metadata(pi, ctx)); });
	pi.on("agent_start", async (_event, ctx) => { current = ctx; if (enabled) bridge.emit("agent_start", {}); });
	pi.on("agent_settled", async (_event, ctx) => { current = ctx; dispatching = false; if (enabled) { bridge.update({ history: history(ctx) }); bridge.emit("agent_settled", { pending: pendingInputs.length }); dispatchNext(); } });
	pi.on("message_start", async (event, ctx) => { current = ctx; if (enabled) bridge.emit("message_start", { message: plain(event.message) as Record<string, unknown> }); });
	pi.on("message_update", async (event, ctx) => { current = ctx; if (enabled) bridge.emit("message_update", { message: plain(event.message) as Record<string, unknown> }); });
	pi.on("message_end", async (event, ctx) => { current = ctx; if (enabled) bridge.emit("message_end", { message: plain(event.message) as Record<string, unknown> }); });
	pi.on("tool_execution_start", async (event, ctx) => {
		current = ctx;
		const value = event as unknown as { toolCallId: string; toolName: string; args: unknown };
		const path = (value.toolName === "write" || value.toolName === "edit") ? previewPathFromArgs(ctx.cwd, value.args) : undefined;
		if (path) writePaths.set(value.toolCallId, { path, toolName: value.toolName });
		if (enabled) bridge.emit("tool_start", { toolCallId: value.toolCallId, toolName: value.toolName, args: plain(value.args) as Record<string, unknown> });
	});
	pi.on("tool_execution_update", async (event, ctx) => { current = ctx; if (enabled) { const value = event as unknown as { toolCallId: string; toolName: string; partialResult: unknown }; bridge.emit("tool_update", { toolCallId: value.toolCallId, toolName: value.toolName, result: plain(value.partialResult) as Record<string, unknown> }); } });
	pi.on("tool_execution_end", async (event, ctx) => {
		current = ctx;
		const value = event as unknown as { toolCallId: string; toolName: string; result: unknown; isError: boolean };
		if (enabled) bridge.emit("tool_end", { toolCallId: value.toolCallId, toolName: value.toolName, result: plain(value.result) as Record<string, unknown>, isError: value.isError });
		const changed = writePaths.get(value.toolCallId); writePaths.delete(value.toolCallId);
		if (enabled && changed && !value.isError) bridge.emit("file_changed", { path: changed.path, toolName: changed.toolName, diffAvailable: await hasGitDiff(ctx.cwd, changed.path) });
	});
}
