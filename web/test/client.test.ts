import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Exercise the actual dashboard functions without introducing a browser dependency.
const serverSource = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
const functions = ["appendDialogs", "applyEvent", "agentState"].map((name) => {
	const source = serverSource.split("\n").find((line) => line.startsWith(`function ${name}(`));
	assert.ok(source, `Missing client function ${name}`);
	return source;
}).join("\n");

class Node {
	children: unknown[];
	value = "";
	oninput?: () => void;
	onchange?: () => void;
	onclick?: () => void;
	constructor(public tag: string, properties: object = {}, ...children: unknown[]) {
		Object.assign(this, properties);
		this.children = children;
	}
	append(...children: unknown[]) { this.children.push(...children); }
}

function client() {
	const sent: unknown[] = [], markdown: string[] = [], drafts = new Map<string, string>();
	const api = new Function("el", "markdownView", "socket", "dialogDrafts", "commandDialog",
		`let selected = "selected";\n${functions}\nreturn { appendDialogs, applyEvent, agentState };`)(
		(tag: string, props: object, ...children: unknown[]) => new Node(tag, props, ...children),
		(_agent: unknown, text: string) => { markdown.push(text); return new Node("markdown", {}, text); },
		{ send: (data: string) => sent.push(JSON.parse(data)) }, drafts, () => assert.fail("Not a command dialog"),
	);
	return { api, sent, markdown, drafts };
}

function control(box: Node, tag: string): Node {
	const node = box.children.find((child) => child instanceof Node && child.tag === tag);
	assert.ok(node instanceof Node, `Missing ${tag}`);
	return node;
}

test("review dialogs render findings as Markdown and submit only the selected answer", () => {
	const { api, sent, markdown } = client();
	const detail = "### [High] Missing check\n\n**File:** parser.go:12\n\nGenerate a fix?";
	const agent = { id: "selected", dialogs: [{ id: "finding", kind: "select", title: "Finding 1/2", detail, options: ["yes", "no"], data: { markdown: true } }] };
	const messages = new Node("messages");
	api.appendDialogs(messages, agent);
	const box = messages.children[0] as Node;
	assert.deepEqual(markdown, [detail]);
	const selector = control(box, "select");
	assert.equal(selector.value, "yes");
	selector.value = "no";
	selector.onchange!();
	control(box, "button").onclick!();
	assert.deepEqual(sent, [{ type: "dialog_response", agentId: "selected", id: "finding", value: "no" }]);
	const rerendered = new Node("messages");
	api.appendDialogs(rerendered, agent);
	assert.equal(control(rerendered.children[0] as Node, "select").value, "no");
});

test("multiline iteration prompts survive redraws and reach the agent unchanged", () => {
	const { api, sent } = client();
	const agent = { id: "selected", dialogs: [{ id: "iteration", kind: "input", title: "Iteration prompt", data: { multiline: true } }] };
	const messages = new Node("messages");
	api.appendDialogs(messages, agent);
	const field = control(messages.children[0] as Node, "textarea");
	field.value = "Keep the guard.\nCover negative indexes.";
	field.oninput!();
	const redraw = new Node("messages");
	api.appendDialogs(redraw, agent);
	const box = redraw.children[0] as Node;
	assert.equal(control(box, "textarea").value, field.value);
	control(box, "button").onclick!();
	assert.deepEqual(sent, [{ type: "dialog_response", agentId: "selected", id: "iteration", value: field.value }]);
});

test("model completion cannot replace the waiting icon while a review question remains open", () => {
	const { api } = client();
	const agent = { id: "selected", status: "busy", dialogs: [{ id: "finding" }] };
	api.applyEvent(agent, { type: "agent_settled" });
	assert.deepEqual(api.agentState(agent), ["waiting", "🙅"]);
	api.applyEvent(agent, { type: "agent_start" });
	assert.deepEqual(api.agentState(agent), ["waiting", "🙅"]);
	agent.dialogs = [];
	api.applyEvent(agent, { type: "agent_start" });
	assert.deepEqual(api.agentState(agent), ["working", "🚧"]);
	api.applyEvent(agent, { type: "agent_settled" });
	assert.deepEqual(api.agentState(agent), ["idle", "🙋"]);
	agent.id = "other";
	assert.deepEqual(api.agentState(agent), ["finished", "🏁"]);
});
