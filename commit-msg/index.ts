import { execFile } from "node:child_process";
import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_DIFF_CHARS = 60000;
const WEB_BRIDGE_SYMBOL = Symbol.for("spikat.pi.web.bridge");
const WEB_COMMAND_CONTRIBUTORS_SYMBOL = Symbol.for("spikat.pi.web.command-contributors");
type WebBridge = { registerCommand(name: string, handler: (args: string) => Promise<void> | void): () => void };
type WebContributor = (bridge: WebBridge) => void;

function registerWebCommand(name: string, handler: (args: string) => Promise<void> | void): void {
	const global = globalThis as Record<symbol, unknown>;
	let contributors = global[WEB_COMMAND_CONTRIBUTORS_SYMBOL] as Set<WebContributor> | undefined;
	if (!contributors) { contributors = new Set(); global[WEB_COMMAND_CONTRIBUTORS_SYMBOL] = contributors; }
	const contributor: WebContributor = (bridge) => { bridge.registerCommand(name, handler); };
	contributors.add(contributor);
	(global[WEB_BRIDGE_SYMBOL] as WebBridge | undefined)?.registerCommand(name, handler);
}

function runGit(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) { reject(new Error((stderr || error.message).trim())); return; }
			resolve(stdout.trimEnd());
		});
	});
}
function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
	return text.length <= maxChars ? { text, truncated: false } : { text: `${text.slice(0, maxChars)}\n\n[Diff truncated after ${maxChars} characters]`, truncated: true };
}
function extractAssistantText(message: unknown): string {
	if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") return "";
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content) ? content.flatMap((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []).join("\n").trim() : "";
}

export default function (pi: ExtensionAPI) {
	let pendingCommitMessage = false;
	let current: ExtensionContext | undefined;
	async function generate(ctx: ExtensionContext): Promise<void> {
		try { await runGit(["rev-parse", "--is-inside-work-tree"], ctx.cwd); } catch { ctx.ui.notify("Not inside a git repository", "warning"); return; }
		const stagedFiles = await runGit(["diff", "--cached", "--name-status"], ctx.cwd);
		if (!stagedFiles.trim()) { ctx.ui.notify("No staged changes found", "warning"); return; }
		const [stat, rawDiff] = await Promise.all([runGit(["diff", "--cached", "--stat", "--no-color"], ctx.cwd), runGit(["diff", "--cached", "--no-color", "--find-renames", "--find-copies", "--diff-algorithm=histogram"], ctx.cwd)]);
		const diff = truncate(rawDiff, MAX_DIFF_CHARS);
		const prompt = ["Generate a git commit message in English for the staged changes below.", "Constraints:", "- Output only the commit message, no markdown, no explanation.", "- Maximum 5 lines total.", "- The first line must summarize the entire change.", "- Prefer imperative mood and be concise.", diff.truncated ? "- The diff is truncated; rely on the file list and stat too." : undefined, "", "Staged files:", "```", stagedFiles, "```", "", "Diff stat:", "```", stat, "```", "", "Staged diff:", "```diff", diff.text, "```"].filter((line): line is string => line !== undefined).join("\n");
		ctx.ui.notify("Generating commit message from staged changes…", "info"); pendingCommitMessage = true; pi.sendUserMessage(prompt);
	}
	pi.on("session_start", async (_event, ctx) => { current = ctx; });
	pi.on("message_end", async (event, ctx) => {
		current = ctx;
		if (!pendingCommitMessage) return;
		const text = extractAssistantText(event.message); if (!text) return;
		pendingCommitMessage = false; if (!ctx.hasUI) return;
		const copy = await ctx.ui.confirm("Copy commit message?", "Copy the generated content to the clipboard?"); if (!copy) return;
		try { await copyToClipboard(text); ctx.ui.notify("Commit message copied to the clipboard", "info"); } catch (error) { ctx.ui.notify(`Unable to copy to the clipboard: ${error instanceof Error ? error.message : String(error)}`, "error"); }
	});
	pi.registerCommand("gen-commit-msg", { description: "Generate an English commit message from staged git changes", handler: async (_args, ctx) => { await ctx.waitForIdle(); await generate(ctx); } });
	registerWebCommand("gen-commit-msg", async () => { if (current?.isIdle()) await generate(current); });
}
