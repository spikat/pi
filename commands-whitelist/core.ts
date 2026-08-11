import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const CONFIG_VERSION = 2 as const;
export type Store = { version: 2; whitelist: string[]; blacklist: string[]; editDirectories: string[]; editFiles: string[] };
export const EMPTY_STORE: Store = { version: CONFIG_VERSION, whitelist: [], blacklist: [], editDirectories: [], editFiles: [] };
export type RuleState = "undecided" | "allow" | "deny";
export type CommandPart = { original: string; words: string[]; displayWords: string[]; dynamic: boolean; unsupported?: boolean; pythonScript?: boolean };

const CONTROL_WORDS = new Set(["then", "else", "elif", "fi", "do", "done", "in", "case", "esac", "{"]);
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function normalizeWord(word: string): string {
	return word.replace(/^\.\//, "");
}

/** A deliberately conservative lexer: unsupported syntax is returned to the caller for global approval. */
export function shellWords(source: string): { words: string[]; dynamic: boolean } | undefined {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let dynamic = false;
	let escaped = false;
	for (let i = 0; i < source.length; i++) {
		const c = source[i]!;
		if (escaped) { current += c; escaped = false; continue; }
		if (c === "\\" && quote !== "'") { escaped = true; continue; }
		if ((c === "'" || c === '"') && !quote) { quote = c; continue; }
		if (c === quote) { quote = undefined; continue; }
		if (!quote && /\s/.test(c)) { if (current) { words.push(current); current = ""; } continue; }
		if (c === "$" && source[i + 1] !== "(" && source[i + 1] !== "{") dynamic = true;
		current += c;
	}
	if (quote || escaped) return undefined;
	if (current) words.push(current);
	return { words, dynamic };
}

function stripRedirections(source: string): string {
	let out = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let i = 0; i < source.length; i++) {
		const c = source[i]!;
		if (escaped) { out += c; escaped = false; continue; }
		if (c === "\\" && quote !== "'") { out += c; escaped = true; continue; }
		if ((c === "'" || c === '"') && !quote) { quote = c; out += c; continue; }
		if (c === quote) { quote = undefined; out += c; continue; }
		if (!quote && /[0-9]/.test(c) && (i === 0 || /\s/.test(source[i - 1]!)) && (source[i + 1] === ">" || source[i + 1] === "<")) {
			i++; while (i + 1 < source.length && /[>&]/.test(source[i + 1]!)) i++;
			while (i + 1 < source.length && /\s/.test(source[i + 1]!)) i++;
			while (i + 1 < source.length && !/\s|[|;&(){}]/.test(source[i + 1]!)) i++;
			continue;
		}
		if (!quote && (c === ">" || (c === "<" && source[i + 1] !== "("))) {
			while (i + 1 < source.length && /[>&]/.test(source[i + 1]!)) i++;
			while (i + 1 < source.length && /\s/.test(source[i + 1]!)) i++;
			while (i + 1 < source.length && !/\s|[|;&(){}]/.test(source[i + 1]!)) i++;
			continue;
		}
		out += c;
	}
	return out;
}

/** Splits shell lists while respecting quotes, escaped separators and nested $(...) / <(...). */
export function splitShellLists(command: string): string[] | undefined {
	const parts: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let depth = 0;
	for (let i = 0; i < command.length; i++) {
		const c = command[i]!; const next = command[i + 1];
		if (escaped) { current += c; escaped = false; continue; }
		if (c === "\\" && quote !== "'") { current += c; escaped = true; continue; }
		if ((c === "'" || c === '"') && !quote) { quote = c; current += c; continue; }
		if (c === quote) { quote = undefined; current += c; continue; }
		if (!quote && (c === "(" || c === "{")) { depth++; current += c; continue; }
		if (!quote && (c === ")" || c === "}")) { if (depth === 0) return undefined; depth--; current += c; continue; }
		if (!quote && depth === 0 && (c === "|" || c === ";" || c === "&" || c === "\n")) {
			if (current.trim()) parts.push(current.trim());
			current = "";
			if ((c === "|" && (next === "|" || next === "&")) || (c === "&" && next === "&")) i++;
			continue;
		}
		current += c;
	}
	if (quote || escaped || depth !== 0) return undefined;
	if (current.trim() && !current.trim().startsWith("#")) parts.push(current.trim());
	return parts;
}

