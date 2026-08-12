import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { analyseShell, classification, loadStore, matchesRule, normalizeRule, ruleFor, saveStore, type CommandPart, type RuleState, type Store } from "./core.js";

const NAME = "commands whitelist";
const FILE = "commands-whitelist.json";
type Choice = { part: CommandPart; state: RuleState; args: number; persisted?: string };
type GateResult = { action: "allow" } | { action: "block"; reason: string } | { action: "prompt"; prompt: string };
const sessionEditDirectories = new Set<string>();
const sessionEditFiles = new Set<string>();

function gitRoot(cwd: string): string | undefined { let current = resolve(cwd); while (true) { if (existsSync(resolve(current, ".git"))) return current; const parent = dirname(current); if (parent === current) return undefined; current = parent; } }
function storePath(cwd: string): string { return resolve(gitRoot(cwd) ?? cwd, CONFIG_DIR_NAME, FILE); }
function pathFor(cwd: string, raw: unknown): string | undefined { if (typeof raw !== "string" || !raw) return undefined; const value = raw.startsWith("@") ? raw.slice(1) : raw; return isAbsolute(value) ? resolve(value) : resolve(cwd, value); }
function within(parent: string, child: string): boolean { const rel = relative(parent, child); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }
function marker(state: RuleState): string { return state === "allow" ? "✅" : state === "deny" ? "❌" : "🔁"; }
function footer(): string { return "↑↓ select · ←→ arguments · Space state · Enter validate/send · Ctrl+C cancel · h help"; }
function detailedHelp(): string[] { return ["Commands whitelist", "🔁 authorizes this session only; ✅ saves an allow rule; ❌ saves a deny rule.", "←/→ changes the number of literal arguments; * matches all remaining arguments.", "Enter on ‘Validate current selection’ applies choices. A denied part blocks the whole shell command.", "The prompt input cancels the pending command and sends its text to the assistant.", "Use /whitelist to list, add, edit, and delete saved rules.", "Esc returns to the menu."]; }

