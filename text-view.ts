/**
 * Scrollable read-only text overlay for command output.
 *
 * `/a6api list` and `/a6api <model>` print more lines than a notification can
 * hold, and pi's transcript has no "print this" path for extensions. The
 * overlay keeps the report readable and scrollable in the TUI, while other
 * modes fall back to `notify()`.
 */

import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";

/** pi's footer and the minimum chat viewport: the overlay never takes the whole terminal. */
const PI_CHROME_LINES = 8;
/** Title, two separators, and one hint row. */
const CHROME_LINES = 4;

export class TextViewComponent implements Component {
	private top = 0;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly title: string,
		private readonly lines: readonly string[],
		private readonly done: () => void,
	) {}

	dispose(): void {}

	private visibleHeight(): number {
		const rows = this.tui.terminal?.rows ?? 24;
		return Math.max(4, rows - PI_CHROME_LINES - CHROME_LINES);
	}

	private scroll(delta: number): void {
		const maxTop = Math.max(0, this.lines.length - this.visibleHeight());
		this.top = Math.max(0, Math.min(this.top + delta, maxTop));
		this.touch();
	}

	private touch(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) return this.scroll(-1);
		if (this.keybindings.matches(data, "tui.select.down")) return this.scroll(1);
		if (matchesKey(data, Key.pageUp)) return this.scroll(-this.visibleHeight());
		if (matchesKey(data, Key.pageDown)) return this.scroll(this.visibleHeight());
		if (matchesKey(data, Key.home)) {
			this.top = 0;
			return this.touch();
		}
		if (matchesKey(data, Key.end)) {
			this.top = Math.max(0, this.lines.length - this.visibleHeight());
			return this.touch();
		}
		// Enter, escape, and ctrl+c all close a read-only view.
		if (
			this.keybindings.matches(data, "tui.select.cancel") ||
			this.keybindings.matches(data, "tui.select.confirm") ||
			matchesKey(data, Key.ctrl("c")) ||
			matchesKey(data, Key.space)
		) {
			this.done();
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const theme = this.theme;
		const separator = theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
		const height = this.visibleHeight();
		const end = Math.min(this.lines.length, this.top + height);

		const lines: string[] = [separator, `  ${theme.bold(theme.fg("accent", this.title))}`, separator];
		for (let index = this.top; index < end; index += 1) {
			const line = this.lines[index] ?? "";
			lines.push(`  ${theme.fg("text", truncateToWidth(line, Math.max(1, width - 4)))}`);
		}
		for (let index = end; index < this.top + height; index += 1) {
			lines.push("");
		}
		const position = `${this.top + 1}-${end} of ${this.lines.length}`;
		lines.push(
			separator,
			`  ${theme.fg("dim", "↑↓ scroll · pgup/pgdn page · esc close")}  ${theme.fg("muted", position)}`,
		);

		this.cachedWidth = width;
		this.cachedLines = lines.map((line) => {
			const current = visibleWidth(line);
			return current >= width ? truncateToWidth(line, width) : line + " ".repeat(width - current);
		});
		return this.cachedLines;
	}
}
