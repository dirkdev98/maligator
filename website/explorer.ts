import type { ExplorerResult } from "../src/explorer/api.ts";
import { ExplorerClient, ExplorerClientError } from "../src/explorer/browser-client.ts";
import {
	EXPLORER_DEFAULT_CONFIG,
	explorerBuildConfig,
	normalizeExplorerConfig,
	normalizeExplorerLanguage,
	utf8ByteLength,
} from "../src/explorer/config.ts";
import type { ExplorerConfig } from "../src/explorer/config.ts";
import type { ExplorerSiteData } from "../src/explorer/protocol.ts";
import type { Sample, ViewId as SampleViewId } from "../src/explorer/samples.ts";

type ViewId = SampleViewId | "strippedSource";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
	const value = document.getElementById(id);
	if (value === null) throw new Error(`Missing explorer element: ${id}`);
	return value as T;
}

const data = JSON.parse(element("explorer-data").textContent) as ExplorerSiteData;
const source = element<HTMLTextAreaElement>("source");
const language = element<HTMLSelectElement>("language");
const examples = element<HTMLSelectElement>("example");
const trails = element<HTMLSelectElement>("trail");
const search = element<HTMLInputElement>("search");
const compare = element<HTMLInputElement>("compare");
const booleanSettings = [
	"regexp",
	"realms",
	"temporal",
	"intl",
	"webPlatform",
	"node",
	"maligator",
] as const;
const stages = [
	{
		id: "strippedSource",
		label: "0 · Type stripping",
		left: "source",
		leftTitle: "Your TypeScript",
		rightTitle: "JavaScript after type stripping",
		explanation:
			"Erasable types become spaces, preserving source positions. Types are not checked; syntax requiring JavaScript generation is rejected.",
	},
	{
		id: "preCore",
		label: "1 · Initial Core",
		left: "source",
		leftTitle: "JavaScript",
		rightTitle: "Core before optimization",
		explanation: "The source becomes an SSA graph before compiler optimizations.",
	},
	{
		id: "optimizedCore",
		label: "2 · Optimized Core",
		left: "preCore",
		leftTitle: "Core before optimization",
		rightTitle: "Optimized Core",
		explanation:
			"Constants, control flow and program facts shape the optimized SSA graph.",
	},
	{
		id: "target",
		label: "3 · Target",
		left: "optimizedCore",
		leftTitle: "Optimized Core",
		rightTitle: "Target and native plan",
		explanation:
			"The graph lowers to allocated terminal operations and selected native specializations.",
	},
	{
		id: "malw",
		label: "4 · MALW",
		left: "target",
		leftTitle: "Target",
		rightTitle: "Decoded MALW and hex",
		explanation:
			"The runtime image contains instructions, constant pools, handlers and GC safepoints.",
	},
	{
		id: "c",
		label: "5 · C",
		left: "target",
		leftTitle: "Target",
		rightTitle: "Emitted C",
		explanation:
			"Native function bodies and runtime-image tables, ready for the native toolchain.",
	},
] as const;
type Side = "left" | "right";
let stage: number = 1;
let result: ExplorerResult | undefined;
let compiledSource = "";
let requestVersion = 0;
const pages: Record<Side, number> = { left: 0, right: 0 };
const outputs: Record<Side, { text: string; view: ViewId }> = {
	left: { text: "", view: "source" },
	right: { text: "", view: "preCore" },
};
const PAGE_LINES = 300;

function status(message: string, state = "ready"): void {
	element("status").textContent = message;
	element("status").dataset.state = state;
}

const client = new ExplorerClient(data, (state) =>
	status(
		state === "loading"
			? `Loading the compiler locally (${(data.compressedBytes / 1024 / 1024).toFixed(1)} MiB compressed)…`
			: "Compiling locally…",
		state,
	),
);

function selectedSample(): Sample {
	return data.samples.find((sample) => sample.id === examples.value) ?? data.samples[0]!;
}

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

