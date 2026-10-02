import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const { runGit } = await createJiti(import.meta.url, { fsCache: false }).import("../git.ts");

test("large Git output is drained and bounded before buffering 10 MiB", async t => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-git-output-")); const oldPath = process.env.PATH;
	t.after(async () => { process.env.PATH = oldPath; await rm(cwd, { recursive: true, force: true }); });
	const executable = join(cwd, "git");
	await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(12 * 1024 * 1024));\n`); await chmod(executable, 0o700);
	process.env.PATH = `${cwd}:${oldPath}`;
	const output = await runGit(["diff", "--cached"], cwd, undefined, 1_000);
	assert.match(output, /Content truncated after 1000 characters/); assert.ok(output.length < 1_100);
	await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`);
	assert.deepEqual(JSON.parse(await runGit(["diff", "--cached"], cwd)), ["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--cached"]);
	await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
	const controller = new AbortController(); const waiting = runGit(["diff"], cwd, controller.signal); controller.abort();
	await assert.rejects(waiting, /abort/i);
});
