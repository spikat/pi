import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const CONFIG_VERSION = 2 as const;
export type Store = { version: 2; whitelist: string[]; blacklist: string[]; editDirectories: string[]; editFiles: string[] };
export const EMPTY_STORE: Store = { version: CONFIG_VERSION, whitelist: [], blacklist: [], editDirectories: [], editFiles: [] };
export type RuleState = "undecided" | "allow" | "deny";
export type RuleScope = "global" | "project";
export type ResolvedRule = { scope: RuleScope; state: "allow" | "deny"; rule: string };
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
	let substitutionDepth = 0;
	for (let i = 0; i < source.length; i++) {
		const c = source[i]!;
		if (escaped) { current += c; escaped = false; continue; }
		if (c === "\\" && quote !== "'") { escaped = true; continue; }
		if ((c === "'" || c === '"') && !quote) { quote = c; continue; }
		if (c === quote) { quote = undefined; continue; }
		if (!quote && c === "(" && (source[i - 1] === "$" || source[i - 1] === "<")) { substitutionDepth++; current += c; continue; }
		if (!quote && c === ")" && substitutionDepth > 0) { substitutionDepth--; current += c; continue; }
		if (!quote && substitutionDepth === 0 && /\s/.test(c)) { if (current) { words.push(current); current = ""; } continue; }
		if (c === "$" && source[i + 1] !== "(" && source[i + 1] !== "{") dynamic = true;
		current += c;
	}
	if (quote || escaped || substitutionDepth !== 0) return undefined;
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

function hereDocumentDelimiter(line: string): { delimiter: string; stripTabs: boolean } | undefined {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let i = 0; i < line.length - 1; i++) {
		const char = line[i]!;
		if (escaped) { escaped = false; continue; }
		if (char === "\\" && quote !== "'") { escaped = true; continue; }
		if ((char === "'" || char === '"') && !quote) { quote = char; continue; }
		if (char === quote) { quote = undefined; continue; }
		if (quote || char !== "<" || line[i + 1] !== "<" || line[i + 2] === "<") continue;
		let cursor = i + 2;
		const stripTabs = line[cursor] === "-";
		if (stripTabs) cursor++;
		while (/\s/.test(line[cursor] ?? "")) cursor++;
		if (!line[cursor]) return undefined;
		const quoted = line[cursor] === "'" || line[cursor] === '"' ? line[cursor++] : undefined;
		let delimiter = "";
		while (cursor < line.length && (quoted ? line[cursor] !== quoted : !/\s|[|;&(){}]/.test(line[cursor]!))) delimiter += line[cursor++]!;
		return delimiter ? { delimiter, stripTabs } : undefined;
	}
	return undefined;
}

/** Remove here-document bodies so their data cannot become fake shell commands. */
function removeHereDocumentBodies(command: string): string | undefined {
	const lines = command.split("\n");
	const output: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		output.push(line);
		const hereDoc = hereDocumentDelimiter(line);
		if (!hereDoc) continue;
		let found = false;
		while (++index < lines.length) {
			const rawCandidate = lines[index]!.replace(/\r$/, "");
			const candidate = hereDoc.stripTabs ? rawCandidate.replace(/^\t+/, "") : rawCandidate;
			if (candidate === hereDoc.delimiter) { found = true; break; }
			output.push("");
		}
		if (!found) return undefined;
	}
	return output.join("\n");
}

/** Splits shell lists while respecting quotes, escaped separators and nested $(...) / <(...). */
export function splitShellLists(command: string): string[] | undefined {
	const withoutHereDocBodies = removeHereDocumentBodies(command);
	if (withoutHereDocBodies === undefined) return undefined;
	command = withoutHereDocBodies;
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
		// A `#` at the beginning of a shell word comments out the rest of its
		// physical line. Skip it here, rather than allowing the comment to become
		// a standalone command when the following newline splits the shell list.
		if (!quote && c === "#" && (i === 0 || /[\s;|&]/.test(command[i - 1]!))) {
			while (i + 1 < command.length && command[i + 1] !== "\n") i++;
			continue;
		}
		if (!quote && (c === "(" || c === "{")) { depth++; current += c; continue; }
		if (!quote && (c === ")" || c === "}")) { if (depth === 0) return undefined; depth--; current += c; continue; }
		// `2>&1` is a redirection, not an asynchronous-command separator.
		const redirectionAmpersand = c === "&" && command[i - 1] === ">";
		if (!quote && depth === 0 && !redirectionAmpersand && (c === "|" || c === ";" || c === "&" || c === "\n")) {
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
		// `$((...))` is arithmetic expansion, not a command substitution. Its
		// contents must not create a fake command such as the `0` in `$((0))`.
		const arithmetic = source[i] === "$" && source[start + 1] === "(";
		let depth = arithmetic ? 2 : 1; let quote: "'" | '"' | undefined; let escaped = false; let j = start + (arithmetic ? 2 : 1);
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
		if (arithmetic) {
			const insideArithmetic = nestedExpressions(source.slice(start + 2, j - 2));
			if (!insideArithmetic) return undefined;
			nested.push(...insideArithmetic);
		} else nested.push(source.slice(start + 1, j - 1));
		i = j - 1;
	}
	return nested;
}