class PromptLine {
	text = ""; cursor = 0;
	handle(data: string): boolean {
		if (matchesKey(data, Key.left)) { this.cursor = Math.max(0, this.cursor - 1); return true; }
		if (matchesKey(data, Key.right)) { this.cursor = Math.min(this.text.length, this.cursor + 1); return true; }
		if (matchesKey(data, Key.backspace)) { if (this.cursor) { this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor); this.cursor--; } return true; }
		if (matchesKey(data, Key.delete)) { this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1); return true; }
		// Terminal paste arrives as one multi-character input event, unlike normal
		// typing. Keep this single-line input stable by folding pasted newlines.
		const pasted = data.replace(/[\r\n]+/g, " ");
		if (pasted.length > 0 && !/[\x00-\x1f\x7f]/.test(pasted)) { this.text = this.text.slice(0, this.cursor) + pasted + this.text.slice(this.cursor); this.cursor += pasted.length; return true; }
		return false;
	}
	render(active: boolean): string { const before = this.text.slice(0, this.cursor); const at = this.text[this.cursor] ?? " "; const after = this.text.slice(this.cursor + 1); return `  Enter a prompt for the assistant: ${before}${active ? `\x1b[7m${at}\x1b[27m` : this.text || "[... ]"}${active ? after : ""}`; }
}

async function showGate(ctx: ExtensionContext, choices: Choice[], global?: string): Promise<GateResult> {
	if (ctx.mode !== "tui") return { action: "block", reason: `${NAME}: no interactive UI is available` };
	return ctx.ui.custom<GateResult>((tui, theme, _kb, done) => {
		let selected = 0; let help = false; const prompt = new PromptLine(); const validateIndex = choices.length; const promptIndex = choices.length + 1;
		const render = (width: number): string[] => {
			if (help) return detailedHelp().map((line) => truncateToWidth(line, width));
			const lines = [theme.fg("accent", theme.bold("Review shell command"))];
			if (global) lines.push(truncateToWidth(theme.fg("dim", `Original: ${global}`), width));
			for (let i = 0; i < choices.length; i++) { const c = choices[i]!; const label = `${marker(c.state)} ${ruleFor(c.part, c.args)}${c.part.pythonScript ? " (one time only)" : ""}`; const row = `${i === selected ? "› " : "  "}${label}`; lines.push(truncateToWidth(i === selected ? theme.bg("selectedBg", theme.fg("accent", row)) : row, width)); }
			const validate = `${selected === validateIndex ? "› " : "  "}Validate current selection`;
			lines.push(theme.bg(selected === validateIndex ? "selectedBg" : "toolPendingBg", truncateToWidth(validate, width)));
			const input = prompt.render(selected === promptIndex);
			lines.push(selected === promptIndex ? theme.bg("selectedBg", truncateToWidth(input, width)) : truncateToWidth(input, width));
			lines.push(theme.fg("dim", footer())); return lines;
		};
		return { invalidate() {}, render, handleInput(data: string) {
			if (help) { if (matchesKey(data, Key.escape)) { help = false; tui.requestRender(); } return; }
			if (matchesKey(data, Key.ctrl("c"))) return done({ action: "block", reason: `${NAME}: cancelled by user` });
			// The prompt editor owns printable keys, including “h”.
			if (selected === promptIndex) { if (matchesKey(data, Key.enter)) return done({ action: "prompt", prompt: prompt.text.trim() }); if (prompt.handle(data)) { tui.requestRender(); return; } }
			if (data === "h") { help = true; tui.requestRender(); return; }
			if (matchesKey(data, Key.up)) { selected = Math.max(0, selected - 1); tui.requestRender(); return; }
			if (matchesKey(data, Key.down)) { selected = Math.min(promptIndex, selected + 1); tui.requestRender(); return; }
			if (selected < choices.length) {
				const choice = choices[selected]!;
				if (choice.part.pythonScript) {
					// Python script execution is opaque: it can only be allowed once or denied.
					if (matchesKey(data, Key.space)) choice.state = choice.state === "deny" ? "undecided" : "deny";
				} else if (matchesKey(data, Key.left)) choice.args = Math.max(0, choice.args - 1);
				else if (matchesKey(data, Key.right)) choice.args = Math.min(choice.part.displayWords.filter((w) => w !== "*").length - 1, choice.args + 1);
				else if (matchesKey(data, Key.space)) choice.state = choice.state === "undecided" ? "allow" : choice.state === "allow" ? "deny" : "undecided";
				if (matchesKey(data, Key.enter)) selected = Math.min(promptIndex, selected + 1);
				tui.requestRender(); return;
			}
			if (selected === validateIndex && matchesKey(data, Key.enter)) done({ action: "allow" });
		} };
	});
}

async function gateBash(pi: ExtensionAPI, ctx: ExtensionContext, command: string): Promise<{ block: true; reason: string } | undefined> {
	if (!command.trim()) return { block: true, reason: `${NAME}: empty command` };
	if (command.trim().startsWith("#")) return undefined;
	const result = analyseShell(command);
	const parts = result.unsupported ? result.parts : result.parts;
	const store = await loadStore(storePath(ctx.cwd));
	const choices: Choice[] = parts.map((part) => {
		const found = [...store.whitelist, ...store.blacklist].find((r) => matchesRule(r, part));
		// A Python script may never be persistently allowed, even through an existing
		// broad allow rule. Stored deny rules still block it immediately.
		const state = part.pythonScript ? (store.blacklist.some((r) => matchesRule(r, part)) ? "deny" : "undecided") : classification(store, part);
		return { part, state, args: Math.max(0, (found ? found.split(" ").length - 2 : part.displayWords.filter((w) => w !== "*").length - 1)), persisted: found };
	});
	const denied = choices.filter((c) => c.state === "deny");
	if (denied.length) return { block: true, reason: `${NAME}: blocked command\nOriginal: ${command}\nDenied: ${denied.map((c) => `${c.part.original} (rule: ${c.persisted})`).join("; ")}` };
	if (choices.length && choices.every((c) => c.state === "allow")) return undefined;
	const answer = await showGate(ctx, choices, command);
	if (answer.action === "prompt") { if (answer.prompt) pi.sendUserMessage(answer.prompt, { deliverAs: "steer" }); return { block: true, reason: `${NAME}: command cancelled; prompt sent to assistant` }; }
	if (answer.action === "block") return { block: true, reason: answer.reason };
	for (const c of choices) {
		if (c.state === "undecided") continue;
		if (c.part.pythonScript && c.state === "allow") continue;
		const rule = ruleFor(c.part, c.args);
		if (c.persisted && c.persisted !== rule) {
			store.whitelist = store.whitelist.filter((value) => value !== c.persisted);
			store.blacklist = store.blacklist.filter((value) => value !== c.persisted);
		}
		if (c.state === "allow") { store.blacklist = store.blacklist.filter((r) => r !== rule); if (!store.whitelist.includes(rule)) store.whitelist.push(rule); }
		else { store.whitelist = store.whitelist.filter((r) => r !== rule); if (!store.blacklist.includes(rule)) store.blacklist.push(rule); }
	}
	if (store.whitelist.some((r) => store.blacklist.includes(r))) return { block: true, reason: `${NAME}: whitelist/blacklist conflict` };
	if (choices.some((c) => c.state !== "undecided")) await saveStore(storePath(ctx.cwd), store);
	const explicitDeny = choices.filter((c) => c.state === "deny");
	if (explicitDeny.length) return { block: true, reason: `${NAME}: command denied\nOriginal: ${command}\nDenied: ${explicitDeny.map((c) => c.part.original).join("; ")}` };
	return undefined;
}

async function showEditGate(ctx: ExtensionContext, title: string): Promise<{ choice: 1 | 2 | 3 | 4; persistent: boolean } | undefined> {
	if (ctx.mode !== "tui") return undefined;
	return ctx.ui.custom((tui, theme, _kb, done) => { let selected = 0; const persistent = [false, false]; const labels = ["1. Allow a directory", "2. Allow this file", "3. Deny", "4. Enter a prompt for the assistant"]; return { invalidate() {}, render(width: number) { return [theme.fg("accent", title), ...labels.map((label, index) => { const status = index < 2 ? (persistent[index] ? "✅" : "🔁") : index === 2 ? "❌" : "  "; const row = `${selected === index ? "› " : "  "}${status} ${label}`; return truncateToWidth(selected === index ? theme.bg("selectedBg", row) : row, width); }), theme.fg("dim", "↑↓ select · Space session/persist · Enter confirm · Ctrl+C cancel")]; }, handleInput(data: string) { if (matchesKey(data, Key.ctrl("c"))) return done(undefined); if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1); else if (matchesKey(data, Key.down)) selected = Math.min(3, selected + 1); else if (matchesKey(data, Key.space) && selected < 2) persistent[selected] = !persistent[selected]; else if (matchesKey(data, Key.enter)) done({ choice: (selected + 1) as 1 | 2 | 3 | 4, persistent: selected < 2 && persistent[selected] }); tui.requestRender(); } }; });
}

