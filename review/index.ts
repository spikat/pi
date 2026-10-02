import { execFile } from "node:child_process";
import { getMarkdownTheme, isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { ReviewUI } from "./web-ui.js";
import { parseInlineFinding, postInlineFinding, validateInlineFindings } from "./inline.js";
import { ALL_COMMENTS, CHECK_COMMENTS, JUST_ME, checkPrompt, chooseCommentActions, currentGitLogin, loadCommentThreads, parseAssessment, publishCommentAction, type Assessment, type CommentThread } from "./comments.js";

const MAX_SECTION_CHARS = 50000;
const MAX_FILE_DIFF_CHARS = 12000;
const MAX_LISTED_PATHS = 20;
const WEB_BRIDGE_SYMBOL = Symbol.for("spikat.pi.web.bridge");
const WEB_COMMAND_CONTRIBUTORS_SYMBOL = Symbol.for("spikat.pi.web.command-contributors");
const RUN_RELEVANT_TESTS = "Run all tests relevant to the changes (working branch)";
const SKIP_TESTS = "Skip test execution (branch already validated in CI)";
const FIX_LOCALLY = "Fix locally";
const COMMENT_ON_PR = "Comment on the PR";
const TEST_RUNNER_COMMAND_PATTERN = /(?:^|(?:&&|\|\||;|\n)\s*)(?:(?:go|cargo|deno|dotnet|flutter|mix|bazel|buck|meson)\s+test\b|ctest\b|(?:npm|pnpm|yarn|bun)\s+(?:(?:run|exec)\s+)?test\b|(?:npx|bunx)\s+(?:--no-install\s+)?(?:jest|vitest|mocha|ava)\b|node\s+--test\b|(?:python(?:3)?\s+-m\s+)?(?:pytest|unittest)\b|(?:uv\s+run|poetry\s+run)\s+pytest\b|(?:make|g?make)\s+test\b|(?:\.?\/?)(?:mvnw|gradlew)\s+test\b|(?:mvn|gradle)\s+test\b|(?:bundle\s+exec\s+)?rspec\b|phpunit\b|php\s+artisan\s+test\b)/im;
type WebBridge = { registerCommand(name: string, handler: (args: string) => Promise<void> | void): () => void };
type WebContributor = (bridge: WebBridge) => void;
function registerWebCommand(name: string, handler: (args: string) => Promise<void> | void): void { const global = globalThis as Record<symbol, unknown>; let contributors = global[WEB_COMMAND_CONTRIBUTORS_SYMBOL] as Set<WebContributor> | undefined; if (!contributors) { contributors = new Set(); global[WEB_COMMAND_CONTRIBUTORS_SYMBOL] = contributors; } const contributor: WebContributor = (bridge) => { bridge.registerCommand(name, handler); }; contributors.add(contributor); (global[WEB_BRIDGE_SYMBOL] as WebBridge | undefined)?.registerCommand(name, handler); }

function runCommand(command: string, args: string[], cwd: string, input?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(command, args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error((stderr || error.message).trim()));
				return;
			}
			resolve(stdout.trimEnd());
		});
		// Handle a process that exits before consuming stdin (e.g. missing gh).
		child.stdin?.on("error", () => {});
		child.stdin?.end(input);
	});
}

function runGit(args: string[], cwd: string): Promise<string> {
	return runCommand("git", args, cwd);
}

async function tryGit(args: string[], cwd: string): Promise<string | undefined> {
	try {
		const result = await runGit(args, cwd);
		return result.trim() || undefined;
	} catch {
		return undefined;
	}
}

type RenderedDiff = { text: string; truncated: boolean };

type ChangedFile = {
	status: string;
	path: string;
};

function truncate(text: string, maxChars: number): RenderedDiff {
	if (text.length <= maxChars) return { text, truncated: false };
	return {
		text: `${text.slice(0, maxChars)}\n\n[Content truncated after ${maxChars} characters]`,
		truncated: true,
	};
}

function patchPath(patch: string, index: number): string {
	const destination = patch.match(/^\+\+\+ b\/(.+)$/m)?.[1];
	if (destination && destination !== "/dev/null") return destination;

	const renamedDestination = patch.match(/^rename to (.+)$/m)?.[1];
	if (renamedDestination) return renamedDestination;

	const source = patch.match(/^--- a\/(.+)$/m)?.[1];
	if (source && source !== "/dev/null") return source;

	return `patch ${index + 1}`;
}

const BUILD_CONSTRAINT_PATTERN = /^[+-]\/\/(?:go:build|\s+\+build)\b/m;

function patchPriority(patch: string, path: string): number {
	const lowerPath = path.toLowerCase();
	if (lowerPath.includes("pkg/security/")) return 0;
	if (/(?:_test\.go|\/(?:test|tests)\/)/.test(lowerPath)) return 1;
	if (BUILD_CONSTRAINT_PATTERN.test(patch) || /(?:^|\/)(?:go\.mod|go\.sum|go\.work|go\.work\.sum)$/.test(lowerPath) || /(?:^|\/)(?:rules|config)(?:\/|\.|$)/.test(lowerPath)) return 2;
	return 3;
}

