import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { runCoreCrossCallTransforms } from "../src/compiler/core/core-cross-call-transforms.ts";
import {
	CoreFunctionOptimizationResources,
	CoreFunctionOptimizationSession,
} from "../src/compiler/core/core-function-optimization-session.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "../src/compiler/core/core-internal-attributes.ts";
import { buildCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-selection.ts";
import type { CoreOptimizationPlan } from "../src/compiler/core/core-ir-regions.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import type { CoreOptimizationReport } from "../src/compiler/core/core-optimization-report.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { projectCoreSpecializationRecipes } from "../src/compiler/core/core-specialization-recipes.ts";
import type { CoreProgram } from "../src/compiler/core/core-store.ts";
import { CoreTransformCandidateService } from "../src/compiler/core/core-transform-candidates.ts";
import type {
	CoreTransformBudgetLimits,
	CoreTransformCandidate,
} from "../src/compiler/core/core-transform-candidates.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	inspectCoreBlockHandler,
	inspectCoreBlockParameters,
	inspectCoreTerminatorPayload,
} from "./helpers/core-inspection.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";
import {
	analysisProgram,
	appendCaller,
	appendLeaf,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";

function runTransforms(program: CoreProgram, limits?: CoreTransformBudgetLimits) {
	const context = programAnalysisContext();
	const report = new CoreOptimizationReportBuilder(program);
	const analyses = new CoreAnalysisManager(program, context, report);
	const resources = new CoreFunctionOptimizationResources(program);
	const candidates = new CoreTransformCandidateService(limits);
	const result = runCoreCrossCallTransforms(
		program,
		analyses,
		(wave, functionId, editor) =>
			new CoreFunctionOptimizationSession(
				program,
				context,
				report,
				resources,
				functionId,
				{ crossCallWave: wave },
			).optimizeCrossCall(editor),
		limits,
		undefined,
		candidates,
	);
	return {
		...result,
		plan: buildCoreOptimizationPlan(
			program,
			analyses,
			result.summaries,
			[...program.functionIds()],
			{ candidateService: candidates },
		),
	};
}

function callInstructions(program: CoreProgram, functionId: number) {
	const fn = program.function(functionId as never);
	return [...fn.instructionIds()].filter(
		(instruction) =>
			fn.instructionKind(instruction) === "operation" &&
			fn.registry.byId(fn.instructionOpcode(instruction)).callTransfer !== undefined,
	);
}

const TINY_CODE_BUDGET: CoreTransformBudgetLimits = {
	perSiteExpansions: 1,
	perCallerExpansions: 8,
	perCallerGeneratedCode: 0,
	perCallerCompilerWork: 1_000,
	programGeneratedCode: 0,
	programCompilerWork: 10_000,
};

describe("bounded Core cross-call transforms", () => {
	it("owns exactly two deliberate waves without driving pass stages", () => {
		const source = readFileSync(
			new URL("../src/compiler/core/core-cross-call-transforms.ts", import.meta.url),
			"utf8",
		);

		expect(source).toMatch(/wave < 2/);
		expect(source).not.toMatch(/while\s*\(true\)/);
		expect(source).not.toMatch(/passes\.runStage/);
		expect(source).not.toMatch(/finishCrossCallWave/);
	});

	it("deduplicates candidates and enforces site, caller, and compiler-work limits", () => {
		const service = new CoreTransformCandidateService({
			perSiteExpansions: 1,
			perCallerExpansions: 1,
			perCallerGeneratedCode: 10,
			perCallerCompilerWork: 3,
			programGeneratedCode: 10,
			programCompilerWork: 3,
		});
		const candidate = (
			priorityScore: number,
			site: number,
			work = 1,
		): CoreTransformCandidate => ({
			kind: "inline",
			caller: 0 as never,
			site: site as never,
			revision: 0,
			priorityClass: 0,
			priorityScore,
			targets: [1 as never],
			generatedCodeCost: 1,
			compilerWorkCost: work,
			expansive: true,
		});
		expect(service.offer(candidate(1, 1))).toBe(true);
		expect(service.offer(candidate(1, 1))).toBe(false);
		const first = service.next()!;
		expect(service.admit(first)).toBeUndefined();
		service.recordApplied(first);
		expect(service.admit(candidate(2, 1))).toBe("expansion-limit");
		expect(service.admit(candidate(2, 2))).toBe("expansion-limit");

		const compilerLimited = new CoreTransformCandidateService({
			perSiteExpansions: 2,
			perCallerExpansions: 2,
			perCallerGeneratedCode: 10,
			perCallerCompilerWork: 1,
			programGeneratedCode: 10,
			programCompilerWork: 1,
		});
		expect(compilerLimited.admit(candidate(1, 1, 2))).toBe("compiler-work-cost");

		const ordered = new CoreTransformCandidateService();
		for (const priority of [3, 1, 2]) ordered.offer(candidate(priority, priority));
		expect(ordered.next()?.priorityScore).toBe(1);
		ordered.offer(candidate(0, 4));
		expect([
			ordered.next()?.priorityScore,
			ordered.next()?.priorityScore,
			ordered.next()?.priorityScore,
		]).toEqual([0, 2, 3]);
	});

	it("discovers inline candidates without mutating analysis metadata into Core", () => {
		const program = analysisProgram();
		appendCaller(program, 1);
		appendLeaf(program);
		const result = runTransforms(program);
		expect(callInstructions(program, 0)).toEqual([]);
		expect(result.statistics.appliedByKind).toMatchObject({
			inline: 1,
		});
		expect(result.statistics.instructionsIntroduced).toBe(1);
		expect(result.statistics.generatedCodeConsumed).toBe(1);
		expect(result.statistics.callGraphFunctionsAnalyzed).toBeGreaterThan(2);
		expect(result.statistics.waves).toBeLessThanOrEqual(2);
		expect(result.statistics.programFlowResolves).toBe(result.statistics.waves + 1);
		expect(result.statistics.callerEditSessions).toBe(
			result.statistics.callerLocalOptimizations,
		);
	});

	it("preserves representation joins when inlining represented returns", () => {
		const program = analysisProgram();
		const caller = new CoreFunctionBuilder(program);
		const entry = caller.createBlock();
		const merge = caller.createBlock([{ representation: "boxed" }]);
		const [callee] = caller.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		const [receiver] = caller.appendInstruction(entry, "createUndefined", []);
		const [result] = caller.appendInstruction(entry, "call", [callee!, receiver!]);
		caller.setTerminator(entry, {
			kind: "jump",
			edge: { block: merge, arguments: [result!] },
		});
		const joined = inspectCoreBlockParameters(caller, merge)[0]!.value;
		caller.setTerminator(merge, { kind: "return", value: joined });
		const callerId = caller.finish(entry).function;

		const target = new CoreFunctionBuilder(program);
		const targetEntry = target.createBlock();
		const [returned] = target.appendInstruction(targetEntry, "createBoolean", [], {
			attributes: { value: false },
			outputRepresentations: ["boolean"],
		});
		target.setTerminator(targetEntry, { kind: "return", value: returned! });
		target.finish(targetEntry);

		const transformed = runTransforms(program);
		expect(callInstructions(program, callerId)).toEqual([]);
		expect(transformed.statistics.appliedByKind.inline).toBe(1);
		verifyCoreProgram(program, { stage: "pre-target" });
	});

	it("retains the callee source chain when inlining", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function outer(value) {
					function addOne(input) { return input + 1; }
					return addOne(value);
				}`,
				"core-inline-source-chain.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		expect(optimized).toBeDefined();
		const outer = coreFunctionNamed(optimized!, "outer")!;
		const addOne = coreFunctionNamed(optimized!, "addOne")!;
		expect(coreOperations(outer).some(({ opcode }) => opcode === "call")).toBe(false);
		const binary = coreOperations(outer).find(({ opcode }) => opcode === "binary")!;
		const source =
			optimized!.sourcePositions[outer.instructionSourcePosition(binary.id)!];
		expect(source?.inlinedFunctionIndex).toBe(addOne.id);
		expect(typeof source?.callerPosId).toBe("number");
	});

	it("retains closed callee facts across nested argument relocation", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function outer() {
					function leaf() { return 1; }
					function middle(target) { return target(); }
					return middle(leaf);
				}`,
				"core-inline-relocated-target.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const outer = coreFunctionNamed(optimized!, "outer")!;
		expect(coreOperations(outer).some(({ opcode }) => opcode === "call")).toBe(false);
		expect(
			coreOperations(outer).some(
				({ opcode, attributes }) => opcode === "createNumber" && attributes.value === 1,
			),
		).toBe(true);
	});

	it("does not relocate callee activation reads into the caller", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function captured(input) {
					function closure() { return input + 1; }
					return closure();
				}
				function counted(value) {
					function inner() { return arguments.length; }
					return value + inner(1, 2);
				}
				captured(13);
				counted(3);`,
				"core-inline-activation.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		expect(optimized).toBeDefined();
		const captured = coreFunctionNamed(optimized!, "captured")!;
		const counted = coreFunctionNamed(optimized!, "counted")!;
		expect(coreOperations(captured).some(({ opcode }) => opcode === "call")).toBe(true);
		expect(coreOperations(captured).some(({ opcode }) => opcode === "loadCaptured")).toBe(
			false,
		);
		expect(coreOperations(counted).some(({ opcode }) => opcode === "call")).toBe(true);
		expect(
			coreOperations(counted).some(({ opcode }) => opcode === "loadArgumentCount"),
		).toBe(false);
	});

	it("sinks one-shot captured callbacks into guarded fallbacks", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`let enabled = false;
				function invoke(callback) {
					const value = callback();
					return enabled ? value + 1 : value;
				}
				function outer(input) {
					let result = 0;
					for (let index = 0; index < 10; index++) {
						const value = input + index;
						result += invoke(() => value + 1);
					}
					return result;
				}
				outer(3);`,
				"core-inline-captured-callback.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);

		const outer = coreFunctionNamed(optimized!, "outer")!;
		const operations = coreOperations(outer);
		expect(operations.filter(({ opcode }) => opcode === "createFunction")).toHaveLength(
			1,
		);
		expect(
			operations.filter(
				({ opcode, attributes }) =>
					opcode === "call" &&
					attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] !== true,
			),
		).toHaveLength(0);
		expect(
			operations.some(
				({ opcode, attributes }) =>
					opcode === "call" &&
					attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] === true,
			),
		).toBe(true);
		expect(operations.some(({ opcode }) => opcode === "loadCaptured")).toBe(true);
	});

	it("guards and inlines hot global rest argument snapshots", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function sumRest(...values) {
					return values[0] + values[1] + values[2] + values[3];
				}
				function hot(value) {
					let checksum = 0;
					for (let index = 0; index < 10; index++) {
						checksum += sumRest(value, 3, 5, 7);
					}
					return checksum;
				}
				hot(1);`,
				"core-inline-rest-snapshots.js",
			),
			{
				facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);

		const hot = coreFunctionNamed(optimized!, "hot")!;
		const operations = coreOperations(hot);
		const fallback = operations.find(({ opcode }) => opcode === "call");
		expect(fallback?.attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE]).toBe(true);
		expect(operations.some(({ opcode }) => opcode === "guardFunctionIndex")).toBe(true);
		expect(operations.some(({ opcode }) => opcode === "loadArgument")).toBe(false);
	});

	it("materializes missing scalarized rest snapshots after exact inlining", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function outer(value) {
					function pick(...values) { return values[2]; }
					return pick(value);
				}
				outer(1);`,
				"core-inline-missing-rest-snapshot.js",
			),
			{
				facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);

		const outer = coreFunctionNamed(optimized!, "outer")!;
		const operations = coreOperations(outer);
		expect(operations.some(({ opcode }) => opcode === "call")).toBe(false);
		expect(operations.some(({ opcode }) => opcode === "loadArgument")).toBe(false);
		expect(operations.some(({ opcode }) => opcode === "createUndefined")).toBe(true);
	});

	it("binds scalarized rest snapshots in guarded inline fast paths", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function outer(value) {
					let handler = (...values) => values[0] + values[2];
					function install(other) { handler = other; }
					globalThis.install = install;
					return handler(value);
				}`,
				"core-guarded-inline-rest-snapshots.js",
			),
			{
				facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);

		const outer = coreFunctionNamed(optimized!, "outer")!;
		const operations = coreOperations(outer);
		const fallback = operations.find(({ opcode }) => opcode === "call");
		expect(fallback?.attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE]).toBe(true);
		expect(operations.some(({ opcode }) => opcode === "guardFunctionIndex")).toBe(true);
		expect(
			operations.some(
				({ opcode, attributes }) => opcode === "binary" && attributes.operator === "+",
			),
		).toBe(true);
		expect(operations.some(({ opcode }) => opcode === "createUndefined")).toBe(true);
		expect(operations.some(({ opcode }) => opcode === "loadArgument")).toBe(false);
	});

	it("omits unreachable guarded-call sites after non-linear rest inlining", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function identity(value) {
					for (let index = 0; index < 3; index++) value += index;
					return value;
				}
				function outer(value) {
					function read(first = identity(1), ...rest) {
						return identity(rest[0]);
					}
					return read(undefined, value);
				}
				outer(2);`,
				"core-inline-rest-guarded-plan.js",
			),
			{
				facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);

		const outer = coreFunctionNamed(optimized!, "outer")!;
		expect(coreOperations(outer).some(({ opcode }) => opcode === "loadArgument")).toBe(
			false,
		);
	});

	it("uses generated-code cost rather than a tiny call-count cap", () => {
		const nested = Array.from({ length: 16 }, () => "leaf(").join("");
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function outer(value) {
					function leaf(input) { return input + 1; }
					return ${nested}value${")".repeat(16)};
				}
				outer(1);`,
				"core-inline-tiny-chain.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		expect(optimized).toBeDefined();
		const outer = coreFunctionNamed(optimized!, "outer")!;
		expect(coreOperations(outer).some(({ opcode }) => opcode === "call")).toBe(false);
	});

	it("admits benchmark-sized local helpers by emitted-code cost", () => {
		let optimized: CoreProgram | undefined;
		let report: CoreOptimizationReport | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`const vector = (x, y, z) => ({ x, y, z });
				const scale = (value, factor) =>
					vector(value.x * factor, value.y * factor, value.z * factor);
				const add = (left, right) =>
					vector(left.x + right.x, left.y + right.y, left.z + right.z);
				const dot = (left, right) =>
					left.x * right.x + left.y * right.y + left.z * right.z;
				function hot(limit) {
					let checksum = 0;
					for (let index = 0; index < limit; index++) {
						const first = vector(index, index + 1, index + 2);
						const second = scale(first, 0.5);
						const result = add(first, second);
						checksum += dot(result, second);
					}
					return checksum;
				}
				hot(10);`,
				"core-guarded-inline-allocation-chain.js",
			),
			{
				coreInstrumentation: "full",
				afterCoreOptimization(program, _context, optimizationReport) {
					optimized = program;
					report = optimizationReport;
				},
			},
		);

		const hot = coreFunctionNamed(optimized!, "hot")!;
		const instructions = coreOperations(hot);
		expect(instructions.some(({ opcode }) => opcode === "call")).toBe(false);
		expect(
			instructions.some(
				({ opcode }) => opcode === "createObject" || opcode === "createObjectShaped",
			),
		).toBe(false);
		expect(report!.transforms.appliedByKind.inline).toBe(8);
		expect(report!.transforms.generatedCodeConsumed).toBe(39);
		expect(report!.transforms.declinedByReason["generated-code-cost"]).toBe(0);
	});

	it("inlines the known target of an open captured callee behind a generic fallback", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function outer(value) {
					let handler = (input) => input + 10;
					function install(other) { handler = other; }
					globalThis.install = install;
					try { return handler(value) * 2; }
					catch (error) { return error; }
				}`,
				"core-guarded-captured-call.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		expect(optimized).toBeDefined();
		const outer = coreFunctionNamed(optimized!, "outer")!;
		const handler = coreFunctionNamed(optimized!, "handler")!;
		const calls = coreOperations(outer).filter(({ opcode }) => opcode === "call");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE]).toBe(true);
		expect(calls[0]!.attributes.calleeTargets).toBeUndefined();
		const guard = coreOperations(outer).find(
			({ opcode }) => opcode === "guardFunctionIndex",
		)!;
		expect(guard.attributes.functionIndex).toBe(handler.id);
		const branch = inspectCoreTerminatorPayload(
			outer,
			outer.blockTerminator(guard.block),
		);
		expect(branch.kind).toBe("branch");
		if (branch.kind !== "branch") throw new Error("expected guarded inline branch");
		expect(branch.condition).toBe(guard.outputs[0]);
		expect(branch.alternate.block).toBe(calls[0]!.block);
		const fastTerminator = inspectCoreTerminatorPayload(
			outer,
			outer.blockTerminator(branch.consequent.block),
		);
		const fallbackTerminator = inspectCoreTerminatorPayload(
			outer,
			outer.blockTerminator(branch.alternate.block),
		);
		expect(fastTerminator.kind).toBe("jump");
		expect(fallbackTerminator.kind).toBe("jump");
		if (fastTerminator.kind !== "jump" || fallbackTerminator.kind !== "jump")
			throw new Error("expected guarded inline join");
		expect(fastTerminator.edge.block).toBe(fallbackTerminator.edge.block);
		expect(inspectCoreBlockHandler(outer, branch.consequent.block)?.block).toBe(
			inspectCoreBlockHandler(outer, branch.alternate.block)?.block,
		);
		expect(inspectCoreBlockHandler(outer, fastTerminator.edge.block)?.block).toBe(
			inspectCoreBlockHandler(outer, branch.alternate.block)?.block,
		);
		expect(
			coreOperations(outer).some(
				({ block, opcode, attributes }) =>
					block === branch.consequent.block &&
					opcode === "binary" &&
					attributes.operator === "+",
			),
		).toBe(true);
		expect(calls[0]!.attributes.directFunctionIndex).toBeUndefined();
	});

	it("bridges scalar arguments into guarded non-linear callees", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function outer(value) {
					let handler = (input, fallback) => {
						if (input === undefined) return "";
						if (fallback === undefined) return input;
						return input + fallback;
					};
					function install(other) { handler = other; }
					globalThis.install = install;
					try { return handler("", value) + "tail"; }
					catch (error) { return error; }
				}`,
				"core-guarded-inline-scalar-argument.js",
			),
			{
				coreVerification: "per-pass",
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);

		const outer = coreFunctionNamed(optimized!, "outer")!;
		const operations = coreOperations(outer);
		expect(operations.some(({ opcode }) => opcode === "guardFunctionIndex")).toBe(true);
		expect(
			operations.some(
				({ opcode, inputs, outputs }) =>
					opcode === "move" &&
					inputs.length === 1 &&
					outputs.length === 1 &&
					outer.valueRepresentation(inputs[0]!) === "string" &&
					outer.valueRepresentation(outputs[0]!) === "boxed",
			),
		).toBe(true);
	});

	it("guards and inlines a known class static method without assuming the property is closed", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class Service { static run(value) { return value + 10; } }
				function caller(value) { return Service.run(value) * 2; }
				caller(1);`,
				"core-guarded-static-inline.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		expect(optimized).toBeDefined();
		const caller = coreFunctionNamed(optimized!, "caller")!;
		const target = coreFunctionNamed(optimized!, "run")!;
		const operations = coreOperations(caller);
		const guard = operations.find(({ opcode }) => opcode === "guardFunctionIndex");
		const fallback = operations.find(({ opcode }) => opcode === "call");
		expect(guard?.attributes.functionIndex).toBe(target.id);
		expect(fallback?.attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE]).toBe(true);
		expect(fallback?.attributes.calleeTargets).toBeUndefined();
		expect(
			operations.some(
				({ opcode, attributes }) => opcode === "binary" && attributes.operator === "+",
			),
		).toBe(true);
	});

	it("guards and inlines a unique class instance method in a loop", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class Counter {
					constructor(offset) { this.offset = offset; }
					add(value) { return value + this.offset; }
				}
				function caller(counter, value) {
					let total = 0;
					for (let index = 0; index < 4; index++) total += counter.add(value + index);
					return total;
				}
				caller(new Counter(10), 1);`,
				"core-guarded-instance-inline.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		expect(optimized).toBeDefined();
		const caller = coreFunctionNamed(optimized!, "caller")!;
		const target = coreFunctionNamed(optimized!, "add")!;
		const operations = coreOperations(caller);
		const guard = operations.find(({ opcode }) => opcode === "guardFunctionIndex");
		const fallback = operations.find(({ opcode }) => opcode === "call");
		expect(guard?.attributes.functionIndex).toBe(target.id);
		expect(fallback?.attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE]).toBe(true);
		expect(fallback?.attributes.calleeTargets).toBeUndefined();
		expect(
			operations.some(
				({ opcode, attributes }) => opcode === "binary" && attributes.operator === "+",
			),
		).toBe(true);
	});

	it("plans guarded direct dispatch for a unique captured instance method", () => {
		let optimized: CoreProgram | undefined;
		let plan: CoreOptimizationPlan | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class Counter {
					#add(value) { return value + 10; }
					run(value) { return this.#add(value); }
				}
				function caller(counter, value) {
					let total = 0;
					for (let index = 0; index < 4; index++) total += counter.run(value + index);
					return total;
				}
				caller(new Counter(), 1);`,
				"core-guarded-instance-direct.js",
			),
			{
				afterCoreOptimization(program, _context, _report, optimizationPlan) {
					optimized = program;
					plan = optimizationPlan;
				},
			},
		);
		expect(optimized).toBeDefined();
		const caller = coreFunctionNamed(optimized!, "caller")!;
		const target = coreFunctionNamed(optimized!, "run")!;
		const operations = coreOperations(caller);
		expect(operations.some(({ opcode }) => opcode === "guardFunctionIndex")).toBe(false);
		const call = operations.find(({ opcode }) => opcode === "call");
		expect(call).toBeDefined();
		expect(
			plan === undefined ? [] : projectCoreSpecializationRecipes(plan.recipes),
		).toContainEqual(
			expect.objectContaining({
				kind: "guarded-direct-call",
				function: caller.id,
				anchors: [call!.id],
				targetFunctions: [target.id],
			}),
		);
	});

	it("finite-dispatches a private dense array of lexical-this callees", () => {
		let optimized: CoreProgram | undefined;
		let report: CoreOptimizationReport | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function caller(count) {
					const handlers = [
						(value) => value + 1,
						(value) => value * 3,
						(value) => value - 7,
						(value) => value ^ 85,
					];
					let total = 0;
					for (let index = 0; index < count; index++) {
						total += handlers[index & 3](index & 1023);
					}
					return total;
				}
				caller(10);`,
				"core-finite-array-dispatch.js",
			),
			{
				facts: compilerProgramFactsFromConfig(
					resolveBuildConfig({ engine: { primordials: "locked", realms: false } }),
				),
				coreInstrumentation: "full",
				afterCoreOptimization(program, _context, optimizationReport) {
					optimized = program;
					report = optimizationReport;
				},
			},
		);

		const caller = coreFunctionNamed(optimized!, "caller")!;
		const operations = coreOperations(caller);
		expect(operations.some(({ opcode }) => opcode === "call")).toBe(false);
		expect(
			operations.filter(({ opcode }) => opcode === "guardFunctionIndex"),
		).toHaveLength(3);
		expect(report!.transforms.appliedByKind["finite-dispatch"]).toBe(1);
		expect(
			[...optimized!.functionIds()].filter(
				(id) => optimized!.function(id).metadata.lexicalThis,
			),
		).toHaveLength(4);
	});

	it("keeps private arrays of receiver-observing functions on generic dispatch", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function caller(count) {
					const handlers = [
						function first(value) { this[0] = first; return value + 1; },
						function second(value) { return value + 2; },
					];
					let total = 0;
					for (let index = 0; index < count; index++) total += handlers[index & 1](index);
					return total;
				}
				caller(10);`,
				"core-private-array-receiver-mutation.js",
			),
			{
				facts: compilerProgramFactsFromConfig(
					resolveBuildConfig({ engine: { primordials: "locked", realms: false } }),
				),
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const caller = coreFunctionNamed(optimized!, "caller")!;
		expect(coreOperations(caller).some(({ opcode }) => opcode === "call")).toBe(true);
		expect(
			coreOperations(caller).some(({ opcode }) => opcode === "guardFunctionIndex"),
		).toBe(false);
	});

	it("does not speculate on ambiguous or cold instance-method names", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class First { add(value) { return value + 1; } }
				class Second { add(value) { return value + 2; } }
				function ambiguous(receiver, value) {
					let total = 0;
					for (let index = 0; index < 4; index++) total += receiver.add(value);
					return total;
				}
				class Unique { read(value) { return value + 3; } }
				function cold(receiver, value) { return receiver.read(value); }
				ambiguous(new First(), 1);
				ambiguous(new Second(), 1);
				cold(new Unique(), 1);`,
				"core-instance-inline-declines.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		expect(optimized).toBeDefined();
		for (const name of ["ambiguous", "cold"]) {
			const operations = coreOperations(coreFunctionNamed(optimized!, name)!);
			expect(operations.some(({ opcode }) => opcode === "guardFunctionIndex")).toBe(
				false,
			);
			expect(operations.some(({ opcode }) => opcode === "call")).toBe(true);
		}
	});

	it("plans every finite target installed through a nested closure", () => {
		let optimized: CoreProgram | undefined;
		let plan: CoreOptimizationPlan | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function outer(reassign) {
					function handler() { return 1; }
					function replacement() { return 2; }
					const retarget = () => { handler = replacement; };
					if (reassign) retarget();
					return handler();
				}`,
				"core-finite-captured-call.js",
			),
			{
				afterCoreOptimization(program, _context, _report, optimizationPlan) {
					optimized = program;
					plan = optimizationPlan;
				},
			},
		);
		expect(optimized).toBeDefined();
		const outer = coreFunctionNamed(optimized!, "outer")!;
		const targets = [
			coreFunctionNamed(optimized!, "handler")!.id,
			coreFunctionNamed(optimized!, "replacement")!.id,
		].sort((left, right) => left - right);
		const selection =
			plan === undefined
				? undefined
				: projectCoreSpecializationRecipes(plan.recipes).find(
						(candidate) =>
							candidate.kind === "guarded-direct-call" &&
							candidate.function === outer.id &&
							candidate.targetFunctions.length === 2,
					);
		expect(selection?.targetFunctions).toEqual(targets);
		expect(selection?.fallback).toBe("canonical-core");
	});

	it("never inlines class constructors through ordinary calls", () => {
		let optimized: CoreProgram | undefined;
		let plan: CoreOptimizationPlan | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function callClosed(value) {
					class Closed { constructor(input) { return input + 1; } }
					return Closed(value);
				}
				function callOpen(value) {
					let Current = class Open { constructor(input) { return input + 2; } };
					function install(other) { Current = other; }
					globalThis.installClass = install;
					return Current(value);
				}
				callClosed(1);
				callOpen(1);`,
				"core-class-constructor-inline.js",
			),
			{
				afterCoreOptimization(program, _context, _report, optimizationPlan) {
					optimized = program;
					plan = optimizationPlan;
				},
			},
		);
		expect(optimized).toBeDefined();
		for (const [callerName, targetName] of [
			["callClosed", "Closed"],
			["callOpen", "Open"],
		] as const) {
			const caller = coreFunctionNamed(optimized!, callerName)!;
			const target = coreFunctionNamed(optimized!, targetName)!;
			const calls = coreOperations(caller).filter(({ opcode }) => opcode === "call");
			expect(calls).toHaveLength(1);
			expect(
				coreOperations(caller).some(
					({ opcode, attributes }) => opcode === "binary" && attributes.operator === "+",
				),
			).toBe(false);
			expect(
				plan === undefined ? [] : projectCoreSpecializationRecipes(plan.recipes),
			).toContainEqual(
				expect.objectContaining({
					kind: "guarded-direct-call",
					function: caller.id,
					anchors: [calls[0]!.id],
					targetFunctions: [target.id],
				}),
			);
		}
	});

	it.each([
		["early returns", "if (value < 0) return -value; return value + 1;"],
		[
			"diamond",
			"let result; if (value < 0) result = -value; else result = value + 1; return result * 2;",
		],
	])("inlines bounded %s and preserves caller-local proofs", (_name, body) => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`
			function outer(value) {
				function helper(input) { const value = +input; ${body} }
				return helper(value);
			}`,
				"core-inline-dag.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const outer = coreFunctionNamed(optimized!, "outer")!;
		expect(callInstructions(optimized!, outer.id)).toEqual([]);
		expect(
			coreOperations(outer).some(
				({ opcode, attributes }) => opcode === "binary" && attributes.operator === "<",
			),
		).toBe(true);
		verifyCoreProgram(optimized!, { stage: "pre-target" });
		for (const operation of coreOperations(outer)) {
			const refinement = outer.instructionEffectRefinement(operation.id);
			if (refinement === undefined) continue;
			expect(outer.fact(refinement.proof).claims).toContainEqual(
				expect.objectContaining({ kind: "effect", instruction: operation.id }),
			);
		}
	});

	it("keeps cyclic and exception-handling helpers outside the acyclic inliner", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`
			function outer(value) {
				function cycle(input) { while (input > 2) input /= 2; return input; }
				function handled(input) { try { return +input; } catch { return 0; } }
				return cycle(value) + handled(value);
			}`,
				"core-inline-rejected-graphs.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const outer = coreFunctionNamed(optimized!, "outer")!;
		expect(callInstructions(optimized!, outer.id)).toHaveLength(2);
		verifyCoreProgram(optimized!, { stage: "pre-target" });
	});

	it("keeps the generic call and records its decision only in the plan", () => {
		const program = analysisProgram();
		const caller = appendCaller(program, 1);
		appendLeaf(program);
		const result = runTransforms(program, TINY_CODE_BUDGET);
		const fn = program.function(caller.function);
		const [call] = callInstructions(program, caller.function);
		expect(call).toBeDefined();
		const attributes = fn.instructionAttributes(call!);
		expect(attributes.directFunctionIndex).toBeUndefined();
		expect(attributes.calleeTargets).toBeUndefined();
		expect(attributes.callParameterEscape).toBeUndefined();
		expect(attributes.callParameterContainment).toBeUndefined();
		expect(attributes.callReturnProvenance).toBeUndefined();
		expect(attributes.callReturnRepresentation).toBeUndefined();
		expect(result.statistics.considered).toBe(0);
		expect(result.statistics.declinedByReason["generated-code-cost"] ?? 0).toBe(0);
		expect(result.plan.statistics.declinedByPlanReason["generated-code-cost"]).toBe(1);
		expect(projectCoreSpecializationRecipes(result.plan.recipes)).toEqual([]);
	});

	it("shares the whole-program generated-code budget with late specialization", () => {
		const program = analysisProgram();
		const inlinedCaller = appendCaller(program, 2);
		const specializedCaller = appendCaller(program, 3);
		appendLeaf(program);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const consequent = builder.createBlock();
		const alternate = builder.createBlock();
		const [condition] = builder.appendInstruction(entry, "createBoolean", [], {
			attributes: { value: true },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: consequent, arguments: [] },
			alternate: { block: alternate, arguments: [] },
		});
		for (const block of [consequent, alternate]) {
			const [value] = builder.appendInstruction(block, "createUndefined", []);
			builder.setTerminator(block, { kind: "return", value: value! });
		}
		builder.finish(entry);

		const result = runTransforms(program, {
			perSiteExpansions: 1,
			perCallerExpansions: 8,
			perCallerGeneratedCode: 8,
			perCallerCompilerWork: 1_000,
			programGeneratedCode: 1,
			programCompilerWork: 10_000,
		});
		expect(callInstructions(program, inlinedCaller.function)).toEqual([]);
		expect(callInstructions(program, specializedCaller.function)).toHaveLength(1);
		expect(projectCoreSpecializationRecipes(result.plan.recipes)).toEqual([]);
		expect(result.statistics.generatedCodeConsumed).toBe(1);
		expect(result.plan.statistics.declinedByPlanReason["generated-code-cost"]).toBe(1);
	});

	it("terminates a recursive inline candidate by identity", () => {
		const program = analysisProgram();
		appendCaller(program, 0);
		const result = runTransforms(program);
		expect(callInstructions(program, 0)).toHaveLength(1);
		expect(result.statistics.declinedByReason.recursive).toBe(1);
	});

	it("publishes finite guarded dispatch while sharing the original fallback", () => {
		const program = analysisProgram();
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock([{ representation: "boxed" }]);
		const [condition] = builder.appendInstruction(entry, "createBoolean", [], {
			outputRepresentations: ["boolean"],
			attributes: { value: true },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [first] = builder.appendInstruction(left, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [first!] },
		});
		const [second] = builder.appendInstruction(right, "createFunction", [], {
			attributes: { functionIndex: 2 },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [second!] },
		});
		const callee = inspectCoreBlockParameters(builder, join)[0]!.value;
		const [receiver] = builder.appendInstruction(join, "createUndefined", []);
		const [result] = builder.appendInstruction(join, "call", [callee, receiver!]);
		builder.setTerminator(join, { kind: "return", value: result! });
		builder.finish(entry);
		appendLeaf(program);
		appendLeaf(program);

		const transformed = runTransforms(program);
		const fn = program.function(0 as never);
		const [call] = callInstructions(program, 0);
		expect(fn.instructionAttributes(call!).guardedFunctionIndices).toBeUndefined();
		expect(callInstructions(program, 0)).toHaveLength(1);
		expect(projectCoreSpecializationRecipes(transformed.plan.recipes)).toMatchObject([
			{ kind: "guarded-direct-call", targetFunctions: [1, 2] },
		]);
	});

	it("discovers callsites exposed by an earlier inline without global rounds", () => {
		const program = analysisProgram();
		appendCaller(program, 1);
		appendCaller(program, 2);
		appendLeaf(program);
		const transformed = runTransforms(program);
		expect(callInstructions(program, 0)).toEqual([]);
		expect(transformed.statistics.appliedByKind.inline).toBeGreaterThanOrEqual(2);
		expect(transformed.statistics.compilerWorkConsumed).toBeGreaterThan(0);
	});
});
