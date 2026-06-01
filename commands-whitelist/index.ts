import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const EXTENSION_NAME = "commands whitelist";
const STORE_FILE = "commands-whitelist.json";

type Store = {
	version: 1;
	actionKeys: string[];
	globalActionKeys: string[];
	editDirectories: string[];
};

type WhitelistEntry =
	| { type: "action"; index: number; label: string; value: string }
	| { type: "globalAction"; index: number; label: string; value: string }
	| { type: "editDirectory"; index: number; label: string; value: string };

type WhitelistMenuResult =
	| { action: "quit" }
	| { action: "delete"; entry: WhitelistEntry }
	| { action: "edit"; entry: WhitelistEntry };

const DEFAULT_STORE: Store = {
	version: 1,
	actionKeys: [],
	globalActionKeys: [],
	editDirectories: [],
};

function findGitRoot(start: string): string | undefined {
	let current = resolve(start);
	while (true) {
		if (existsSync(resolve(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function getPiDirectory(cwd: string): string {
	return resolve(findGitRoot(cwd) ?? cwd, ".pi");
}

function normalizePath(cwd: string, rawPath: unknown): string | undefined {
	if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
	const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	return isAbsolute(withoutAt) ? resolve(withoutAt) : resolve(cwd, withoutAt);
}

function isInsideOrEqual(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

async function loadStore(path: string): Promise<Store> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<Store>;
		return {
			version: 1,
			actionKeys: Array.isArray(parsed.actionKeys) ? parsed.actionKeys.filter((v) => typeof v === "string") : [],
			globalActionKeys: Array.isArray(parsed.globalActionKeys) ? parsed.globalActionKeys.filter((v) => typeof v === "string") : [],
			editDirectories: Array.isArray(parsed.editDirectories)
				? parsed.editDirectories.filter((v) => typeof v === "string").map((v) => resolve(v))
				: [],
		};
	} catch {
		return { ...DEFAULT_STORE };
	}
}

async function saveStore(path: string, store: Store): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const normalized: Store = {
		version: 1,
		actionKeys: [...new Set(store.actionKeys)].sort(),
		globalActionKeys: [...new Set(store.globalActionKeys)].sort(),
		editDirectories: [...new Set(store.editDirectories.map((v) => resolve(v)))].sort(),
	};
	await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

function getPathInput(input: unknown): unknown {
	if (!input || typeof input !== "object") return undefined;
	return (input as Record<string, unknown>).path;
}

function getPrimaryPath(cwd: string, toolName: string, input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;

	// Built-in read/write/edit use `path`. ls/grep/find/head/tail/rg commonly use `path` or `directory`.
	const candidates = [record.path, record.directory, record.cwd];
	for (const candidate of candidates) {
		const normalized = normalizePath(cwd, candidate);
		if (normalized) return normalized;
	}

	// If no path is supplied for read-like tools, pi usually defaults to cwd.
	if (["ls", "grep", "find", "head", "tail", "wc", "rg"].includes(toolName)) return resolve(cwd);
	return undefined;
}

function isReadLikeTool(toolName: string): boolean {
	return ["read", "ls", "grep", "find", "head", "tail", "wc", "rg"].includes(toolName) || toolName.endsWith(".read");
}

function hasWriteRedirection(command: string): boolean {
	// Allow input redirections (`< file`) and `>` inside quotes (e.g. sed 's/a/>/g'),
	// but block stdout/stderr/read-write redirections that can create/modify files.
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		const previous = command[i - 1];
		const next = command[i + 1];

		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if ((char === "'" || char === '"') && !quote) {
			quote = char;
			continue;
		}
		if (char === quote) {
			quote = undefined;
			continue;
		}
		if (quote) continue;

		if (char === ">") return true;
		if (char === "<" && next === ">") return true;
		if (char === "&" && previous === ">") return true;
	}

	return false;
}

function splitShellSegments(command: string): string[] | undefined {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		const next = command[i + 1];

		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			current += char;
			escaped = true;
			continue;
		}
		if ((char === "'" || char === '"') && !quote) {
			quote = char;
			current += char;
			continue;
		}
		if (char === quote) {
			quote = undefined;
			current += char;
			continue;
		}
		if (!quote && (char === "|" || char === ";" || char === "&")) {
			if (current.trim()) segments.push(current.trim());
			current = "";
			if ((char === "|" && next === "|") || (char === "&" && next === "&")) i++;
			continue;
		}
		current += char;
	}

	if (quote) return undefined;
	if (current.trim()) segments.push(current.trim());
	return segments;
}

function splitWords(segment: string): string[] | undefined {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (const char of segment) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if ((char === "'" || char === '"') && !quote) {
			quote = char;
			continue;
		}
		if (char === quote) {
			quote = undefined;
			continue;
		}
		if (!quote && /\s/.test(char)) {
			if (current) words.push(current);
			current = "";
			continue;
		}
		current += char;
	}

	if (quote) return undefined;
	if (current) words.push(current);
	return words;
}

