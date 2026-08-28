import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ANSWER_TOOLS = new Set(["read", "bash", "grep", "find", "ls"]);
const READ_ONLY_COMMANDS = new Set([
	"basename",
	"cat",
	"cut",
	"date",
	"df",
	"dirname",
	"du",
	"echo",
	"file",
	"find",
	"git",
	"grep",
	"head",
	"id",
	"jq",
	"ls",
	"pgrep",
	"printenv",
	"printf",
	"pwd",
	"readlink",
	"realpath",
	"rg",
	"sort",
	"stat",
	"tail",
	"test",
	"true",
	"false",
	"tr",
	"uname",
	"uniq",
	"uptime",
	"wc",
	"whoami",
]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"status",
	"diff",
	"log",
	"show",
	"ls-files",
	"ls-tree",
	"rev-parse",
	"merge-base",
	"blame",
	"grep",
	"shortlog",
	"describe",
	"name-rev",
]);
const UNSAFE_FIND_ARGUMENTS = new Set(["-delete", "-exec", "-execdir", "-fprint", "-fprintf", "-fls", "-ok", "-okdir"]);

const READ_ONLY_INSTRUCTIONS = `

IMPORTANT — READ-ONLY QUESTION MODE
Answer the user's question. You may inspect existing project information when useful, but you must not modify any file or system state.
Use only the available read-only tools and read-only shell commands. Never use edit, write, or any other tool that can change files.
Do not run commands that create, overwrite, delete, rename, install, commit, stage, or otherwise modify files or system state.
If answering requires a change, explain the answer or proposed change without applying it.
`;

function isReadOnlyBashCommand(input: unknown): boolean {
	if (typeof input !== "string") return false;

	const command = input.trim();
	if (!command || /[\n\r;&|`<>]|\$[({]/.test(command)) return false;

	const [executable, ...args] = command.split(/\s+/);
	if (!executable || !READ_ONLY_COMMANDS.has(executable)) return false;
	if (executable === "git") {
		const subcommand = args.find((arg) => !arg.startsWith("-"));
		return subcommand !== undefined
			&& READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)
			&& !args.some((arg) => arg === "--output" || arg.startsWith("--output=") || arg === "--ext-diff");
	}
	if (executable === "find") return !args.some((arg) => UNSAFE_FIND_ARGUMENTS.has(arg));
	if (executable === "rg") return !args.some((arg) => arg === "--pre" || arg.startsWith("--pre="));
	if (executable === "date") return !args.some((arg) => arg === "-s" || arg === "--set" || arg.startsWith("--set="));
	return true;
}

export default function (pi: ExtensionAPI) {
	let readOnlyQuestion = false;
	let previousActiveTools: string[] | undefined;

	function restoreTools(): void {
		if (previousActiveTools === undefined) return;

		const tools = previousActiveTools;
		previousActiveTools = undefined;
		readOnlyQuestion = false;
		pi.setActiveTools(tools);
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
			await ctx.waitForIdle();
			if (previousActiveTools !== undefined) {
				ctx.ui.notify("A read-only question is already starting.", "warning");
				return;
			}

			previousActiveTools = pi.getActiveTools();
			readOnlyQuestion = true;
			pi.setActiveTools(previousActiveTools.filter((tool) => ANSWER_TOOLS.has(tool)));
			pi.sendUserMessage(prompt);
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

	pi.on("session_shutdown", () => {
		restoreTools();
	});
}
