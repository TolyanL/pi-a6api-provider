/**
 * `/a6api` — searchable model browser for the A6API catalog.
 *
 * One provider, so the screen is a filtered list plus a detail pane for the
 * selected model: price, cache price, long-context tiers, context/output
 * estimates, vendor, gateway groups, and flags. Enter switches the session
 * model when the entry is a chat model; generators and embeddings only report
 * their price.
 */

import {
	decodeKittyPrintable,
	fuzzyFilter,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { CatalogModel } from "./catalog.ts";
import { describeLines, formatTokens, kindLabel, pricePair } from "./info.ts";

/** Header/footer chrome of the picker: 2 borders, title, search, 2 hint rows. */
const PICKER_LINES = 6;
/** pi's footer and the minimum chat viewport: the picker never gets the whole terminal. */
const PI_CHROME_LINES = 8;
const MAX_LIST_ROWS = 12;
/** The detail pane is fixed-height so the list does not jump while scrolling. */
const DETAIL_LINES = 7;

type SortMode = "name" | "price" | "context";

const SORT_LABELS: Record<SortMode, string> = {
	name: "name",
	price: "cheapest",
	context: "largest context",
};

const SORT_ORDER: SortMode[] = ["name", "price", "context"];

export interface PickerOptions {
	models: readonly CatalogModel[];
	/** Id of the model active in the session, marked with ✓. */
	currentId?: string;
	initialQuery?: string;
	/** Re-read the catalog; the picker replaces its list with the result. */
	refresh: () => Promise<{ models: readonly CatalogModel[]; warning?: string }>;
	/** Switch the session model. Returns false when pi refused (e.g. no auth). */
	select: (model: CatalogModel) => Promise<boolean>;
}

export class A6ApiPickerComponent implements Component {
	private models: CatalogModel[];
	private readonly currentId: string | undefined;
	private readonly refreshCatalog: PickerOptions["refresh"];
	private readonly onSelect: PickerOptions["select"];
	private readonly onDone: (model: CatalogModel | undefined) => void;

	private query: string;
	private sort: SortMode = "name";
	private rows: CatalogModel[] = [];
	private selected = 0;
	private top = 0;
	private status: string | undefined;
	private refreshing = false;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		options: PickerOptions,
		done: (model: CatalogModel | undefined) => void,
	) {
		this.models = [...options.models];
		this.currentId = options.currentId;
		this.refreshCatalog = options.refresh;
		this.onSelect = options.select;
		this.onDone = done;
		this.query = options.initialQuery?.trim() ?? "";
		this.rebuild();
	}

	dispose(): void {}

	// ── state ────────────────────────────────────────────────────────

	private compare(a: CatalogModel, b: CatalogModel): number {
		if (this.sort === "price") {
			const priceOf = (model: CatalogModel): number => {
				if (model.kind === "chat") return model.cost.input;
				return model.pricing?.perCallUsd ?? Number.POSITIVE_INFINITY;
			};
			const delta = priceOf(a) - priceOf(b);
			if (Number.isFinite(delta) && delta !== 0) return delta;
		} else if (this.sort === "context") {
			const delta = b.contextWindow - a.contextWindow;
			if (delta !== 0) return delta;
		}
		return a.id.localeCompare(b.id);
	}

	private rebuild(preferredId?: string): void {
		const previousId = preferredId ?? this.rows[this.selected]?.id;
		const sorted = [...this.models].sort((a, b) => this.compare(a, b));
		const query = this.query.trim();
		const visible = query
			? fuzzyFilter(sorted, query, (model) => `${model.id} ${model.name} ${model.vendor ?? ""} ${model.kind}`)
			: sorted;

		this.rows = visible;
		let index = previousId ? this.rows.findIndex((model) => model.id === previousId) : -1;
		if (index === -1) index = this.rows.findIndex((model) => model.id === this.currentId);
		if (index === -1) index = 0;
		this.selected = Math.max(0, Math.min(index, this.rows.length - 1));
		this.ensureVisible();
	}

	private visibleListHeight(): number {
		const rows = this.tui.terminal?.rows ?? 24;
		const available = rows - PICKER_LINES - PI_CHROME_LINES - DETAIL_LINES;
		return Math.max(3, Math.min(MAX_LIST_ROWS, available));
	}

	private ensureVisible(): void {
		const height = this.visibleListHeight();
		const maxTop = Math.max(0, this.rows.length - height);
		if (this.selected < this.top) this.top = this.selected;
		if (this.selected >= this.top + height) this.top = this.selected - height + 1;
		this.top = Math.max(0, Math.min(this.top, maxTop));
	}

	private touch(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private move(delta: number): void {
		if (this.rows.length === 0) return;
		const next = Math.max(0, Math.min(this.selected + delta, this.rows.length - 1));
		if (next === this.selected) return;
		this.selected = next;
		this.ensureVisible();
		this.touch();
	}

	private setQuery(query: string): void {
		this.query = query.slice(0, 60);
		this.rebuild();
		this.touch();
	}

	private cycleSort(): void {
		const index = SORT_ORDER.indexOf(this.sort);
		this.sort = SORT_ORDER[(index + 1) % SORT_ORDER.length] ?? "name";
		this.rebuild();
		this.touch();
	}

	private setStatus(text: string | undefined): void {
		this.status = text;
		this.touch();
	}

	private async refresh(): Promise<void> {
		if (this.refreshing) return;
		this.refreshing = true;
		this.touch();
		try {
			const result = await this.refreshCatalog();
			this.models = [...result.models];
			this.rebuild();
			this.setStatus(result.warning);
		} catch (error) {
			this.setStatus(`refresh failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.refreshing = false;
			this.touch();
		}
	}

	private async select(): Promise<void> {
		const model = this.rows[this.selected];
		if (!model) return;
		if (model.kind !== "chat") {
			this.setStatus(`${model.id} is ${kindLabel(model.kind)}-only: no chat endpoint to switch to`);
			return;
		}
		if (model.hidden) {
			this.setStatus(`${model.id} is hidden in ~/.pi/agent/a6api.json`);
			return;
		}
		const ok = await this.onSelect(model);
		if (ok) {
			this.onDone(model);
			return;
		}
		this.setStatus(`pi did not switch to ${model.id} (check /login for this provider)`);
	}

	// ── input ────────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) return this.move(-1);
		if (this.keybindings.matches(data, "tui.select.down")) return this.move(1);
		if (matchesKey(data, Key.pageUp)) return this.move(-this.visibleListHeight());
		if (matchesKey(data, Key.pageDown)) return this.move(this.visibleListHeight());
		if (matchesKey(data, Key.home)) {
			this.selected = 0;
			this.ensureVisible();
			return this.touch();
		}
		if (matchesKey(data, Key.end)) {
			this.selected = Math.max(0, this.rows.length - 1);
			this.ensureVisible();
			return this.touch();
		}
		if (matchesKey(data, Key.tab)) {
			this.cycleSort();
			return;
		}
		if (matchesKey(data, Key.ctrl("r"))) {
			void this.refresh();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			void this.select();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) {
			this.onDone(undefined);
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.setQuery(this.query.slice(0, -1));
			return;
		}
		if (matchesKey(data, Key.space)) {
			this.setQuery(`${this.query} `);
			return;
		}
		const text = printableText(data);
		if (text) this.setQuery(this.query + text);
	}

	// ── render ───────────────────────────────────────────────────────

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const theme = this.theme;
		const separator = theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
		const lines: string[] = [separator, this.renderTitle(), this.renderSearch(), separator];

		const height = this.visibleListHeight();
		const end = Math.min(this.rows.length, this.top + height);
		if (this.rows.length === 0) {
			lines.push(theme.fg("warning", `  ${this.emptyHint()}`));
		} else {
			const idWidth = Math.min(
				34,
				Math.max(...this.rows.map((model) => model.id.length), 8),
			);
			for (let index = this.top; index < end; index += 1) {
				const model = this.rows[index];
				if (model) lines.push(this.renderRow(model, index === this.selected, idWidth, width));
			}
		}

		lines.push(separator, ...this.renderDetail(width), separator, ...this.renderHints(width));
		this.cachedWidth = width;
		this.cachedLines = lines.map((line) => {
			const current = visibleWidth(line);
			return current >= width ? truncateToWidth(line, width) : line + " ".repeat(width - current);
		});
		return this.cachedLines;
	}

	private renderTitle(): string {
		const theme = this.theme;
		const counts = `${this.rows.length}/${this.models.length}`;
		const sort = theme.fg("muted", `sort: ${SORT_LABELS[this.sort]}`);
		const refreshing = this.refreshing ? theme.fg("warning", " refreshing…") : "";
		return `  ${theme.bold(theme.fg("accent", "A6API models"))}  ${theme.fg("dim", counts)}  ${sort}${refreshing}`;
	}

	private renderSearch(): string {
		const theme = this.theme;
		const value =
			this.query.length > 0
				? `${theme.fg("text", this.query)}${theme.fg("accent", "▏")}`
				: theme.fg("dim", "… type to filter by id, name, vendor, or kind");
		return `  ${theme.fg("muted", "Search:")} ${value}`;
	}

	private renderRow(model: CatalogModel, isSelected: boolean, idWidth: number, width: number): string {
		const theme = this.theme;
		const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
		const current = model.id === this.currentId ? theme.fg("accent", "✓ ") : "  ";
		const paint = (text: string): string => (isSelected ? theme.fg("accent", text) : text);

		// One leading space keeps the price column off the id on wide terminals.
		const price = ` ${pricePair(model)}`.padEnd(18);
		const context = formatTokens(model.contextWindow).padStart(5);
		const flags: string[] = [];
		if (model.kind !== "chat") flags.push(kindLabel(model.kind));
		if (model.reasoning) flags.push("R");
		if (model.vision) flags.push("V");
		if (model.hidden) flags.push(theme.fg("dim", "hidden"));

		// Columns: cursor, current mark, id, price, context, flags, then the display
		// name in whatever is left. The id shrinks before the name disappears.
		const fixed = 2 + 2 + 1 + 17 + 5 + 2; // cursor, current, space, price, context, gap
		const flagText = flags.join(" ");
		const room = Math.max(8, width - fixed - flagText.length);
		const nameWidth = room > idWidth + 8 ? room - idWidth - 1 : 0;
		const idRoom = Math.max(8, room - nameWidth);
		const id = truncateToWidth(model.id, idRoom);
		const idPadded = id + " ".repeat(Math.max(0, idRoom - visibleWidth(id)));
		const suffix =
			nameWidth > 6 && model.name !== model.id
				? theme.fg("dim", ` ${truncateToWidth(model.name, nameWidth - 1)}`)
				: "";

		return `${cursor}${current}${paint(idPadded)}${theme.fg("muted", price)}${theme.fg("muted", context)}  ${flagText}${suffix}`;
	}

	private renderDetail(width: number): string[] {
		const theme = this.theme;
		const model = this.rows[this.selected];
		if (!model) return [""];
		const detail = describeLines(model).slice(0, DETAIL_LINES);
		const lines = detail.map((line) => theme.fg("muted", `  ${truncateToWidth(line, Math.max(1, width - 4))}`));
		while (lines.length < DETAIL_LINES) lines.push("");
		return lines;
	}

	private renderHints(width: number): string[] {
		const theme = this.theme;
		const primary = ["↑↓ move", "⏎ use model", "esc close", "type to filter", "tab sort", "ctrl+r refresh"];
		const compact = ["↑↓", "⏎", "esc", "tab", "ctrl+r"];
		const fits = (parts: string[], budget: number): boolean => visibleWidth(parts.join(" · ")) <= budget;
		const budget = Math.max(8, width - 2);
		const chosen = fits(primary, budget)
			? primary
			: compact;
		const kept = [...chosen];
		while (kept.length > 1 && !fits(kept, budget)) kept.pop();
		// Problems go on their own row: appending them to the hints silently
		// truncates the very message the user needs to read.
		const status = this.status ? `  ${theme.fg("warning", truncateToWidth(this.status, Math.max(1, width - 2)))}` : "  ";
		return [`  ${theme.fg("dim", kept.join(" · "))}`, status];
	}

	private emptyHint(): string {
		if (this.query.trim().length > 0) return "Nothing matched: backspace clears the filter, esc closes.";
		return "No models cached: ctrl+r refreshes from the gateway.";
	}
}

/** Printable text typed into the filter, or undefined for control/escape sequences. */
function printableText(data: string): string | undefined {
	if (!data) return undefined;
	const text = decodeKittyPrintable(data) ?? data;
	if (text.startsWith("\x1b")) return undefined;
	if (/[\x00-\x1f\x7f]/.test(text)) return undefined;
	return text;
}
