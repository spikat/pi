import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
	const path = statePath(dir); const temporary = `${path}.${randomUUID()}.tmp`;
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
	const dir = runtimeDir();
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const lock = join(dir, "startup.lock");
	const deadline = Date.now() + 12_000;
	while (true) {
		try { await mkdir(lock, { mode: 0o700 }); break; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const state = await readBridgeState();
			if (state && await bridgeIsHealthy(state)) {
				if (requirePort && state.port !== port) throw new Error(`web: bridge already runs on port ${state.port}`);
				return state;
			}
			// Only reclaim an old abandoned lock, never an in-progress startup.
			try {
				const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as { pid: number; childPid?: number };
				const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; } };
				if (!alive(owner.pid) && (!owner.childPid || !alive(owner.childPid))) { await rm(lock, { recursive: true, force: true }); continue; }
			} catch { try { if (Date.now() - (await stat(lock)).mtimeMs > 30_000) { await rm(lock, { recursive: true, force: true }); continue; } } catch {} }
			if (Date.now() >= deadline) throw new Error("web: timed out waiting for bridge startup lock");
			await sleep(100);
		}
	}
	try {
		await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
		const healthy = await readBridgeState();
		if (healthy && await bridgeIsHealthy(healthy)) {
			if (requirePort && healthy.port !== port) throw new Error(`web: bridge already runs on port ${healthy.port}`);
			return healthy;
		}
		const here = dirname(fileURLToPath(import.meta.url));
		const child = spawn(process.execPath, [join(here, "server.mjs")], {
			detached: true, stdio: "ignore", env: { ...process.env, PI_WEB_RUNTIME_DIR: dir, PI_WEB_PORT: String(port) },
		});
		let failure: Error | undefined;
		const onError = (error: Error) => { failure = error; };
		const onExit = (code: number | null) => { failure = new Error(`web: bridge exited during startup (${code})`); };
		child.once("error", onError); child.once("exit", onExit); child.unref();
		try {
			await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, childPid: child.pid }), { mode: 0o600 });
			for (let attempt = 0; attempt < 80; attempt++) {
				await sleep(100);
				const state = await readBridgeState();
				if (state && await bridgeIsHealthy(state)) {
					if (requirePort && state.port !== port) throw new Error(`web: bridge already runs on port ${state.port}`);
					return state;
				}
				if (failure) throw failure;
			}
			throw new Error(`web: bridge did not become available on https://localhost:${port}`);
		} catch (error) { child.kill("SIGTERM"); throw error; }
		finally { child.removeListener("error", onError); child.on("error", () => {}); child.removeListener("exit", onExit); }
	} finally { await rm(lock, { recursive: true, force: true }); }
}

export async function runtimeFilesArePrivate(dir = runtimeDir()): Promise<boolean> {
	try { await access(dir, constants.R_OK | constants.W_OK); return true; } catch { return false; }
}
