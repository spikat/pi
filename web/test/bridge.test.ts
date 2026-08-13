import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { LocalWebBridge } from "../bridge.js";
import { readBridgeState, type BridgeState } from "../runtime.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function freePort(): Promise<number> {
	const server = createNetServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}
async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
	for (let index = 0; index < 100; index++) { const value = await read(); if (value !== undefined) return value; await wait(50); }
	throw new Error("timed out");
}
function getCookie(state: BridgeState): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = request({ hostname: "localhost", port: state.port, path: `/?token=${state.browserToken}`, rejectUnauthorized: false }, (response) => {
			response.resume();
			const cookie = response.headers["set-cookie"]?.toString().split(";")[0];
			if (cookie) resolve(cookie); else reject(new Error("browser cookie was not set"));
		});
		req.on("error", reject); req.end();
	});
}
async function openBrowser(state: BridgeState): Promise<WebSocket> {
	const cookie = await getCookie(state);
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`wss://localhost:${state.port}/ws`, { rejectUnauthorized: false, headers: { cookie, origin: `https://localhost:${state.port}` } });
		socket.once("open", () => resolve(socket)); socket.once("error", reject);
	});
}
function waitForDialog(socket: WebSocket, agentId: string, dialogId: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const done = () => { clearTimeout(timeout); socket.off("message", receive); resolve(); };
		const receive = (raw: WebSocket.RawData) => {
			const data = JSON.parse(String(raw)) as { type?: string; agentId?: string; dialog?: { id?: string }; agents?: Array<{ id?: string; dialogs?: Array<{ id?: string }> }> };
			if (data.type === "dialog_open" && data.agentId === agentId && data.dialog?.id === dialogId) return done();
			if (data.type === "snapshot" && data.agents?.some((agent) => agent.id === agentId && agent.dialogs?.some((dialog) => dialog.id === dialogId))) done();
		};
		const timeout = setTimeout(() => { socket.off("message", receive); reject(new Error("timed out waiting for replayed dialog")); }, 5_000);
		socket.on("message", receive);
	});
}
function stop(state: BridgeState | undefined): void { if (state) try { process.kill(state.pid, "SIGTERM"); } catch {} }

test("replays pending dialogs after the bridge restarts", async () => {
	const runtimeParent = await mkdtemp(join(tmpdir(), "pi-web-")); const runtime = join(runtimeParent, "pi-web"); const port = await freePort();
	const originalRuntime = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = runtimeParent;
	let bridge: LocalWebBridge | undefined; let browser: WebSocket | undefined; let state: BridgeState | undefined;
	try {
		bridge = new LocalWebBridge();
		await bridge.connect({ id: "replay-agent", cwd: runtimeParent, commands: [], history: [] }, port, true);
		state = await eventually(() => readBridgeState(runtime));
		browser = await openBrowser(state);
		const decision = bridge.openDecision<boolean>({ kind: "confirm", title: "Reconnect decision" });
		assert.ok(decision);
		await waitForDialog(browser, "replay-agent", decision.id);
		browser.close(); browser = undefined;
		stop(state);
		state = await eventually(async () => { const next = await readBridgeState(runtime); return next && next.pid !== state?.pid ? next : undefined; });
		browser = await openBrowser(state);
		await waitForDialog(browser, "replay-agent", decision.id);
		browser.send(JSON.stringify({ type: "dialog_response", agentId: "replay-agent", id: decision.id, value: true }));
		assert.equal(await decision.promise, true);
	} finally {
		browser?.close(); bridge?.disconnect(); stop(await readBridgeState(runtime));
		if (originalRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = originalRuntime;
		await rm(runtimeParent, { recursive: true, force: true });
	}
});
