import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const cancellations = new Set<() => void>();
export function cancelDecisions(): void { for (const cancel of [...cancellations]) cancel(); }

export function waitDecision<T>(ctx: ExtensionContext, promise: Promise<T>, cancelled: T, close: () => void): Promise<T> {
	return new Promise<T>(resolve => {
		let settled = false;
		const finish = (value: T) => {
			if (settled) return;
			settled = true; cancellations.delete(cancel); ctx.signal?.removeEventListener("abort", cancel); resolve(value);
		};
		const cancel = () => { finish(cancelled); close(); };
		cancellations.add(cancel);
		ctx.signal?.addEventListener("abort", cancel, { once: true });
		promise.then(finish, cancel);
		if (ctx.signal?.aborted) cancel();
	});
}

export function customDecision<T>(ctx: ExtensionContext, cancelled: T, factory: Parameters<ExtensionContext["ui"]["custom"]>[0], onCancel: () => void = () => {}): Promise<T> {
	let done: ((value: unknown) => void) | undefined;
	let cancelledOperation = false;
	const native = Promise.resolve().then(() => cancelledOperation ? cancelled : ctx.ui.custom<T>((tui, theme, keys, finish) => {
		done = finish as (value: unknown) => void;
		return factory(tui, theme, keys, done);
	}));
	return waitDecision(ctx, native.then(value => value ?? cancelled), cancelled, () => { cancelledOperation = true; done?.(cancelled); onCancel(); });
}
