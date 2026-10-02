import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyseShell } from "../core.js";
import extension from "../index.js";

test("conditions and output process substitutions are not omitted", () => {
	for (const command of ["if rm protected; then echo ok; fi", "while rm protected; do echo ok; done", "until rm protected; do echo ok; done", "if ! rm protected; then echo ok; fi", "time rm protected", "echo >(rm protected)"]) {
		const result = analyseShell(command);
		assert.ok(result.unsupported || result.parts.some(p => p.words[0] === "rm"), command);
	}
	for (const command of ["echo `rm protected`", "cat <<EOF\n$(rm protected)\nEOF"]) assert.equal(analyseShell(command).unsupported, true, command);
});

async function setup(t: any) {
	const cwd = await mkdtemp(join(tmpdir(), "cw-security-"));
	const old = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	t.after(async () => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; await rm(cwd, { recursive: true, force: true }); });
	await mkdir(join(cwd, ".pi"));
	await writeFile(join(cwd, ".pi", "commands-whitelist.json"), JSON.stringify({ version: 2, whitelist: ["echo *"], blacklist: ["rm *"], editDirectories: [cwd], editFiles: [] }));
	let gate: any; const events = new Map<string, any>();
	extension({ on: (name: string, handler: any) => { events.set(name, handler); if (name === "tool_call") gate = handler; }, registerCommand() {} } as any);
	return { cwd, gate, events, ctx: { cwd, mode: "print", hasUI: false, ui: {}, sessionManager: { getBranch: () => [] } } };
}

test("a leading comment cannot bypass a deny rule", async t => {
	const { gate, ctx } = await setup(t);
	assert.equal((await gate({ toolName: "bash", input: { command: "# comment\nrm protected" } }, ctx)).block, true);
	assert.equal(await gate({ toolName: "bash", input: { command: "# only a comment" } }, ctx), undefined);
});

test("unapproved edits fail closed and symlink escapes do not inherit permission", async t => {
	const { gate, ctx, cwd } = await setup(t);
	const outside = await mkdtemp(join(tmpdir(), "cw-outside-"));
	t.after(() => rm(outside, { recursive: true, force: true }));
	await symlink(outside, join(cwd, "link"));
	await symlink(join(outside, "missing.txt"), join(cwd, "dangling"));
	await symlink(join(outside, "missing-dir"), join(cwd, "dangling-dir"));
	assert.equal((await gate({ toolName: "write", input: { path: "dangling" } }, ctx)).block, true);
	assert.equal((await gate({ toolName: "write", input: { path: "dangling-dir/new.txt" } }, ctx)).block, true);
	assert.equal((await gate({ toolName: "write", input: { path: "link/new.txt" } }, ctx)).block, true);
	assert.equal(await gate({ toolName: "write", input: { path: "allowed.txt" } }, ctx), undefined);
	assert.equal((await gate({ toolName: "write", input: { path: join(outside, "new.txt") } }, ctx)).block, true);
});

test("a directory approval must contain the pending file", async t => {
	const { gate, ctx, cwd } = await setup(t);
	const key = Symbol.for("spikat.pi.web.bridge"), old = (globalThis as any)[key];
	const answers = ["allow directory permanently", "."];
	(globalThis as any)[key] = { active: true, openDecision: () => ({ promise: Promise.resolve(answers.shift()), resolve() {} }) };
	t.after(() => { if (old === undefined) delete (globalThis as any)[key]; else (globalThis as any)[key] = old; });
	const result = await gate({ toolName: "write", input: { path: join(cwd, "..", "outside.txt") } }, { ...ctx, mode: "rpc", hasUI: true });
	assert.equal(result.block, true); assert.match(result.reason, /does not contain/);
});

test("session approvals are cleared at shutdown and unapproved cwd edits fail closed", async t => {
	const { gate, ctx, cwd, events } = await setup(t);
	await writeFile(join(cwd, ".pi", "commands-whitelist.json"), JSON.stringify({ version: 2, whitelist: [], blacklist: [], editDirectories: [], editFiles: [] }));
	assert.equal((await gate({ toolName: "write", input: { path: "new.txt" } }, ctx)).block, true);
	const key = Symbol.for("spikat.pi.web.bridge"), old = (globalThis as any)[key];
	(globalThis as any)[key] = { active: true, openDecision: () => ({ promise: Promise.resolve("allow file once"), resolve() {} }) };
	try { assert.equal(await gate({ toolName: "write", input: { path: "new.txt" } }, { ...ctx, mode: "rpc", hasUI: true }), undefined); }
	finally { if (old === undefined) delete (globalThis as any)[key]; else (globalThis as any)[key] = old; }
	assert.equal(await gate({ toolName: "write", input: { path: "new.txt" } }, ctx), undefined);
	await events.get("session_shutdown")();
	assert.equal((await gate({ toolName: "write", input: { path: "new.txt" } }, ctx)).block, true);
});