const READ_ONLY_BASH_COMMANDS = new Set([
	"basename",
	"cat",
	"cd",
	"cut",
	"dirname",
	"du",
	"echo",
	"egrep",
	"false",
	"fgrep",
	"file",
	"find",
	"grep",
	"head",
	"less",
	"ls",
	"pwd",
	"realpath",
	"rg",
	"sort",
	"stat",
	"tail",
	"test",
	"tr",
	"tree",
	"true",
	"uniq",
	"wc",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"blame",
	"branch",
	"diff",
	"grep",
	"log",
	"ls-files",
	"rev-parse",
	"show",
	"status",
]);

function getCommandName(words: string[]): { command: string; args: string[] } | undefined {
	let index = 0;
	while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(words[index]!)) index++;
	while (["command", "builtin", "time"].includes(words[index] ?? "")) index++;
	if (words[index] === "env") {
		index++;
		while (index < words.length && (words[index]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(words[index]!))) index++;
	}
	if (!words[index]) return undefined;
	return { command: words[index]!.split("/").pop()!, args: words.slice(index + 1) };
}

function getGitSubcommand(args: string[]): string | undefined {
	let index = 0;
	while (index < args.length) {
		const arg = args[index]!;
		if (arg === "-C" || arg === "-c") index += 2;
		else if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) index++;
		else if (arg.startsWith("-")) index++;
		else break;
	}
	return args[index];
}

function getXargsCommand(args: string[]): { command: string; args: string[] } | undefined {
	let index = 0;
	while (index < args.length) {
		const arg = args[index]!;
		if (["-0", "-r", "--no-run-if-empty", "-t", "-p"].includes(arg)) {
			index++;
			continue;
		}
		if (["-n", "-L", "-P", "-I", "-d", "-s", "-E", "--max-args", "--max-lines", "--max-procs", "--replace", "--delimiter", "--max-chars", "--eof"].includes(arg)) {
			index += 2;
			continue;
		}
		if (arg.startsWith("-")) {
			index++;
			continue;
		}
		return { command: arg.split("/").pop()!, args: args.slice(index + 1) };
	}
	return undefined;
}

function getBashCommandKey(command: string, args: string[]): string {
	if (command === "git") {
		const subcommand = getGitSubcommand(args);
		return subcommand ? `git ${subcommand}` : "git";
	}
	if (command === "xargs") {
		const xargsCommand = getXargsCommand(args);
		return xargsCommand ? getBashCommandKey(xargsCommand.command, xargsCommand.args) : "xargs";
	}
	return command;
}

function isReadOnlyBashParsed(command: string, args: string[]): boolean {
	if (command === "git") return READ_ONLY_GIT_SUBCOMMANDS.has(getGitSubcommand(args) ?? "");
	if (command === "xargs") {
		const xargsCommand = getXargsCommand(args);
		return xargsCommand ? isReadOnlyBashParsed(xargsCommand.command, xargsCommand.args) : false;
	}

	if (!READ_ONLY_BASH_COMMANDS.has(command)) return false;
	if (command === "find" && args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(arg))) return false;
	if (command === "sed" && args.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place="))) return false;
	return true;
}

function isReadOnlyBashSegment(segment: string): boolean {
	const words = splitWords(segment);
	if (!words) return false;
	const parsed = getCommandName(words);
	if (!parsed) return true;
	return isReadOnlyBashParsed(parsed.command, parsed.args);
}

function isReadOnlyBashCommand(input: unknown): boolean {
	if (!input || typeof input !== "object") return false;
	const command = (input as Record<string, unknown>).command;
	if (typeof command !== "string" || command.trim().length === 0) return false;
	if (hasWriteRedirection(command) || command.includes("`") || command.includes("$(")) return false;
	const segments = splitShellSegments(command);
	return !!segments?.length && segments.every(isReadOnlyBashSegment);
}

function isEditLikeTool(toolName: string): boolean {
	return ["edit", "write"].includes(toolName);
}

function actionLabel(toolName: string, input: unknown, cwd: string): string {
	if (toolName === "bash" && input && typeof input === "object") {
		const command = (input as Record<string, unknown>).command;
		if (typeof command === "string") return `bash: ${command}`;
	}

	const path = getPrimaryPath(cwd, toolName, input);
	const pathText = path ? relative(cwd, path) || "." : undefined;
	return pathText ? `${toolName}: ${pathText}` : `${toolName}: ${stableStringify(input)}`;
}

