import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSemanticAnalysisForGraph } from "../src/compiler/frontend/analyze-module-graph.ts";
import { buildModuleGraph } from "../src/compiler/frontend/module-graph.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";

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
