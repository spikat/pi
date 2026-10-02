import { spawn } from "node:child_process";

/** Drain stdout without keeping an unbounded diff in memory. */
export function runGit(args: string[], cwd: string, signal?: AbortSignal, limit = 60_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const safe = ["diff", "show", "log"].includes(args[0] ?? "") ? [args[0]!, "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args;
		const child = spawn("git", ["--no-pager", ...safe], { cwd, signal, stdio: ["ignore", "pipe", "pipe"] });
		let output = "", errorOutput = "", truncated = false, timedOut = false;
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
		child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { const remaining = Math.max(0, limit - output.length); output += chunk.slice(0, remaining); if (chunk.length > remaining) truncated = true; });
		child.stderr.on("data", (chunk: string) => { errorOutput = (errorOutput + chunk).slice(-4_000); });
		child.once("error", error => { clearTimeout(timer); reject(error); });
		child.once("close", code => {
			clearTimeout(timer);
			if (code !== 0 || timedOut) { reject(new Error(timedOut ? "Git command timed out" : errorOutput.trim() || `Git exited with code ${code}`)); return; }
			resolve(output.trimEnd() + (truncated ? `\n[Content truncated after ${limit} characters]` : ""));
		});
	});
}
export async function tryGit(args: string[], cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	try { return (await runGit(args, cwd, signal)).trim() || undefined; }
	catch (error) { if (signal?.aborted) throw error; return undefined; }
}
export function formatPaths(value: string): string { return value.split("\0").filter(Boolean).map(path => JSON.stringify(path)).join("\n"); }
