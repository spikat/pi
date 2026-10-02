import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { registerWebCommand } = await createJiti(import.meta.url, { fsCache: false }).import("../web-command.ts");
test("reload replaces a contributor; shutdown removes its bridge command", t => {
	const key = Symbol.for("spikat.pi.web.command-contributors"), bridgeKey = Symbol.for("spikat.pi.web.bridge");
	const old = globalThis[key], oldBridge = globalThis[bridgeKey]; const commands = new Map();
	globalThis[key] = new Set(); globalThis[bridgeKey] = { registerCommand(name, handler) { commands.set(name, handler); return () => { if (commands.get(name) === handler) commands.delete(name); }; } };
	t.after(() => { if (old === undefined) delete globalThis[key]; else globalThis[key] = old; if (oldBridge === undefined) delete globalThis[bridgeKey]; else globalThis[bridgeKey] = oldBridge; });
	const first = registerWebCommand("test", () => "old"), second = registerWebCommand("test", () => "new");
	assert.equal(globalThis[key].size, 1); assert.equal(commands.get("test")(), "new"); first.dispose(); assert.equal(commands.get("test")(), "new");
	second.dispose(); assert.equal(globalThis[key].size, 0); assert.equal(commands.size, 0);
	second.activate(); assert.equal(commands.size, 1); second.dispose();
});
