// The lifecycle tests use RPC dialogs; custom TUI rendering is deliberately unused.
export const getMarkdownTheme = () => ({});
export const isToolCallEventType = (name, event) => event.toolName === name;
export class Container {}
export class Markdown {}
export class SelectList {}
export class Spacer {}
export class Text {}
