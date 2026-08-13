import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename, isAbsolute, resolve } from "node:path";
import { LocalWebBridge, applyWebCommandContributors, installWebBridge, type AgentMetadata } from "./bridge.js";
import { DEFAULT_PORT, readBridgeState } from "./runtime.js";

const bridge = new LocalWebBridge();
installWebBridge(bridge);
applyWebCommandContributors(bridge);

type ToolPath = { path: string; toolName: string };

function plain(value: unknown): unknown {
	try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
}

function history(ctx: ExtensionContext): unknown[] {
	return ctx.sessionManager.getEntries().flatMap((entry) => {
		const candidate = entry as { type?: unknown; id?: unknown; message?: unknown };
		return candidate.type === "message" && candidate.message ? [{ id: candidate.id, message: plain(candidate.message) }] : [];
	});
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

function pathFromArgs(cwd: string, value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = (value as { path?: unknown }).path;
	if (typeof raw !== "string" || !raw.toLowerCase().endsWith(".md")) return undefined;
	return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw.startsWith("@") ? raw.slice(1) : raw);
}

export default function (pi: ExtensionAPI) {
	let current: ExtensionContext | undefined;
	let enabled = false;
	let dispatching = false;
	const pendingInputs: string[] = [];
	const writePaths = new Map<string, ToolPath>();

	const dispatchNext = () => {
		if (!enabled || dispatching || !current || !pendingInputs.length || !current.isIdle()) return;
		dispatching = true;
		const text = pendingInputs.shift()!;
		bridge.emit("queue", { pending: pendingInputs.length, active: text });
		try { pi.sendUserMessage(text); }
		catch (error) { bridge.emit("error", { message: error instanceof Error ? error.message : String(error) }); dispatching = false; dispatchNext(); }
	};

	bridge.onRename((name) => { if (enabled) pi.setSessionName(name.trim()); });
	bridge.onDisconnect(() => {
		if (!enabled) return;
		enabled = false; pendingInputs.length = 0; bridge.disconnect();
		current?.ui.notify("Disconnected from Pi Web by a browser client.", "warning");
	});

	bridge.onSync(() => { if (enabled && current) bridge.update({ history: history(current) }); });

	bridge.onInput((text) => {
		if (!enabled || !current) return;
		if (!text.trim()) return;
		if (text.startsWith("/")) { bridge.emit("error", { message: `This agent cannot execute ${text.split(/\s+/, 1)[0]} through Pi Web. It is listed for completion, but only commands that explicitly opt into Pi Web can be invoked remotely.` }); return; }
		pendingInputs.push(text);
		bridge.emit("queue", { pending: pendingInputs.length, active: dispatching ? "running" : undefined });
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
			if (command === "off") { enabled = false; pendingInputs.length = 0; bridge.disconnect(); ctx.ui.notify("This Pi session disconnected from the web dashboard", "info"); return; }
			if (command === "status") { ctx.ui.notify(enabled ? "This Pi session is connected to Pi Web." : "This Pi session is not connected to Pi Web.", "info"); return; }
			ctx.ui.notify("Usage: /web [on [port]|off|status]", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => { current = ctx; });
	pi.on("session_shutdown", async () => { enabled = false; pendingInputs.length = 0; bridge.disconnect(); current = undefined; });
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
		const path = (value.toolName === "write" || value.toolName === "edit") ? pathFromArgs(ctx.cwd, value.args) : undefined;
		if (path) writePaths.set(value.toolCallId, { path, toolName: value.toolName });
		if (enabled) bridge.emit("tool_start", { toolCallId: value.toolCallId, toolName: value.toolName, args: plain(value.args) as Record<string, unknown> });
	});
	pi.on("tool_execution_update", async (event, ctx) => { current = ctx; if (enabled) { const value = event as unknown as { toolCallId: string; toolName: string; partialResult: unknown }; bridge.emit("tool_update", { toolCallId: value.toolCallId, toolName: value.toolName, result: plain(value.partialResult) as Record<string, unknown> }); } });
	pi.on("tool_execution_end", async (event, ctx) => {
		current = ctx;
		const value = event as unknown as { toolCallId: string; toolName: string; result: unknown; isError: boolean };
		if (enabled) bridge.emit("tool_end", { toolCallId: value.toolCallId, toolName: value.toolName, result: plain(value.result) as Record<string, unknown>, isError: value.isError });
		const changed = writePaths.get(value.toolCallId); writePaths.delete(value.toolCallId);
		if (enabled && changed && !value.isError) bridge.emit("markdown_changed", { path: changed.path, toolName: changed.toolName });
	});
}
