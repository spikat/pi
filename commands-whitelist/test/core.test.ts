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

test("does not mistake wc -c for a shell -c invocation", () => {
  const result = analyseShell("git diff --check && wc -c comparatif.html && rg -n 'foo|bar' comparatif.html");
  assert.deepEqual(result.parts.map((part) => part.displayWords.join(" ")), [
    "git diff --check *",
    "wc -c comparatif.html *",
    "rg -n foo|bar comparatif.html *",
  ]);
});

test("keeps process substitutions as arguments while analyzing their contents", () => {
  const result = analyseShell("probe=$(comm -13 <(printf '%s\\n' $oldpids | sort -n) <(pgrep -x xclip | sort -n) | tail -1)");
  assert.deepEqual(result.parts.map((part) => part.displayWords.join(" ")), [
    "comm -13 *",
    "printf %s\\n *",
    "sort -n *",
    "pgrep -x xclip *",
    "sort -n *",
    "tail -1 *",
  ]);
  assert.equal(result.parts.some((part) => part.displayWords[0]?.startsWith("<(")), false);
});

test("normalizes bracket conditions instead of exposing a [ command", () => {
  const result = analyseShell(`echo "clipboard-image matches published package: $([ "$result" = 0 ] && echo yes || echo no)"`);
  assert.deepEqual(result.parts.map((part) => part.displayWords.join(" ")), [
    "echo *",
    "test *",
    "echo yes *",
    "echo no *",
  ]);
  assert.equal(result.parts.some((part) => part.displayWords[0] === "["), false);
});

test("does not reduce a dynamic executable to a fake wildcard command", () => {
  const result = analyseShell(`set -euo pipefail
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp commit-msg/index.ts pr-description/index.ts review/index.ts "$work"/
ln -s "$PWD/commands-whitelist/node_modules" "$work/node_modules"
cat >"$work/tsconfig.json" <<'EOF'
{ "include": ["*.ts"] }
EOF
(cd "$work" && "$PWD/node_modules/.bin/tsc" -p tsconfig.json)`);
  assert.deepEqual(result.parts.map((part) => part.displayWords.join(" ")), [
    "set -euo pipefail *",
    "mktemp -d *",
    "trap *",
    "cp commit-msg/index.ts pr-description/index.ts review/index.ts *",
    "ln -s *",
    "cat *",
    "cd *",
    "$PWD/node_modules/.bin/tsc *",
  ]);
  assert.equal(result.parts.some((part) => part.displayWords.length === 1 && part.displayWords[0] === "*"), false);
});

test("does not turn command-substitution assignment arguments into commands", () => {
  const result = analyseShell(`set -euo pipefail
dir=$(mktemp -d); PI_WEB_RUNTIME_DIR="$dir" node web/server.mjs & pid=$!; for i in $(seq 1 50); do test -f "$dir/bridge.json" && break; sleep .1; done; token=$(node -p "require('$dir/bridge.json').browserToken"); curl -sk "https://localhost/?token=$token" > /tmp/pi-web-page.html; python3 - <<'PY'
import re
print('ignored')
PY
node --check /tmp/pi-web-client.js || true
kill $pid; wait $pid || true; rm -rf "$dir"`);
  assert.deepEqual(result.parts.map((part) => part.displayWords.join(" ")), [
    "set -euo pipefail *",
    "mktemp -d *",
    "node web/server.mjs *",
    "seq 1 50 *",
    "test -f *",
    "break *",
    "sleep .1 *",
    "node -p *",
    "curl -sk *",
    "python3 - *",
    "node --check /tmp/pi-web-client.js *",
    "true *",
    "kill *",
    "wait *",
    "true *",
    "rm -rf *",
  ]);
});

test("does not split stderr redirections into a fake command", () => {
  const result = analyseShell("(cd web && npm pack --dry-run 2>&1 | rg 'npm notice (📦|[0-9].* (README|index|server|package|LICENSE))' || true)");
  assert.deepEqual(result.parts.map((part) => part.displayWords.join(" ")), [
    "cd web *",
    "npm pack --dry-run *",
    "rg npm notice (📦|[0-9].* (README|index|server|package|LICENSE)) *",
    "true *",
  ]);
});

test("does not treat here-document bodies as shell commands", () => {
  const result = analyseShell(`mkdir -p web/test && cat > web/package.json <<'EOF'
{
  "name": "@spikat/pi-web",
  "scripts": { "test": "tsx --test test/**/*.test.ts" }
}
EOF
cat > web/tsconfig.json <<'EOF'
{ "compilerOptions": { "target": "ES2022" } }
EOF
cp LICENSE web/LICENSE
cd web && npm install --package-lock-only`);
  assert.deepEqual(result.parts.map((part) => part.displayWords.join(" ")), [
    "mkdir -p web/test *",
    "cat *",
    "cat *",
    "cp LICENSE web/LICENSE *",
    "cd web *",
    "npm install --package-lock-only *",
  ]);
});

test("does not treat Node here-document bodies as shell commands", () => {
  const result = analyseShell("set -e\r\ncd commands-whitelist && npm version 1.1.0 --no-git-tag-version\r\nnode - <<'NODE'\r\nconst fs=require('fs');\r\nfor (const dir of ['commit-msg','pr-description','review']) {\r\n  const path = './package.json';\r\n  fs.writeFileSync(path, 'updated');\r\n}\r\nNODE");
  assert.deepEqual(result.parts.map((part) => part.displayWords.join(" ")), [
    "set -e *",
    "cd commands-whitelist *",
    "npm version 1.1.0 --no-git-tag-version *",
    "node - *",
  ]);
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
