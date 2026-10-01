import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, Text } from "@earendil-works/pi-tui";

const WEB_BRIDGE_SYMBOL = Symbol.for("spikat.pi.web.bridge");
export type ReviewWebDialog = {
	kind: "select" | "input";
	title: string;
	detail?: string;
	options?: string[];
	initial?: string;
	data?: Record<string, unknown>;
};
type WebDecision = { promise: Promise<unknown>; resolve(value: unknown): void };
type ReviewWebBridge = {
	active: boolean;
	openDecision(dialog: ReviewWebDialog): WebDecision | undefined;
	update(metadata: { status: "busy" | "idle" | "waiting" }): void;
};

/** Optional integration: review remains usable without the web package. */
export class ReviewUI {
	private readonly pending = new Set<() => void>();
	private disposed = false;

	private bridge(): ReviewWebBridge | undefined {
		const bridge = (globalThis as Record<symbol, unknown>)[WEB_BRIDGE_SYMBOL] as ReviewWebBridge | undefined;
		return bridge?.active && typeof bridge.openDecision === "function" && typeof bridge.update === "function" ? bridge : undefined;
	}

	get isDisposed(): boolean { return this.disposed; }
	available(ctx: ExtensionContext): boolean { return !this.disposed && (ctx.hasUI || !!this.bridge()); }
	status(status: "busy" | "idle" | "waiting"): void { this.bridge()?.update({ status }); }

	/** The first answer wins; close both views before opening the next dialog. */
	decide(ctx: ExtensionContext, dialog: ReviewWebDialog, local: (signal: AbortSignal) => Promise<string | null | undefined>): Promise<string | undefined> {
		if (!this.available(ctx)) return Promise.resolve(undefined);
		const bridge = this.bridge();
		const remote = bridge?.openDecision(dialog);
		const controller = new AbortController();
		const operationSignal = ctx.signal;
		const normalize = (value: unknown): string | undefined => typeof value === "string"
			&& (dialog.kind !== "select" || dialog.options?.includes(value)) ? value : undefined;
		return new Promise<string | undefined>((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				this.pending.delete(cancel);
				operationSignal?.removeEventListener("abort", cancel);
				controller.abort();
			};
			const finish = (value: unknown) => {
				if (settled) return;
				settled = true;
				const answer = normalize(value);
				// Settle before aborting the terminal dialog: its cancellation is not
				// a competing answer that may replace a valid browser selection.
				resolve(answer);
				remote?.resolve(answer);
				cleanup();
				bridge?.update({ status: "busy" });
			};
			const fail = (error: unknown) => {
				if (settled) return;
				settled = true;
				reject(error);
				remote?.resolve(undefined);
				cleanup();
				bridge?.update({ status: "busy" });
			};
			const cancel = () => finish(undefined);
			this.pending.add(cancel);
			operationSignal?.addEventListener("abort", cancel, { once: true });
			bridge?.update({ status: "waiting" });
			if (operationSignal?.aborted) { cancel(); return; }
			remote?.promise.then(finish, fail);
			// RPC has no terminal components to dismiss. With an active bridge,
			// use the browser there instead of leaving a second RPC dialog pending.
			if (ctx.hasUI && (!remote || ctx.mode === "tui")) {
				Promise.resolve().then(() => settled ? undefined : local(controller.signal)).then(finish, fail);
			} else if (!remote) cancel();
		});
	}

	select(ctx: ExtensionContext, title: string, options: string[]): Promise<string | undefined> {
		return this.decide(ctx, { kind: "select", title, options }, (signal) => ctx.ui.select(title, options, { signal }));
	}

	input(ctx: ExtensionContext, title: string, placeholder: string): Promise<string | undefined> {
		return this.decide(ctx, { kind: "input", title, data: { placeholder } }, (signal) => ctx.ui.input(title, placeholder, { signal }));
	}

	editor(ctx: ExtensionContext, title: string): Promise<string | undefined> {
		return this.decide(ctx, { kind: "input", title, data: { multiline: true } }, (signal) => {
			if (!this.bridge() || ctx.mode !== "tui") return ctx.ui.editor(title);
			return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
				const editor = new Editor(tui, {
					borderColor: (text) => theme.fg("accent", text),
					selectList: {
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: (text) => theme.fg("warning", text),
					},
				});
				let finished = false;
				const finish = (value: string | undefined) => {
					if (finished) return;
					finished = true;
					signal.removeEventListener("abort", cancel);
					done(value);
				};
				const cancel = () => finish(undefined);
				editor.onSubmit = finish;
				signal.addEventListener("abort", cancel, { once: true });
				if (signal.aborted) cancel();
				return {
					get focused() { return editor.focused; },
					set focused(value: boolean) { editor.focused = value; },
					render: (width) => [
						...new Text(theme.fg("accent", title), 0, 0).render(width),
						...editor.render(width),
						...new Text(theme.fg("dim", "Enter submit · Shift+Enter newline · Esc cancel"), 0, 0).render(width),
					],
					invalidate: () => editor.invalidate(),
					dispose: () => signal.removeEventListener("abort", cancel),
					handleInput: (data: string) => {
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) cancel();
						else editor.handleInput(data);
						tui.requestRender();
					},
				};
			});
		});
	}

	dispose(): void {
		this.disposed = true;
		for (const cancel of [...this.pending]) cancel();
	}
}