function nestedExpressions(source: string): string[] | undefined {
	const nested: string[] = [];
	for (let i = 0; i < source.length; i++) {
		if (source[i] !== "$" && !(source[i] === "<" && source[i + 1] === "(")) continue;
		const start = source[i] === "$" ? i + 1 : i + 1;
		if (source[start] !== "(") continue;
		let depth = 1; let quote: "'" | '"' | undefined; let escaped = false; let j = start + 1;
		for (; j < source.length && depth; j++) {
			const c = source[j]!;
			if (escaped) { escaped = false; continue; }
			if (c === "\\" && quote !== "'") { escaped = true; continue; }
			if ((c === "'" || c === '"') && !quote) { quote = c; continue; }
			if (c === quote) { quote = undefined; continue; }
			if (!quote && c === "(") depth++;
			if (!quote && c === ")") depth--;
		}
		if (depth || quote) return undefined;
		nested.push(source.slice(start + 1, j - 1)); i = j - 1;
	}
	return nested;
}

function ruleWords(words: string[], dynamic: boolean): string[] {
	let index = 0;
	while (SHELL_ASSIGNMENT.test(words[index] ?? "")) index++;
	const kept = words.slice(index).map(normalizeWord);
	if (!kept.length) return [];
	const dynamicIndex = dynamic ? kept.findIndex((word) => word.includes("$")) : -1;
	if (dynamicIndex >= 0) return [...kept.slice(0, dynamicIndex), "*"];
	return [...kept, "*"];
}

function isPythonScript(words: string[]): boolean {
	const executable = words[0]?.split("/").at(-1) ?? "";
	if (!/^python(?:\d+(?:\.\d+)*)?$/.test(executable)) return false;
	// A Python source file is an opaque program boundary. Python -c/-m remains a
	// regular shell invocation because it does not launch a script path.
	return words.some((word) => word.endsWith(".py"));
}

function shellCContent(words: string[]): string | undefined {
	const flag = words.indexOf("-c");
	return flag >= 0 ? words[flag + 1] : undefined;
}

