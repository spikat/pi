type Bridge = { registerCommand(name: string, handler: (args: string) => Promise<void> | void): () => void };
type Contributor = ((bridge: Bridge) => void) & { key?: string; dispose?: () => void };
const CONTRIBUTORS = Symbol.for("spikat.pi.web.command-contributors");
const BRIDGE = Symbol.for("spikat.pi.web.bridge");

/** Keyed ownership prevents reloads retaining obsolete runtimes. */
export function registerWebCommand(name: string, handler: (args: string) => Promise<void> | void) {
	const globals = globalThis as Record<symbol, unknown>;
	let unregister: (() => void) | undefined;
	const contributor: Contributor = (bridge) => { unregister?.(); unregister = bridge.registerCommand(name, handler); };
	contributor.key = name;
	function dispose() {
		unregister?.(); unregister = undefined;
		(globals[CONTRIBUTORS] as Set<Contributor> | undefined)?.delete(contributor);
	}
	contributor.dispose = dispose;
	function activate() {
		let contributors = globals[CONTRIBUTORS] as Set<Contributor> | undefined;
		if (!contributors) { contributors = new Set(); globals[CONTRIBUTORS] = contributors; }
		for (const old of contributors) if (old !== contributor && old.key === name) old.dispose?.();
		contributors.add(contributor);
		const bridge = globals[BRIDGE] as Bridge | undefined;
		if (bridge) contributor(bridge);
	}
	activate();
	return { activate, dispose };
}
