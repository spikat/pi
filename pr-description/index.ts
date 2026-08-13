import { execFile } from "node:child_process";
import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_DIFF_CHARS = 60000;
const WEB_BRIDGE_SYMBOL = Symbol.for("spikat.pi.web.bridge");
const WEB_COMMAND_CONTRIBUTORS_SYMBOL = Symbol.for("spikat.pi.web.command-contributors");
type WebBridge = { registerCommand(name: string, handler: (args: string) => Promise<void> | void): () => void };
type WebContributor = (bridge: WebBridge) => void;
function registerWebCommand(name: string, handler: (args: string) => Promise<void> | void): void { const global = globalThis as Record<symbol, unknown>; let contributors = global[WEB_COMMAND_CONTRIBUTORS_SYMBOL] as Set<WebContributor> | undefined; if (!contributors) { contributors = new Set(); global[WEB_COMMAND_CONTRIBUTORS_SYMBOL] = contributors; } const contributor: WebContributor = (bridge) => { bridge.registerCommand(name, handler); }; contributors.add(contributor); (global[WEB_BRIDGE_SYMBOL] as WebBridge | undefined)?.registerCommand(name, handler); }
function runGit(args: string[], cwd: string): Promise<string> { return new Promise((resolve, reject) => execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout.trimEnd()))); }
async function tryGit(args: string[], cwd: string): Promise<string | undefined> { try { return (await runGit(args, cwd)).trim() || undefined; } catch { return undefined; } }
function truncate(text: string, maxChars: number): { text: string; truncated: boolean } { return text.length <= maxChars ? { text, truncated: false } : { text: `${text.slice(0, maxChars)}\n\n[Diff truncated after ${maxChars} characters]`, truncated: true }; }
async function resolveBaseRef(cwd: string): Promise<string | undefined> { const originHead = await tryGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd); for (const candidate of [originHead, "origin/main", "origin/master", "main", "master"].filter((value): value is string => !!value)) { const base = await tryGit(["merge-base", "HEAD", candidate], cwd); if (base) return base; } return undefined; }
function extractAssistantText(message: unknown): string { if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") return ""; const content = (message as { content?: unknown }).content; return Array.isArray(content) ? content.flatMap((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []).join("\n").trim() : ""; }

export default function (pi: ExtensionAPI) {
	let pendingPrDescription = false; let current: ExtensionContext | undefined;
	async function generate(ctx: ExtensionContext): Promise<void> {
		try { await runGit(["rev-parse", "--is-inside-work-tree"], ctx.cwd); } catch { ctx.ui.notify("Not inside a git repository", "warning"); return; }
		const branch = await runGit(["branch", "--show-current"], ctx.cwd); const base = await resolveBaseRef(ctx.cwd);
		if (!base) { ctx.ui.notify("Unable to determine a base branch (tried origin/HEAD, origin/main, origin/master, main, master)", "warning"); return; }
		const commitLog = await runGit(["log", "--no-merges", "--format=%h %s%n%b", `${base}..HEAD`], ctx.cwd);
		if (!commitLog.trim()) { ctx.ui.notify("No branch commits found compared to the base branch", "warning"); return; }
		const [nameStatus, stat, rawDiff] = await Promise.all([runGit(["diff", "--name-status", base, "HEAD"], ctx.cwd), runGit(["diff", "--stat", "--no-color", base, "HEAD"], ctx.cwd), runGit(["diff", "--no-color", "--find-renames", "--find-copies", "--diff-algorithm=histogram", base, "HEAD"], ctx.cwd)]);
		const diff = truncate(rawDiff, MAX_DIFF_CHARS);
		const prompt = ["Generate a pull request description in Markdown for the current branch changes.", "Use exactly this template and keep these headings:", "", "### What does this PR do?", "", "### Motivation", "", "### Describe how you validated your changes", "", "### Additional Notes", "", "Rules:", "- Output only the PR description markdown, no code fences, no extra explanation.", "- Write in clear English.", "- If validation is not evident from commits or diff, mention that validation is not specified.", diff.truncated ? "- The diff is truncated; rely on commits, file list, and stat too." : undefined, "", `Current branch: ${branch || "unknown"}`, `Base commit: ${base}`, "", "Branch commits:", "```", commitLog, "```", "", "Changed files:", "```", nameStatus, "```", "", "Diff stat:", "```", stat, "```", "", "Diff:", "```diff", diff.text, "```"].filter((line): line is string => line !== undefined).join("\n");
		ctx.ui.notify("Generating PR description from current branch commits…", "info"); pendingPrDescription = true; pi.sendUserMessage(prompt);
	}
	pi.on("session_start", async (_event, ctx) => { current = ctx; });
	pi.on("message_end", async (event, ctx) => { current = ctx; if (!pendingPrDescription) return; const text = extractAssistantText(event.message); if (!text) return; pendingPrDescription = false; if (!ctx.hasUI) return; const copy = await ctx.ui.confirm("Copy PR description?", "Copy the generated Markdown to the clipboard?"); if (!copy) return; try { await copyToClipboard(text); ctx.ui.notify("PR description copied to the clipboard", "info"); } catch (error) { ctx.ui.notify(`Unable to copy to the clipboard: ${error instanceof Error ? error.message : String(error)}`, "error"); } });
	pi.registerCommand("gen-pr-desc", { description: "Generate a markdown PR description from current branch commits", handler: async (_args, ctx) => { await ctx.waitForIdle(); await generate(ctx); } });
	registerWebCommand("gen-pr-desc", async () => { if (current?.isIdle()) await generate(current); });
}
