/** Parse one literal command only. Shell expansion, operators and assignments fail closed. */
export function literalWords(input: unknown): string[] | undefined {
	if (typeof input !== "string" || /[\n\r;&|`<>$]/.test(input)) return undefined;
	const words: string[] = [];
	let word = "", quote = "", started = false;
	for (let i = 0; i < input.length; i++) {
		const c = input[i]!;
		if (c === "\\" && quote !== "'") {
			if (++i === input.length) return undefined;
			word += input[i]; started = true; continue;
		}
		if (quote) { if (c === quote) quote = ""; else word += c; started = true; continue; }
		if (c === "'" || c === '"') { quote = c; started = true; continue; }
		if (/\s/.test(c)) { if (started) words.push(word); word = ""; started = false; continue; }
		// Globs, tilde expansion, shell comments and grouping are not supported.
		if (/[()*?{}#]/.test(c) || (c === "~" && !started)) return undefined;
		word += c; started = true;
	}
	if (quote) return undefined;
	if (started) words.push(word);
	return words.length ? words : undefined;
}

const COMMANDS = new Set(["basename", "cat", "cut", "date", "df", "dirname", "du", "echo", "file", "find", "git", "grep", "head", "id", "ls", "pgrep", "printenv", "printf", "pwd", "readlink", "realpath", "rg", "sort", "stat", "tail", "test", "true", "false", "tr", "uname", "uptime", "wc", "whoami"]);
const GIT = new Set(["status", "diff", "log", "show", "ls-files", "ls-tree", "rev-parse", "merge-base", "blame", "grep", "shortlog", "describe", "name-rev"]);

export function isReadOnlyBashCommand(input: unknown): boolean {
	const words = literalWords(input);
	if (!words) return false;
	const [executable, ...args] = words;
	if (!executable || !COMMANDS.has(executable)) return false;
	if (executable === "git") {
		const subcommand = args[0];
		if (!subcommand || !GIT.has(subcommand)) return false;
		if (args.some(a => /^--(?:output|ext-diff|textconv|open-files-in-pager|config-env)(?:=|$)/.test(a) || /^-(?:c|O)/.test(a))) return false;
		// Do not let repository-configured diff drivers execute programs.
		if (["diff", "show", "log"].includes(subcommand)) return args.includes("--no-ext-diff") && args.includes("--no-textconv");
		return true;
	}
	if (executable === "find") return !args.some(a => /^-(?:delete|exec|execdir|fprint.*|fprintf|fls|ok|okdir)$/.test(a));
	if (executable === "sort") return !args.some(a => /^--(?:output|compress-program)(?:=|$)/.test(a) || /^-[^-]*o/.test(a));
	if (executable === "date") return !args.some(a => /^--set(?:=|$)/.test(a) || /^-[^-]*s/.test(a));
	if (executable === "file") return !args.some(a => a === "--compile" || /^-[^-]*C/.test(a));
	if (executable === "rg") return !args.some(a => /^--(?:pre|hostname-bin)(?:=|$)/.test(a));
	return true;
}
