import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { request } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PORT = 8088;
export type BridgeState = { version: 1; pid: number; port: number; agentToken: string; browserToken: string; startedAt: number };

export function runtimeDir(): string {
	const xdg = process.env.XDG_RUNTIME_DIR;
	if (xdg) return join(xdg, "pi-web");
	const home = process.env.HOME;
	if (!home) throw new Error("web: HOME or XDG_RUNTIME_DIR is required");
	return join(home, ".pi", "web");
}
export function statePath(dir = runtimeDir()): string { return join(dir, "bridge.json"); }

function isState(value: unknown): value is BridgeState {
	if (!value || typeof value !== "object") return false;
	const state = value as Record<string, unknown>;
	return state.version === 1 && typeof state.pid === "number" && typeof state.port === "number" && typeof state.agentToken === "string" && typeof state.browserToken === "string" && typeof state.startedAt === "number";
}

export async function readBridgeState(dir = runtimeDir()): Promise<BridgeState | undefined> {
	try {
		const raw = await readFile(statePath(dir), "utf8");
		const value: unknown = JSON.parse(raw);
		return isState(value) ? value : undefined;
	} catch { return undefined; }
}

export async function writeBridgeState(state: BridgeState, dir = runtimeDir()): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
	const path = statePath(dir); const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, path);
	await chmod(path, 0o600);
}

export function freshBridgeState(port = DEFAULT_PORT): BridgeState {
	return { version: 1, pid: process.pid, port, agentToken: randomBytes(32).toString("base64url"), browserToken: randomBytes(32).toString("base64url"), startedAt: Date.now() };
}

export async function bridgeIsHealthy(state: BridgeState): Promise<boolean> {
	return new Promise((resolve) => {
		const req = request({ hostname: "127.0.0.1", port: state.port, path: "/health", method: "GET", rejectUnauthorized: false, headers: { "x-pi-web-agent-token": state.agentToken }, timeout: 800 }, (res) => {
			res.resume(); resolve(res.statusCode === 204);
		});
		req.once("error", () => resolve(false));
		req.once("timeout", () => { req.destroy(); resolve(false); });
		req.end();
	});
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Starts the detached shared server only after a /web command asks for it. */
export async function ensureBridge(port = DEFAULT_PORT, requirePort = false): Promise<BridgeState> {
	const existing = await readBridgeState();
	if (existing && await bridgeIsHealthy(existing)) {
		if (requirePort && existing.port !== port) throw new Error(`web: bridge already runs on port ${existing.port}; use /web on or stop every connected agent first`);
		return existing;
	}
	const here = dirname(fileURLToPath(import.meta.url));
	const child = spawn(process.execPath, [join(here, "server.mjs")], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, PI_WEB_RUNTIME_DIR: runtimeDir(), PI_WEB_PORT: String(port) },
	});
	child.unref();
	for (let attempt = 0; attempt < 80; attempt++) {
		await sleep(100);
		const state = await readBridgeState();
		if (state && await bridgeIsHealthy(state)) return state;
	}
	throw new Error(`web: bridge did not become available on https://localhost:${port}`);
}

export async function runtimeFilesArePrivate(dir = runtimeDir()): Promise<boolean> {
	try { await access(dir, constants.R_OK | constants.W_OK); return true; } catch { return false; }
}
