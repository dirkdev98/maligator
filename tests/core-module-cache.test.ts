import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import {
	decodeCoreModule,
	encodeCoreModule,
	importCoreModule,
} from "../src/compiler/core/core-module-artifact.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { loadOrCompileCoreModule } from "../src/core-module-cache.ts";
import { appendLeaf } from "./helpers/core-program-analysis.ts";

const source =
	"let n = 1; export function add(x) { n += x + (2 * 3); return n; } export function read() { return n; }";
const directories: Array<string> = [];
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function options() {
	const directory = mkdtempSync(path.join(os.tmpdir(), "core-module-"));
	directories.push(directory);
	return {
		source,
		sourcePath: "/first/pilot.mjs",
		moduleKey: "package:pilot",
		cacheDirectory: directory,
	};
}
it("loads completed optimized Core without construction or optimizer work in another checkout", () => {
	const input = options();
	const cold = loadOrCompileCoreModule(input);
	if (cold.status !== "ready") throw new Error(cold.reason);
	expect(cold.cache).toBe("miss");
	expect(cold.work).toEqual({ constructedFunctions: 3, optimizedFunctions: 3 });
	const operations = (artifact: typeof cold.canonical) =>
		artifact.functions.flatMap((fn) => fn.blocks.flatMap((block) => block.operations));
	expect(operations(cold.canonical).filter((op) => op.opcode === "binary")).toHaveLength(
		3,
	);
	expect(operations(cold.optimized).filter((op) => op.opcode === "binary")).toHaveLength(
		2,
	);
	const warm = loadOrCompileCoreModule({
		...input,
		sourcePath: "/second/pilot.mjs",
		onWork() {
			throw new Error("Warm cache repeated compiler work");
		},
	});
	expect(warm).toMatchObject({
		status: "ready",
		cache: "hit",
		work: { constructedFunctions: 0, optimizedFunctions: 0 },
	});
	if (warm.status !== "ready") throw new Error(warm.reason);
	const destination = new CoreProgram(coreOpcodeRegistry, {
		globalCount: 7,
		stringConstants: [[120], [121]],
		sourcePositions: [{ line: 99, column: 3 }],
	});
	appendLeaf(destination);
	const imported = importCoreModule(destination, warm.optimized, "/second/pilot.mjs");
	expect(imported.initializer).toBe(1);
	expect(imported.exports.get("add")).toBe(8);
	expect(destination.globalCount).toBe(10);
	expect(destination.function(imported.functions[1]!).metadata.sourcePath).toBe(
		"/second/pilot.mjs",
	);
	const second = importCoreModule(destination, warm.optimized, "/third/pilot.mjs");
	expect(second.exports.get("add")).toBe(11);
	expect(destination.globalCount).toBe(13);
	verifyCoreProgram(destination, { stage: "pre-target" });
});
it("misses after source or recipe changes and repairs a corrupt entry before import", () => {
	const input = options();
	const initial = loadOrCompileCoreModule(input);
	if (initial.status !== "ready") throw new Error(initial.reason);
	writeFileSync(path.join(input.cacheDirectory, `${initial.key}.json`), "partial");
	expect(loadOrCompileCoreModule(input)).toMatchObject({
		status: "ready",
		cache: "miss",
	});
	expect(
		loadOrCompileCoreModule({ ...input, source: source.replace("n = 1", "n = 2") }),
	).toMatchObject({ status: "ready", cache: "miss" });
	expect(loadOrCompileCoreModule({ ...input, maxWorkItems: 90_000 })).toMatchObject({
		status: "ready",
		cache: "miss",
	});
});
it.each([
	"import { x } from './missing.mjs'; export { x };",
	"export function* f() { yield 1; }",
	"export function f() { for (let x = 0; x < 2; x++) (() => x)(); }",
	"export async function f() { return 1; }",
])("declines unsupported boundaries: %s", (text) => {
	expect(loadOrCompileCoreModule({ ...options(), source: text })).toMatchObject({
		status: "unsupported",
	});
});
it("preserves special numbers and rejects an invalid relocation before destination mutation", () => {
	const result = loadOrCompileCoreModule({
		...options(),
		source:
			"export function negativeZero() { return -0; } export function numbers() { return [0/0, 1/0, -1/0]; }",
	});
	if (result.status !== "ready") throw new Error(result.reason);
	const decoded = decodeCoreModule(encodeCoreModule(result.optimized));
	expect(() =>
		decodeCoreModule(
			encodeCoreModule(result.optimized).replace('"$number":"-0"', '"$number":["-0"]'),
		),
	).toThrow();
	expect(Reflect.set(decoded.exports[0]!, "slot", 1000)).toBe(false);
	expect(Reflect.set(decoded.functions[0]!.metadata, "capturedCount", 1000)).toBe(false);
	expect(
		decoded.functions
			.flatMap((fn) => fn.blocks.flatMap((block) => block.operations))
			.some(
				(op) =>
					["createNumber", "createF64"].includes(op.opcode) &&
					Object.is(op.attributes.value, -0),
			),
	).toBe(true);
	const numbers = decoded.functions
		.flatMap((fn) => fn.blocks.flatMap((block) => block.operations))
		.filter((op) => ["createNumber", "createF64"].includes(op.opcode))
		.map((op) => op.attributes.value);
	for (const number of [NaN, Infinity, -Infinity])
		expect(numbers.some((value) => Object.is(value, number))).toBe(true);
	const bad = structuredClone(decoded);
	bad.exports = [{ name: "bad", slot: 1000 }];
	const destination = new CoreProgram(coreOpcodeRegistry, { globalCount: 4 });
	appendLeaf(destination);
	expect(() => importCoreModule(destination, bad, "/pilot.mjs")).toThrow();
	expect(destination.globalCount).toBe(4);
	expect([...destination.functionIds()]).toHaveLength(1);
});

