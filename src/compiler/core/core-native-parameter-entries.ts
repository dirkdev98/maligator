import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import { CORE_CONTROL_FLOW_BUNDLE_ANALYSIS } from "./core-ir-control-flow.ts";
import type { CoreDirectEntryPlan, CorePlanRepresentation } from "./core-ir-regions.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import {
	analyzeCoreNativeEntry,
	coreArgumentObservation,
} from "./core-native-entry-analysis.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

type ParameterEntry = Pick<
	CoreDirectEntryPlan,
	| "function"
	| "callSites"
	| "canonicalDispatch"
	| "parameterRepresentations"
	| "valueRepresentations"
	| "resultRepresentation"
	| "constantBooleans"
	| "instructionFacts"
>;

const MAX_PARAMETERS = 16;
const MAX_INSTRUCTIONS = 512;

/**
 * Number variants of looping functions that the canonical entry selects at run time.
 *
 * A caller only selects a typed entry when it knows the target and the argument kinds,
 * so a method reached through a property load, or a loop counter read from an object,
 * leaves every recurrence the parameters seed boxed. A looping function instead
 * nominates as Numbers the parameters that seed a loop recurrence and are never used as
 * objects and, when that makes loop operations numeric or unboxes loop values, lets its
 * canonical entry test the arguments before running that variant. Other arguments,
 * constructions and arities run the canonical body.
 */
export function coreNumericParameterEntryOpportunities(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	live: ReadonlySet<CoreFunctionId>,
	builtinCallbackTargets: ReadonlySet<CoreFunctionId>,
) {
	return [...live].flatMap((functionId) => {
		const fn = program.function(functionId);
		// A builtin reaches its callback through the callback's own typed entry.
		if (
			builtinCallbackTargets.has(functionId) ||
			fn.parameterCount === 0 ||
			fn.parameterCount > MAX_PARAMETERS ||
			fn.isGenerator ||
			fn.isAsync ||
			fn.metadata.isClassConstructor ||
			fn.metadata.isDerivedConstructor ||
			fn.metadata.toolchain === true
		)
			return [];
		const instructionCount = [...fn.instructionIds()].length;
		if (instructionCount > MAX_INSTRUCTIONS) return [];
		const loops = analyses
			.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, { scope: "function", function: functionId })
			.ordinary().loops;
		if (loops.length === 0) return [];
		const headers = new Set(loops.map((loop) => loop.header));
		const nominated = Array.from(
			{ length: fn.parameterCount },
			(_, index): CorePlanRepresentation => {
				const flow = parameterFlow(fn, fn.kernel.functionParameter(index), headers);
				return flow.seedsRecurrence && !flow.usedAsObject ? "f64" : "boxed";
			},
		);
		const nominations = nominated.filter((rep) => rep === "f64").length;
		if (nominations === 0) return [];
		const loopWeight = new Map<CoreBlockId, number>();
		for (const loop of loops)
			for (const block of loop.blocks)
				loopWeight.set(
					block,
					Math.max(loopWeight.get(block) ?? 0, 4 ** Math.min(3, loop.depth)),
				);
		const generatedCode = Math.max(8, instructionCount);
		// One entry analysis; the canonical representations are the baseline.
		const compilerWork = generatedCode + fn.valueCapacity;
		// Each seeded recurrence saves a generic operation per iteration, like a call does.
		const runtimeBenefit = nominations * Math.max(...loopWeight.values()) * 8;
		// The budget names a site; the first looping instruction stands for the whole entry.
		const instruction = [...fn.instructionIds()].find((candidate) =>
			loopWeight.has(fn.instructionBlock(candidate)),
		);
		if (instruction === undefined) return [];
		return [
			{
				function: functionId,
				instruction,
				generatedCode,
				compilerWork,
				runtimeBenefit,
				resolve(): ParameterEntry | undefined {
					// The entry reads parameters only, so an `arguments` read could disagree.
					const observation = coreArgumentObservation(fn);
					if (
						observation.kind === "general" ||
						observation.readsCount ||
						observation.indices.length > 0 ||
						observation.restStarts.length > 0
					)
						return;
					const cfg = analyses
						.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
							scope: "function",
							function: functionId,
						})
						.exceptional();
					const inLoop = (value: CoreValueId): boolean =>
						loopWeight.has(
							fn.kernel.valueDefinitionKind(value) === 0
								? (fn.kernel.valueDefinitionOwner(value) as CoreBlockId)
								: fn.instructionBlock(
										fn.kernel.valueDefinitionOwner(value) as CoreInstructionId,
									),
						);
					const variant = analyzeCoreNativeEntry(program, cfg, nominated, undefined, []);
					// Loop values, recurrences included, that the canonical body keeps boxed.
					if (
						!variant.valueRepresentations.some(
							(rep, value) =>
								rep !== "boxed" &&
								fn.valueRepresentation(value as CoreValueId) === "boxed" &&
								inLoop(value as CoreValueId),
						)
					)
						return;
					return Object.freeze({
						function: functionId,
						callSites: Object.freeze([]),
						canonicalDispatch: true as const,
						parameterRepresentations: Object.freeze(nominated),
						...variant,
					});
				},
			},
		];
	});
}

const OBJECT_OPERANDS: Readonly<Record<string, number>> = {
	loadPropertyStatic: 0,
	loadProperty: 0,
	storePropertyStatic: 0,
	storeProperty: 0,
	defineProperty: 0,
};

/**
 * Follows a parameter through moves and block arguments. It seeds a recurrence when it
 * reaches a loop header's parameter, and is used as an object when any value it becomes
 * is a property receiver, callee or call receiver, which a Number guard would always fail.
 */
function parameterFlow(
	fn: CoreFunctionStore,
	parameter: CoreValueId,
	headers: ReadonlySet<CoreBlockId>,
): { readonly seedsRecurrence: boolean; readonly usedAsObject: boolean } {
	let seedsRecurrence = false;
	const seen = new Set<CoreValueId>([parameter]);
	const pending = [parameter];
	while (pending.length > 0) {
		const value = pending.pop()!;
		for (
			let use = fn.kernel.valueFirstUse(value);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			const instruction = fn.kernel.useInstruction(use);
			const follow = (next: CoreValueId) => {
				if (seen.has(next)) return;
				seen.add(next);
				pending.push(next);
			};
			if (fn.instructionKind(instruction) !== "operation") {
				const start = fn.kernel.terminatorEdgeStart(instruction);
				for (
					let edge = start;
					edge < start + fn.kernel.terminatorEdgeCount(instruction);
					edge++
				) {
					const block = fn.kernel.terminatorEdgeBlock(edge);
					const argumentStart = fn.kernel.terminatorEdgeArgumentStart(edge);
					const parameterStart = fn.kernel.blockParameterStart(block);
					for (
						let index = 0;
						index < fn.kernel.terminatorEdgeArgumentCount(edge);
						index++
					) {
						if (fn.kernel.operandAt(argumentStart + index) !== value) continue;
						if (headers.has(block)) seedsRecurrence = true;
						follow(fn.kernel.blockParameterValue(parameterStart + index));
					}
				}
				continue;
			}
			const opcode = fn.instructionOpcodeName(instruction);
			const operand = fn.kernel.useOperand(use);
			if (
				OBJECT_OPERANDS[opcode] === operand ||
				((opcode === "call" || opcode === "construct") && operand <= 1)
			)
				return { seedsRecurrence, usedAsObject: true };
			if (opcode === "move")
				follow(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)));
		}
	}
	return { seedsRecurrence, usedAsObject: false };
}