function applySettings(config: ExplorerConfig): void {
	element<HTMLSelectElement>("primordials").value = config.primordials;
	element<HTMLSelectElement>("eval").value = String(config.eval);
	for (const key of booleanSettings) element<HTMLInputElement>(key).checked = config[key];
}

function refreshInput(): void {
	const bytes = utf8ByteLength(source.value);
	element("source-size").textContent = `${(bytes / 1024).toFixed(1)} / 64 KiB`;
	const stale =
		result !== undefined &&
		(source.value !== compiledSource ||
			language.value !== result.language ||
			JSON.stringify(settings()) !== JSON.stringify(result.config));
	const badge = element("result-state");
	badge.textContent =
		result === undefined
			? "No result yet"
			: stale
				? "Previous result · edits not compiled"
				: "Up to date";
	badge.dataset.stale = String(stale);
}

function loadSample(): void {
	const sample = selectedSample();
	source.value = sample.source;
	language.value = sample.language ?? "javascript";
	stage = language.value === "typescript" ? 0 : 1;
	applySettings(normalizeExplorerConfig(sample.config ?? EXPLORER_DEFAULT_CONFIG));
	element("example-group").textContent = sample.group;
	element("example-title").textContent = sample.title;
	element("example-summary").textContent = sample.summary;
	trails.replaceChildren(
		new Option("Whole stage", ""),
		...sample.trails.map((trail, index) => new Option(trail.title, String(index))),
	);
	search.value = "";
	refreshInput();
	const url = new URL(location.href);
	url.searchParams.set("sample", sample.id);
	history.replaceState(null, "", url);
}

function setBusy(busy: boolean): void {
	element<HTMLButtonElement>("compile").disabled = busy;
	element<HTMLButtonElement>("cancel").disabled = !busy;
}

async function compile(): Promise<void> {
	const version = ++requestVersion;
	const input = source.value;
	setBusy(true);
	element("diagnostics").hidden = true;
	try {
		const output = await client.compile(
			input,
			settings(),
			normalizeExplorerLanguage(language.value),
		);
		if (version !== requestVersion) return;
		if (result?.language !== output.result.language)
			stage = output.result.language === "typescript" ? 0 : 1;
		result = output.result;
		compiledSource = input;
		status(
			output.cached
				? "Loaded from this tab’s result cache."
				: `Compiled locally in ${output.milliseconds.toFixed(0)} ms · ${(output.memoryBytes / 1024 / 1024).toFixed(1)} MiB Wasm memory.`,
		);
		const diagnostics = element("diagnostics");
		diagnostics.hidden = result.diagnostics.length === 0;
		diagnostics.textContent = result.diagnostics
			.map(
				(diagnostic) =>
					`${diagnostic.severity}: ${diagnostic.message} (${diagnostic.line}:${diagnostic.column})`,
			)
			.join("\n");
		pages.left = pages.right = 0;
		render(true);
		refreshInput();
	} catch (error) {
		if (version !== requestVersion) return;
		const message = error instanceof Error ? error.message : String(error);
		status(
			error instanceof ExplorerClientError && error.kind === "cancelled"
				? "Compilation cancelled."
				: "Compilation did not complete. You can edit and try again.",
			"error",
		);
		element("diagnostics").hidden = false;
		element("diagnostics").textContent = message;
		refreshInput();
	} finally {
		if (version === requestVersion) setBusy(false);
	}
}

function viewText(view: ViewId, mode: "generic" | "full"): string {
	if (result === undefined) return "Compile a snippet to inspect this stage.";
	if (view === "source") return compiledSource;
	if (view === "strippedSource") return result.strippedSource;
	if (view === "preCore") return result.preCore;
	if (view === "malw")
		return `${result.modes[mode].malw}\n\nHex dump\n${result.modes[mode].hex}`;
	return result.modes[mode][view];
}

function queryFor(view: ViewId): string {
	if (search.value !== "") return search.value;
	if (view === "strippedSource") return "";
	if (trails.value === "") return "";
	return selectedSample().trails[Number(trails.value)]?.queries[view] ?? "";
}

