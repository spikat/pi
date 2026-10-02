import assert from "node:assert/strict";
import test from "node:test";
import { cancelDecisions, customDecision, waitDecision } from "../decisions.js";

test("aborting and shutting down cancel browser-only decisions", async () => {
	const controller = new AbortController(); let closed = false;
	const decision = waitDecision({ signal: controller.signal } as any, new Promise<string>(() => {}), "deny", () => closed = true);
	controller.abort(); assert.equal(await decision, "deny"); assert.equal(closed, true);
	const next = waitDecision({} as any, new Promise<string>(() => {}), "deny", () => {});
	cancelDecisions(); assert.equal(await next, "deny");
});

test("native UI rejection settles fail-closed instead of leaving an outer promise pending", async () => {
	const ctx = { ui: { custom: () => Promise.reject(new Error("UI unavailable")) } };
	assert.equal(await customDecision(ctx as any, "deny", () => ({} as any)), "deny");
});