function ruleWords(words: string[], dynamic: boolean): string[] {
	let index = 0;
	while (SHELL_ASSIGNMENT.test(words[index] ?? "")) index++;
	let kept = words.slice(index).map(normalizeWord);
	// `[` is the POSIX spelling of the `test` builtin. Normalize it into a
	// meaningful command rule rather than exposing an invalid-looking `[ *`.
	if (kept[0] === "[") kept = ["test", ...kept.slice(1, kept.at(-1) === "]" ? -1 : undefined)];
	if (!kept.length) return [];
	const dynamicIndex = dynamic ? kept.findIndex((word) => word.includes("$")) : -1;
	// The command itself must always remain visible. A dynamic executable such as
	// "$PWD/node_modules/.bin/tsc" is therefore retained, while its remaining
	// arguments collapse to the terminal wildcard.
	if (dynamicIndex === 0) return [kept[0]!, "*"];
	if (dynamicIndex > 0) return [...kept.slice(0, dynamicIndex), "*"];
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
	if (flag < 0) return undefined;
	const content = words[flag + 1];
	if (!content) return undefined;
	const executable = words[0]?.split("/").at(-1) ?? "";
	// `-c` is widely used by non-shell programs: `wc -c`, `stat -c`, and
	// `rg -c 'foo|bar'` are all ordinary command arguments. Only recurse when
	// the executable itself is a recognized shell; shell-like syntax in an
	// arbitrary argument is not enough to prove that it will be executed.
	const knownShell = /(?:^|[-_.])(ba|z|da|k|mk|tc)?sh$|^(?:bash|zsh|dash|fish|shell)$/i.test(executable);
	return knownShell ? content : undefined;
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
		let parsed = shellWords(clean);
		if (!parsed || !parsed.words.length) return { parts: [{ original: command, words: [], displayWords: [command, "*"], dynamic: false, unsupported: true }], unsupported: true };
		// `do`, `then`, and `else` introduce a real command after a control-list
		// separator; analyse that body rather than discarding the whole segment.
		if (["do", "then", "else"].includes(parsed.words[0]!) && parsed.words.length > 1) parsed = shellWords(clean.replace(/^\s*(?:do|then|else)\s+/, ""));
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

/** Returns the most specific matching rule from a single allow/deny list. */
export function matchingRule(rules: string[], part: CommandPart): string | undefined {
	return rules
		.filter((rule) => matchesRule(rule, part))
		.sort((left, right) => right.split(" ").length - left.split(" ").length || left.localeCompare(right))[0];
}

export function classification(store: Store, part: CommandPart): RuleState {
	if (matchingRule(store.blacklist, part)) return "deny";
	if (matchingRule(store.whitelist, part)) return "allow";
	return "undecided";
}

/**
 * Resolves command rules from both scopes. A matching deny always wins; within
 * a decision, project rules are reported before global rules.
 */
export function resolveRule(global: Store, project: Store, part: CommandPart): ResolvedRule | undefined {
	for (const [scope, state, rules] of [
		["project", "deny", project.blacklist],
		["global", "deny", global.blacklist],
		["project", "allow", project.whitelist],
		["global", "allow", global.whitelist],
	] as const) {
		const rule = matchingRule(rules, part);
		if (rule) return { scope, state, rule };
	}
	return undefined;
}

function isStore(value: unknown, scope: RuleScope): value is Store {
	if (!value || typeof value !== "object") return false;
	const store = value as Record<string, unknown>;
	const commandLists = ["whitelist", "blacklist"].every((key) => Array.isArray(store[key]) && (store[key] as unknown[]).every((item) => typeof item === "string"));
	const editLists = ["editDirectories", "editFiles"].every((key) => Array.isArray(store[key]) && (store[key] as unknown[]).every((item) => typeof item === "string"));
	return store.version === 2 && commandLists && (scope === "global" || editLists);
}

export async function loadStore(path: string, scope: RuleScope = "project"): Promise<Store> {
	if (!existsSync(path)) return { ...EMPTY_STORE, whitelist: [], blacklist: [], editDirectories: [], editFiles: [] };
	const raw = await readFile(path, "utf8");
	let value: unknown;
	try { value = JSON.parse(raw); } catch { throw new Error(`commands whitelist: invalid JSON in ${path}`); }
	if (value && typeof value === "object" && !("version" in value)) { await rm(path); return { ...EMPTY_STORE, whitelist: [], blacklist: [], editDirectories: [], editFiles: [] }; }
	const version = value && typeof value === "object" ? (value as { version?: unknown }).version : undefined;
	if (typeof version === "number" && version < CONFIG_VERSION) { await rm(path); return { ...EMPTY_STORE, whitelist: [], blacklist: [], editDirectories: [], editFiles: [] }; }
	if (!isStore(value, scope)) throw new Error(`commands whitelist: unsupported or malformed configuration in ${path}`);
	return { ...value, whitelist: [...new Set(value.whitelist)], blacklist: [...new Set(value.blacklist)], editDirectories: scope === "global" ? [] : [...new Set(value.editDirectories)], editFiles: scope === "global" ? [] : [...new Set(value.editFiles)] };
}

export async function saveStore(path: string, store: Store, scope: RuleScope = "project"): Promise<void> {
	const normalized: Store = { version: 2, whitelist: [...new Set(store.whitelist)], blacklist: [...new Set(store.blacklist)], editDirectories: [...new Set(store.editDirectories)], editFiles: [...new Set(store.editFiles)] };
	if (normalized.whitelist.some((r) => normalized.blacklist.includes(r))) throw new Error("commands whitelist: identical whitelist and blacklist rule");
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	const serializable = scope === "global" ? { version: normalized.version, whitelist: normalized.whitelist, blacklist: normalized.blacklist } : normalized;
	await writeFile(temp, `${JSON.stringify(serializable, null, 2)}\n`, "utf8");
	await rename(temp, path);
}
