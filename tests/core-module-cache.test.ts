import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	"export function f() { return globalThis.value; }",
	"export function f() { let x = 1; return () => x; }",
	"export async function f() { return 1; }",
])("declines unsupported boundaries: %s", (text) => {
	expect(loadOrCompileCoreModule({ ...options(), source: text })).toMatchObject({
		status: "unsupported",
	});
});
it("preserves special numbers and rejects an invalid relocation before destination mutation", () => {
	const result = loadOrCompileCoreModule({
		...options(),
		source: "export function negativeZero() { return -0; }",
	});
	if (result.status !== "ready") throw new Error(result.reason);
	const decoded = decodeCoreModule(encodeCoreModule(result.optimized));
	expect(
		decoded.functions
			.flatMap((fn) => fn.blocks.flatMap((block) => block.operations))
			.some(
				(op) =>
					["createNumber", "createF64"].includes(op.opcode) &&
					Object.is(op.attributes.value, -0),
			),
	).toBe(true);
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
