import { isAbsolute, relative, resolve } from "node:path";

export type QueueItem = { id: string; text: string; receivedAt: number };
export type QueueState = { active?: QueueItem; pending: QueueItem[] };

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
