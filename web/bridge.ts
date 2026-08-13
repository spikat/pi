import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { ensureBridge, type BridgeState } from "./runtime.js";

export const WEB_BRIDGE_SYMBOL = Symbol.for("spikat.pi.web.bridge");
export const WEB_COMMAND_CONTRIBUTORS_SYMBOL = Symbol.for("spikat.pi.web.command-contributors");

export type WebDialog = {
	id: string;
	kind: "confirm" | "select" | "input" | "command";
	title: string;
	detail?: string;
	options?: string[];
	initial?: string;
	data?: Record<string, unknown>;
};
export type WebDecision<T = unknown> = { id: string; promise: Promise<T>; resolve(value: T): void };
export type AgentMetadata = {
	id: string;
	cwd: string;
	sessionFile?: string;
	name?: string;
	model?: string;
	status?: "busy" | "idle" | "waiting";
	commands: Array<{ name: string; description?: string; source: string }>;
	history: unknown[];
};
export type WebCommandContributor = (bridge: WebBridge) => void;
export type WebBridge = {
	readonly active: boolean;
	connect(metadata: AgentMetadata, port?: number, requirePort?: boolean): Promise<void>;
	disconnect(): void;
	update(metadata: Partial<AgentMetadata>): void;
	emit(type: string, payload: Record<string, unknown>): void;
	openDecision<T>(dialog: Omit<WebDialog, "id">): WebDecision<T> | undefined;
	registerCommand(name: string, handler: (args: string) => Promise<void> | void): () => void;
	onInput(handler: (text: string) => void): void;
	onRename(handler: (name: string) => void): void;
	onDisconnect(handler: () => void): void;
	onSync(handler: () => void): void;
};

type Pending = { dialog: WebDialog; resolve(value: unknown): void };

/** Agent-side WebSocket client. It deliberately talks only to the local bridge. */
export class LocalWebBridge implements WebBridge {
	readonly #pending = new Map<string, Pending>();
	readonly #commands = new Map<string, (args: string) => Promise<void> | void>();
	#socket: WebSocket | undefined;
	#metadata: AgentMetadata | undefined;
	#state: BridgeState | undefined;
	#inputHandler: ((text: string) => void) | undefined;
	#renameHandler: ((name: string) => void) | undefined;
	#disconnectHandler: (() => void) | undefined;
	#syncHandler: (() => void) | undefined;
	#reconnectTimer: NodeJS.Timeout | undefined;
	#outbox: string[] = [];
	#wanted = false;