function getGlobalActionKey(toolName: string, input: unknown): string {
	if (toolName !== "bash" || !input || typeof input !== "object") return `tool:${toolName}`;

	const command = (input as Record<string, unknown>).command;
	if (typeof command !== "string") return "bash";
	const segments = splitShellSegments(command);
	if (!segments?.length) return "bash";

	const commandKeys = segments
		.map((segment) => {
			const words = splitWords(segment);
			const parsed = words ? getCommandName(words) : undefined;
			return parsed ? getBashCommandKey(parsed.command, parsed.args) : undefined;
		})
		.filter((value): value is string => !!value);

	return commandKeys.length > 0 ? `bash:${commandKeys.join(" | ")}` : "bash";
}

function getWhitelistEntries(store: Store): WhitelistEntry[] {
	return [
		...store.actionKeys.map((value, index) => ({
			type: "action" as const,
			index,
			label: `Action exacte: ${value}`,
			value,
		})),
		...store.globalActionKeys.map((value, index) => ({
			type: "globalAction" as const,
			index,
			label: `Commande globale: ${value}`,
			value,
		})),
		...store.editDirectories.map((value, index) => ({

			type: "editDirectory" as const,
			index,
			label: `Éditions dans le répertoire: ${value}`,
			value,
		})),
	];
}

function deleteWhitelistEntry(store: Store, entry: WhitelistEntry): void {
	if (entry.type === "action") store.actionKeys.splice(entry.index, 1);
	else if (entry.type === "globalAction") store.globalActionKeys.splice(entry.index, 1);
	else store.editDirectories.splice(entry.index, 1);
}

function updateWhitelistEntry(store: Store, entry: WhitelistEntry, nextValue: string): void {
	if (entry.type === "action") store.actionKeys[entry.index] = nextValue;
	else if (entry.type === "globalAction") store.globalActionKeys[entry.index] = nextValue;
	else store.editDirectories[entry.index] = resolve(nextValue);
}

async function showWhitelistMenu(ctx: ExtensionCommandContext, store: Store): Promise<WhitelistMenuResult> {
	const entries = getWhitelistEntries(store);
	let selected = 0;

	return ctx.ui.custom<WhitelistMenuResult>((tui, theme, _keybindings, done) => ({
		handleInput(data: string): void {
			if (matchesKey(data, Key.up)) {
				selected = Math.max(0, selected - 1);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.down)) {
				selected = Math.min(Math.max(0, entries.length - 1), selected + 1);
				tui.requestRender();
				return;
			}
			if (data === "q" || matchesKey(data, Key.escape)) {
				done({ action: "quit" });
				return;
			}
			if (entries.length === 0) return;
			if (data === "d") {
				done({ action: "delete", entry: entries[selected]! });
				return;
			}
			if (data === "e") {
				done({ action: "edit", entry: entries[selected]! });
			}
		},
		render(width: number): string[] {
			const innerWidth = Math.max(10, width - 2);
			const lines: string[] = [];
			const border = theme.fg("borderAccent", "─".repeat(innerWidth));
			lines.push(border);
			lines.push(truncateToWidth(theme.fg("accent", theme.bold("Whitelist courantes")), width));
			lines.push(theme.fg("dim", `Stockées dans .pi/${STORE_FILE}`));
			lines.push("");

			if (entries.length === 0) {
				lines.push(theme.fg("muted", "Aucune whitelist enregistrée."));
			} else {
				for (let i = 0; i < entries.length; i++) {
					const entry = entries[i]!;
					const prefix = i === selected ? "› " : "  ";
					const text = `${prefix}${entry.label}`;
					lines.push(truncateToWidth(i === selected ? theme.bg("selectedBg", theme.fg("accent", text)) : text, width));
				}
			}

			lines.push("");
			lines.push(theme.fg("dim", "↑/↓ se déplacer • d supprimer • e éditer • q quitter"));
			lines.push(border);
			return lines.map((line) => truncateToWidth(line, width));
		},
		invalidate(): void {},
	}));
}

