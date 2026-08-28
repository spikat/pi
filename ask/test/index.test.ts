import assert from "node:assert/strict";
import test from "node:test";
import askExtension from "../index.js";

type Handler = (event: any, ctx?: any) => any;
type Command = { handler: (args: string, ctx: any) => Promise<void> };

function createExtension() {
	const handlers = new Map<string, Handler>();
	const notifications: Array<{ message: string; level: string }> = [];
	const toolSelections: string[][] = [];
	const userMessages: string[] = [];
	const initialTools = ["read", "bash", "edit", "write", "grep", "some_extension_tool"];
	let command: Command | undefined;

	askExtension({
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, registered: Command) {
			assert.equal(name, "ask");
			command = registered;
		},
		getActiveTools() {
			return initialTools;
		},
		setActiveTools(tools: string[]) {
			toolSelections.push(tools);
		},
		sendUserMessage(message: string) {
			userMessages.push(message);
		},
	} as any);

	return {
		command: command!,
		handlers,
		notifications,
		toolSelections,
		userMessages,
		initialTools,
		context: {
			async waitForIdle() {},
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
		},
	};
}

test("/ask allows inspection while blocking changes and restores the tool selection", async () => {
	const extension = createExtension();

	await extension.command.handler("  What does this project do?  ", extension.context);

	assert.deepEqual(extension.toolSelections, [["read", "bash", "grep"]]);
	assert.deepEqual(extension.userMessages, ["What does this project do?"]);

	const beforeAgentStart = extension.handlers.get("before_agent_start")!;
	const result = beforeAgentStart({ systemPrompt: "Base instructions" });
	assert.match(result.systemPrompt, /READ-ONLY QUESTION MODE/);
	assert.match(result.systemPrompt, /must not modify any file or system state/);

	const toolCall = extension.handlers.get("tool_call")!;
	assert.equal(toolCall({ toolName: "read", input: { path: "README.md" } }), undefined);
	assert.equal(toolCall({ toolName: "bash", input: { command: "git diff --stat" } }), undefined);
	assert.equal(toolCall({ toolName: "bash", input: { command: "find . -name '*.ts'" } }), undefined);
	assert.deepEqual(toolCall({ toolName: "write", input: { path: "README.md" } }), {
		block: true,
		reason: "/ask only allows read-only project inspection.",
	});
	assert.deepEqual(toolCall({ toolName: "some_extension_tool", input: {} }), {
		block: true,
		reason: "/ask only allows read-only project inspection.",
	});
	assert.deepEqual(toolCall({ toolName: "bash", input: { command: "git status > status.txt" } }), {
		block: true,
		reason: "/ask only allows read-only shell commands.",
	});
	assert.deepEqual(toolCall({ toolName: "bash", input: { command: "find . -delete" } }), {
		block: true,
		reason: "/ask only allows read-only shell commands.",
	});
	assert.deepEqual(toolCall({ toolName: "bash", input: { command: "git branch feature" } }), {
		block: true,
		reason: "/ask only allows read-only shell commands.",
	});
	assert.deepEqual(toolCall({ toolName: "bash", input: { command: "env rm README.md" } }), {
		block: true,
		reason: "/ask only allows read-only shell commands.",
	});
	assert.deepEqual(toolCall({ toolName: "bash", input: { command: "rg --pre='touch unsafe' TODO" } }), {
		block: true,
		reason: "/ask only allows read-only shell commands.",
	});

	extension.handlers.get("agent_settled")!({});
	assert.deepEqual(extension.toolSelections, [["read", "bash", "grep"], extension.initialTools]);
	assert.equal(extension.handlers.get("before_agent_start")!({ systemPrompt: "Base" }), undefined);
});

test("/ask requires a prompt", async () => {
	const extension = createExtension();

	await extension.command.handler("   ", extension.context);

	assert.deepEqual(extension.notifications, [{ message: "Usage: /ask <prompt>", level: "warning" }]);
	assert.deepEqual(extension.toolSelections, []);
	assert.deepEqual(extension.userMessages, []);
});
