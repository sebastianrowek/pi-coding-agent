/**
 * Model Picker Extension - sorted, filterable /m command.
 *
 * Registers a `/m` command that shows all available models sorted
 * alphabetically by provider then model id, with live filtering.
 *
 * Usage:
 *   /m            — open sorted model picker
 *   /m claude     — open picker pre-filtered to "claude"
 *
 * Installation: copy to ~/.pi/agent/extensions/model-picker.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	type SelectItem,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// FilterableSelectList — a self-contained component that renders an inline
// filter input line plus a scrolling item list.  SelectList's handleInput()
// only understands navigation keys, so we build the filtering logic ourselves.
// ---------------------------------------------------------------------------
class FilterableSelectList {
	private allItems: SelectItem[];
	private filteredItems: SelectItem[] = [];
	private selectedIndex = 0;
	private filterText = "";
	private maxVisible: number;
	private theme: {
		accent: (s: string) => string;
		muted: (s: string) => string;
		dim: (s: string) => string;
		warning: (s: string) => string;
		selected: (s: string) => string;
	};

	public onSelect?: (item: SelectItem) => void;
	public onCancel?: () => void;

	constructor(
		items: SelectItem[],
		maxVisible: number,
		theme: {
			accent: (s: string) => string;
			muted: (s: string) => string;
			dim: (s: string) => string;
			warning: (s: string) => string;
			selected: (s: string) => string;
		},
		initialFilter = "",
	) {
		this.allItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.filterText = initialFilter;
		this.refilter();
	}

	// ---- filtering --------------------------------------------------------

	private refilter(): void {
		if (!this.filterText) {
			this.filteredItems = this.allItems;
		} else {
			const q = this.filterText.toLowerCase();
			this.filteredItems = this.allItems.filter(
				(item) =>
					item.value.toLowerCase().includes(q) ||
					item.label.toLowerCase().includes(q) ||
					(item.description?.toLowerCase().includes(q) ?? false),
			);
		}
		// Clamp selection to new list length
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.filteredItems.length - 1));
	}

	// ---- rendering --------------------------------------------------------

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		// Filter input line
		const cursor = this.theme.accent("█");
		const filterLine = `  Filter: ${this.filterText}${cursor}`;
		lines.push(truncateToWidth(filterLine, width - 2, ""));

		// Separator
		lines.push(this.theme.dim(`  ${"─".repeat(Math.max(0, width - 4))}`));

		// Items
		if (this.filteredItems.length === 0) {
			lines.push(this.theme.warning("  No matching models"));
			return lines;
		}

		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

		// Compute column widths
		const PRIMARY_COL = 32;
		const prefixWidth = 2; // "→ " or "  "

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i]!;
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? "→ " : "  ";

			if (item.description && width > 50) {
				const maxPrimary = Math.min(PRIMARY_COL, width - prefixWidth - 4);
				const primaryStr = truncateToWidth(item.label, maxPrimary, "");
				const pad = " ".repeat(Math.max(1, maxPrimary + 2 - visibleWidth(primaryStr)));
				const descWidth = width - prefixWidth - maxPrimary - pad.length - 2;
				const descStr = descWidth > 5 ? truncateToWidth(item.description, descWidth, "") : "";

				const row = `${prefix}${primaryStr}${pad}${descStr}`;
				lines.push(isSelected ? this.theme.selected(row) : prefix + primaryStr + this.theme.muted(pad + descStr));
			} else {
				const maxW = width - prefixWidth - 2;
				const row = `${prefix}${truncateToWidth(item.label, maxW, "")}`;
				lines.push(isSelected ? this.theme.selected(row) : row);
			}
		}

		// Scroll indicator
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			lines.push(this.theme.dim(`  (${this.selectedIndex + 1}/${this.filteredItems.length})`));
		}

		return lines;
	}

	// ---- input handling ---------------------------------------------------

	handleInput(data: string): void {
		// Navigation
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const item = this.filteredItems[this.selectedIndex];
			if (item) this.onSelect?.(item);
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onCancel?.();
			return;
		}

		// Backspace — remove last char from filter
		if (matchesKey(data, Key.backspace)) {
			if (this.filterText.length > 0) {
				this.filterText = this.filterText.slice(0, -1);
				this.refilter();
			}
			return;
		}

		// Printable characters — append to filter
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.filterText += data;
			this.refilter();
			return;
		}
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
	pi.registerCommand("m", {
		description: "Switch model (sorted, filterable picker)",
		handler: async (args, ctx) => {
			// Fetch all models that have a valid API key configured.
			const available = await ctx.modelRegistry.getAvailable();

			if (available.length === 0) {
				ctx.ui.notify("No models available. Check your API keys.", "warning");
				return;
			}

			// Sort: alphabetically by provider, then by model id.
			const sorted = [...available].sort((a, b) => {
				const cmp = a.provider.localeCompare(b.provider);
				return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
			});

			// Build select items. Mark the currently active model.
			const currentModel = ctx.model;
			const items: SelectItem[] = sorted.map((m) => {
				const isActive = currentModel && m.provider === currentModel.provider && m.id === currentModel.id;
				return {
					value: `${m.provider}/${m.id}`,
					label: isActive ? `${m.id} ✓` : m.id,
					description: m.provider,
				};
			});

			const initialFilter = args?.trim() ?? "";
			const _theme = ctx.ui.theme;

			const chosen = await ctx.ui.custom<string | null>((tui, thm, _kb, done) => {
				const filterList = new FilterableSelectList(
					items,
					Math.min(items.length, 15),
					{
						accent: (s) => thm.fg("accent", s),
						muted: (s) => thm.fg("muted", s),
						dim: (s) => thm.fg("dim", s),
						warning: (s) => thm.fg("warning", s),
						selected: (s) => thm.fg("accent", s),
					},
					initialFilter,
				);

				filterList.onSelect = (item) => done(item.value);
				filterList.onCancel = () => done(null);

				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => thm.fg("accent", s)));
				container.addChild(
					new Text(thm.fg("accent", thm.bold(`Select Model  (${available.length} available)`)), 1, 0),
				);
				container.addChild(filterList as unknown as import("@earendil-works/pi-tui").Component);
				container.addChild(
					new Text(
						thm.fg(
							"dim",
							"↑↓ navigate  •  type to filter  •  backspace to clear  •  enter select  •  esc cancel",
						),
						1,
						0,
					),
				);
				container.addChild(new DynamicBorder((s: string) => thm.fg("accent", s)));

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						filterList.handleInput(data);
						tui.requestRender();
					},
				};
			});

			if (!chosen) return;

			const [provider, ...rest] = chosen.split("/");
			const modelId = rest.join("/");

			const model = ctx.modelRegistry.find(provider!, modelId);
			if (!model) {
				ctx.ui.notify(`Model not found: ${chosen}`, "error");
				return;
			}

			const ok = await pi.setModel(model);
			if (!ok) {
				ctx.ui.notify(`No API key available for ${chosen}`, "error");
			} else {
				ctx.ui.notify(`Switched to ${model.provider}/${model.id}`, "info");
			}
		},
	});
}
