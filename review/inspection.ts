/** One literal Git snapshot inspection; no shell expansion or opaque tools. */
export function isSnapshotInspection(input: unknown): boolean {
	if (typeof input !== "string" || /[\n\r;&|`<>$]/.test(input)) return false;
	const words: string[] = [];
	let word = "", quote = "", started = false;
	for (let i = 0; i < input.length; i++) {
		const c = input[i]!;
		if (c === "\\" && quote !== "'") { if (++i === input.length) return false; word += input[i]; started = true; continue; }
		if (quote) { if (c === quote) quote = ""; else word += c; started = true; continue; }
		if (c === "'" || c === '"') { quote = c; started = true; continue; }
		if (/\s/.test(c)) { if (started) words.push(word); word = ""; started = false; continue; }
		if (/[()*?{}#]/.test(c) || (c === "~" && !started)) return false;
		word += c; started = true;
	}
	if (quote) return false;
	if (started) words.push(word);
	if (words.shift() !== "git") return false;
	if (words[0] === "-C") words.splice(0, 2);
	const subcommand = words.shift();
	if (!subcommand || !["show", "diff", "log", "ls-tree", "cat-file", "rev-parse"].includes(subcommand)) return false;
	if (words.some(a => /^--(?:output|ext-diff|textconv|no-index|filters|config-env)(?:=|$)/.test(a) || /^-c/.test(a))) return false;
	return !["show", "diff", "log"].includes(subcommand) || (words.includes("--no-ext-diff") && words.includes("--no-textconv"));
}
