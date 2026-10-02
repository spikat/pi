import assert from "node:assert/strict";
import test from "node:test";
import { send } from "../transport.mjs";

test("stale sockets, closed sockets and send errors are harmless", () => {
	assert.equal(send(undefined, {}), false);
	assert.equal(send({ readyState: 3 }, {}), false);
	assert.equal(send({ readyState: 1, bufferedAmount: 0, send() { throw new Error("closed"); } }, {}), false);
	let data = "";
	assert.equal(send({ readyState: 1, bufferedAmount: 0, send(value: string) { data = value; } }, { type: "sync" }), true);
	assert.equal(data, '{"type":"sync"}');
});

test("slow consumers are disconnected before unbounded buffering", () => {
	let closed = false;
	assert.equal(send({ readyState: 1, bufferedAmount: 3 * 1024 * 1024, close() { closed = true; } }, {}), false);
	assert.equal(closed, true);
});
