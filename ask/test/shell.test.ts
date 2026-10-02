import assert from "node:assert/strict";
import test from "node:test";
import { isReadOnlyBashCommand, literalWords } from "../shell.js";
import extension from "../index.js";

test("literal argument parsing fails closed and decodes quotes", () => {
	assert.deepEqual(literalWords("find . '-delete'"), ["find", ".", "-delete"]);
	assert.deepEqual(literalWords("cat 'path with spaces'"), ["cat", "path with spaces"]);
	for (const command of ["cat $FILE", "echo $(rm x)", "cat a; rm b", "cat a > b", "cat 'unterminated", "cat *"]) assert.equal(literalWords(command), undefined);
});

test("mutating options and program-launching arguments are denied", () => {
	for (const command of ["sort -o /tmp/output README.md", "sort '-no' /tmp/output README.md", "sort --compress-program=evil README.md", "uniq README.md /tmp/output", "find . '-delete'", "find . -fprint0 /tmp/output", "date '-s' '2030-01-01'", "git diff '--output' /tmp/output", "git -c alias.show=evil show", "git grep -Oevil foo", "rg --pre=evil foo", "file -C", "git show HEAD:file"]) assert.equal(isReadOnlyBashCommand(command), false, command);
	for (const command of ["cat 'file name'", "git status --short", "git diff --no-ext-diff --no-textconv --stat", "find . -name '*.ts'"]) assert.equal(isReadOnlyBashCommand(command), true, command);
});

test("failed prompt delivery restores tools", async () => {
	let command: any; let active = ["read", "edit"];
	extension({ registerCommand: (_: string, c: any) => command = c, on() {}, getActiveTools: () => active, setActiveTools: (tools: string[]) => active = tools, sendUserMessage() { throw new Error("delivery failed"); } } as any);
	await assert.rejects(command.handler("question", { waitForIdle: async () => {}, ui: { notify() {} } }), /delivery failed/);
	assert.deepEqual(active, ["read", "edit"]);
});

test("restoration preserves a newer tool selection from another extension", async () => {
	let command: any; let active = ["read", "edit"]; const events = new Map<string, any>();
	extension({ registerCommand: (_: string, c: any) => command = c, on: (name: string, handler: any) => events.set(name, handler), getActiveTools: () => active, setActiveTools: (tools: string[]) => active = tools, sendUserMessage() {} } as any);
	await command.handler("question", { waitForIdle: async () => {}, ui: { notify() {} } });
	active = ["read", "grep"];
	events.get("agent_settled")(); assert.deepEqual(active, ["read", "grep"]);
});

test("a session change while waiting for idle cannot start an old question", async () => {
	let command: any; let finish!: () => void; let sent = 0; const events = new Map<string, any>();
	extension({ registerCommand: (_: string, c: any) => command = c, on: (name: string, handler: any) => events.set(name, handler), getActiveTools: () => ["read"], setActiveTools() {}, sendUserMessage() { sent++; } } as any);
	const pending = command.handler("question", { waitForIdle: () => new Promise<void>(resolve => finish = resolve), ui: { notify() {} } });
	events.get("session_start")(); finish(); await pending; assert.equal(sent, 0);
});
