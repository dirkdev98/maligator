import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSemanticAnalysisForGraph } from "../src/compiler/frontend/analyze-module-graph.ts";
import { buildModuleGraph } from "../src/compiler/frontend/module-graph.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";
import { inspectStaticValueFunctions } from "./helpers/static-values.ts";

function readerOpcodes(files: Readonly<Record<string, string>>): ReadonlyArray<string> {
	const root = mkdtempSync(join(tmpdir(), "mal-module-initialization-"));
	try {
		for (const [name, source] of Object.entries(files))
			writeFileSync(join(root, name), source);
		let opcodes: ReadonlyArray<string> = [];
		compileSemanticProgramToProgramImage(
			runSemanticAnalysisForGraph(buildModuleGraph(join(root, "entry.mjs"))),
			{
				afterCoreOptimization(program) {
					const reader = coreFunctionNamed(program, "reader");
					if (reader === undefined) throw new Error("Missing Core function reader");
					opcodes = coreOperations(reader).map((operation) => operation.opcode);
				},
			},
		);
		return opcodes;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const entry = `import { reader } from "./limits.mjs"; globalThis.result = reader(3);`;

describe("module bindings initialized before user code", () => {
	it("reads a constant initialized before the module can call out without a TDZ check", () => {
		const opcodes = readerOpcodes({
			"entry.mjs": entry,
			"limits.mjs": `
				const LIMIT = 1_000_000_007;
				const table = { scale: 3, names: ["a", "b"] };
				export function reader(value) { return (value * table.scale) % LIMIT; }
			`,
		});
		expect(opcodes).not.toContain("throwIfTdz");
	});

	it("keeps the check when the module can run user code before initializing", () => {
		const opcodes = readerOpcodes({
			"entry.mjs": entry,
			"limits.mjs": `
				export function reader(value) { return value % LIMIT; }
				globalThis.early = (() => { try { return reader(1); } catch { return "tdz"; } })();
				const LIMIT = 7;
			`,
		});
		expect(opcodes).toContain("throwIfTdz");
	});

	it("keeps the check for a module in an import cycle", () => {
		const opcodes = readerOpcodes({
			"entry.mjs": entry,
			"limits.mjs": `
				import "./entry.mjs";
				const LIMIT = 7;
				export function reader(value) { return value % LIMIT; }
			`,
		});
		expect(opcodes).toContain("throwIfTdz");
	});
});

function capturedReaders(source: string, names: ReadonlyArray<string>) {
	const inspected = inspectStaticValueFunctions(source, names);
	return Object.fromEntries(
		names.map((name) => [
			name,
			inspected.get(name)!.core.some((operation) => operation.opcode === "throwIfTdz"),
		]),
	);
}

describe("captured bindings initialized before their closures exist", () => {
	it("drops the check for closures created after the declaration", () => {
		expect(
			capturedReaders(
				`function outer(items) {
					const scale = items.length;
					const scaled = (item) => item * scale;
					const fns = [];
					for (let index = 0; index < items.length; index++) {
						const offset = index * 2;
						fns.push(function shifted() { return offset + index + scale; });
					}
					return [items.map(scaled), fns];
				}
				globalThis.outer = outer;`,
				["scaled", "shifted"],
			),
		).toEqual({ scaled: false, shifted: false });
	});

	it("keeps the check where a closure can run before the declaration", () => {
		expect(
			capturedReaders(
				`function outer(kind) {
					function hoisted() { return limit; }
					const before = () => limit;
					const early = [hoisted, before];
					const limit = early.length;
					switch (kind) {
						case 0:
							let late = limit;
							return early;
						default:
							return function skipped() { return late; };
					}
				}
				globalThis.outer = outer;`,
				["hoisted", "before", "skipped"],
			),
		).toEqual({ hoisted: true, before: true, skipped: true });
	});

	it("drops the owner's check after a dominating initialization only", () => {
		expect(
			capturedReaders(
				`function after(items) {
					const scale = items.length;
					const scaled = (item) => item * scale;
					return [items.map(scaled), scale];
				}
				function before(flag) {
					const early = flag ? late : 0;
					const late = 1;
					return [early, () => late];
				}
				globalThis.read = [after, before];`,
				["after", "before"],
			),
		).toEqual({ after: false, before: true });
	});

	it("drops the checks on a loop scope's own reads after its initialization", () => {
		expect(
			capturedReaders(
				`function loopAfter(items) {
					const out = [];
					for (const item of items) {
						out.push(() => item);
						out.push(item * 2);
					}
					return out;
				}
				function loopBefore(items) {
					const out = [];
					for (const item of items) {
						out.push(typeof late === "number" ? item : 0);
						let late = item;
						out.push(() => late);
					}
					return out;
				}
				globalThis.read = [loopAfter, loopBefore];`,
				["loopAfter", "loopBefore"],
			),
		).toEqual({ loopAfter: false, loopBefore: true });
	});
});
