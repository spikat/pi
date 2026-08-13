import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_SECTION_CHARS = 50000;
const WEB_BRIDGE_SYMBOL = Symbol.for("spikat.pi.web.bridge");
const WEB_COMMAND_CONTRIBUTORS_SYMBOL = Symbol.for("spikat.pi.web.command-contributors");
type WebBridge = { registerCommand(name: string, handler: (args: string) => Promise<void> | void): () => void };
type WebContributor = (bridge: WebBridge) => void;
function registerWebCommand(name: string, handler: (args: string) => Promise<void> | void): void { const global = globalThis as Record<symbol, unknown>; let contributors = global[WEB_COMMAND_CONTRIBUTORS_SYMBOL] as Set<WebContributor> | undefined; if (!contributors) { contributors = new Set(); global[WEB_COMMAND_CONTRIBUTORS_SYMBOL] = contributors; } const contributor: WebContributor = (bridge) => { bridge.registerCommand(name, handler); }; contributors.add(contributor); (global[WEB_BRIDGE_SYMBOL] as WebBridge | undefined)?.registerCommand(name, handler); }

function runGit(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error((stderr || error.message).trim()));
				return;
			}
			resolve(stdout.trimEnd());
		});
	});
}

async function tryGit(args: string[], cwd: string): Promise<string | undefined> {
	try {
		const result = await runGit(args, cwd);
		return result.trim() || undefined;
	} catch {
		return undefined;
	}
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return {
		text: `${text.slice(0, maxChars)}\n\n[Content truncated after ${maxChars} characters]`,
		truncated: true,
	};
}

async function resolveBaseRef(cwd: string): Promise<string | undefined> {
	const originHead = await tryGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd);
	const candidates = [originHead, "origin/main", "origin/master", "main", "master"].filter((value): value is string => !!value);

	for (const candidate of candidates) {
		const mergeBase = await tryGit(["merge-base", "HEAD", candidate], cwd);
		if (mergeBase) return mergeBase;
	}

	return undefined;
}

function extractAssistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	if ((message as { role?: unknown }).role !== "assistant") return "";

	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";

	return content
		.flatMap((part) => {
			if (!part || typeof part !== "object") return [];
			if ((part as { type?: unknown }).type !== "text") return [];
			const text = (part as { text?: unknown }).text;
			return typeof text === "string" ? [text] : [];
		})
		.join("\n")
		.trim();
}

function parseFindings(reviewText: string): string[] {
	const severity = "Critical|High|Medium|Low|Nit";
	const headingPattern = new RegExp(`^###\\s+\\[(${severity})\\][^\\n]*(?:\\n(?!###\\s+\\[(?:${severity})\\]).*)*`, "gim");
	const headingMatches = reviewText.match(headingPattern)?.map((finding) => finding.trim()).filter(Boolean) ?? [];
	if (headingMatches.length > 0) return headingMatches;

	const bulletPattern = new RegExp(`^(?:[-*]|\\d+\\.)\\s+(?:\\*\\*)?(?:${severity})(?:\\*\\*)?[:\\s-].*(?:\\n(?![-*]\\s+(?:(?:\\*\\*)?(?:${severity})(?:\\*\\*)?[:\\s-])|\\d+\\.\\s+(?:(?:\\*\\*)?(?:${severity})(?:\\*\\*)?[:\\s-])).*)*`, "gim");
	const bulletMatches = reviewText.match(bulletPattern)?.map((finding) => finding.trim()).filter(Boolean) ?? [];
	if (bulletMatches.length > 0) return bulletMatches;

	if (/no (substantial )?findings|no issues found|nothing significant/i.test(reviewText)) return [];
	return reviewText ? [reviewText] : [];
}

type ReviewState =
	| { mode: "idle" }
	| { mode: "awaiting-review" }
	| { mode: "review-interaction"; findings: string[]; index: number }
	| { mode: "awaiting-fix-validation"; findings: string[]; index: number };

