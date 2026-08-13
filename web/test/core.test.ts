import assert from "node:assert/strict";
import test from "node:test";
import { advance, enqueue, isSafeMarkdownPath, renderMarkdown, resolveMarkdownPath, stripSensitiveToken, type QueueState } from "../core.js";

test("queues browser input in FIFO order", () => {
	let state: QueueState = { pending: [] };
	state = enqueue(state, { id: "one", text: "first", receivedAt: 1 });
	state = enqueue(state, { id: "two", text: "second", receivedAt: 2 });
	assert.equal(state.active?.text, "first");
	assert.deepEqual(state.pending.map((item) => item.text), ["second"]);
	state = advance(state);
	assert.equal(state.active?.text, "second");
	assert.deepEqual(advance(state), { pending: [] });
});

test("markdown previews cannot escape the agent project", () => {
	assert.equal(isSafeMarkdownPath("/work/project", "README.md"), true);
	assert.equal(isSafeMarkdownPath("/work/project", "/work/project/docs/guide.MD"), true);
	assert.equal(isSafeMarkdownPath("/work/project", "../secret.md"), false);
	assert.equal(isSafeMarkdownPath("/work/project", "/work/other/README.md"), false);
	assert.equal(isSafeMarkdownPath("/work/project", "notes.txt"), false);
	assert.equal(resolveMarkdownPath("/work/project", "docs/a.md"), "/work/project/docs/a.md");
});

test("markdown rendering escapes HTML and only keeps safe HTTP links", () => {
	const rendered = renderMarkdown("# Hello\n<script>alert(1)</script>\n[ok](https://example.test)\n[javascript](javascript:alert(1))\n```\n<unsafe>\n```");
	assert.match(rendered, /<h1>Hello<\/h1>/);
	assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.match(rendered, /href="https:\/\/example.test"/);
	assert.match(rendered, /\[javascript\]\(javascript:alert\(1\)\)/);
	assert.match(rendered, /&lt;unsafe&gt;/);
});

test("removes the browser token without changing other URL data", () => {
	assert.equal(stripSensitiveToken("https://localhost:8088/?token=secret&view=all#main"), "/?view=all#main");
});