function renderDiffByFile(diff: string, emptyMessage: string): RenderedDiff {
	if (!diff) return { text: emptyMessage, truncated: false };

	const patches = diff
		.split(/(?=^diff --git )/m)
		.filter(Boolean)
		.map((patch, index) => ({ patch, index, path: patchPath(patch, index) }))
		.sort((left, right) => patchPriority(left.patch, left.path) - patchPriority(right.patch, right.path) || left.index - right.index);

	let usedChars = 0;
	let truncated = false;
	const included: string[] = [];
	const omitted: string[] = [];

	for (const { patch, path } of patches) {
		const renderedPatch = truncate(patch, MAX_FILE_DIFF_CHARS);
		if (usedChars + renderedPatch.text.length > MAX_SECTION_CHARS) {
			truncated = true;
			omitted.push(path);
			continue;
		}

		included.push(renderedPatch.text);
		usedChars += renderedPatch.text.length;
		truncated ||= renderedPatch.truncated;
	}

	if (omitted.length > 0) {
		included.push(`[Omitted patches for ${omitted.length} subsequent file(s) after ${MAX_SECTION_CHARS} characters: ${formatPaths(omitted)}. See the exhaustive file list above.]`);
	}

	return { text: included.join("\n"), truncated };
}

function parseChangedFiles(nameStatus: string): ChangedFile[] {
	if (!nameStatus) return [];

	return nameStatus.split("\n").flatMap((line) => {
		const fields = line.split("\t");
		if (fields.length < 2) return [];
		const status = fields[0]!;
		const path = fields[fields.length - 1];
		return path ? [{ status, path }] : [];
	});
}

function formatPaths(paths: string[]): string {
	if (paths.length === 0) return "none";
	const shown = paths.slice(0, MAX_LISTED_PATHS);
	return `${shown.join(", ")}${paths.length > shown.length ? `, … (+${paths.length - shown.length})` : ""}`;
}

function goDependencyChanges(diff: string): { added: string[]; updated: string[] } {
	const additions = new Map<string, string>();
	const removals = new Set<string>();

	for (const patch of diff.split(/(?=^diff --git )/m)) {
		if (!patch || !/(?:^|\/)go\.mod$/.test(patchPath(patch, 0))) continue;

		for (const line of patch.split("\n")) {
			const match = line.match(/^[+-]\s*(?:require\s+)?([^\s()]+)\s+(v[^\s]+)(?:\s|$)/);
			if (!match) continue;

			const moduleName = match[1];
			const version = match[2];
			if (!moduleName || !version) continue;
			if (line.startsWith("+")) additions.set(moduleName, `${moduleName} ${version}`);
			if (line.startsWith("-")) removals.add(moduleName);
		}
	}

	const added: string[] = [];
	const updated: string[] = [];
	for (const [moduleName, dependency] of additions) {
		(removals.has(moduleName) ? updated : added).push(dependency);
	}
	return { added, updated };
}

function summarizeChangeSurface(nameStatus: string, diff: string, emptyMessage: string): string {
	const files = parseChangedFiles(nameStatus);
	if (files.length === 0) return emptyMessage;

	const pathsWithStatus = (prefix: string) => files.filter(({ status }) => status.startsWith(prefix)).map(({ path }) => path);
	const isTestFile = ({ path }: ChangedFile) => /(?:_test\.go|\/(?:test|tests)\/)/.test(path);
	const added = pathsWithStatus("A");
	const deleted = pathsWithStatus("D");
	const renamed = pathsWithStatus("R");
	const addedTests = files.filter((file) => file.status.startsWith("A") && isTestFile(file)).map(({ path }) => path);
	const deletedTests = files.filter((file) => file.status.startsWith("D") && isTestFile(file)).map(({ path }) => path);
	const modifiedTests = files.filter((file) => !file.status.startsWith("A") && !file.status.startsWith("D") && isTestFile(file)).map(({ path }) => path);
	const goModuleFiles = files.filter(({ path }) => /(?:^|\/)(?:go\.(?:mod|sum|work)|go\.work\.sum)$/.test(path)).map(({ path }) => path);
	const goDependencies = goDependencyChanges(diff);
	const buildTagsChanged = BUILD_CONSTRAINT_PATTERN.test(diff);

	return [
		`- Changed files: ${files.length}`,
		`- Added (${added.length}): ${formatPaths(added)}`,
		`- Deleted (${deleted.length}): ${formatPaths(deleted)}`,
		`- Renamed (${renamed.length}): ${formatPaths(renamed)}`,
		`- Test files added (${addedTests.length}): ${formatPaths(addedTests)}`,
		`- Test files deleted (${deletedTests.length}): ${formatPaths(deletedTests)}`,
		`- Test files modified or renamed (${modifiedTests.length}): ${formatPaths(modifiedTests)}`,
		`- Go module metadata changed (${goModuleFiles.length}): ${formatPaths(goModuleFiles)}`,
		`- Added Go dependencies (${goDependencies.added.length}): ${formatPaths(goDependencies.added)}`,
		`- Updated Go dependencies (${goDependencies.updated.length}): ${formatPaths(goDependencies.updated)}`,
		`- Go build constraints changed: ${buildTagsChanged ? "yes" : "no"}`,
	].join("\n");
}

function isDatadogAgentRepository(remoteUrls: string | undefined): boolean {
	return remoteUrls?.split("\n").some((line) => {
		const parts = line.trim().split(/\s+/);
		const url = parts[parts.length - 1] ?? "";
		return /(?:^|[/:])datadog\/datadog-agent(?:\.git)?\/?$/i.test(url);
	}) ?? false;
}

const GENERAL_REVIEW_QUALITY = [
	"- Function comments and documentation:",
	"  - Review comments and docstrings on every added or modified function for accuracy and concision; flag stale descriptions of behavior, parameters, return values, and side effects.",
	"  - Check that non-obvious intent, invariants, preconditions, and concurrency assumptions are explained where needed. Do not demand comments that merely restate self-explanatory code.",
	"- Test value:",
	"  - Assess whether added or modified tests protect project-specific behavior, contracts, edge cases, or plausible regressions, with assertions that would catch a meaningful defect.",
	"  - Flag redundant tests that only mirror the implementation or re-test a standard collection, such as Add/Get wrappers that directly forward to an array without adding a project-specific contract. Simple tests are still valuable when they protect real project logic.",
	"Use concrete evidence from the in-scope changes; do not manufacture a finding merely because a checklist category exists.",
].join("\n");