export default function (pi: ExtensionAPI) {
	let state: ReviewState = { mode: "idle" };
	let current: ExtensionContext | undefined;
	pi.on("session_start", async (_event, ctx) => { current = ctx; });

	async function processNextFinding(ctx: ExtensionContext, findings: string[], startIndex: number): Promise<void> {
		if (!ctx.hasUI) {
			state = { mode: "idle" };
			return;
		}

		let index = startIndex;
		while (index < findings.length) {
			const finding = findings[index]!;
			const choice = await ctx.ui.select(`Finding ${index + 1}/${findings.length}\n\n${finding}\n\nGenerate a fix for this issue?`, ["yes", "no"]);

			if (choice === "yes") {
				state = { mode: "awaiting-fix-validation", findings, index };
				pi.sendUserMessage([
					"Generate and apply a fix for the following code review finding.",
					"Do not address unrelated findings. Keep the change focused.",
					"After applying the fix, briefly summarize what changed and mention any validation that should be run.",
					"",
					"Finding:",
					finding,
				].join("\n"), { deliverAs: "followUp" });
				return;
			}

			index++;
		}

		state = { mode: "idle" };
		ctx.ui.notify("Review findings processed", "info");
	}

	async function validateFix(ctx: ExtensionContext, findings: string[], index: number): Promise<void> {
		if (!ctx.hasUI) {
			state = { mode: "idle" };
			return;
		}

		while (true) {
			const choice = await ctx.ui.select(`Fix validation ${index + 1}/${findings.length}`, ["ok", "iterate with a prompt"]);
			if (!choice || choice === "ok") {
				await processNextFinding(ctx, findings, index + 1);
				return;
			}

			if (choice === "iterate with a prompt") {
				const prompt = await ctx.ui.editor("Iteration prompt for the fix");
				const trimmed = prompt?.trim();
				if (!trimmed) {
					ctx.ui.notify("Empty or cancelled prompt", "warning");
					continue;
				}

				state = { mode: "awaiting-fix-validation", findings, index };
				pi.sendUserMessage([
					"Iterate on the previous fix for this review finding.",
					"Keep the scope limited to this finding unless explicitly requested otherwise.",
					"",
					"Finding:",
					findings[index]!,
					"",
					"User iteration request:",
					trimmed,
				].join("\n"), { deliverAs: "followUp" });
				return;
			}
		}
	}

	pi.on("message_end", async (event, ctx) => {
		const text = extractAssistantText(event.message);
		if (!text) return;

		if (state.mode === "awaiting-review") {
			const findings = parseFindings(text);
			if (findings.length === 0) {
				state = { mode: "idle" };
				if (ctx.hasUI) ctx.ui.notify("No review findings to process", "info");
				return;
			}

			state = { mode: "review-interaction", findings, index: 0 };
			await processNextFinding(ctx, findings, 0);
			return;
		}

		if (state.mode === "awaiting-fix-validation") {
			await validateFix(ctx, state.findings, state.index);
		}
	});

	async function runReview(ctx: ExtensionContext): Promise<void> {
			try {
				await runGit(["rev-parse", "--is-inside-work-tree"], ctx.cwd);
			} catch {
				ctx.ui.notify("Not inside a git repository", "warning");
				return;
			}

			const branch = await runGit(["branch", "--show-current"], ctx.cwd);
			const status = await runGit(["status", "--short", "--branch"], ctx.cwd);
			const base = await resolveBaseRef(ctx.cwd);

			const [commitLog, branchNameStatus, branchStat, branchDiff, stagedNameStatus, stagedStat, stagedDiff, unstagedNameStatus, unstagedStat, unstagedDiff] = await Promise.all([
				base ? runGit(["log", "--no-merges", "--format=%h %s%n%b", `${base}..HEAD`], ctx.cwd) : Promise.resolve("[Base branch could not be determined]"),
				base ? runGit(["diff", "--name-status", base, "HEAD"], ctx.cwd) : Promise.resolve("[Base branch could not be determined]"),
				base ? runGit(["diff", "--stat", "--no-color", base, "HEAD"], ctx.cwd) : Promise.resolve("[Base branch could not be determined]"),
				base ? runGit(["diff", "--no-color", "--find-renames", "--find-copies", "--diff-algorithm=histogram", base, "HEAD"], ctx.cwd) : Promise.resolve("[Base branch could not be determined]"),
				runGit(["diff", "--cached", "--name-status"], ctx.cwd),
				runGit(["diff", "--cached", "--stat", "--no-color"], ctx.cwd),
				runGit(["diff", "--cached", "--no-color", "--find-renames", "--find-copies", "--diff-algorithm=histogram"], ctx.cwd),
				runGit(["diff", "--name-status"], ctx.cwd),
				runGit(["diff", "--stat", "--no-color"], ctx.cwd),
				runGit(["diff", "--no-color", "--find-renames", "--find-copies", "--diff-algorithm=histogram"], ctx.cwd),
			]);

			const branchDiffTruncated = truncate(branchDiff || "[No committed branch diff]", MAX_SECTION_CHARS);
			const stagedDiffTruncated = truncate(stagedDiff || "[No staged changes]", MAX_SECTION_CHARS);
			const unstagedDiffTruncated = truncate(unstagedDiff || "[No unstaged changes]", MAX_SECTION_CHARS);

			const prompt = [
				"Perform a code review of the current branch and working tree changes.",
				"Analyze the branch commits, staged changes, and unstaged changes for:",
				"- bugs and correctness issues",
				"- regressions or behavior changes",
				"- performance problems",
				"- security or data-loss risks",
				"- maintainability, test coverage, and other relevant concerns",
				"",
				"Output requirements:",
				"- Sort findings by criticality: Critical, High, Medium, Low, Nit.",
				"- Use one third-level heading per finding, exactly in this format: ### [Severity] Short title.",
				"- For each finding, include: severity, affected file(s), evidence, impact, and a recommended fix when possible.",
				"- Do not apply fixes automatically. Leave the final decision to the user on a case-by-case basis.",
				"- If there are no substantial findings, say so clearly and mention any residual risks or missing validation.",
				"- Be concise but specific. Avoid generic praise.",
				branchDiffTruncated.truncated || stagedDiffTruncated.truncated || unstagedDiffTruncated.truncated
					? "- Some diffs are truncated; explicitly mention that the review may be incomplete."
					: undefined,
				"",
				`Current branch: ${branch || "unknown"}`,
				`Base commit: ${base ?? "unknown"}`,
				"",
				"Git status:",
				"```",
				status || "[Clean working tree]",
				"```",
				"",
				"Branch commits:",
				"```",
				commitLog || "[No branch commits found]",
				"```",
				"",
				"Committed branch changes - files:",
				"```",
				branchNameStatus || "[No committed branch changes]",
				"```",
				"",
				"Committed branch changes - stat:",
				"```",
				branchStat || "[No committed branch changes]",
				"```",
				"",
				"Committed branch changes - diff:",
				"```diff",
				branchDiffTruncated.text,
				"```",
				"",
				"Staged changes - files:",
				"```",
				stagedNameStatus || "[No staged changes]",
				"```",
				"",
				"Staged changes - stat:",
				"```",
				stagedStat || "[No staged changes]",
				"```",
				"",
				"Staged changes - diff:",
				"```diff",
				stagedDiffTruncated.text,
				"```",
				"",
				"Unstaged changes - files:",
				"```",
				unstagedNameStatus || "[No unstaged changes]",
				"```",
				"",
				"Unstaged changes - stat:",
				"```",
				unstagedStat || "[No unstaged changes]",
				"```",
				"",
				"Unstaged changes - diff:",
				"```diff",
				unstagedDiffTruncated.text,
				"```",
			]
				.filter((line): line is string => line !== undefined)
				.join("\n");

			ctx.ui.notify("Generating code review for current branch and working tree…", "info");
			state = { mode: "awaiting-review" };
			pi.sendUserMessage(prompt);
	}
	pi.registerCommand("review", { description: "Review the current branch, staged changes, and unstaged changes", handler: async (_args, ctx) => { await ctx.waitForIdle(); await runReview(ctx); } });
	registerWebCommand("review", async () => { if (current?.isIdle()) await runReview(current); });
}
