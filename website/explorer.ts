import type { ExplorerResult } from "../src/explorer/api.ts";
import { ExplorerClient, ExplorerClientError } from "../src/explorer/browser-client.ts";
import {
	EXPLORER_DEFAULT_CONFIG,
	explorerBuildConfig,
	normalizeExplorerConfig,
	utf8ByteLength,
} from "../src/explorer/config.ts";
import type { ExplorerConfig } from "../src/explorer/config.ts";
import type { ExplorerSiteData } from "../src/explorer/protocol.ts";
import { ExplorerCodeView } from "./explorer-code-view.ts";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
	const value = document.getElementById(id);
	if (value === null) throw new Error(`Missing explorer element: ${id}`);
	return value as T;
}

const data = JSON.parse(element("explorer-data").textContent) as ExplorerSiteData;
const source = new ExplorerCodeView(element("source-editor"));
const output = new ExplorerCodeView(element("c-editor"));
const examples = element<HTMLSelectElement>("example");
const functions = element<HTMLSelectElement>("function");
const tables = element<HTMLInputElement>("tables");
const linked = element<HTMLInputElement>("linked");
const booleanSettings = [
	"regexp",
	"realms",
	"temporal",
	"intl",
	"webPlatform",
	"node",
	"maligator",
] as const;
type MappingRange = ExplorerResult["mapping"]["ranges"][number];
let result: ExplorerResult | undefined;
let compiledSource = "";
let requestVersion = 0;
let activeSymbol: string | undefined;
let cLines: Array<string> = [];
let sourceRanges = new Map<number, Array<MappingRange>>();
let stale = false;
let matchedRanges: ReadonlyArray<MappingRange> = [];
let matchedIndex = 0;

function status(message: string, state = "ready"): void {
	element("status").textContent = message;
	element("status").dataset.state = state;
}

const client = new ExplorerClient(data, (state) =>
	status(
		state === "loading"
			? `Loading the compiler (${(data.compressedBytes / 1024 / 1024).toFixed(1)} MiB)…`
			: "Compiling locally…",
		state,
	),
);

function settings(): ExplorerConfig {
	const config: Record<string, unknown> = {
		primordials: element<HTMLSelectElement>("primordials").value,
		eval: element<HTMLSelectElement>("eval").value,
	};
	if (config.eval === "true") config.eval = true;
	if (config.eval === "false") config.eval = false;
	for (const key of booleanSettings) config[key] = element<HTMLInputElement>(key).checked;
	return normalizeExplorerConfig(config);
}

function clearHighlights(): void {
	source.highlight([]);
	output.highlight([]);
	element("range-navigation").hidden = true;
	element("mapping-help").textContent =
		"Select a source statement or a C line to see how they connect.";
}

function setMatchingRanges(
	ranges: ReadonlyArray<MappingRange>,
	selected: MappingRange,
): void {
	matchedRanges = ranges;
	matchedIndex = Math.max(0, ranges.indexOf(selected));
	element("range-navigation").hidden = ranges.length < 2;
	element("range-position").textContent = `${matchedIndex + 1} of ${ranges.length}`;
}

function revealRange(range: MappingRange): void {
	activeSymbol = range.symbol;
	if (!tables.checked && functions.value !== "" && functions.value !== range.symbol) {
		functions.value = range.symbol;
		renderC();
	}
	output.highlight(matchedRanges);
	output.reveal(range.startLine);
}

function refreshInput(): void {
	const sample = data.samples.find((item) => item.id === examples.value);
	if (sample !== undefined)
		element("example-summary").textContent =
			source.text === sample.source ? sample.title : "Your code";
	const bytes = utf8ByteLength(source.text);
	element("source-size").textContent = `${(bytes / 1024).toFixed(1)} / 64 KiB`;
	stale =
		result !== undefined &&
		(source.text !== compiledSource ||
			JSON.stringify(settings()) !== JSON.stringify(result.config));
	const badge = element("result-state");
	badge.textContent =
		result === undefined ? "Ready when you are" : stale ? "Out of date" : "Up to date";
	badge.dataset.stale = String(stale);
	element("mapping-state").textContent = stale
		? "Linking paused"
		: linked.checked
			? "Scrolling linked"
			: "Scrolling independent";
	if (stale) {
		clearHighlights();
		element("mapping-help").textContent =
			"Showing the previous compilation. Compile your edits to reconnect the panes.";
	} else
		element("mapping-help").textContent =
			"Select a source statement or a C line to see how they connect.";
}

function loadSample(): void {
	const sample =
		data.samples.find((item) => item.id === examples.value) ?? data.samples[0]!;
	source.setText(sample.source);
	const config = normalizeExplorerConfig(sample.config ?? EXPLORER_DEFAULT_CONFIG);
	element<HTMLSelectElement>("primordials").value = config.primordials;
	element<HTMLSelectElement>("eval").value = String(config.eval);
	for (const key of booleanSettings) element<HTMLInputElement>(key).checked = config[key];
	element("example-summary").textContent = sample.title;
	element("example-summary").title = sample.summary;
	refreshInput();
	const url = new URL(location.href);
	url.searchParams.set("sample", sample.id);
	history.replaceState(null, "", url);
}

