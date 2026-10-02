import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ANSWER_TOOLS = new Set(["read", "bash", "grep", "find", "ls"]);
import { isReadOnlyBashCommand } from "./shell.js";

const READ_ONLY_INSTRUCTIONS = `

IMPORTANT — READ-ONLY QUESTION MODE
Answer the user's question. You may inspect existing project information when useful, but you must not modify any file or system state.
Use only the available read-only tools and literal inspection commands. For git diff/show/log, include --no-ext-diff --no-textconv. Shell expansions and compound commands are unavailable. Never use edit, write, or any other tool that can change files.
Do not run commands that create, overwrite, delete, rename, install, commit, stage, or otherwise modify files or system state.
If answering requires a change, explain the answer or proposed change without applying it.
`;

export default function (pi: ExtensionAPI) {
	let readOnlyQuestion = false;
	let sessionEpoch = 0;
	let previousActiveTools: string[] | undefined;
	let restrictedTools: string[] | undefined;

	function restoreTools(): void {
		if (previousActiveTools === undefined) return;

		const tools = previousActiveTools;
		previousActiveTools = undefined;
		readOnlyQuestion = false;
		// Do not overwrite another extension's newer selection.
		if (restrictedTools && pi.getActiveTools().join("\0") === restrictedTools.join("\0")) pi.setActiveTools(tools);
		restrictedTools = undefined;
	}

	pi.registerCommand("ask", {
		description: "Ask a question while allowing only read-only project inspection",
		handler: async (args, ctx) => {
			const prompt = args.trim();
			if (!prompt) {
				ctx.ui.notify("Usage: /ask <prompt>", "warning");
				return;
			}

			// Do not change the tool set of a turn that is already running. This also
			// waits for any queued messages so this command owns the next agent run.
			const epoch = sessionEpoch;
			await ctx.waitForIdle();
			if (epoch !== sessionEpoch) { ctx.ui.notify("Session changed before the question could start; retry /ask.", "warning"); return; }
			if (previousActiveTools !== undefined) {
				ctx.ui.notify("A read-only question is already starting.", "warning");
				return;
			}

			previousActiveTools = pi.getActiveTools();
			readOnlyQuestion = true;
			restrictedTools = previousActiveTools.filter((tool) => ANSWER_TOOLS.has(tool));
			try { pi.setActiveTools(restrictedTools); pi.sendUserMessage(prompt); }
			catch (error) { restoreTools(); throw error; }
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!readOnlyQuestion) return;
		return { systemPrompt: event.systemPrompt + READ_ONLY_INSTRUCTIONS };
	});

	// The active tools exclude write/edit/custom tools. This gate also limits bash
	// to conservative inspection commands if another extension changes the tool set.
	pi.on("tool_call", (event) => {
		if (!readOnlyQuestion) return;
		if (!ANSWER_TOOLS.has(event.toolName)) {
			return { block: true, reason: "/ask only allows read-only project inspection." };
		}
		if (event.toolName === "bash" && !isReadOnlyBashCommand(event.input?.command)) {
			return { block: true, reason: "/ask only allows read-only shell commands." };
		}
	});

	pi.on("agent_settled", () => {
		restoreTools();
	});

	pi.on("session_start", () => { sessionEpoch++; restoreTools(); });

	pi.on("session_shutdown", () => {
		sessionEpoch++;
		restoreTools();
	});
}
