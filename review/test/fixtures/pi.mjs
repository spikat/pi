// Minimal components for exercising custom finding dialogs without a real terminal.
export const getMarkdownTheme = () => ({});
export const isToolCallEventType = (name, event) => event.toolName === name;
export const Key = { escape: "\x1b", ctrl: (key) => `ctrl+${key}` };
export const matchesKey = (data, key) => data === key;
export class Editor {
	focused = false;
	text = "";
	setText(text) { this.text = text; }
	render() { return this.text.split("\n"); }
	invalidate() {}
	handleInput(data) { this.onSubmit?.(data); }
}
export class Container {
	children = [];
	addChild(child) { this.children.push(child); }
	render(width) { return this.children.flatMap((child) => child.render(width)); }
	invalidate() {}
}
export class Text {
	constructor(text) { this.text = text; }
	render() { return this.text.split("\n"); }
}
export class Markdown extends Text {}
export class Spacer {
	constructor(height) { this.height = height; }
	render() { return Array(this.height).fill(""); }
}
export class SelectList {
	constructor(items) { this.items = items; }
	render() { return this.items.map(({ label }) => label); }
	handleInput(value) {
		if (value === "\x1b") this.onCancel?.();
		else this.onSelect?.(this.items.find((item) => item.value === value));
	}
	handleMouse() {}
}