function renderPane(
	side: Side,
	view: ViewId,
	mode: "generic" | "full",
	title: string,
	focus: boolean,
): void {
	const text = viewText(view, mode);
	outputs[side] = { text, view };
	element(`${side}-kind`).textContent = compare.checked
		? `${mode} target lowering`
		: side === "left"
			? "Input stage"
			: "Output stage";
	element(`${side}-title`).textContent = title;
	const lines = text.split("\n");
	const query = queryFor(view);
	const firstMatch = query === "" ? -1 : lines.findIndex((line) => line.includes(query));
	if (focus && firstMatch >= 0) pages[side] = Math.floor(firstMatch / PAGE_LINES);
	pages[side] = Math.min(pages[side], Math.floor((lines.length - 1) / PAGE_LINES));
	const start = pages[side] * PAGE_LINES;
	const nodes = lines.slice(start, start + PAGE_LINES).map((line, offset) => {
		const row = document.createElement("span");
		row.className = "code-line";
		const number = document.createElement("span");
		number.className = "line-number";
		number.textContent = String(start + offset + 1);
		number.setAttribute("aria-hidden", "true");
		row.append(number);
		const index = query === "" ? -1 : line.indexOf(query);
		if (index < 0) row.append(document.createTextNode(line || " "));
		else {
			const mark = document.createElement("mark");
			mark.textContent = line.slice(index, index + query.length);
			row.append(
				document.createTextNode(line.slice(0, index)),
				mark,
				document.createTextNode(line.slice(index + query.length)),
			);
		}
		return row;
	});
	const code = element(`${side}-code`);
	code.replaceChildren(...nodes);
	if (focus && firstMatch >= start && firstMatch < start + PAGE_LINES)
		code.scrollTop = (firstMatch - start) * 20;
	else code.scrollTop = 0;
	element(`${side}-page`).textContent =
		`${start + 1}–${Math.min(lines.length, start + PAGE_LINES)} of ${lines.length} lines${query !== "" && firstMatch < 0 ? " · no match" : ""}`;
	element<HTMLButtonElement>(`${side}-previous`).disabled = pages[side] === 0;
	element<HTMLButtonElement>(`${side}-next`).disabled =
		start + PAGE_LINES >= lines.length;
	for (const action of ["copy", "save"])
		element<HTMLButtonElement>(`${side}-${action}`).disabled = result === undefined;
}

function render(focus = false): void {
	const typed = result?.language === "typescript";
	element("stage-0").hidden = !typed;
	if (!typed && stage === 0) stage = 1;
	const selected = stages[stage]!;
	compare.disabled = stage === 0;
	if (compare.disabled) compare.checked = false;
	for (const [index] of stages.entries())
		element(`stage-${index}`).setAttribute("aria-pressed", String(index === stage));
	const trail =
		trails.value === "" ? undefined : selectedSample().trails[Number(trails.value)];
	element("explanation").textContent =
		`${trail?.explanation ?? selected.explanation}${compare.checked ? " Generic uses the same optimized Core with late specialization disabled." : ""}`;
	renderPane(
		"left",
		compare.checked
			? selected.id
			: selected.id === "preCore" && typed
				? "strippedSource"
				: selected.left,
		compare.checked ? "generic" : "full",
		compare.checked ? `Generic · ${selected.rightTitle}` : selected.leftTitle,
		focus,
	);
	renderPane(
		"right",
		selected.id,
		"full",
		compare.checked ? `Full · ${selected.rightTitle}` : selected.rightTitle,
		focus,
	);
	element<HTMLButtonElement>("download-wire").disabled = result === undefined;
	if (result !== undefined) {
		const stats = result.modes.full.stats;
		element("statistics").textContent =
			`${stats.functions} functions · ${stats.instructions} instructions · ${stats.safepoints} safepoints · ${stats.wireBytes.toLocaleString()} MALW bytes · ${stats.cLines.toLocaleString()} C lines`;
		element("world").textContent =
			`Primordials ${result.world.primordialPolicy} · source ${result.closure.sourceClosure.kind === "known" ? "closed" : "open"}`;
	}
	if (element<HTMLDetailsElement>("structure").open) renderStructure();
}

