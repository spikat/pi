import type { CheckPR } from "./comments.js";

type Run = (command: string, args: string[], cwd: string, input?: string) => Promise<string>;
export type InlineFinding = { body: string; path: string; line: number; side: "LEFT" | "RIGHT" };
const ANCHOR_PATTERN = /<!--\s*pi-review-inline\s+([\s\S]*?)-->/g;

/** Prefer explicit model metadata; never guess an anchor from arbitrary prose. */
export function parseInlineFinding(finding: string): InlineFinding {
	const markers = [...finding.matchAll(ANCHOR_PATTERN)];
	let location: any;
	if (markers.length) {
		if (markers.length !== 1) throw new Error("Each finding must have exactly one pi-review-inline location");
		try { location = JSON.parse(markers[0]![1]!); }
		catch { throw new Error("Invalid pi-review-inline JSON location"); }
	} else {
		// Compatibility with previous output: only a single explicit File: path:line
		// is accepted, on the new-code side. Deleted lines require LEFT metadata.
		const files = [...finding.matchAll(/^File:\s+([^:\n]+):([1-9]\d*)(?=[\s.,;]|$)/gm)];
		if (files.length !== 1) throw new Error("Missing or ambiguous inline location; include pi-review-inline path, line and side metadata");
		location = { path: files[0]![1]!.trim(), line: Number(files[0]![2]), side: "RIGHT" };
	}
	if (!location || typeof location.path !== "string" || !location.path.trim()
		|| location.path.startsWith("/") || /[\n\r\0]/.test(location.path) || location.path.split("/").some((part: string) => part === "..")
		|| !Number.isSafeInteger(location.line) || location.line < 1 || !["LEFT", "RIGHT"].includes(location.side)) {
		throw new Error("Invalid inline location: expected a repository-relative path, positive line number and LEFT/RIGHT side");
	}
	const body = finding.replace(ANCHOR_PATTERN, "").trim();
	if (!body) throw new Error("Empty inline comment body");
	return { body, path: location.path, line: location.line, side: location.side };
}

/** GitHub anchors deletions on LEFT, additions and context on RIGHT. */
export function commentableLines(patch: string): { LEFT: Set<number>; RIGHT: Set<number> } {
	const result = { LEFT: new Set<number>(), RIGHT: new Set<number>() };
	let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
	for (const line of patch.split("\n")) {
		const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
		if (hunk) {
			oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
			oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1);
		} else if (line.startsWith("-") && oldRemaining > 0) {
			result.LEFT.add(oldLine++); oldRemaining--;
		} else if (line.startsWith("+") && newRemaining > 0) {
			result.RIGHT.add(newLine++); newRemaining--;
		} else if (line.startsWith(" ") && oldRemaining > 0 && newRemaining > 0) {
			result.RIGHT.add(newLine++); oldLine++; oldRemaining--; newRemaining--;
		}
	}
	return result;
}

/** Validate the complete selected batch before sending any review comment. */
export async function validateInlineFindings(run: Run, pr: CheckPR, findings: InlineFinding[]): Promise<void> {
	const prefix = `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`;
	const api = async (endpoint: string) => JSON.parse(await run("gh", ["api", "--hostname", "github.com", endpoint], pr.cwd));
	const checkHead = async () => {
		if ((await api(prefix)).head?.sha !== pr.head) throw new Error("PR head changed; run /review again before posting inline threads");
	};
	await checkHead();
	const patches = new Map<string, ReturnType<typeof commentableLines>>();
	for (let page = 1; ; page++) {
		const files = await api(`${prefix}/files?per_page=100&page=${page}`);
		if (!Array.isArray(files)) throw new Error("GitHub returned an invalid PR file list");
		for (const file of files) {
			// Missing patches (e.g. binary/very large diffs) must never be invented.
			if (typeof file.filename === "string" && typeof file.patch === "string") patches.set(file.filename, commentableLines(file.patch));
		}
		if (files.length < 100) break;
	}
	for (let index = 0; index < findings.length; index++) {
		const finding = findings[index]!;
		if (!patches.get(finding.path)?.[finding.side].has(finding.line)) {
			throw new Error(`Selected finding ${index + 1}: ${finding.path}:${finding.line} (${finding.side}) is not a commentable line in the GitHub PR diff, or its patch is unavailable. No general-comment fallback.`);
		}
	}
	await checkHead();
}

export async function postInlineFinding(run: Run, pr: CheckPR, finding: InlineFinding): Promise<void> {
	// A new review comment with no in_reply_to creates its own resolvable thread.
	await run("gh", ["api", "--hostname", "github.com", "--method", "POST",
		`repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`, "--input", "-"], pr.cwd,
		JSON.stringify({ commit_id: pr.head, body: finding.body, path: finding.path, line: finding.line, side: finding.side }));
}
