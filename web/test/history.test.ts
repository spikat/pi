import assert from "node:assert/strict";
import test from "node:test";

test("history exports only the active branch, never abandoned entries", async () => {
	const symbol = Symbol.for("spikat.pi.web.bridge"), old = (globalThis as any)[symbol];
	try {
		const { history } = await import("../index.js");
		const active = { type: "message", id: "active", message: { role: "user", content: "active branch" } };
		const entries = history({ sessionManager: { getBranch: () => [active], getEntries: () => { throw new Error("must not export abandoned branches"); } } } as any) as any[];
		assert.deepEqual(entries.map(entry => entry.id), ["active"]);
	} finally { if (old === undefined) delete (globalThis as any)[symbol]; else (globalThis as any)[symbol] = old; }
});
