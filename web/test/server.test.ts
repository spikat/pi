import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import selfsigned from "selfsigned";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync("git", ["-C", cwd, ...args]);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function freePort(): Promise<number> {
	const server = createNetServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}
async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
	for (let index = 0; index < 80; index++) { const value = await read(); if (value !== undefined) return value; await wait(50); }
	throw new Error("timed out");
}
function get(options: Parameters<typeof request>[1]): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request(options, (response) => { let body = ""; response.setEncoding("utf8"); response.on("data", (part) => { body += part; }); response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body })); });
		req.on("error", reject); req.end();
	});
}
function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> { return new Promise((resolve) => socket.once("message", (value) => resolve(JSON.parse(String(value)) as Record<string, unknown>))); }
function open(url: string, options: WebSocket.ClientOptions): Promise<WebSocket> { return new Promise((resolve, reject) => { const socket = new WebSocket(url, options); socket.once("open", () => resolve(socket)); socket.once("error", reject); }); }

test("HTTPS bridge renews certificates that are close to expiry", async () => {
	const runtime = await mkdtemp(join(tmpdir(), "pi-web-")); const port = await freePort();
	const expiring = selfsigned.generate([{ name: "commonName", value: "localhost" }], { days: 1, keySize: 2048 });
	await writeFile(join(runtime, "localhost-key.pem"), expiring.private);
	await writeFile(join(runtime, "localhost-cert.pem"), expiring.cert);
	const child = spawn(process.execPath, [join(process.cwd(), "server.mjs")], { cwd: join(process.cwd()), env: { ...process.env, PI_WEB_RUNTIME_DIR: runtime, PI_WEB_PORT: String(port) }, stdio: "ignore" });
	try {
		await eventually(async () => { try { return JSON.parse(await readFile(join(runtime, "bridge.json"), "utf8")) as Record<string, unknown>; } catch { return undefined; } });
		const renewed = await readFile(join(runtime, "localhost-cert.pem"), "utf8");
		assert.notEqual(renewed, expiring.cert);
		assert.ok(Date.parse(new X509Certificate(renewed).validTo) > Date.now() + 300 * 24 * 60 * 60 * 1000);
	} finally { child.kill("SIGTERM"); await rm(runtime, { recursive: true, force: true }); }
});

test("HTTPS bridge bounds retained agent history", async () => {
	const runtime = await mkdtemp(join(tmpdir(), "pi-web-")); const port = await freePort();
	const child = spawn(process.execPath, [join(process.cwd(), "server.mjs")], { cwd: join(process.cwd()), env: { ...process.env, PI_WEB_RUNTIME_DIR: runtime, PI_WEB_PORT: String(port) }, stdio: "ignore" });
	try {
		const state = await eventually(async () => { try { return JSON.parse(await readFile(join(runtime, "bridge.json"), "utf8")) as { agentToken: string; browserToken: string }; } catch { return undefined; } });
		const page = await get({ hostname: "localhost", port, path: `/?token=${state.browserToken}`, rejectUnauthorized: false });
		const cookie = page.headers["set-cookie"]?.toString().split(";")[0]; assert.ok(cookie);
		const browser = await open(`wss://localhost:${port}/ws`, { rejectUnauthorized: false, headers: { cookie, origin: `https://localhost:${port}` } });
		await nextMessage(browser);
		const agent = await open(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false, headers: { "x-pi-web-agent-token": state.agentToken } });
		const history = Array.from({ length: 100 }, (_, index) => ({ id: `history-${index}`, message: { role: "assistant", content: [{ type: "text", text: "x".repeat(20_000) }] } }));
		agent.send(JSON.stringify({ type: "agent_hello", metadata: { id: "agent-history", cwd: runtime, commands: [], history } }));
		const joined = await nextMessage(browser);
		const retained = ((joined.agent as { history: unknown[] }).history);
		assert.ok(retained.length < history.length);
		assert.ok(retained.length <= 64);
		assert.ok(Buffer.byteLength(JSON.stringify(retained)) <= 512 * 1024);
		assert.equal((retained.at(-1) as { id: string }).id, "history-99");
		agent.close(); browser.close();
	} finally { child.kill("SIGTERM"); await rm(runtime, { recursive: true, force: true }); }
});

