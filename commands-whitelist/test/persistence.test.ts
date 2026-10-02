import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { EMPTY_STORE, loadStore, saveChanges } from "../core.js";

test("parallel decision deltas retain unrelated rules and concurrent denies", async t => {
	const dir = await mkdtemp(join(tmpdir(), "cw-persist-")); t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "rules.json");
	await Promise.all(Array.from({ length: 20 }, (_, i) => saveChanges(path, EMPTY_STORE, { ...EMPTY_STORE, whitelist: [`cmd${i} *`] })));
	assert.equal((await loadStore(path)).whitelist.length, 20);
	await saveChanges(path, EMPTY_STORE, { ...EMPTY_STORE, blacklist: ["dangerous *"] });
	await saveChanges(path, EMPTY_STORE, { ...EMPTY_STORE, whitelist: ["dangerous *"] });
	assert.ok(!(await loadStore(path)).whitelist.includes("dangerous *"));
	assert.deepEqual((await readdir(dir)).filter(name => name.endsWith(".tmp") || name.endsWith(".lock")), []);
});

test("separate processes serialize their read-modify-write operations", async t => {
	const dir = await mkdtemp(join(tmpdir(), "cw-process-")); t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "rules.json");
	const exec = promisify(execFile);
	await Promise.all(Array.from({ length: 4 }, (_, i) => exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import {updateStore} from './core.ts'; await updateStore(${JSON.stringify(path)}, s => { s.whitelist.push('process${i} *'); });`], { cwd: process.cwd() })));
	assert.equal(JSON.parse(await readFile(path, "utf8")).whitelist.length, 4);
});