it("does not alias distinct UTF-16 sources in persistent identities", () => {
	const input = options();
	const first = loadOrCompileCoreModule({
		...input,
		source: 'export function text() { return "\ud800"; }',
	});
	const second = loadOrCompileCoreModule({
		...input,
		source: 'export function text() { return "\ud801"; }',
	});
	expect(first).toMatchObject({ status: "ready", cache: "miss" });
	expect(second).toMatchObject({ status: "ready", cache: "miss" });
	if (first.status === "ready" && second.status === "ready")
		expect(first.key).not.toBe(second.key);
});

it("retains independent captured owners and rejects synthetic loop environments before import", () => {
	const input = options();
	const result = loadOrCompileCoreModule({
		...input,
		source:
			"const helper = x => x + 1; export function make(x) { const y = helper(x); return () => y; }",
	});
	if (result.status !== "ready") throw new Error(result.reason);
	expect(result.optimized.singleAssignmentGlobalSlots.length).toBeGreaterThan(0);
	expect(result.optimized.singleAssignmentCapturedSlots.length).toBeGreaterThan(0);
	const destination = new CoreProgram(coreOpcodeRegistry, { globalCount: 5 });
	appendLeaf(destination);
	const imported = importCoreModule(destination, result.optimized, "/moved.mjs");
	expect(imported.singleAssignmentCapturedSlots.every((slot) => slot.owner > 0)).toBe(
		true,
	);
	verifyCoreProgram(destination, { stage: "pre-target" });
	expect(
		loadOrCompileCoreModule({
			...input,
			source:
				"export function make() { let f; for(let i=0;i<1;i++){ const n=i; f=()=>n; } return f; }",
		}),
	).toMatchObject({ status: "unsupported" });
});

it("records budget-limited attempts without publishing completed bodies and retries a larger recipe", () => {
	const input = options();
	expect(loadOrCompileCoreModule({ ...input, maxWorkItems: 1 })).toMatchObject({
		status: "budget-limited",
	});
	expect(readdirSync(input.cacheDirectory)).toHaveLength(1);
	expect(
		loadOrCompileCoreModule({
			...input,
			maxWorkItems: 1,
			onWork() {
				throw new Error("Repeated incomplete recipe");
			},
		}),
	).toMatchObject({ status: "budget-limited" });
	expect(loadOrCompileCoreModule(input)).toMatchObject({
		status: "ready",
		cache: "miss",
	});
});

it("continues compilation when the optional cache cannot publish", () => {
	const input = options();
	const file = path.join(input.cacheDirectory, "not-a-directory");
	writeFileSync(file, "occupied");
	expect(loadOrCompileCoreModule({ ...input, cacheDirectory: file })).toMatchObject({
		status: "ready",
		cache: "miss",
	});
});