async function gateEdit(pi: ExtensionAPI, ctx: ExtensionContext, toolName: string, input: unknown): Promise<{ block: true; reason: string } | undefined> {
	const path = pathFor(ctx.cwd, input && typeof input === "object" ? (input as { path?: unknown }).path : undefined);
	if (!path) return { block: true, reason: `${NAME}: ${toolName} requires a path` };
	const store = await loadStore(storePath(ctx.cwd));
	if (store.editFiles.includes(path) || sessionEditFiles.has(path) || store.editDirectories.some((d) => within(d, path)) || [...sessionEditDirectories].some((d) => within(d, path))) return undefined;
	if (!ctx.hasUI) return within(resolve(ctx.cwd), path) ? undefined : { block: true, reason: `${NAME}: ${toolName} blocked without UI outside current directory` };
	const selected = await showEditGate(ctx, `${toolName}: ${path}`);
	if (!selected || selected.choice === 3) return { block: true, reason: `${NAME}: ${toolName} denied` };
	if (selected.choice === 4) { const prompt = await ctx.ui.editor("Enter a prompt for the assistant"); if (prompt?.trim()) pi.sendUserMessage(prompt.trim(), { deliverAs: "steer" }); return { block: true, reason: `${NAME}: ${toolName} cancelled` }; }
	if (selected.choice === 1) { const chosen = await ctx.ui.editor("Allowed directory", resolve(ctx.cwd)); if (!chosen?.trim()) return { block: true, reason: `${NAME}: directory permission cancelled` }; const dir = resolve(chosen.trim()); if (selected.persistent) { store.editDirectories.push(dir); await saveStore(storePath(ctx.cwd), store); } else sessionEditDirectories.add(dir); return undefined; }
	if (selected.persistent) { store.editFiles.push(path); await saveStore(storePath(ctx.cwd), store); } else sessionEditFiles.add(path); return undefined;
}

