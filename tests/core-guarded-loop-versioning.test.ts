import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import type { CoreProgram } from "../src/compiler/core/core-store.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import {
	compilerProgramFactsFromConfig,
	withProgramClosure,
	programClosureCertificate,
} from "../src/compiler/shared/compiler-facts.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";

function optimizedProgram(): CoreProgram {
	let optimized: CoreProgram | undefined;
	compileEntrypoint("tests/local/guarded-loop-versioning.mjs", {
		buildConfig: resolveBuildConfig({
			engine: { primordials: "mutable" },
			surface: { node: true },
		}),
		coreVerification: "per-pass",
		afterCoreOptimization(program) {
			optimized = program;
		},
	});
	return optimized!;
}

const program = optimizedProgram();

describe("guarded numeric loop versioning", () => {
	it.each(["methodLoop", "callbackLoop"])(
		"gives %s an unboxed recurrence while retaining generic completions",
		(name) => {
			const fn = coreFunctionNamed(program, name)!;
			const cfg = buildCoreControlFlow(program, fn.id);
			const numeric = cfg.loops.some((loop) => {
				const start = fn.kernel.blockParameterStart(loop.header);
				return Array.from(
					{ length: fn.kernel.blockParameterCount(loop.header) },
					(_, index) => fn.kernel.blockParameterValue(start + index),
				).some((value) => fn.valueRepresentation(value) === "f64");
			});
			expect(numeric).toBe(true);
			expect(
				coreOperations(fn).some(
					({ opcode, attributes, outputs }) =>
						opcode === "call" &&
						attributes.guardedInlineFallback === true &&
						outputs.some((value) => fn.valueRepresentation(value) === "boxed"),
				),
			).toBe(true);
		},
	);

	it("verifies mid-iteration generic entries with live values from the fast loop", () => {
		const fn = coreFunctionNamed(program, "methodLoop")!;
		const cfg = buildCoreControlFlow(program, fn.id);
		expect(cfg.irreducibleCycles.some((cycle) => cycle.entries.size > 1)).toBe(true);
		for (const cycle of cfg.irreducibleCycles)
			for (const block of cycle.entries) {
				expect(fn.kernel.blockParameterCount(block)).toBeGreaterThan(0);
			}
	});

	it.each([
		[1, true],
		[300, false],
	] as const)("bounds cloning for a loop with %i opaque calls", (width, expected) => {
		let edits = 0;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`
					class Account { calculate(value) { return value + this.offset; } }
					function compute(receiver, limit, touch) {
					let sum=0;
					for(let index=0; index<limit; index++) {
						${"touch(index);".repeat(width)}
						sum += receiver.calculate(index);
					}
					return sum;
				}
				globalThis.compute=compute;
					globalThis.Account=Account;
			`,
				"/guarded-loop-budget.mjs",
			),
			{
				facts: withProgramClosure(
					compilerProgramFactsFromConfig(resolveBuildConfig({})),
					programClosureCertificate(
						{ kind: "whole-program", entry: "/guarded-loop-budget.mjs" },
						[],
						[],
					),
				),
				coreInstrumentation: "full",
				afterCoreOptimization(program, _context, report) {
					const fn = coreFunctionNamed(program, "compute")!;
					expect(
						coreOperations(fn).some(
							({ attributes }) => attributes.guardedInlineFallback === true,
						),
					).toBe(true);
					edits =
						report.passes.find((pass) => pass.pass === "guarded-numeric-loop-versioning")
							?.edits ?? 0;
				},
			},
		);
		expect(edits > 0).toBe(expected);
	});
});
