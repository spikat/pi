import { isAbsolute, relative, resolve } from "node:path";

export type QueueItem = { id: string; text: string; receivedAt: number };
export type QueueState = { active?: QueueItem; pending: QueueItem[] };

export const HISTORY_PROMPT_LIMIT = 3;
export const HISTORY_MAX_ENTRIES = 64;
export const HISTORY_MAX_CHARS = 512 * 1024;
export const HISTORY_ENTRY_MAX_CHARS = 64 * 1024;
const TRANSPORT_MAX_DEPTH = 8;
const TRANSPORT_MAX_ITEMS = 100;
const TRANSPORT_MAX_NODES = 1_000;
const TRANSPORT_TRUNCATION = "\n[Truncated for Pi Web]";

/** Keeps exactly one browser-originated item active per agent. */
export function enqueue(state: QueueState, item: QueueItem): QueueState {
	if (!state.active) return { active: item, pending: [...state.pending] };
	return { active: state.active, pending: [...state.pending, item] };
}

/** Marks the active item complete and advances the FIFO queue. */
export function advance(state: QueueState): QueueState {
	const [active, ...pending] = state.pending;
	return active ? { active, pending } : { pending: [] };
}

export function isSafeMarkdownPath(cwd: string, requestedPath: string): boolean {
	if (!requestedPath || !requestedPath.toLowerCase().endsWith(".md")) return false;
	const target = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(cwd, requestedPath);
	const rel = relative(resolve(cwd), target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveMarkdownPath(cwd: string, requestedPath: string): string | undefined {
	return isSafeMarkdownPath(cwd, requestedPath)
		? (isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(cwd, requestedPath))
		: undefined;
}

export function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Creates a JSON-safe, size-bounded copy before sending session data to the browser. */
export function compactForTransport(value: unknown, maxChars: number): unknown {
	let remaining = Math.max(0, maxChars);
	let nodes = 0;
	const seen = new WeakSet<object>();
	const text = (source: string): string => {
		if (source.length <= remaining) { remaining -= source.length; return source; }
		if (!remaining) return "";
		const length = Math.max(0, remaining - TRANSPORT_TRUNCATION.length);
		remaining = 0;
		return `${source.slice(0, length)}${TRANSPORT_TRUNCATION}`;
	};
	const truncated = () => text(TRANSPORT_TRUNCATION);
	const copy = (candidate: unknown, depth: number): unknown => {
		if (++nodes > TRANSPORT_MAX_NODES) return truncated();
		if (typeof candidate === "string") return text(candidate);
		if (candidate === null || typeof candidate === "boolean" || typeof candidate === "number") return candidate;
		if (typeof candidate === "bigint") return text(candidate.toString());
		if (candidate === undefined) return undefined;
		if (typeof candidate !== "object") return text(String(candidate));
		if (depth >= TRANSPORT_MAX_DEPTH) return truncated();
		if (seen.has(candidate)) return text("[Circular]");
		seen.add(candidate);
		if (Array.isArray(candidate)) {
			const result = candidate.slice(0, TRANSPORT_MAX_ITEMS).map((item) => copy(item, depth + 1));
			if (candidate.length > TRANSPORT_MAX_ITEMS) result.push(truncated());
			return result;
		}
		const result: Record<string, unknown> = {};
		let count = 0;
		for (const key in candidate) {
			if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;
			if (count++ >= TRANSPORT_MAX_ITEMS || key.length > remaining) { result.__piWebTruncated = true; break; }
			remaining -= key.length;
			const copied = copy((candidate as Record<string, unknown>)[key], depth + 1);
			if (copied !== undefined) result[key] = copied;
		}
		return result;
	};
	return copy(value, 0);
}

/**
 * A deliberately small, safe Markdown renderer for local previews. It never accepts
 * HTML from the Markdown document and leaves unsupported syntax as escaped text.
 */
export function renderMarkdown(markdown: string): string {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let inCode = false;
	let code: string[] = [];
	let listOpen = false;
	const inline = (text: string): string => {
		let safe = escapeHtml(text);
		safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");
		safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
		safe = safe.replace(/\*([^*]+)\*/g, "<em>$1</em>");
		return safe.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noreferrer noopener" target="_blank">$1</a>');
	};
	const closeList = () => { if (listOpen) { out.push("</ul>"); listOpen = false; } };
	for (const line of lines) {
		if (line.startsWith("```")) {
			if (inCode) { out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`); code = []; }
			inCode = !inCode;
			continue;
		}
		if (inCode) { code.push(line); continue; }
		const heading = /^(#{1,6})\s+(.+)$/.exec(line);
		if (heading) { closeList(); const level = heading[1]!.length; out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`); continue; }
		const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
		if (bullet) { if (!listOpen) { out.push("<ul>"); listOpen = true; } out.push(`<li>${inline(bullet[1]!)}</li>`); continue; }
		closeList();
		if (!line.trim()) continue;
		out.push(`<p>${inline(line)}</p>`);
	}
	if (inCode) out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
	closeList();
	return out.join("\n");
}

export function stripSensitiveToken(url: string): string {
	const parsed = new URL(url);
	parsed.searchParams.delete("token");
	return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
