import { expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { deferCapturedAllocations } from "../src/compiler/core/core-captured-materialization.ts";
import {
	buildCoreControlFlow,
	coreTerminatorInput,
} from "../src/compiler/core/core-ir-control-flow.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import { coreFunctionId } from "../src/compiler/core/core-ir.ts";
import {
	CORE_CONSTRUCTION_ANNOTATION_PASSES,
	CORE_CONSTRUCTION_NORMALIZATION_PASSES,
} from "../src/compiler/core/core-local-passes.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CoreFunctionPassScheduler } from "../src/compiler/core/core-pass-manager.ts";
import { runSemanticAnalysisForGraph } from "../src/compiler/frontend/analyze-module-graph.ts";
import { certifyProgramClosure } from "../src/compiler/frontend/certify-closure.ts";
import { buildModuleGraph } from "../src/compiler/frontend/module-graph.ts";
import { constructSemanticProgramCore } from "../src/compiler/pipeline/compile-core-common.ts";
import {
	compilerProgramFactsFromConfig,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import { inspectCoreValueDefinition } from "./helpers/core-inspection.ts";

function construct(source: string, evalEnabled = false, strict = true) {
	const config = resolveBuildConfig({ engine: { eval: evalEnabled, realms: false } });
	const graph = buildModuleGraph(strict ? "/capture-cohort.mjs" : "/capture-cohort.cjs", {
		entrySource: source,
		entryGoal: strict ? "module" : "script",
		entryStrict: strict,
		buildConfig: config,
	});
	const compilation = constructSemanticProgramCore(
		runSemanticAnalysisForGraph(graph),
		{
			facts: withProgramClosure(
				compilerProgramFactsFromConfig(config),
				certifyProgramClosure(graph, config, {
					relocatableArtifact: false,
					hostWireSplicing: false,
				}),
			),
		},
		(_phase, run) => run(),
	);
	const { program, context } = compilation;
	const report = new CoreOptimizationReportBuilder(program);
	for (const id of program.functionIds()) {
		const analyses = new CoreAnalysisManager(program, context, report);
		new CoreFunctionPassScheduler(program, context, analyses, report, id).runComponent(
			"canonicalize",
			CORE_CONSTRUCTION_ANNOTATION_PASSES,
		);
		new CoreFunctionPassScheduler(program, context, analyses, report, id, {
			localOptimization: true,
		}).runComponent("canonicalize", CORE_CONSTRUCTION_NORMALIZATION_PASSES);
	}
	return compilation;
}

const helpers = `
function first(value) { return value > 0 ? second(value - 1) : 1; }
function second(value) { return value > 0 ? first(value - 1) : 2; }
`;

it.each([
	{
		name: "short-circuit fast return",
		body: `${helpers} if (!values || values.length === 0) return 0; return first(values.length);`,
		admitted: true,
	},
	{
		name: "indirect closure observer",
		body: `function first(value) { return (() => second(value))(); } function second(value) { return value; } if (!values) return 0; return first(values.length);`,
		admitted: true,
	},
	{
		name: "binding read before the guard",
		body: `${helpers} globalThis.saved = first; if (!values) return 0; return second(values.length);`,
		admitted: false,
	},
	{
		name: "external observer before the guard",
		body: `${helpers} globalThis.saved = () => first; if (!values) return 0; return second(values.length);`,
		admitted: false,
	},
	{
		name: "binding reassignment",
		body: `${helpers} if (!values) return 0; first = () => 7; return second(values.length);`,
		admitted: false,
	},
	{
		name: "repeated loop destination",
		body: `${helpers} while (values.next()) { if (values.skip()) continue; values.observe(first); } return 0;`,
		admitted: false,
	},
	{
		name: "exception handler owner",
		body: `${helpers} try { if (!values) return 0; return first(values.length); } catch { return 3; }`,
		admitted: false,
	},
])("preserves captured closure admission for $name", ({ body, admitted }) => {
	const compilation = construct(
		`function owner(values) { ${body} } globalThis.owner = owner;`,
	);
	const { program } = compilation;
	const owner = [...program.functionIds()]
		.map((id) => program.function(id))
		.find((fn) => program.stringConstantText(fn.metadata.nameStringIndex) === "owner")!;
	expect(owner).toBeDefined();
	const allocations = [...owner.instructionIds()].filter((instruction) => {
		if (owner.instructionKind(instruction) !== "operation") return false;
		if (owner.instructionOpcodeName(instruction) !== "createFunction") return false;
		const target = owner.instructionAttributes(instruction).functionIndex;
		return (
			typeof target === "number" &&
			["first", "second"].includes(
				program.stringConstantText(
					program.function(coreFunctionId(target)).metadata.nameStringIndex,
				),
			)
		);
	});
	expect(allocations.length).toBeGreaterThan(0);
	const origins = allocations.map((instruction) => owner.instructionBlock(instruction));
	deferCapturedAllocations(compilation);
	for (const [index, instruction] of allocations.entries())
		expect(owner.instructionBlock(instruction) !== origins[index]).toBe(admitted);
	if (admitted) {
		const earlyReturns = [...owner.blockIds()].filter((block) => {
			const exit = coreTerminatorInput(owner, owner.blockTerminator(block));
			if (exit.kind !== "return" || exit.value === undefined) return false;
			const definition = inspectCoreValueDefinition(owner, exit.value);
			return (
				definition.kind === "instruction" &&
				owner.instructionOpcodeName(definition.instruction) === "createNumber" &&
				owner.instructionAttributes(definition.instruction).value === 0
			);
		});
		expect(earlyReturns.length).toBeGreaterThan(0);
		const flow = buildCoreControlFlow(program, owner.id);
		const reachesEarlyReturn = new Set(earlyReturns);
		const pending = [...earlyReturns];
		while (pending.length > 0)
			for (const edge of flow.predecessors[pending.pop()!] ?? []) {
				if (reachesEarlyReturn.has(edge.from)) continue;
				reachesEarlyReturn.add(edge.from);
				pending.push(edge.from);
			}
		for (const instruction of allocations)
			expect(reachesEarlyReturn.has(owner.instructionBlock(instruction))).toBe(false);
	}
	verifyCoreProgram(program);
});

it.each([
	{ evalEnabled: true, strict: true, directEval: true },
	{ evalEnabled: false, strict: false, directEval: false },
])(
	"retains closure initialization with eval=$evalEnabled, strict=$strict and direct eval=$directEval",
	({ evalEnabled, strict, directEval }) => {
		const compilation = construct(
			`function owner(values) { ${helpers} if (!values) return 0; return first(values.length); } globalThis.owner = owner;${directEval ? ' eval("0");' : ""}`,
			evalEnabled,
			strict,
		);
		expect(deferCapturedAllocations(compilation)).toBe(0);
	},
);

it("defers closure initialization when run-time code can only be global", () => {
	const compilation = construct(
		`function owner(values) { ${helpers} if (!values) return 0; return first(values.length); } globalThis.owner = owner;`,
		true,
	);
	expect(deferCapturedAllocations(compilation)).toBeGreaterThan(0);
	verifyCoreProgram(compilation.program);
});

it("defers a captured suffix rest behind the same early return", () => {
	const compilation = construct(
		`function owner(first, ...values) { if (!first) return 0; return () => values.length; } globalThis.owner = owner;`,
	);
	expect(deferCapturedAllocations(compilation)).toBeGreaterThan(0);
	verifyCoreProgram(compilation.program);
});