it("relocates literal pools, exception edges and string switches before importing boxed Core", () => {
	const result = loadOrCompileCoreModule({
		...options(),
		source: `
			export function literal() { return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, "nine", 10n, { key: -0 }]; }
			export function choose(key, callback) {
				try { switch (key) { case "a": return callback(1); case "b": return callback(2); default: return 3; } }
				catch (error) { return key + error; }
			}
			export class Derived extends Error { constructor(text) { super(text); } get detail() { return literal(); } }
		`,
	});
	if (result.status !== "ready") throw new Error(result.reason);
	const artifact = decodeCoreModule(encodeCoreModule(result.optimized));
	expect(artifact.literalTemplates.length).toBeGreaterThan(0);
	expect(artifact.bigints).toContain("10");
	expect(artifact.functions.some((fn) => fn.metadata.isDerivedConstructor)).toBe(true);
	const blocks = artifact.functions.flatMap((fn) => fn.blocks);
	expect(blocks.some((block) => block.handler !== undefined)).toBe(true);
	expect(blocks.some((block) => block.terminator.kind === "switch")).toBe(true);
	const numeric = structuredClone(artifact);
	const switchBlock = numeric.functions
		.flatMap((fn) => fn.blocks)
		.find((block) => block.terminator.kind === "switch")!;
	if (switchBlock.terminator.kind !== "switch") throw new Error("Missing switch");
	const edge = switchBlock.terminator.cases[0]!.edge;
	switchBlock.terminator = {
		...switchBlock.terminator,
		cases: [-0, NaN, Infinity, -Infinity].map((value) => ({
			value: { kind: "number", value },
			edge,
		})),
	};
	const decodedSwitch = decodeCoreModule(encodeCoreModule(numeric))
		.functions.flatMap((fn) => fn.blocks)
		.find((block) => block.terminator.kind === "switch")!.terminator;
	if (decodedSwitch.kind !== "switch") throw new Error("Missing decoded switch");
	expect(decodedSwitch.cases.map((item) => item.value)).toEqual(
		[-0, NaN, Infinity, -Infinity].map((value) => ({ kind: "number", value })),
	);
	const destination = new CoreProgram(coreOpcodeRegistry, {
		globalCount: 3,
		stringConstants: [[120]],
		bigintConstants: [99n],
		literalTemplateData: [8, 1, 6, 0],
	});
	appendLeaf(destination);
	importCoreModule(destination, artifact, "/shifted.mjs");
	importCoreModule(destination, artifact, "/second.mjs");
	verifyCoreProgram(destination, { stage: "pre-target" });
	expect(destination.bigintConstants).toEqual([99n, 10n, 10n]);
	const corruptions = [
		(bad: typeof artifact) => {
			bad.literalTemplates = [8, 2, 5, 0];
		},
		(bad: typeof artifact) => {
			bad.literalTemplates = [5, bad.strings.length];
		},
		(bad: typeof artifact) => {
			bad.bigints = ["01"];
		},
		(bad: typeof artifact) => {
			const block = bad.functions
				.flatMap((fn) => fn.blocks)
				.find((b) => b.handler !== undefined)!;
			block.handler = { block: 999_999 as typeof block.id, arguments: [] };
		},
		(bad: typeof artifact) => {
			const block = bad.functions
				.flatMap((fn) => fn.blocks)
				.find((b) => b.terminator.kind === "switch")!;
			const term = block.terminator;
			if (term.kind === "switch")
				block.terminator = {
					...term,
					cases: [
						{ value: { kind: "string", index: bad.strings.length }, edge: term.default },
					],
				};
		},
		(bad: typeof artifact) => {
			const op = bad.functions
				.flatMap((fn) => fn.blocks.flatMap((block) => block.operations))
				.find((op) => op.opcode === "instantiateLiteralTemplate")!;
			op.attributes = { templateOffset: 1 };
		},
		(bad: typeof artifact) => {
			const op = bad.functions
				.flatMap((fn) => fn.blocks.flatMap((block) => block.operations))
				.find((op) => op.opcode === "defineAccessor")!;
			op.attributes = { kind: ["set"], enumerable: false };
		},
	];
	for (const corrupt of corruptions) {
		const bad = structuredClone(artifact);
		corrupt(bad);
		const functions = destination.functionCapacity;
		const globals = destination.globalCount;
		expect(() => importCoreModule(destination, bad, "/corrupt.mjs")).toThrow();
		expect(destination.functionCapacity).toBe(functions);
		expect(destination.globalCount).toBe(globals);
	}
});

it("accepts long static property names and sparse argument reads without host argument limits", () => {
	const key = "key".repeat(50_000);
	const result = loadOrCompileCoreModule({
		...options(),
		source: `export function f(value) { return { ${JSON.stringify(key)}: value, missing: arguments[1000000] }; }`,
	});
	if (result.status !== "ready") throw new Error(result.reason);
	const artifact = decodeCoreModule(encodeCoreModule(result.optimized));
	const destination = new CoreProgram(coreOpcodeRegistry);
	importCoreModule(destination, artifact, "/long-key.mjs");
	verifyCoreProgram(destination, { stage: "pre-target" });
});