const DATADOG_AGENT_OBSERVABILITY_REVIEW = [
	"For Datadog Agent changes, additionally review:",
	"- Runtime observability:",
	"  - For new logic such as a cache or resolver, assess whether existing metrics make its behavior diagnosable or whether useful new metrics are warranted (for example hits/misses, evictions, occupancy, resolution failures, or latency).",
	"  - Recommend metrics only for concrete operational questions not already covered; keep label cardinality bounded and hot-path overhead low.",
	"- Event field exposure:",
	"  - When event fields are added or changed, assess whether they should be serialized in reported events and/or exposed to SECL rules so downstream consumers can use them. Flag unjustified omissions, not intentional internal-only or sensitive fields.",
	"  - Check the applicable serializers, model tags, generated accessors, field documentation, and tests for consistent types, naming, availability, and backward compatibility. Do not require serialization or SECL exposure without a concrete consumer need.",
].join("\n");

const DATADOG_AGENT_SECURITY_REVIEW = [
	"For changes under pkg/security/, additionally review:",
	"- Event-pipeline correctness:",
	"  - Verify that an event remains correct from collection (eBPF, ptracer, or audit) through decoding, resolvers, SECL/rule evaluation, serialization, and reporting.",
	"  - Check timestamps, process/container identity, cgroup context, namespaces, file paths, and event fields for consistency across this pipeline.",
	"  - Look for silent event loss, duplicated events, incorrect ordering, or changes that create false positives or false negatives.",
	"- Policy and detection semantics:",
	"  - Review changes to rules, filters, discarders, suppression, activity dumps, and security profiles for unintended changes in detection coverage.",
	"  - Pay particular attention to bypasses caused by filtering too early, over-broad discarder rules, or mismatched field semantics.",
	"  - Verify backward compatibility of serialized event schemas, rule fields, remote configuration, and persisted profiles when applicable.",
	"- Kernel, eBPF, and ptracer safety:",
	"  - Check all map lookups and kernel-derived pointers for nil checks, bounds, alignment, endianness, and lifetime issues.",
	"  - Identify verifier-risky changes, unbounded work in hot paths, unsafe map access, architecture-specific assumptions, and incorrect per-CPU map handling.",
	"  - Verify behavior on supported architectures and feature variants (linux/windows, amd64/arm64, eBPF/eBPF-less) as applicable.",
	"- Runtime safety and lifecycle:",
	"  - Look for goroutine, file descriptor, socket, pinned-map, or subscription leaks.",
	"  - Review start/stop/reload paths for races, double cleanup, missed cleanup, blocked shutdown, and use-after-close behavior.",
	"  - Check concurrent access to caches, resolvers, probes, and reloaded policies.",
	"- Performance and resilience under load:",
	"  - Treat event handling as a hot path: flag avoidable allocations, locks, blocking I/O, expensive path resolution, or repeated parsing per event.",
	"  - Check boundedness of queues, caches, maps, telemetry labels, and retry loops.",
	"  - Verify rate limiting and backpressure behavior: overload must not cause unbounded memory use, prolonged event-loop stalls, or unexpected event loss.",
	"- Cross-platform and generated artifacts:",
	"  - Check build tags and platform-specific files for missing implementations, diverging behavior, or compilation regressions on unsupported platforms.",
	"  - Verify that changes requiring generated serializers, easyjson output, protobuf artifacts, or mocks update their generated counterparts.",
	"- Validation:",
	"  - Identify the smallest relevant test command(s), including focused Go tests and, when event semantics change, functional/integration security tests.",
	"  - Explicitly call out meaningful missing coverage: kernel feature variants, architecture coverage, reload paths, overload behavior, and regression tests for false-positive/false-negative scenarios.",
].join("\n");

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

function isTestRunnerCommand(command: string): boolean {
	return TEST_RUNNER_COMMAND_PATTERN.test(command);
}

type TestExecution = "run" | "skip";
type ReviewAction = "fix" | "comment";
type ReviewOptions = { testExecution: TestExecution; action: ReviewAction | "check" };
type PullRequest = { owner: string; repo: string; number: number; url: string };
type PreparedPullRequest = PullRequest & { head: string; base: string; cwd: string };