export function analyseShell(command: string): { parts: CommandPart[]; unsupported: boolean } {
	if (/\b(function\s+[A-Za-z_]|[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{)/.test(command)) return { parts: [{ original: command, words: [], displayWords: [command, "*"], dynamic: false, unsupported: true }], unsupported: true };
	const lists = splitShellLists(command);
	if (!lists) return { parts: [{ original: command, words: [], displayWords: [command, "*"], dynamic: false, unsupported: true }], unsupported: true };
	const parts: CommandPart[] = [];
	for (const original of lists) {
		const trimmed = original.trim();
		if ((trimmed.startsWith("(") && trimmed.endsWith(")")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
			const inner = trimmed.slice(1, -1).replace(/;\s*$/, "");
			const result = analyseShell(inner);
			if (result.unsupported) return result;
			parts.push(...result.parts);
			continue;
		}
		const clean = stripRedirections(original).trim();
		const parsed = shellWords(clean);
		if (!parsed || !parsed.words.length) return { parts: [{ original: command, words: [], displayWords: [command, "*"], dynamic: false, unsupported: true }], unsupported: true };
		const first = parsed.words[0]!;
		const pythonScript = isPythonScript(parsed.words);
		if (!CONTROL_WORDS.has(first) && first !== "for" && first !== "while" && first !== "if" && first !== "case") {
			const displayWords = ruleWords(parsed.words, parsed.dynamic);
			if (displayWords.length) parts.push({ original, words: parsed.words, displayWords, dynamic: parsed.dynamic, pythonScript });
		}
		// A Python file is intentionally opaque: do not recursively inspect shell-like
		// text in arguments or attempt to reason about the script it will execute.
		if (pythonScript) continue;
		const nested = nestedExpressions(original);
		if (!nested) return { parts: [{ original: command, words: [], displayWords: [command, "*"], dynamic: false, unsupported: true }], unsupported: true };
		for (const content of nested) {
			const result = analyseShell(content);
			if (result.unsupported) return result;
			parts.push(...result.parts);
		}
		const shellContent = shellCContent(parsed.words);
		if (shellContent !== undefined) {
			const result = analyseShell(shellContent);
			if (result.unsupported) return result;
			parts.push(...result.parts);
		}
	}
	return { parts, unsupported: false };
}

export function ruleFor(part: CommandPart, argumentCount: number): string {
	const words = part.displayWords.filter((word) => word !== "*");
	return [...words.slice(0, Math.max(1, argumentCount + 1)), "*"].join(" ");
}

export function normalizeRule(text: string): string | undefined {
	const parsed = shellWords(text.trim());
	if (!parsed?.words.length) return undefined;
	const stars = parsed.words.filter((word) => word === "*");
	if (stars.length > 1 || (stars.length === 1 && parsed.words.at(-1) !== "*")) return undefined;
	const words = parsed.words.filter((word) => word !== "*").map(normalizeWord);
	return [...words, "*"].join(" ");
}

export function matchesRule(rule: string, part: CommandPart): boolean {
	const ruleWords = normalizeRule(rule)?.split(" ");
	if (!ruleWords) return false;
	const actual = part.displayWords.filter((word) => word !== "*");
	return ruleWords.slice(0, -1).every((word, index) => actual[index] === word);
}

export function classification(store: Store, part: CommandPart): RuleState {
	if (store.blacklist.some((rule) => matchesRule(rule, part))) return "deny";
	if (store.whitelist.some((rule) => matchesRule(rule, part))) return "allow";
	return "undecided";
}

function isStore(value: unknown): value is Store {
	if (!value || typeof value !== "object") return false;
	const s = value as Record<string, unknown>;
	return s.version === 2 && ["whitelist", "blacklist", "editDirectories", "editFiles"].every((key) => Array.isArray(s[key]) && (s[key] as unknown[]).every((item) => typeof item === "string"));
}

export async function loadStore(path: string): Promise<Store> {
	if (!existsSync(path)) return { ...EMPTY_STORE, whitelist: [], blacklist: [], editDirectories: [], editFiles: [] };
	const raw = await readFile(path, "utf8");
	let value: unknown;
	try { value = JSON.parse(raw); } catch { throw new Error(`commands whitelist: invalid JSON in ${path}`); }
	if (value && typeof value === "object" && !("version" in value)) { await rm(path); return { ...EMPTY_STORE, whitelist: [], blacklist: [], editDirectories: [], editFiles: [] }; }
	const version = value && typeof value === "object" ? (value as { version?: unknown }).version : undefined;
	if (typeof version === "number" && version < CONFIG_VERSION) { await rm(path); return { ...EMPTY_STORE, whitelist: [], blacklist: [], editDirectories: [], editFiles: [] }; }
	if (!isStore(value)) throw new Error(`commands whitelist: unsupported or malformed configuration in ${path}`);
	return { ...value, whitelist: [...new Set(value.whitelist)], blacklist: [...new Set(value.blacklist)], editDirectories: [...new Set(value.editDirectories)], editFiles: [...new Set(value.editFiles)] };
}

export async function saveStore(path: string, store: Store): Promise<void> {
	const normalized: Store = { version: 2, whitelist: [...new Set(store.whitelist)], blacklist: [...new Set(store.blacklist)], editDirectories: [...new Set(store.editDirectories)], editFiles: [...new Set(store.editFiles)] };
	if (normalized.whitelist.some((r) => normalized.blacklist.includes(r))) throw new Error("commands whitelist: identical whitelist and blacklist rule");
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
	await rename(temp, path);
}