function helpText(): string { return "Usage: /whitelist [list|allow|add|deny|block|remove|rm|del|delete|help|--help|-h]"; }
type ManagerResult = { action: "quit" } | { action: "add" } | { action: "edit"; rule: string; state: "allow" | "deny" } | { action: "delete"; rule: string; state: "allow" | "deny" };
async function showManager(ctx: ExtensionCommandContext, store: Store): Promise<ManagerResult> {
	return ctx.ui.custom<ManagerResult>((tui, theme, _kb, done) => {
		const entries = [...store.whitelist.map((rule) => ({ rule, state: "allow" as const })), ...store.blacklist.map((rule) => ({ rule, state: "deny" as const }))].sort((a, b) => a.rule.localeCompare(b.rule));
		let selected = 0; let help = false;
		return { invalidate() {}, render(width: number) {
			if (help) return ["/whitelist manager", "a add · e edit · d delete · ↑↓ select · Ctrl+C or q quit", "Esc returns to the list."].map((line) => truncateToWidth(line, width));
			const lines = [theme.fg("accent", theme.bold("Command rules"))];
			if (!entries.length) lines.push(theme.fg("muted", "No whitelist or blacklist rules configured."));
			for (let i = 0; i < entries.length; i++) { const e = entries[i]!; const row = `${i === selected ? "› " : "  "}${e.state === "allow" ? "✅" : "❌"} | ${e.rule}`; lines.push(truncateToWidth(i === selected ? theme.bg("selectedBg", row) : row, width)); }
			lines.push(theme.fg("dim", "↑↓ select · a add · e edit · d delete · h help · Ctrl+C quit")); return lines;
		}, handleInput(data: string) {
			if (help) { if (matchesKey(data, Key.escape)) { help = false; tui.requestRender(); } return; }
			if (matchesKey(data, Key.ctrl("c")) || data === "q") return done({ action: "quit" });
			if (data === "h") { help = true; tui.requestRender(); return; }
			if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1); else if (matchesKey(data, Key.down)) selected = Math.min(Math.max(0, entries.length - 1), selected + 1); else if (data === "a") return done({ action: "add" }); else if (entries.length && data === "e") return done({ action: "edit", ...entries[selected]! }); else if (entries.length && data === "d") return done({ action: "delete", ...entries[selected]! }); tui.requestRender();
		} };
	});
}
async function list(ctx: ExtensionCommandContext, store: Store): Promise<void> { const rules = [...store.whitelist.map((r) => `✅ | ${r}`), ...store.blacklist.map((r) => `❌ | ${r}`)].sort(); ctx.ui.notify(rules.length ? rules.join("\n") : "No whitelist or blacklist rules configured.\nUse /whitelist help for help.", "info"); }
async function chooseRuleState(ctx: ExtensionCommandContext, initial: "allow" | "deny"): Promise<"allow" | "deny" | undefined> {
	return ctx.ui.custom((tui, theme, _kb, done) => { let state = initial; return { invalidate() {}, render(width: number) { return [theme.fg("accent", "Choose rule type"), `${state === "allow" ? "› " : "  "}✅ whitelist`, `${state === "deny" ? "› " : "  "}❌ blacklist`, theme.fg("dim", "Space toggle · Enter confirm · Esc cancel")].map((line) => truncateToWidth(line, width)); }, handleInput(data: string) { if (matchesKey(data, Key.escape)) return done(undefined); if (matchesKey(data, Key.space) || matchesKey(data, Key.up) || matchesKey(data, Key.down)) { state = state === "allow" ? "deny" : "allow"; tui.requestRender(); } else if (matchesKey(data, Key.enter)) done(state); } }; });
}