test("HTTPS bridge authenticates the browser and relays agent state", async () => {
	const runtime = await mkdtemp(join(tmpdir(), "pi-web-")); const port = await freePort();
	await git(runtime, ["init", "--quiet"]);
	const child = spawn(process.execPath, [join(process.cwd(), "server.mjs")], { cwd: join(process.cwd()), env: { ...process.env, PI_WEB_RUNTIME_DIR: runtime, PI_WEB_PORT: String(port) }, stdio: "ignore" });
	try {
		const state = await eventually(async () => { try { return JSON.parse(await readFile(join(runtime, "bridge.json"), "utf8")) as { agentToken: string; browserToken: string }; } catch { return undefined; } });
		const health = await get({ hostname: "127.0.0.1", port, path: "/health", rejectUnauthorized: false, headers: { "x-pi-web-agent-token": state.agentToken } });
		assert.equal(health.status, 204);
		const page = await get({ hostname: "localhost", port, path: `/?token=${state.browserToken}`, rejectUnauthorized: false });
		assert.equal(page.status, 200); assert.match(page.body, /Show agent reasoning/); assert.match(page.body, /Desktop notifications/); assert.match(page.body, /Mute agent notifications/); assert.match(page.body, /Drop queued prompts/); assert.match(page.body, /Copy this agent message to the clipboard/); assert.match(page.body, /navigator\.clipboard\?\.writeText/); assert.match(page.body, /appendFileReferences/); assert.match(page.body, /fileViewer/); assert.match(page.body, /View source/); assert.match(page.body, /\.file-viewer>\.markdown\{box-sizing:border-box;padding:\.45rem \.8rem \.8rem\}/); assert.match(page.body, /focusFirstChange:true/); assert.match(page.body, /title:'Previous change'/); assert.match(page.body, /title:'Next change'/); assert.match(page.body, /scrollToDiffChange/); assert.match(page.body, /language==='python'/); assert.match(page.body, /syntax-target/); assert.match(page.body, /gitDiffRows/); assert.match(page.body, /isTableDivider/); assert.match(page.body, /appendDialogs\(messages,agent\)/); assert.match(page.body, /showThinking=false,showTools=false/); assert.match(page.body, /Validate current selection/); assert.match(page.body, /Enter a prompt for the assistant/);
		assert.match(page.body, /fileAvailability=new Map/); assert.match(page.body, /function previewAvailability/); assert.match(page.body, /&check=1/); assert.match(page.body, /Close file view/); assert.match(page.body, /event\.key==='Escape'/);
		assert.match(page.body, /agentViews=new Map/); assert.match(page.body, /rememberAgentView\(selected\)/); assert.match(page.body, /value:agentViews\.get\(agent\.id\)\?\.draft\|\|''/); assert.match(page.body, /liveMessages\.scrollTop=view\.scrollTop/);
		assert.match(page.body, /function notificationAllowed/); assert.match(page.body, /function syncNotificationSettings/); assert.match(page.body, /disabled:notificationsDisabled/);
		const clientScript = /<script>([\s\S]*?)<\/script>/.exec(page.body)?.[1]; assert.ok(clientScript); assert.doesNotThrow(() => new Function(clientScript));
		const cookie = page.headers["set-cookie"]?.toString().split(";")[0]; assert.ok(cookie);
		const browser = await open(`wss://localhost:${port}/ws`, { rejectUnauthorized: false, headers: { cookie, origin: `https://localhost:${port}` } });
		const initial = await nextMessage(browser); assert.equal(initial.type, "snapshot");
		await writeFile(join(runtime, "format.md"), "| Name | Value |\n| --- | --- |\n| **bold** | `code` |\n\n> quoted text\n\n   ```md\n> literal Markdown\nREADME.md\n   ```");
		const agent = await open(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false, headers: { "x-pi-web-agent-token": state.agentToken } });
		agent.send(JSON.stringify({ type: "agent_hello", metadata: { id: "agent-1", cwd: runtime, commands: [], history: [] } }));
		const joined = await nextMessage(browser); assert.equal(joined.type, "agent_join");
		assert.equal((joined.agent as { id: string }).id, "agent-1");
		agent.send(JSON.stringify({ type: "agent_event", event: { type: "queue", pending: 2, characters: 42, maxPending: 20, maxCharacters: 100000 } }));
		const queued = await nextMessage(browser); assert.equal(queued.type, "agent_event"); assert.equal(((queued.event as { pending: number }).pending), 2);
		const preview = await get({ hostname: "localhost", port, path: "/markdown?agent=agent-1&path=format.md", rejectUnauthorized: false, headers: { cookie } });
		assert.equal(preview.status, 200); assert.match(preview.body, /<table>/); assert.match(preview.body, /<strong>bold<\/strong>/); assert.match(preview.body, /<code>code<\/code>/); assert.match(preview.body, /<blockquote>/); assert.match(preview.body, /<pre><code>&gt; literal Markdown\nREADME\.md<\/code><\/pre>/);
		const markdownFile = await get({ hostname: "localhost", port, path: "/file?agent=agent-1&path=format.md", rejectUnauthorized: false, headers: { cookie } });
		assert.equal(JSON.parse(markdownFile.body).language, "markdown");
		const previewableCheck = await get({ hostname: "localhost", port, path: "/file?agent=agent-1&path=format.md&check=1", rejectUnauthorized: false, headers: { cookie } });
		assert.equal(previewableCheck.status, 204); assert.equal(previewableCheck.body, "");
		const originalGo = "package main\n\nfunc main() { println(\"old\") }\n";
		await writeFile(join(runtime, "example.go"), originalGo); await git(runtime, ["add", "--", "example.go"]);
		await writeFile(join(runtime, "example.go"), "package main\n\nfunc main() { println(\"new\") }\n");
		agent.send(JSON.stringify({ type: "agent_event", event: { type: "file_changed", path: join(runtime, "example.go"), diffAvailable: true } }));
		const changed = await nextMessage(browser); assert.equal(changed.type, "agent_event"); assert.equal((changed.event as { type: string }).type, "file_changed"); assert.equal(Object.hasOwn(changed.event as object, "before"), false);
		const file = await get({ hostname: "localhost", port, path: "/file?agent=agent-1&path=example.go", rejectUnauthorized: false, headers: { cookie } });
		assert.equal(file.status, 200); assert.deepEqual(JSON.parse(file.body), { path: join(runtime, "example.go"), language: "go", mode: "file", content: "package main\n\nfunc main() { println(\"new\") }\n" });
		const diff = await get({ hostname: "localhost", port, path: "/file?agent=agent-1&path=example.go&mode=diff", rejectUnauthorized: false, headers: { cookie } });
		assert.equal(diff.status, 200); const gitDiff = JSON.parse(diff.body) as { diff: string }; assert.match(gitDiff.diff, /-func main\(\) \{ println\(\"old\"\) \}/); assert.match(gitDiff.diff, /\+func main\(\) \{ println\(\"new\"\) \}/);
		const untrackedDiff = await get({ hostname: "localhost", port, path: "/file?agent=agent-1&path=format.md&mode=diff", rejectUnauthorized: false, headers: { cookie } });
		assert.equal(untrackedDiff.status, 404);
		const escapedFile = await get({ hostname: "localhost", port, path: "/file?agent=agent-1&path=../outside.go", rejectUnauthorized: false, headers: { cookie } });
		const escapedCheck = await get({ hostname: "localhost", port, path: "/file?agent=agent-1&path=../outside.go&check=1", rejectUnauthorized: false, headers: { cookie } });
		assert.equal(escapedFile.status, 404); assert.equal(escapedCheck.status, 404);
		const outside = await mkdtemp(join(tmpdir(), "pi-web-outside-"));
		try {
			const secret = join(outside, "secret.md");
			await writeFile(secret, "outside project");
			await symlink(secret, join(runtime, "linked-secret.md"));
			const linkedFile = await get({ hostname: "localhost", port, path: "/file?agent=agent-1&path=linked-secret.md", rejectUnauthorized: false, headers: { cookie } });
			const linkedMarkdown = await get({ hostname: "localhost", port, path: "/markdown?agent=agent-1&path=linked-secret.md", rejectUnauthorized: false, headers: { cookie } });
			assert.equal(linkedFile.status, 404);
			assert.equal(linkedMarkdown.status, 404);
		} finally { await rm(outside, { recursive: true, force: true }); }
		await writeFile(join(runtime, "oversized.md"), "x".repeat(512 * 1024 + 1));
		const oversizedFile = await get({ hostname: "localhost", port, path: "/file?agent=agent-1&path=oversized.md", rejectUnauthorized: false, headers: { cookie } });
		const oversizedMarkdown = await get({ hostname: "localhost", port, path: "/markdown?agent=agent-1&path=oversized.md", rejectUnauthorized: false, headers: { cookie } });
		const oversizedCheck = await get({ hostname: "localhost", port, path: "/file?agent=agent-1&path=oversized.md&check=1", rejectUnauthorized: false, headers: { cookie } });
		assert.equal(oversizedFile.status, 404);
		assert.equal(oversizedMarkdown.status, 404); assert.equal(oversizedCheck.status, 404);
		await writeFile(join(runtime, "binary.go"), Buffer.from([0, 1, 2]));
		const binaryCheck = await get({ hostname: "localhost", port, path: "/file?agent=agent-1&path=binary.go&check=1", rejectUnauthorized: false, headers: { cookie } });
		assert.equal(binaryCheck.status, 404);
		const fifo = join(runtime, "preview.fifo.md");
		await execFileAsync("mkfifo", [fifo]);
		const specialFile = await get({ hostname: "localhost", port, path: "/file?agent=agent-1&path=preview.fifo.md", rejectUnauthorized: false, headers: { cookie } });
		const specialMarkdown = await get({ hostname: "localhost", port, path: "/markdown?agent=agent-1&path=preview.fifo.md", rejectUnauthorized: false, headers: { cookie } });
		assert.equal(specialFile.status, 404);
		assert.equal(specialMarkdown.status, 404);
		browser.send(JSON.stringify({ type: "input", agentId: "agent-1", text: "queued browser prompt" }));
		assert.deepEqual(await nextMessage(agent), { type: "input", text: "queued browser prompt" });
		browser.send(JSON.stringify({ type: "clear_queue", agentId: "agent-1" }));
		assert.deepEqual(await nextMessage(agent), { type: "clear_queue" });
		browser.send(JSON.stringify({ type: "sync", agentId: "agent-1" }));
		assert.deepEqual(await nextMessage(agent), { type: "sync" });
		agent.send(JSON.stringify({ type: "dialog_open", dialog: { id: "gate-1", kind: "confirm", title: "Allow command?" } }));
		assert.equal((await nextMessage(browser)).type, "dialog_open");
		browser.send(JSON.stringify({ type: "dialog_response", agentId: "agent-1", id: "gate-1", value: true }));
		assert.deepEqual(await nextMessage(agent), { type: "dialog_response", id: "gate-1", value: true });
		browser.send(JSON.stringify({ type: "rename", agentId: "agent-1", name: "Renamed agent" }));
		assert.deepEqual(await nextMessage(agent), { type: "rename", text: "Renamed agent" });
		browser.send(JSON.stringify({ type: "disconnect", agentId: "agent-1" }));
		assert.deepEqual(await nextMessage(agent), { type: "disconnect" });
		agent.close(); browser.close();
	} finally { child.kill("SIGTERM"); await rm(runtime, { recursive: true, force: true }); }
});