	get active(): boolean { return this.#wanted; }

	async connect(metadata: AgentMetadata, port?: number, requirePort = false): Promise<void> {
		this.#wanted = true;
		this.#metadata = metadata;
		this.#state = await ensureBridge(port, requirePort);
		this.#open();
	}

	disconnect(): void {
		this.#wanted = false;
		if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
		this.#send({ type: "agent_bye" });
		this.#socket?.close(); this.#socket = undefined;
		for (const pending of this.#pending.values()) pending.resolve(undefined);
		this.#pending.clear();
	}

	update(metadata: Partial<AgentMetadata>): void {
		if (!this.#metadata) return;
		this.#metadata = { ...this.#metadata, ...metadata };
		this.#send({ type: "agent_update", metadata });
	}

	emit(type: string, payload: Record<string, unknown>): void { this.#send({ type: "agent_event", event: { type, ...payload, timestamp: Date.now() } }); }

	openDecision<T>(dialog: Omit<WebDialog, "id">): WebDecision<T> | undefined {
		if (!this.#wanted) return undefined;
		const id = randomUUID();
		let settle!: (value: T) => void;
		const promise = new Promise<T>((resolve) => { settle = resolve; });
		const resolve = (value: T) => {
			if (!this.#pending.delete(id)) return;
			settle(value); this.#sendWhenOpen({ type: "dialog_close", id, value });
		};
		const pending = { id, ...dialog };
		this.#pending.set(id, { dialog: pending, resolve: (value) => resolve(value as T) });
		// Pending dialogs are replayed after every agent hello instead of competing with
		// discardable activity in the bounded outbox.
		this.#sendDialogOpen(pending);
		return { id, promise, resolve };
	}

	registerCommand(name: string, handler: (args: string) => Promise<void> | void): () => void {
		this.#commands.set(name, handler);
		this.#send({ type: "agent_update", metadata: this.#metadata });
		return () => this.#commands.delete(name);
	}

	onInput(handler: (text: string) => void): void { this.#inputHandler = handler; }
	onRename(handler: (name: string) => void): void { this.#renameHandler = handler; }
	onDisconnect(handler: () => void): void { this.#disconnectHandler = handler; }
	onSync(handler: () => void): void { this.#syncHandler = handler; }

	#open(): void {
		const state = this.#state; if (!state || !this.#wanted) return;
		const socket = new WebSocket(`wss://127.0.0.1:${state.port}/ws`, { rejectUnauthorized: false, headers: { "x-pi-web-agent-token": state.agentToken } });
		this.#socket = socket;
		socket.on("open", () => {
			socket.send(JSON.stringify({ type: "agent_hello", metadata: this.#metadata }));
			for (const pending of this.#pending.values()) socket.send(JSON.stringify({ type: "dialog_open", dialog: pending.dialog }));
			for (const event of this.#outbox.splice(0)) socket.send(event);
		});
		socket.on("message", (data) => this.#receive(String(data)));
		socket.on("close", () => this.#retry());
		socket.on("error", () => undefined);
	}

	#retry(): void {
		if (!this.#wanted || this.#reconnectTimer) return;
		this.#reconnectTimer = setTimeout(async () => {
			this.#reconnectTimer = undefined;
			try { this.#state = await ensureBridge(this.#state?.port); this.#open(); } catch { this.#retry(); }
		}, 750);
	}

	#sendWhenOpen(value: unknown): boolean {
		if (this.#socket?.readyState !== WebSocket.OPEN) return false;
		this.#socket.send(JSON.stringify(value));
		return true;
	}

	#sendDialogOpen(dialog: WebDialog): void { this.#sendWhenOpen({ type: "dialog_open", dialog }); }

	#send(value: unknown): void {
		const serialized = JSON.stringify(value);
		if (this.#socket?.readyState === WebSocket.OPEN) { this.#socket.send(serialized); return; }
		if (this.#outbox.length < 200) this.#outbox.push(serialized);
	}

	#receive(raw: string): void {
		let value: unknown; try { value = JSON.parse(raw); } catch { return; }
		if (!value || typeof value !== "object") return;
		const message = value as { type?: unknown; id?: unknown; value?: unknown; text?: unknown };
		if (message.type === "sync") { this.#syncHandler?.(); return; }
		if (message.type === "dialog_response" && typeof message.id === "string") this.#pending.get(message.id)?.resolve(message.value);
		if (message.type === "rename" && typeof message.text === "string") { this.#renameHandler?.(message.text); return; }
		if (message.type === "disconnect") { this.#disconnectHandler?.(); return; }
		if (message.type === "input" && typeof message.text === "string") {
			const [command, ...rest] = message.text.trim().slice(1).split(/\s+/);
			if (message.text.startsWith("/") && command && this.#commands.has(command)) {
				Promise.resolve(this.#commands.get(command)!(rest.join(" "))).catch((error) => this.emit("error", { message: error instanceof Error ? error.message : String(error) }));
			} else this.#inputHandler?.(message.text);
		}
	}
}

export function getWebBridge(): WebBridge | undefined { return (globalThis as Record<symbol, unknown>)[WEB_BRIDGE_SYMBOL] as WebBridge | undefined; }
export function installWebBridge(bridge: WebBridge): void { (globalThis as Record<symbol, unknown>)[WEB_BRIDGE_SYMBOL] = bridge; }
export function applyWebCommandContributors(bridge: WebBridge): void {
	const contributors = (globalThis as Record<symbol, unknown>)[WEB_COMMAND_CONTRIBUTORS_SYMBOL];
	if (contributors instanceof Set) for (const contributor of contributors as Set<WebCommandContributor>) contributor(bridge);
}