export default function (pi: ExtensionAPI) {
	// Validate/migrate the project configuration as soon as a session starts, not only
	// when the first protected tool is called.
	pi.on("session_start", async (_event, ctx) => {
		await loadStore(storePath(ctx.cwd));
	});
	pi.registerCommand("whitelist", { description: "List and edit command allow/deny rules", handler: async (args, ctx) => {
		const [verb, ...rest] = args.trim().split(/\s+/); const path = storePath(ctx.cwd); const store = await loadStore(path);
		if (!verb) {
			if (ctx.mode !== "tui") { await list(ctx, store); return; }
			while (true) {
				const current = await loadStore(path); const action = await showManager(ctx, current);
				if (action.action === "quit") return;
				if (action.action === "delete") {
					if (action.state === "deny" && !(await ctx.ui.confirm("Delete blacklist rule?", `Delete ❌ ${action.rule}?`))) continue;
					current[action.state === "allow" ? "whitelist" : "blacklist"] = current[action.state === "allow" ? "whitelist" : "blacklist"].filter((rule) => rule !== action.rule); await saveStore(path, current); continue;
				}
				const entered = await ctx.ui.editor(action.action === "add" ? "Add command rule" : "Edit command rule", action.action === "edit" ? action.rule : "");
				if (entered === undefined) continue; const rule = normalizeRule(entered); if (!rule) { ctx.ui.notify("Invalid command rule.", "error"); continue; }
				const state = await chooseRuleState(ctx, action.action === "edit" ? action.state : "allow"); if (!state) continue;
				if (action.action === "edit" && action.rule !== rule) current[action.state === "allow" ? "whitelist" : "blacklist"] = current[action.state === "allow" ? "whitelist" : "blacklist"].filter((value) => value !== action.rule);
				const own = state === "allow" ? current.whitelist : current.blacklist; const other = state === "allow" ? current.blacklist : current.whitelist;
				if (other.includes(rule)) { ctx.ui.notify("Rule conflicts with the other list.", "error"); continue; } if (!own.includes(rule)) own.push(rule); await saveStore(path, current);
			}
		}
		if (["help", "--help", "-h"].includes(verb)) { ctx.ui.notify(helpText(), "info"); return; }
		if (verb === "list") { await list(ctx, store); return; }
		const isAllow = ["allow", "add"].includes(verb), isDeny = ["deny", "block"].includes(verb), isRemove = ["remove", "rm", "del", "delete"].includes(verb);
		if (!isAllow && !isDeny && !isRemove) { ctx.ui.notify(`Unknown /whitelist command: ${verb}. Use /whitelist help.`, "error"); return; }
		const rule = normalizeRule(rest.join(" ")); if (!rule) { ctx.ui.notify("A valid command rule is required. Use /whitelist --help.", "error"); return; }
		if (isRemove) { const hasAllow = store.whitelist.includes(rule), hasDeny = store.blacklist.includes(rule); if (!hasAllow && !hasDeny) { ctx.ui.notify("Rule does not exist.", "error"); return; } if (hasDeny && !(await ctx.ui.confirm("Delete blacklist rule?", `Delete ❌ ${rule}?`))) return; store.whitelist = store.whitelist.filter((r) => r !== rule); store.blacklist = store.blacklist.filter((r) => r !== rule); await saveStore(path, store); return; }
		const own = isAllow ? store.whitelist : store.blacklist; const other = isAllow ? store.blacklist : store.whitelist; if (other.includes(rule)) { ctx.ui.notify("Rule conflicts with the other list.", "error"); return; } if (!own.includes(rule)) own.push(rule); await saveStore(path, store);
	} });
	pi.on("tool_call", async (event, ctx) => { if (event.toolName === "bash") { const command = event.input && typeof event.input === "object" ? (event.input as { command?: unknown }).command : undefined; return typeof command === "string" ? gateBash(pi, ctx, command) : { block: true, reason: `${NAME}: invalid bash command` }; } if (event.toolName === "edit" || event.toolName === "write") return gateEdit(pi, ctx, event.toolName, event.input); return undefined; });
}