function renderC(): void {
	if (result === undefined) return;
	const selected = result.mapping.functions.find((fn) => fn.symbol === functions.value);
	const all = result.mapping.functions;
	const first = tables.checked ? 1 : (selected?.startLine ?? all[0]?.startLine ?? 1);
	const last = tables.checked
		? cLines.length
		: (selected?.endLine ?? all.at(-1)?.endLine ?? cLines.length);
	output.setText(cLines.slice(first - 1, last).join("\n"), first);
	element("c-lines").textContent =
		`${first.toLocaleString()}–${last.toLocaleString()} of ${cLines.length.toLocaleString()} lines`;
	element("c-location").textContent = tables.checked
		? "Complete program"
		: selected === undefined
			? "Native functions · tables hidden"
			: selected.symbol;
}

function chooseRange(ranges: ReadonlyArray<MappingRange>): MappingRange | undefined {
	return (
		ranges.find(
			(range) =>
				range.symbol === activeSymbol &&
				range.endLine >= output.firstLine &&
				range.startLine <= output.lastLine,
		) ??
		ranges.find((range) => range.symbol === activeSymbol) ??
		ranges[0]
	);
}

function precisionLabel(range: MappingRange): string {
	return range.precision === "function"
		? " · function-level mapping"
		: range.precision === "region"
			? " · combined source region"
			: "";
}

function showSourceLine(
	line: number,
	scroll: boolean,
	preferred?: MappingRange,
): boolean {
	if (stale || result === undefined) return false;
	const ranges = sourceRanges.get(line) ?? [];
	const selected = preferred ?? chooseRange(ranges);
	source.highlight([{ startLine: line, endLine: line }]);
	output.highlight(ranges);
	if (selected === undefined) {
		element("range-navigation").hidden = true;
		element("mapping-help").textContent =
			`Source line ${line} has no mapped C. The compiler may have combined or removed it.`;
		return false;
	}
	setMatchingRanges(ranges, selected);
	activeSymbol = selected.symbol;
	if (scroll) revealRange(selected);
	element("mapping-help").textContent =
		`Source line ${line} ↔ ${ranges.length} C region${ranges.length === 1 ? "" : "s"} · ${selected.symbol}${precisionLabel(selected)}`;
	return true;
}

function showCLine(line: number, scroll: boolean): void {
	if (stale || result === undefined) return;
	const range = result.mapping.ranges.find(
		(item) => line >= item.startLine && line <= item.endLine,
	);
	if (range === undefined) {
		clearHighlights();
		element("mapping-help").textContent =
			`C line ${line} is compiler scaffolding without a source statement mapping.`;
		return;
	}
	activeSymbol = range.symbol;
	const origins = [...new Set(range.origins.map((origin) => origin.line))];
	setMatchingRanges(sourceRanges.get(origins[0]!) ?? [range], range);
	source.highlight(origins.map((origin) => ({ startLine: origin, endLine: origin })));
	output.highlight([range]);
	if (scroll) source.reveal(origins[0]!);
	element("mapping-help").textContent =
		`C lines ${range.startLine}–${range.endLine} ↔ source ${[...new Set(range.origins.map((origin) => `${origin.line}:${origin.column + 1}`))].join(", ")}${range.origins.some((origin) => origin.inlined) ? " · includes inlined code" : ""}${precisionLabel(range)}`;
}

for (const direction of ["previous", "next"] as const)
	element(`${direction}-range`).onclick = () => {
		if (stale || matchedRanges.length === 0) return;
		matchedIndex =
			(matchedIndex + (direction === "next" ? 1 : -1) + matchedRanges.length) %
			matchedRanges.length;
		const range = matchedRanges[matchedIndex]!;
		setMatchingRanges(matchedRanges, range);
		revealRange(range);
		element("mapping-help").textContent =
			`C lines ${range.startLine}–${range.endLine} ↔ source ${[...new Set(range.origins.map((origin) => `${origin.line}:${origin.column + 1}`))].join(", ")} · ${range.symbol}${precisionLabel(range)}`;
	};

source.onSelect = (line, column) => {
	source.reveal(line);
	element("source-location").textContent = `Ln ${line}, Col ${column}`;
	showSourceLine(line, true);
};
output.onSelect = (line, column) => {
	output.reveal(line);
	element("c-location").textContent = `Ln ${line}, Col ${column}`;
	showCLine(line, true);
};
source.onEdit = refreshInput;
source.onScroll = (first, last) => {
	if (!linked.checked || stale || result === undefined) return;
	for (let line = first; line <= last; line++)
		if (sourceRanges.has(line)) {
			showSourceLine(line, true);
			break;
		}
};
output.onScroll = (first, last) => {
	if (!linked.checked || stale || result === undefined) return;
	const range = result.mapping.ranges.find(
		(item) => item.startLine <= last && item.endLine >= first,
	);
	if (range !== undefined) showCLine(Math.max(first, range.startLine), true);
};

