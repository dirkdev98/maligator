import { expect, it } from "vitest";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "../src/compiler/core/core-internal-attributes.ts";
import type { CoreProgram } from "../src/compiler/core/core-store.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";

it("allocates a multi-slot for-of capture scope only on a guarded callback fallback", () => {
	let optimized: CoreProgram | undefined;
	compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`function findRows(rows, values) {
				let count = 0;
				for (const [id, adjustment] of rows) {
					let key = id + adjustment;
					if (id < 0) key = adjustment;
					count += values.some(value => value === id || value === key);
				}
				return count;
			}
			globalThis.findRows = findRows;`,
			"iteration-environment.js",
		),
		{
			afterCoreOptimization(program) {
				optimized = program;
			},
		},
	);
	const fn = coreFunctionNamed(optimized!, "findRows")!;
	const operations = coreOperations(fn);
	const fallbacks = operations.filter(
		({ opcode, attributes }) =>
			opcode === "call" && attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] === true,
	);
	expect(fallbacks).toHaveLength(1);
	expect(fn.kernel.blockHandlerBlock(fallbacks[0]!.block)).toBeDefined();
	expect(operations.filter(({ opcode }) => opcode === "envCopy")).toHaveLength(0);
	const allocations = operations.filter(({ opcode }) => opcode === "envPush");
	expect(allocations).toHaveLength(1);
	expect(allocations[0]!.block).toBe(fallbacks[0]!.block);
	expect(
		new Set(
			operations
				.filter(({ opcode }) => opcode === "storeCaptured")
				.map(({ attributes }) => attributes.index),
		).size,
	).toBe(2);
});