function renderStructure(): void {
	element("structure-content").textContent =
		result === undefined
			? "Compile a snippet first."
			: JSON.stringify(
					{
						config: explorerBuildConfig(result.config),
						world: result.world,
						closure: result.closure,
						...result.modes.full.structure,
					},
					null,
					2,
				);
}

function download(name: string, contents: string | Uint8Array): void {
	const blob = new Blob(
		[typeof contents === "string" ? contents : (contents as Uint8Array<ArrayBuffer>)],
		{
			type:
				typeof contents === "string"
					? "text/plain;charset=utf-8"
					: "application/octet-stream",
		},
	);
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = name;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

for (const sample of data.samples)
	examples.add(new Option(`${sample.group} · ${sample.title}`, sample.id));
const requested = new URL(location.href).searchParams.get("sample");
if (data.samples.some((sample) => sample.id === requested)) examples.value = requested!;
element("version").textContent =
	`Maligator ${data.version}\nCompiler ${data.identity.slice(0, 12)}`;
for (const [index, candidate] of stages.entries()) {
	const button = document.createElement("button");
	button.id = `stage-${index}`;
	button.type = "button";
	button.textContent = candidate.label;
	button.onclick = () => {
		stage = index;
		pages.left = pages.right = 0;
		render(true);
	};
	element("stages").append(button);
}
element("compile").onclick = () => {
	void compile();
};
element("cancel").onclick = () => {
	requestVersion++;
	client.cancel();
	setBusy(false);
	status("Compilation cancelled.");
	refreshInput();
};
examples.onchange = () => {
	loadSample();
	void compile();
};
element("reset").onclick = () => {
	loadSample();
	void compile();
};
source.oninput = refreshInput;
language.onchange = refreshInput;
document.addEventListener("keydown", (event) => {
	if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
		event.preventDefault();
		void compile();
	}
});
for (const key of ["primordials", "eval", ...booleanSettings])
	element(key).onchange = refreshInput;
trails.onchange = () => {
	search.value = "";
	pages.left = pages.right = 0;
	render(true);
};
compare.onchange = () => {
	pages.left = pages.right = 0;
	render(true);
};
element("find").onclick = () => render(true);
search.onkeydown = (event) => {
	if (event.key === "Enter") render(true);
};
element<HTMLDetailsElement>("structure").ontoggle = () => {
	if (element<HTMLDetailsElement>("structure").open) renderStructure();
};
for (const side of ["left", "right"] as const) {
	element(`${side}-previous`).onclick = () => {
		pages[side] = Math.max(0, pages[side] - 1);
		render();
	};
	element(`${side}-next`).onclick = () => {
		pages[side]++;
		render();
	};
	element(`${side}-copy`).onclick = () => {
		void navigator.clipboard.writeText(outputs[side].text).then(
			() => status("Output copied."),
			() => status("Copy is unavailable; use Download instead.", "error"),
		);
	};
	element(`${side}-save`).onclick = () => {
		const view = outputs[side].view;
		download(
			view === "c"
				? "program.c"
				: view === "source"
					? result?.language === "typescript"
						? "snippet.ts"
						: "snippet.js"
					: view === "strippedSource"
						? "snippet.js"
						: `${view}.txt`,
			outputs[side].text,
		);
	};
}
element("download-wire").onclick = () => {
	if (result !== undefined)
		download("program.malw", new Uint8Array(result.modes.full.wire));
};
element("download-config").onclick = () => {
	const config = explorerBuildConfig(settings());
	download(
		"maligator.build.ts",
		`import { defineBuild } from "@maligator/cli";\n\nexport default defineBuild(${JSON.stringify({ entry: language.value === "typescript" ? "snippet.ts" : "snippet.js", engine: config.engine, surface: config.surface }, null, 2)});\n`,
	);
};
addEventListener("pagehide", () => client.dispose());
if (matchMedia("(max-width: 1000px)").matches)
	document.querySelector<HTMLDetailsElement>(".settings")!.open = false;
loadSample();
render();
