import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyseShell, classification, EMPTY_STORE, loadStore, matchesRule, normalizeRule, ruleFor, saveStore } from "../core.js";

test("splits pipelines and ignores redirections", () => {
  const result = analyseShell('find /path -name "*.go"|grep -v test|sort|xargs grep -i func 2>/dev/null|uniq -c|wc -l');
  assert.equal(result.unsupported, false);
  assert.deepEqual(result.parts.map((p) => p.displayWords.join(" ")), ["find /path -name *.go *", "grep -v test *", "sort *", "xargs grep -i func *", "uniq -c *", "wc -l *"]);
});

test("honours quotes and escaped separators", () => {
  const result = analyseShell('grep "foo|bar" file | echo foo\\|bar | sort');
  assert.deepEqual(result.parts.map((p) => p.displayWords.join(" ")), ["grep foo|bar file *", "echo foo|bar *", "sort *"]);
});

test("recurses through shell -c and process substitutions", () => {
  const shell = analyseShell('sh -c "grep foo bar.txt|sort"');
  assert.equal(shell.parts.length, 3);
  const process = analyseShell('diff <(sort file1) <(sort file2)');
  assert.deepEqual(process.parts.map((p) => p.displayWords.join(" ")), ["diff <(sort file1) <(sort file2) *", "sort file1 *", "sort file2 *"]);
});

test("recurses through shell groups", () => {
  const result = analyseShell("{ cmd1; cmd2 && cmd3; }");
  assert.deepEqual(result.parts.map((p) => p.displayWords.join(" ")), ["cmd1 *", "cmd2 *", "cmd3 *"]);
});

test("dynamic arguments collapse to one wildcard", () => {
  assert.deepEqual(analyseShell('grep "$PATTERN" "$FILE"').parts[0]?.displayWords, ["grep", "*"]);
  assert.deepEqual(analyseShell('cp "$SOURCE" /tmp/output.txt').parts[0]?.displayWords, ["cp", "*"]);
});

test("treats Python scripts as one opaque command", () => {
  const result = analyseShell("python3 tools/check.py --all | grep ignored");
  assert.equal(result.parts.length, 2);
  assert.equal(result.parts[0]?.pythonScript, true);
  assert.deepEqual(result.parts[0]?.displayWords, ["python3", "tools/check.py", "--all", "*"]);
  assert.equal(result.parts[1]?.displayWords.join(" "), "grep ignored *");
});

test("rules are prefix matches and blacklist wins", () => {
  const part = analyseShell("ls foo bar baz").parts[0]!;
  assert.equal(matchesRule("ls foo *", part), true);
  assert.equal(matchesRule("ls baz *", part), false);
  assert.equal(classification({ ...EMPTY_STORE, whitelist: ["ls *"], blacklist: ["ls foo *"] }, part), "deny");
  assert.equal(ruleFor(part, 0), "ls *");
  assert.equal(normalizeRule("ls foo"), "ls foo *");
  assert.equal(normalizeRule("ls * foo"), undefined);
});

test("version migration, malformed config and atomic persistence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cw-")); const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ version: 1, actionKeys: [] }));
  assert.deepEqual(await loadStore(file), EMPTY_STORE);
  await writeFile(file, "{"); await assert.rejects(() => loadStore(file), /invalid JSON/);
  await saveStore(file, { ...EMPTY_STORE, whitelist: ["ls *", "ls *"] });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).whitelist, ["ls *"]);
  await assert.rejects(() => saveStore(file, { ...EMPTY_STORE, whitelist: ["ls *"], blacklist: ["ls *"] }), /identical/);
});