function setBusy(busy: boolean): void {
	element<HTMLButtonElement>("compile").disabled = busy;
	element("cancel").hidden = !busy;
	element("c-editor").setAttribute("aria-busy", String(busy));
}

async function compile(): Promise<void> {
	const version = ++requestVersion;
	const input = source.text;
	setBusy(true);
	element("diagnostics").hidden = true;
	try {
		const compiled = await client.compile(input, settings());
		if (version !== requestVersion) return;
		result = compiled.result;
		compiledSource = input;
		activeSymbol = undefined;
		cLines = result.c.split("\n");
		sourceRanges = new Map();
		for (const range of result.mapping.ranges)
			for (const line of new Set(range.origins.map((origin) => origin.line))) {
				const ranges = sourceRanges.get(line) ?? [];
				ranges.push(range);
				sourceRanges.set(line, ranges);
			}
		functions.replaceChildren(
			new Option("All native functions", ""),
			...result.mapping.functions.map(
				(fn) => new Option(`${fn.name} · ${fn.symbol}`, fn.symbol),
			),
		);
		functions.disabled = false;
		tables.checked = false;
		renderC();
		element("empty-state").hidden = true;
		for (const id of ["c-copy", "c-save"])
			element<HTMLButtonElement>(id).disabled = false;
		status(
			compiled.cached
				? "Loaded from this tab’s result cache."
				: `Compiled locally in ${compiled.milliseconds.toFixed(0)} ms · ${(compiled.memoryBytes / 1024 / 1024).toFixed(1)} MiB Wasm memory.`,
		);
		const diagnostics = element("diagnostics");
		diagnostics.hidden = result.diagnostics.length === 0;
		diagnostics.textContent = result.diagnostics
			.map((item) => `${item.severity}: ${item.message} (${item.line}:${item.column})`)
			.join("\n");
		element("statistics").textContent =
			`${result.stats.functions} functions · ${result.stats.cLines.toLocaleString()} C lines`;
		refreshInput();
		if (!stale) {
			const first = result.mapping.ranges.find(
				(range) => range.precision === "statement" && range.endLine > range.startLine,
			);
			if (first !== undefined) showSourceLine(first.origins[0]!.line, true, first);
		}
	} catch (error) {
		if (version !== requestVersion) return;
		const cancelled = error instanceof ExplorerClientError && error.kind === "cancelled";
		status(
			cancelled
				? "Compilation cancelled."
				: "Compilation did not complete. Edit your code and try again.",
			cancelled ? "ready" : "error",
		);
		element("diagnostics").hidden = cancelled;
		element("diagnostics").textContent =
			error instanceof Error ? error.message : String(error);
		refreshInput();
	} finally {
		if (version === requestVersion) setBusy(false);
	}
}

function download(name: string, text: string): void {
	const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

for (const sample of data.samples) examples.add(new Option(sample.title, sample.id));
const requested = new URL(location.href).searchParams.get("sample");
examples.value = data.samples.some((sample) => sample.id === requested)
	? requested!
	: "control-flow";
element("version").textContent =
	`Maligator ${data.version}\nCompiler ${data.identity.slice(0, 12)}`;
for (const id of ["compile", "empty-compile"])
	element(id).onclick = () => {
		void compile();
	};
element("cancel").onclick = () => {
	requestVersion++;
	client.cancel();
	setBusy(false);
	status("Compilation cancelled.");
};
examples.onchange = () => {
	loadSample();
	void compile();
};
element("reset").onclick = () => {
	loadSample();
	void compile();
};
element("settings-toggle").onclick = () => {
	const panel = element("settings");
	panel.hidden = !panel.hidden;
	element("settings-toggle").setAttribute("aria-expanded", String(!panel.hidden));
};
for (const key of ["primordials", "eval", ...booleanSettings])
	element(key).onchange = refreshInput;
linked.onchange = refreshInput;
functions.onchange = () => {
	tables.checked = false;
	activeSymbol = functions.value || undefined;
	renderC();
	clearHighlights();
};
tables.onchange = () => {
	functions.value = "";
	renderC();
	clearHighlights();
};
for (const side of ["source", "c"] as const)
	element(`${side}-copy`).onclick = () => {
		const text = side === "source" ? source.text : (result?.c ?? "");
		void navigator.clipboard.writeText(text).then(
			() => status("Code copied."),
			() => status("Copy is unavailable. Select the code or use Download.", "error"),
		);
	};
element("c-save").onclick = () => {
	if (result !== undefined) download("program.c", result.c);
};
element("download-config").onclick = () => {
	const config = explorerBuildConfig(settings());
	download(
		"maligator.build.ts",
		`import { defineBuild } from "@maligator/cli";\n\nexport default defineBuild(${JSON.stringify({ entry: "snippet.ts", engine: config.engine, surface: config.surface }, null, 2)});\n`,
	);
};
document.addEventListener("keydown", (event) => {
	if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
		event.preventDefault();
		void compile();
	}
});
addEventListener("pagehide", () => client.dispose());
loadSample();
