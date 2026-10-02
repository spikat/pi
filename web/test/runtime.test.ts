import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ensureBridge, readBridgeState } from "../runtime.js";

async function freePort(): Promise<number> {
	const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

test("concurrent processes start one bridge and enforce the requested port", async () => {
	const parent = await mkdtemp(join(tmpdir(), "pi-web-startup-")); const old = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = parent; const port = await freePort();
	try {
		const script = `import {ensureBridge} from './runtime.ts'; console.log(JSON.stringify(await ensureBridge(${port}, true)));`;
		const exec = promisify(execFile);
		const results = await Promise.all([0, 1].map(() => exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), env: { ...process.env, XDG_RUNTIME_DIR: parent } })));
		const states = results.map(result => JSON.parse(result.stdout)); assert.equal(states[0].pid, states[1].pid);
		assert.equal((await ensureBridge(port, true)).pid, states[0].pid);
		await assert.rejects(ensureBridge(await freePort(), true), /already runs on port/);
		assert.ok(!(await readdir(join(parent, "pi-web"))).includes("startup.lock"));
	} finally {
		const state = await readBridgeState(join(parent, "pi-web")); if (state) try { process.kill(state.pid, "SIGTERM"); } catch {}
		if (old === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = old;
		await rm(parent, { recursive: true, force: true });
	}
});
