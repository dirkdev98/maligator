import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { WASI } from "node:wasi";
import { compileExplorerRequest } from "../src/explorer/api.ts";
import { EXPLORER_SCHEMA } from "../src/explorer/config.ts";
import { SAMPLES } from "../src/explorer/samples.ts";
import { WasmEngine } from "../src/wasm-embedding.ts";

const stress = process.argv.includes("--stress");
const bytes = readFileSync(".cache/wasm/explorer.wasm");
const wasi = new WASI({
	version: "preview1",
	args: [],
	env: {
		TZ: "UTC",
		...(stress ? { MAL_GC_STRESS: "1000", MAL_GC_VERIFY: "1", MAL_GC_STATS: "1" } : {}),
	},
	preopens: {},
	returnOnExit: true,
});
const instance = new WebAssembly.Instance(
	new WebAssembly.Module(bytes),
	wasi.getImportObject() as WebAssembly.Imports,
);
wasi.initialize(instance);
const engine = new WasmEngine(instance);
const cases = [
	...SAMPLES.map((sample) => ({
		name: sample.id,
		source: sample.source,
		config: sample.config ?? {},
		language: sample.language ?? "javascript",
	})),
	{
		name: "exports-unicode",
		source: 'export const text = "café 🐊"; export default text;',
		config: {},
	},
	...([true, false, "compile-check"] as const).map((evalMode) => ({
		name: `eval-${evalMode}`,
		source: 'globalThis.value = eval("40 + 2");',
		config: { eval: evalMode },
	})),
	{
		name: "mutable",
		source: "Array.prototype.extra = 42; globalThis.x = [].extra;",
		config: { primordials: "mutable" },
	},
	{
		name: "regexp-disabled",
		source: 'globalThis.match = /a+/.test("aa");',
		config: {},
	},
	{ name: "syntax-error", source: "const = ;", config: {} },
	{
		name: "nonerasable-types",
		source: "enum Color { Red }",
		config: {},
		language: "typescript",
	},
	{ name: "after-error", source: "globalThis.answer = 42;", config: {} },
	{
		name: "medium",
		source: Array.from(
			{ length: 40 },
			(_, i) =>
				`function f${i}(n) { let total = 0; for (let i = 0; i < n; i++) total += i * ${i + 1}; return total; } globalThis.r${i} = f${i}(10);`,
		).join("\n"),
		config: {},
	},
];
const rows = [];
try {
	for (const item of cases) {
		const input = JSON.stringify({
			schema: EXPLORER_SCHEMA,
			source: item.source,
			config: item.config,
			language: "language" in item ? item.language : "javascript",
		});
		const expected = compileExplorerRequest(input);
		const start = performance.now();
		const actual = engine.call("__compileExplorer", input);
		const row = {
			name: item.name,
			equal: expected === actual,
			milliseconds: performance.now() - start,
			outputBytes: Buffer.byteLength(actual),
			memoryBytes: engine.memoryBytes,
		};
		rows.push(row);
		console.log(JSON.stringify(row));
		if (!row.equal) {
			writeFileSync(`.cache/explorer-parity-${item.name}-expected.json`, expected);
			writeFileSync(`.cache/explorer-parity-${item.name}-actual.json`, actual);
			throw new Error(`Full compiler output differs for ${item.name}`);
		}
	}
	if (stress && Number(engine.api.mal_wasm_collection_count()) === 0)
		throw new Error("Stress run did not collect");
	const report = {
		wasm: createHash("sha256").update(bytes).digest("hex"),
		stress,
		collections: Number(engine.api.mal_wasm_collection_count()),
		rows,
	};
	writeFileSync(
		`.cache/explorer-parity${stress ? "-stress" : ""}.json`,
		`${JSON.stringify(report, null, 2)}\n`,
	);
	console.log(
		`Passed ${rows.length} complete output comparisons; ${Number(engine.api.mal_wasm_collection_count())} collections`,
	);
} finally {
	engine.dispose();
}