function parsePullRequest(value: string): PullRequest {
	const match = value.trim().match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/(?:files|commits))?\/?(?:[?#][^\s]*)?$/i);
	if (!match || !Number.isSafeInteger(Number(match[3]))) {
		throw new Error("Expected a GitHub PR URL: https://github.com/owner/repo/pull/123");
	}
	const [, owner, repo, number] = match;
	return { owner: owner!, repo: repo!, number: Number(number), url: `https://github.com/${owner}/${repo}/pull/${number}` };
}

async function isOwnBranch(cwd: string): Promise<boolean> {
	const [authorEmail, userEmail, authorName, userName] = await Promise.all([
		tryGit(["log", "-1", "--format=%ae"], cwd),
		tryGit(["config", "user.email"], cwd),
		tryGit(["log", "-1", "--format=%an"], cwd),
		tryGit(["config", "user.name"], cwd),
	]);
	if (authorEmail && userEmail) return authorEmail.toLowerCase() === userEmail.toLowerCase();
	return !!authorName && !!userName && authorName === userName;
}

async function chooseReviewOptions(ctx: ExtensionContext, ui: ReviewUI): Promise<ReviewOptions | undefined> {
	if (!ui.available(ctx)) return { testExecution: "skip", action: "fix" };

	const ownBranch = await isOwnBranch(ctx.cwd);
	// The first item is selected by default in both TUI and RPC dialogs.
	const tests = await ui.select(ctx, "Run tests during this review?", ownBranch
		? [RUN_RELEVANT_TESTS, SKIP_TESTS, CHECK_COMMENTS] : [SKIP_TESTS, RUN_RELEVANT_TESTS, CHECK_COMMENTS]);
	if (tests === CHECK_COMMENTS) return { testExecution: "skip", action: "check" };
	const action = tests && await ui.select(ctx, "How should review findings be handled?", ownBranch
		? [FIX_LOCALLY, COMMENT_ON_PR] : [COMMENT_ON_PR, FIX_LOCALLY]);
	if (!tests || !action) {
		ctx.ui.notify("Review cancelled", "info");
		return undefined;
	}
	return { testExecution: tests === RUN_RELEVANT_TESTS ? "run" : "skip", action: action === FIX_LOCALLY ? "fix" : "comment" };
}

async function preparePullRequest(pr: PullRequest, cwd: string, remoteUrls: string | undefined): Promise<PreparedPullRequest> {
	const repository = `${pr.owner}/${pr.repo}`;
	const remoteUrl = remoteUrls?.split("\n").map((line) => line.trim().split(/\s+/).at(-1) ?? "").find((url) => {
		const match = url.match(/^(?:(?:https?|git|ssh):\/\/(?:git@)?github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
		return match?.[1]?.toLowerCase() === repository.toLowerCase();
	});
	if (!remoteUrl) throw new Error(`Open a checkout of ${repository} before reviewing this PR`);

	const metadata = JSON.parse(await runCommand("gh", ["api", "--hostname", "github.com", `repos/${repository}/pulls/${pr.number}`], cwd));
	const head = metadata.head?.sha;
	const baseSha = metadata.base?.sha;
	const baseRef = metadata.base?.ref;
	if (typeof head !== "string" || !/^[a-f0-9]{40}$/.test(head)
		|| typeof baseSha !== "string" || !/^[a-f0-9]{40}$/.test(baseSha) || typeof baseRef !== "string") {
		throw new Error("GitHub returned invalid PR commit metadata");
	}
	await runGit(["check-ref-format", `refs/heads/${baseRef}`], cwd);
	const currentHead = await runGit(["rev-parse", "HEAD"], cwd);
	// Untracked files alone do not make a checkout unsafe. Git will reject the
	// checkout below if the PR would overwrite one; never force or clean it.
	if (currentHead !== head && await runGit(["status", "--porcelain", "--untracked-files=no"], cwd)) {
		throw new Error("Commit or stash tracked local changes before checking out the PR branch");
	}

	const refRoot = `refs/remotes/pi-review/${repository}/pr-${pr.number}`;
	await runGit(["fetch", "--no-tags", remoteUrl,
		`+refs/pull/${pr.number}/head:${refRoot}/head`, `+refs/heads/${baseRef}:${refRoot}/base`], cwd);
	if (await runGit(["rev-parse", `${refRoot}/head`], cwd) !== head) {
		throw new Error("The PR changed while fetching; run /review again to review its latest commit");
	}
	const base = await runGit(["merge-base", baseSha, head], cwd);
	if (currentHead !== head) await runGit(["checkout", "--detach", head], cwd);
	return { ...pr, head, base, cwd };
}

function parseFindings(reviewText: string): string[] {
	const severity = "Critical|High|Medium|Low|Nit";
	const headingPattern = new RegExp(`^###\\s+\\[(${severity})\\][^\\n]*(?:\\n(?!###\\s+\\[(?:${severity})\\]).*)*`, "gim");
	const headingMatches = reviewText.match(headingPattern)?.map((finding) => finding.trim()).filter(Boolean) ?? [];
	if (headingMatches.length > 0) return headingMatches;

	const bulletPattern = new RegExp(`^(?:[-*]|\\d+\\.)\\s+(?:\\*\\*)?(?:${severity})(?:\\*\\*)?[:\\s-].*(?:\\n(?![-*]\\s+(?:(?:\\*\\*)?(?:${severity})(?:\\*\\*)?[:\\s-])|\\d+\\.\\s+(?:(?:\\*\\*)?(?:${severity})(?:\\*\\*)?[:\\s-])).*)*`, "gim");
	return reviewText.match(bulletPattern)?.map((finding) => finding.trim()).filter(Boolean) ?? [];
}

function chooseFindingAction(ctx: ExtensionContext, ui: ReviewUI, finding: string, index: number, total: number, action: ReviewAction = "fix"): Promise<string | null | undefined> {
	const question = action === "comment" ? "Post an inline thread on the PR for this issue?" : "Generate a fix for this issue?";
	const prompt = `Finding ${index + 1}/${total}\n\n${finding}\n\n${question}`;
	const terminal = (signal: AbortSignal) => ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		let finished = false;
		const finish = (value: string | null) => {
			if (finished) return;
			finished = true;
			signal.removeEventListener("abort", cancel);
			done(value);
		};
		const cancel = () => finish(null);
		signal.addEventListener("abort", cancel, { once: true });
		if (signal.aborted) cancel();
		const container = new Container();
		const choices = new SelectList(
			[
				{ value: "yes", label: "yes" },
				{ value: "no", label: "no" },
			],
			2,
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		);
		choices.onSelect = (choice) => finish(choice.value);
		choices.onCancel = cancel;

		container.addChild(new Text(theme.fg("accent", `Finding ${index + 1}/${total}`), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(finding, 0, 0, getMarkdownTheme()));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("text", question), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(choices);

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				choices.handleInput(data);
				tui.requestRender();
			},
			handleMouse: (event) => choices.handleMouse(event),
			dispose: () => signal.removeEventListener("abort", cancel),
		};
	});
	return ui.decide(ctx, {
		kind: "select", title: `Finding ${index + 1}/${total}`,
		detail: `${finding}\n\n${question}`, options: ["yes", "no"], data: { markdown: true },
	}, (signal) => ctx.mode === "tui" ? terminal(signal) : ctx.ui.select(prompt, ["yes", "no"], { signal }));
}

