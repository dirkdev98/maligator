import { expect, test } from "vitest";
import type { OptimizationAblation } from "../src/compiler-diagnostics.ts";
import {
	executeIROptimizations,
	executeIRTransformOptimizations,
	finalizeIROptimizations,
} from "../src/ir-opt.ts";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import type { IntermediateProgram, IRInstruction } from "../src/ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

const inlineSource = `
	function outer(value) {
		function addOne(input) { return input + 1; }
		return addOne(value);
	}
	globalThis.keep = outer;
`;

function optimize(
	source: string,
	ablations: ReadonlySet<OptimizationAblation> = new Set(),
): IntermediateProgram {
	const program = compileSemanticProgramToIr(
		analyzeSourceAndRunSemanticAnalysis(source, "optimization-trace.js"),
		{ collectOptimizationDiagnostics: true },
	);
	executeIROptimizations(program, { ablations });
	return program;
}

function instructions(program: IntermediateProgram): Array<IRInstruction> {
	return program.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) => block.instructions),
	);
}

test("ordinary compilation pays no optimization tracing cost", () => {
	const program = compileSemanticProgramToIr(
		analyzeSourceAndRunSemanticAnalysis(inlineSource, "optimization-trace.js"),
	);
	expect(program.optimizationTrace).toBeUndefined();
	executeIROptimizations(program);
	expect(program.optimizationTrace).toBeUndefined();

	const traced = optimize(inlineSource);
	expect(traced.functions).toEqual(program.functions);
});

test("transform and finalization phases compose to the full pipeline", () => {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		inlineSource,
		"optimization-trace.js",
	);
	const complete = compileSemanticProgramToIr(semantic, {
		collectOptimizationDiagnostics: true,
	});
	const phased = compileSemanticProgramToIr(semantic, {
		collectOptimizationDiagnostics: true,
	});

	executeIROptimizations(complete);
	executeIRTransformOptimizations(phased);
	expect(phased.optimizationTrace?.some((event) => event.stage === "finalization")).toBe(
		false,
	);
	finalizeIROptimizations(phased);

	expect(phased.functions).toEqual(complete.functions);
	expect(phased.optimizationTrace).toEqual(complete.optimizationTrace);
});

test("profile tracing records stable pass names and selected IR deltas", () => {
	const program = optimize(inlineSource);
	const trace = program.optimizationTrace!;
	const inline = trace.find(
		(event) => event.pass === "inline-known-calls" && event.changed,
	)!;

	expect(trace[0]).toMatchObject({
		pass: "eliminate-redundant-tdz-checks",
		stage: "normalization",
		status: "executed",
	});
	expect(inline).toMatchObject({
		stage: "fixpoint",
		status: "executed",
		ablation: "inlining",
	});
	expect(inline.delta.dynamicCalls).toBeLessThan(0);
	expect(inline.after.dynamicCalls).toBe(
		inline.before.dynamicCalls + inline.delta.dynamicCalls,
	);
	expect(Object.keys(inline.before)).toEqual([
		"allocationSites",
		"dynamicCalls",
		"boxedOperations",
		"propertyHelpers",
		"worldGuards",
		"safepoints",
	]);
	expect(trace.at(-1)?.pass).toBe("annotate-terminal-yield-sites");
});

test("inlining ablation retains calls and identifies every skipped pass", () => {
	const program = optimize(inlineSource, new Set(["inlining"]));
	const inliningEvents = program.optimizationTrace!.filter(
		(event) => event.ablation === "inlining",
	);

	expect(inliningEvents.length).toBeGreaterThan(0);
	expect(inliningEvents.every((event) => event.status === "ablated")).toBe(true);
	expect(instructions(program).some((instruction) => instruction.type === "call")).toBe(
		true,
	);
});

test("escape ablation preserves inline cost decisions but removes stack annotations", () => {
	const program = optimize(
		`
		function run(count) {
			function partial(value, escape) {
				const object = { value };
				if (escape) return object;
				return typeof object === "object" ? object.value : 0;
			}
			let total = 0;
			for (let index = 0; index < count; index++) {
				const result = partial(index, index === count - 1);
				total += typeof result === "object" ? result.value : result;
			}
			return total;
		}
		globalThis.keep = run;
		`,
		new Set(["escape"]),
	);
	const residual = instructions(program);

	expect(residual.some((instruction) => instruction.type === "call")).toBe(true);
	expect(
		program.functions.some((fn) =>
			fn.regions?.some((region) => region.kind === "stack-object-plan"),
		),
	).toBe(false);
	expect(
		program.functions.some((fn) =>
			fn.regions?.some(
				(region) =>
					region.kind === "stack-object-plan" &&
					region.sites.some((site) => site.materializations.length > 0),
			),
		),
	).toBe(false);
	expect(
		program.optimizationTrace!.find((event) => event.pass === "clear-stack-object-plans"),
	).toMatchObject({ status: "executed" });
	expect(
		program.optimizationTrace!.find((event) => event.pass === "annotate-stack-objects"),
	).toMatchObject({ status: "ablated", ablation: "escape" });
});

test("bounded ablations cover folding, escape, inlining, and static properties", () => {
	const ablations = new Set<OptimizationAblation>([
		"constant-folding",
		"escape",
		"inlining",
		"static-properties",
	]);
	const program = optimize(
		`function hot(object) { const local = { value: 1 + 2 }; return local.value + object.fixed; } globalThis.keep = hot;`,
		ablations,
	);
	const observed = new Set(
		program
			.optimizationTrace!.filter((event) => event.status === "ablated")
			.flatMap((event) => (event.ablation === undefined ? [] : [event.ablation])),
	);

	expect(observed).toEqual(ablations);
	expect(
		program.optimizationTrace!.find((event) => event.pass === "static-property-keys"),
	).toMatchObject({ status: "ablated", ablation: "static-properties" });
});