export default function (pi: ExtensionAPI) {
	async function blockWithUserPrompt(ctx: ExtensionContext): Promise<{ block: true; reason: string }> {
		const prompt = await ctx.ui.editor("Entrer un prompt à envoyer à l'assistant");
		const trimmed = prompt?.trim();
		if (trimmed) {
			pi.sendUserMessage(trimmed, { deliverAs: "steer" });
			return { block: true, reason: `${EXTENSION_NAME}: action bloquée, prompt utilisateur envoyé` };
		}
		return { block: true, reason: `${EXTENSION_NAME}: action bloquée, prompt utilisateur vide/annulé` };
	}

	pi.registerCommand("whitelist", {
		description: "Lister, éditer et supprimer les whitelists de commands whitelist",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/whitelist nécessite une UI interactive", "warning");
				return;
			}

			const storePath = resolve(getPiDirectory(resolve(ctx.cwd)), STORE_FILE);
			while (true) {
				const store = await loadStore(storePath);
				const result = await showWhitelistMenu(ctx, store);

				if (result.action === "quit") return;

				if (result.action === "delete") {
					deleteWhitelistEntry(store, result.entry);
					await saveStore(storePath, store);
					ctx.ui.notify("Whitelist supprimée", "info");
					continue;
				}

				const nextValue = await ctx.ui.editor("Modifier la whitelist", result.entry.value);
				if (nextValue === undefined) continue;
				const trimmed = nextValue.trim();
				if (!trimmed) {
					ctx.ui.notify("Valeur vide ignorée", "warning");
					continue;
				}
				updateWhitelistEntry(store, result.entry, trimmed);
				await saveStore(storePath, store);
				ctx.ui.notify("Whitelist modifiée", "info");
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const cwd = resolve(ctx.cwd);
		const storePath = resolve(getPiDirectory(cwd), STORE_FILE);
		const store = await loadStore(storePath);

		// No permission needed for file reads, regardless of the tool/path.
		if (isReadLikeTool(event.toolName) || (event.toolName === "bash" && isReadOnlyBashCommand(event.input))) {
			return undefined;
		}

		const globalActionKey = getGlobalActionKey(event.toolName, event.input);
		if (store.globalActionKeys.includes(globalActionKey)) return undefined;

		// File edit/write whitelist is directory-based.
		if (isEditLikeTool(event.toolName)) {
			const rawPath = getPathInput(event.input);
			const targetPath = normalizePath(cwd, rawPath);
			const targetDir = targetPath ? dirname(targetPath) : cwd;
			const whitelistedDirectory = store.editDirectories.find((dir) => isInsideOrEqual(dir, targetDir));
			if (whitelistedDirectory) return undefined;

			if (!ctx.hasUI) {
				return { block: true, reason: `${EXTENSION_NAME}: édition bloquée (aucune UI pour confirmer)` };
			}

			const label = actionLabel(event.toolName, event.input, cwd);
			const choice = await ctx.ui.select(`Confirmer l'action ?\n\n${label}`, [
				`1/ oui, et whitelist les editions de fichier dans ce répertoire (${targetDir})`,
				`2/ oui, et whitelist globalement cette commande (${globalActionKey})`,
				"3/ oui, mais uniquement cette fois",
				"4/ entrer un prompt pour l'assistant",
				"5/ non",
			]);

			if (choice?.startsWith("1/")) {
				store.editDirectories.push(targetDir);
				await saveStore(storePath, store);
				ctx.ui.notify(`${EXTENSION_NAME}: répertoire whitelisté: ${targetDir}`, "info");
				return undefined;
			}
			if (choice?.startsWith("2/")) {
				store.globalActionKeys.push(globalActionKey);
				await saveStore(storePath, store);
				ctx.ui.notify(`${EXTENSION_NAME}: commande whitelistée globalement`, "info");
				return undefined;
			}
			if (choice?.startsWith("3/")) return undefined;
			if (choice?.startsWith("4/")) return blockWithUserPrompt(ctx);
			return { block: true, reason: `${EXTENSION_NAME}: refusé par l'utilisateur` };
		}

		const actionKey = `${event.toolName}:${stableStringify(event.input)}`;
		if (store.actionKeys.includes(actionKey)) return undefined;

		if (!ctx.hasUI) {
			return { block: true, reason: `${EXTENSION_NAME}: action bloquée (aucune UI pour confirmer)` };
		}

		const label = actionLabel(event.toolName, event.input, cwd);
		const choice = await ctx.ui.select(`Confirmer l'action ?\n\n${label}`, [
			"1/ oui, et whitelist pour les prochaines fois",
			`2/ oui, et whitelist globalement cette commande (${globalActionKey})`,
			"3/ oui, mais uniquement cette fois",
			"4/ entrer un prompt pour l'assistant",
			"5/ non",
		]);

		if (choice?.startsWith("1/")) {
			store.actionKeys.push(actionKey);
			await saveStore(storePath, store);
			ctx.ui.notify(`${EXTENSION_NAME}: action whitelistée`, "info");
			return undefined;
		}
		if (choice?.startsWith("2/")) {
			store.globalActionKeys.push(globalActionKey);
			await saveStore(storePath, store);
			ctx.ui.notify(`${EXTENSION_NAME}: commande whitelistée globalement`, "info");
			return undefined;
		}
		if (choice?.startsWith("3/")) return undefined;
		if (choice?.startsWith("4/")) return blockWithUserPrompt(ctx);

		return { block: true, reason: `${EXTENSION_NAME}: refusé par l'utilisateur` };
	});
}