type ReviewState =
	| { mode: "idle" }
	| { mode: "awaiting-check"; pullRequest: PreparedPullRequest; threads: CommentThread[]; context: CommentThread[]; assessments: Assessment[]; index: number; identity: string; interrupted?: boolean }
	| { mode: "check-interaction" }
	| { mode: "awaiting-review"; testExecution: TestExecution; pullRequest?: PreparedPullRequest; interrupted?: boolean }
	| { mode: "review-interaction"; findings: string[]; index: number }
	| { mode: "awaiting-fix-validation"; findings: string[]; index: number };

export default function (pi: ExtensionAPI) {
	let state: ReviewState = { mode: "idle" };
	let current: ExtensionContext | undefined;
	let preparing = false;
	let reviewUI = new ReviewUI();
	pi.on("session_start", async (_event, ctx) => {
		reviewUI.dispose(); reviewUI = new ReviewUI();
		current = ctx; state = { mode: "idle" }; preparing = false;
	});
	pi.on("session_shutdown", () => { reviewUI.dispose(); current = undefined; state = { mode: "idle" }; });

	async function processPullRequestFindings(ctx: ExtensionContext, findings: string[], pr: PreparedPullRequest): Promise<void> {
		const ui = reviewUI;
		if (!ui.available(ctx)) {
			state = { mode: "idle" };
			ctx.ui.notify("PR comments were not posted: interactive finding selection is required", "info");
			return;
		}
		const selected: string[] = [];
		for (let index = 0; index < findings.length; index++) {
			let display = findings[index]!;
			try {
				const inline = parseInlineFinding(display);
				display = `${inline.body}\n\nInline thread: ${inline.path}:${inline.line} (${inline.side})`;
			} catch (error) {
				display += `\n\nCannot publish inline: ${error instanceof Error ? error.message : String(error)}. Select no to skip; selecting yes will prevent publication of the entire batch.`;
			}
			const choice = await chooseFindingAction(ctx, ui, display, index, findings.length, "comment");
			if (ui.isDisposed) return;
			if (!choice) {
				state = { mode: "idle" };
				ctx.ui.notify("Review cancelled; no PR comments sent", "info");
				return;
			}
			if (choice === "yes") selected.push(findings[index]!);
		}
		let posted = 0;
		let submitting = false;
		try {
			if (selected.length > 0) {
				const inlineFindings = selected.map(parseInlineFinding);
				await validateInlineFindings(runCommand, pr, inlineFindings);
				// Collect and validate every decision first, then create one thread per issue.
				for (const finding of inlineFindings) {
					if (ui.isDisposed) return;
					submitting = true;
					await postInlineFinding(runCommand, pr, finding);
					posted++;
				}
				if (ui.isDisposed) return;
				ctx.ui.notify(`Posted ${posted} separate inline PR thread(s) on ${pr.url}`, "info");
			} else {
				ctx.ui.notify("No PR comments selected; nothing sent", "info");
			}
		} catch (error) {
			if (ui.isDisposed) return;
			const detail = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(submitting
				? `Could not confirm PR comment ${posted + 1}/${selected.length}: ${detail}. ${posted} comment(s) confirmed posted as inline threads; subsequent comments were not attempted. Check the PR before retrying.`
				: `Could not prepare inline PR threads: ${detail}. No PR comments sent; nothing was published.`, "error");
		} finally {
			if (!ui.isDisposed) state = { mode: "idle" };
		}
	}

	async function processNextFinding(ctx: ExtensionContext, findings: string[], startIndex: number): Promise<void> {
		const ui = reviewUI;
		if (!ui.available(ctx)) {
			state = { mode: "idle" };
			return;
		}

		let index = startIndex;
		while (index < findings.length) {
			const finding = findings[index]!;
			const choice = await chooseFindingAction(ctx, ui, finding, index, findings.length);
			if (ui.isDisposed) return;

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
		const ui = reviewUI;
		if (!ui.available(ctx)) {
			state = { mode: "idle" };
			return;
		}

		while (true) {
			const choice = await ui.select(ctx, `Fix validation ${index + 1}/${findings.length}`, ["ok", "iterate with a prompt"]);
			if (ui.isDisposed) return;
			if (!choice || choice === "ok") {
				await processNextFinding(ctx, findings, index + 1);
				return;
			}

			if (choice === "iterate with a prompt") {
				const prompt = await ui.editor(ctx, "Iteration prompt for the fix");
				if (ui.isDisposed) return;
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

	pi.on("tool_call", (event) => {
		if (state.mode === "awaiting-check") {
			if (event.toolName === "read") return;
			const command = isToolCallEventType("bash", event) ? event.input.command : undefined;
			// Limit shell access to committed-snapshot inspection. Even a shell
			// fallback must not publish on GitHub or alter the working tree.
			if (command && /^git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))?\s+(?:show|diff|log|ls-tree|cat-file|rev-parse)\s/.test(command)
				&& !/[;|&<>`$\n\r]/.test(command)
				&& !/--(?:output|ext-diff|textconv|no-index|filters)\b/.test(command.replace(/['"\\]/g, ""))) return;
			return { block: true, reason: "Comment checking is read-only: use read or a single git show/diff/log/ls-tree/cat-file/rev-parse command. No tests, mutations, or GitHub actions." };
		}
		if (state.mode !== "awaiting-review") return;
		if (state.pullRequest && (event.toolName === "edit" || event.toolName === "write")) {
			return { block: true, reason: "PR comment mode is read-only. Do not apply local fixes." };
		}
		if (state.testExecution === "run") return;

		const command = isToolCallEventType("bash", event)
			? event.input.command
			: isToolCallEventType("powershell", event)
				? event.input.command
				: undefined;
		if (!command || !isTestRunnerCommand(command)) return;

		return {
			block: true,
			reason: "Test execution was disabled for this review. Inspect tests or recommend validation instead of running test commands.",
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		const ui = reviewUI;
		try {
			// Wait for the whole run so dialogs cannot interrupt commentary or tool calls.
			const message = [...event.messages].reverse().find((message) => message.role === "assistant");
			if (!message || message.role !== "assistant") return;
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				// Preserve the review for an agent retry, but allow an explicit /review restart.
				if (state.mode === "awaiting-review" || state.mode === "awaiting-check") state = { ...state, interrupted: true };
				return;
			}
			if (message.stopReason === "toolUse") return;
			const text = extractAssistantText(message);
			if (!text) return;

			if (state.mode === "awaiting-check") {
				const check = state;
				try {
					check.assessments.push(parseAssessment(text, check.threads[check.index]!));
					check.index++;
					if (check.index < check.threads.length) {
						pi.sendUserMessage(`${check.identity}\n${checkPrompt(check.pullRequest, check.threads[check.index]!, check.context, check.index, check.threads.length)}`, { deliverAs: "followUp" });
						return;
					}
					state = { mode: "check-interaction" };
					await processCommentCheck(ctx, ui, check);
				} catch (error) {
					if (!ui.isDisposed) {
						state = { mode: "idle" };
						ctx.ui.notify(`Comment check stopped: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}
				return;
			}

			if (state.mode === "awaiting-review") {
				const pullRequest = state.pullRequest;
				const findings = parseFindings(text);
				if (findings.length === 0) {
					state = { mode: "idle" };
					if (ctx.hasUI) ctx.ui.notify("No structured review findings to process; see the assistant response", "info");
					return;
				}

				state = { mode: "review-interaction", findings, index: 0 };
				if (pullRequest) await processPullRequestFindings(ctx, findings, pullRequest);
				else await processNextFinding(ctx, findings, 0);
				return;
			}

			if (state.mode === "awaiting-fix-validation") {
				await validateFix(ctx, state.findings, state.index);
			}
		} finally {
			if (!ui.isDisposed && state.mode === "idle" && !preparing) ui.status(ctx.isIdle() ? "idle" : "busy");
		}
	});

	async function generateCommentCheck(ctx: ExtensionContext, ui: ReviewUI, cwd: string, pr?: PullRequest, justMe = false): Promise<void> {
		if (!ui.available(ctx)) {
			ctx.ui.notify("Checking comments requires an interactive UI to validate replies and resolution actions", "warning");
			return;
		}
		if (!pr) {
			const url = await ui.input(ctx, "GitHub PR URL", "https://github.com/owner/repo/pull/123");
			if (!url?.trim() || ui.isDisposed) { ctx.ui.notify("Comment check cancelled", "info"); return; }
			pr = parsePullRequest(url);
		}
		if (!justMe) {
			const scope = await ui.select(ctx, "Whose comments should be checked?", [ALL_COMMENTS, JUST_ME]);
			if (!scope || ui.isDisposed) { ctx.ui.notify("Comment check cancelled", "info"); return; }
			justMe = scope === JUST_ME;
		}
		const remoteUrls = await tryGit(["config", "--get-regexp", "^remote\\..*\\.url$"], cwd);
		if (ui.isDisposed) return;
		const pullRequest = await preparePullRequest(pr, cwd, remoteUrls);
		if (ui.isDisposed) return;
		let login: string | undefined;
		try { login = await currentGitLogin(runCommand, pullRequest); }
		catch (error) {
			if (justMe) throw error;
			ctx.ui.notify("GitHub identity could not be mapped from Git; checking all authors without assuming which comments are yours", "warning");
		}
		const context = await loadCommentThreads(runCommand, pullRequest);
		// A thread belongs to its initial author, not every participant replying.
		const threads = justMe && login ? context.filter((thread) => thread.comments[0]!.author.toLowerCase() === login.toLowerCase()) : context;
		if (ui.isDisposed) return;
		if (!threads.length) { ctx.ui.notify("No matching PR comments to check", "info"); return; }
		const gitEmail = await tryGit(["config", "user.email"], cwd);
		const gitName = await tryGit(["config", "user.name"], cwd);
		if (ui.isDisposed) return;
		const identity = `Current Git user: ${gitName ?? "unknown"} <${gitEmail ?? "unknown"}>${login ? `; GitHub @${login}` : "; GitHub identity unknown: do not assume any comment author is the current user"}. Checking ${threads.length} comments (including resolved threads).`;
		state = { mode: "awaiting-check", pullRequest, threads, context, assessments: [], index: 0, identity };
		ctx.ui.notify(`Checking ${threads.length} PR comment(s)${justMe ? ` opened by @${login}` : " from all authors"}…`, "info");
		pi.sendUserMessage(`${identity}\n${checkPrompt(pullRequest, threads[0]!, context, 0, threads.length)}`);
	}

	async function processCommentCheck(ctx: ExtensionContext, ui: ReviewUI, check: Extract<ReviewState, { mode: "awaiting-check" }>): Promise<void> {
		const selected = await chooseCommentActions(ctx, ui, check.threads, check.assessments);
		if (ui.isDisposed) return;
		if (!selected) {
			state = { mode: "idle" };
			ctx.ui.notify("Comment check cancelled; no GitHub actions sent", "info");
			return;
		}
		let completed = 0;
		try {
			if (selected.length) {
				// Reject stale assessments rather than resolving a thread that gained
				// replies or changed state while the user was choosing actions.
				const latest = JSON.parse(await runCommand("gh", ["api", "--hostname", "github.com", `repos/${check.pullRequest.owner}/${check.pullRequest.repo}/pulls/${check.pullRequest.number}`], check.pullRequest.cwd));
				if (latest.head?.sha !== check.pullRequest.head) throw new Error("PR head changed; run /review check again");
				const refreshed = await loadCommentThreads(runCommand, check.pullRequest);
				if (JSON.stringify(refreshed) !== JSON.stringify(check.context)) throw new Error("PR comments or resolution state changed; run /review check again");
				for (const action of selected) {
					if (ui.isDisposed) return;
					await publishCommentAction(runCommand, check.pullRequest, action);
					completed++;
				}
			}
			if (!ui.isDisposed) ctx.ui.notify(`Comment check completed: ${completed} action(s) confirmed`, "info");
		} catch (error) {
			if (!ui.isDisposed) ctx.ui.notify(`Comment actions stopped: ${error instanceof Error ? error.message : String(error)}. ${completed}/${selected.length} action(s) confirmed; an action can partially succeed (reply sent but unresolve failed). Check the PR before retrying; no automatic retry.`, "error");
		} finally {
			if (!ui.isDisposed) state = { mode: "idle" };
		}
	}

	async function generateReview(ctx: ExtensionContext, args: string, ui: ReviewUI): Promise<void> {
		let workspaceRoot: string;
		try {
			workspaceRoot = await runGit(["rev-parse", "--show-toplevel"], ctx.cwd);
		} catch {
			ctx.ui.notify("Not inside a git repository", "warning");
			return;
		}

		const checkCommand = args.trim().match(/^check(?:\s|$)/i);
		if (checkCommand) {
			const rest = args.trim().slice(5).trim();
			const justMe = /(?:^|\s)--just-me$/.test(rest);
			const value = justMe ? rest.replace(/(?:^|\s)--just-me$/, "").trim() : rest;
			await generateCommentCheck(ctx, ui, workspaceRoot, value ? parsePullRequest(value) : undefined, justMe);
			return;
		}
		let pr: PullRequest | undefined;
		if (args.trim()) pr = parsePullRequest(args);
		const options = pr ? { testExecution: "skip" as const, action: "comment" as const } : await chooseReviewOptions(ctx, ui);
		if (!options) return;
		if (options.action === "check") {
			await generateCommentCheck(ctx, ui, workspaceRoot);
			return;
		}
		const { testExecution } = options;
		if (options.action === "comment" && !pr) {
			const url = await ui.input(ctx, "GitHub PR URL", "https://github.com/owner/repo/pull/123");
			if (!url?.trim()) {
				ctx.ui.notify("Review cancelled", "info");
				return;
			}
			pr = parsePullRequest(url);
		}
		const remoteUrls = await tryGit(["config", "--get-regexp", "^remote\\..*\\.url$"], workspaceRoot);
		const pullRequest = pr ? await preparePullRequest(pr, workspaceRoot, remoteUrls) : undefined;
		const [branch, base] = await Promise.all([
			runGit(["branch", "--show-current"], workspaceRoot),
			pullRequest ? Promise.resolve(pullRequest.base) : resolveBaseRef(workspaceRoot),
		]);
		if (!base) {
			ctx.ui.notify("Could not determine a baseline branch for the committed-range review", "warning");
			return;
		}

		const head = pullRequest?.head ?? "HEAD";
		const [commitLog, branchNameStatus, branchStat, branchDiff, stagedNameStatus, stagedStat, stagedDiff] = await Promise.all([
			runGit(["log", "--no-merges", "--format=%h %s%n%b", `${base}..${head}`], workspaceRoot),
			runGit(["diff", "--name-status", base, head], workspaceRoot),
			runGit(["diff", "--stat", "--no-color", base, head], workspaceRoot),
			runGit(["diff", "--no-color", "--find-renames", "--find-copies", "--diff-algorithm=histogram", base, head], workspaceRoot),
			pullRequest ? Promise.resolve("") : runGit(["diff", "--cached", "--name-status"], workspaceRoot),
			pullRequest ? Promise.resolve("") : runGit(["diff", "--cached", "--stat", "--no-color"], workspaceRoot),
			pullRequest ? Promise.resolve("") : runGit(["diff", "--cached", "--no-color", "--find-renames", "--find-copies", "--diff-algorithm=histogram"], workspaceRoot),
		]);

		const renderedBranchDiff = renderDiffByFile(branchDiff, "[No committed branch changes]");
		const renderedStagedDiff = renderDiffByFile(stagedDiff, "[No staged changes]");
		const datadogAgentWorkspace = isDatadogAgentRepository(remoteUrls);

		const prompt = [
			pullRequest ? `Perform a code review of ${pullRequest.url} at commit ${pullRequest.head}, relative to its PR merge base.`
				: "Perform a code review of committed branch changes relative to the baseline and staged index changes.",
			pullRequest ? "Scope boundary: review only the supplied committed PR range. Staged, unstaged, and untracked changes are excluded. Read committed file snapshots rather than working-tree files."
				: "Scope boundary: base the review only on the committed range and staged changes supplied below. Do not inspect, mention, or draw conclusions from unstaged or untracked working-tree changes; they are intentionally excluded.",
			pullRequest ? "PR comment mode: do not modify local files or post anything to GitHub. The extension will ask the user which findings to publish as separate inline review threads after all decisions. Never use general PR comments as a fallback."
				: "Staged changes are applied on top of the current branch HEAD.",
			testExecution === "run"
				? "Test execution is requested: determine and run every test relevant to the in-scope changes. Do not substitute unrelated broad tests for relevant focused coverage."
				: "Test execution is intentionally disabled because this branch was already validated in CI. Do not run test runners or test scripts; you may inspect test files and recommend validation.",
			"Analyze the in-scope changes for:",
			"- bugs and correctness issues",
			"- regressions or behavior changes",
			"- performance problems",
			"- security or data-loss risks",
			"- maintainability, test coverage, and other relevant concerns",
			GENERAL_REVIEW_QUALITY,
			datadogAgentWorkspace ? "" : undefined,
			datadogAgentWorkspace ? "Datadog Agent workspace detected:" : undefined,
			datadogAgentWorkspace ? DATADOG_AGENT_OBSERVABILITY_REVIEW : undefined,
			datadogAgentWorkspace ? DATADOG_AGENT_SECURITY_REVIEW : undefined,
			"",
			"Output requirements:",
			"- Sort findings by criticality: Critical, High, Medium, Low, Nit.",
			"- Use one third-level heading per finding, exactly in this format: ### [Severity] Short title.",
			"- For each finding, include affected file(s) and line(s) when they can be inferred, concrete evidence, impact, confidence (High/Medium/Low), trigger or preconditions, a recommended fix when possible, and specific validation.",
			pullRequest ? '- Inside every finding, include exactly one inline location marker: <!-- pi-review-inline {"path":"relative/file.go","line":123,"side":"RIGHT"} -->. Use an exact repository-relative path from the PR diff, one positive line number, and RIGHT for additions/context or LEFT for deleted lines (old-side line number). For renamed files use the destination path on either side. Select the most relevant commentable line in a diff hunk; do not invent a line outside the diff or choose an unrelated line just to allow publication. The marker is removed before posting. Findings without a valid anchor cannot be published; explain any such limitation.' : undefined,
			"- Label applicable findings with one or more of: false negative, false positive, event loss, privilege/security boundary, performance under load.",
			"- Do not rate a speculative concern Critical or High without concrete evidence and a plausible execution path.",
			"- Do not apply fixes automatically. Leave the final decision to the user on a case-by-case basis.",
			"- If there are no substantial findings, say so clearly and mention any residual risks or missing validation.",
			"- Be concise but specific. Avoid generic praise.",
			testExecution === "run"
				? "- Report every test command run and its outcome. Clearly state any relevant tests that could not be run."
				: "- Do not report unrun tests as a failure; state only validation that you recommend.",
			renderedBranchDiff.truncated || renderedStagedDiff.truncated
				? "- Some per-file diffs are truncated or omitted after prioritization; explicitly mention that the review may be incomplete and name any relevant unreviewed files from the exhaustive file lists."
				: undefined,
			"",
			`Workspace root: ${workspaceRoot}`,
			`Current branch: ${branch || "detached HEAD"}`,
			`Baseline commit: ${base}`,
			"",
			"Branch commits since baseline:",
			"```",
			commitLog || "[No branch commits found]",
			"```",
			"",
			"Committed branch change surface:",
			summarizeChangeSurface(branchNameStatus, branchDiff, "[No committed branch changes]"),
			"",
			"Committed branch changes - exhaustive file list:",
			"```",
			branchNameStatus || "[No committed branch changes]",
			"```",
			"",
			"Committed branch changes - stat:",
			"```",
			branchStat || "[No committed branch changes]",
			"```",
			"",
			"Committed branch changes - per-file diff (prioritized):",
			"```diff",
			renderedBranchDiff.text,
			"```",
			"",
			"Staged change surface:",
			summarizeChangeSurface(stagedNameStatus, stagedDiff, "[No staged changes]"),
			"",
			"Staged changes - exhaustive file list:",
			"```",
			stagedNameStatus || "[No staged changes]",
			"```",
			"",
			"Staged changes - stat:",
			"```",
			stagedStat || "[No staged changes]",
			"```",
			"",
			"Staged changes - per-file diff (prioritized):",
			"```diff",
			renderedStagedDiff.text,
			"```",
		]
			.filter((line): line is string => line !== undefined)
			.join("\n");

		if (ui.isDisposed) return;
		ctx.ui.notify(pullRequest ? "Generating PR review…" : "Generating code review for committed and staged changes…", "info");
		state = { mode: "awaiting-review", testExecution, pullRequest };
		pi.sendUserMessage(prompt);
	}

	async function runReview(ctx: ExtensionContext, args = ""): Promise<void> {
		if (!preparing && (state.mode === "awaiting-review" || state.mode === "awaiting-check") && state.interrupted) state = { mode: "idle" };
		if (preparing || state.mode !== "idle") {
			ctx.ui.notify("A review is already in progress", "warning");
			return;
		}
		const ui = reviewUI;
		preparing = true;
		ui.status("busy");
		try {
			await generateReview(ctx, args, ui);
		} catch (error) {
			if (ui.isDisposed) return;
			state = { mode: "idle" };
			ctx.ui.notify(`Could not start review: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			if (!ui.isDisposed) {
				preparing = false;
				ui.status(state.mode === "idle" && ctx.isIdle() ? "idle" : "busy");
			}
		}
	}
	pi.registerCommand("review", { description: "Review changes or check existing comments: /review check URL [--just-me]", handler: async (args, ctx) => { await ctx.waitForIdle(); await runReview(ctx, args); } });
	registerWebCommand("review", async (args) => {
		if (!current) return;
		if (!current.isIdle()) { current.ui.notify("Wait for the agent to finish before starting a review", "warning"); return; }
		await runReview(current, args);
	});
}
