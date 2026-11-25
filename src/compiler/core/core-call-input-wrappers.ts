import { COMPILER_VALUE_KIND_TOP } from "../shared/compiler-value-kinds.ts";
import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import { coreCallInputFacts } from "./core-call-input-facts.ts";
import type { CoreCallInputFact, CoreCallInputFacts } from "./core-call-input-facts.ts";
import {
	analyzeCoreConditionalValueKinds,
	corePredicateRestrictions,
} from "./core-conditional-value-kinds.ts";
import {
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	coreCanonicalValueRoots,
} from "./core-ir-control-flow.ts";
import type { CoreFunctionId, CoreInstructionId } from "./core-ir.ts";
import type { CoreProgramFlowState } from "./core-program-flow-analysis.ts";
import type { CoreProgram } from "./core-store.ts";

export function projectCoreCallInputFactsThroughWrappers(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	flow: CoreProgramFlowState,
	seeds: ReadonlySet<CoreFunctionId>,
	plans: Map<CoreFunctionId, Map<CoreInstructionId, CoreCallInputFacts>>,
): void {
	const unknown = () => COMPILER_VALUE_KIND_TOP;
	const summarize = (functionId: CoreFunctionId): CoreCallInputFacts | undefined => {
		const fn = program.function(functionId);
		if (
			fn.isAsync ||
			fn.isGenerator ||
			fn.metadata.mappedArguments ||
			fn.parameterCount === 0 ||
			fn.parameterCount > 16 ||
			fn.instructionCapacity > 160
		)
			return undefined;
		const cfg = analyses
			.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
				scope: "function",
				function: functionId,
			})
			.exceptional();
		if (
			cfg.predecessors[fn.entry]?.some((edge) => cfg.reachable.has(cfg.edges.from(edge)))
		)
			return undefined;
		const roots = coreCanonicalValueRoots(fn, cfg);
		const parameters = Array.from({ length: fn.parameterCount }, (_, index) =>
			fn.kernel.functionParameter(index),
		);
		const read = (instruction: CoreInstructionId) =>
			plans.get(functionId)?.get(instruction) ?? coreCallInputFacts(fn, instruction);
		const kinds = analyzeCoreConditionalValueKinds(program, fn, cfg, unknown, read);
		const join = (
			prior: Array<CoreCallInputFact> | undefined,
			facts: Array<CoreCallInputFact>,
		) =>
			prior === undefined
				? facts
				: prior.flatMap((left) => {
						const right = facts.find((right) => right.index === left.index);
						if (
							right === undefined ||
							(left.mask | right.mask) === COMPILER_VALUE_KIND_TOP
						)
							return [];
						return [
							{
								index: left.index,
								mask: left.mask | right.mask,
								...(left.brand === undefined || left.brand !== right.brand
									? {}
									: { brand: left.brand }),
							},
						];
					});
		let onTrue: Array<CoreCallInputFact> | undefined;
		let onFalse: Array<CoreCallInputFact> | undefined;
		let onReturn: Array<CoreCallInputFact> | undefined;
		for (const block of cfg.reversePostorder) {
			const instruction = fn.blockTerminator(block);
			if (fn.instructionKind(instruction) !== "return") continue;
			const result = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
			const restrictions = corePredicateRestrictions(program, fn, result, unknown, read);
			const yes: Array<CoreCallInputFact> = [];
			const no: Array<CoreCallInputFact> = [];
			for (const restriction of restrictions) {
				if (!restriction.call) continue;
				const index = parameters.indexOf(
					roots.get(restriction.subject) ?? restriction.subject,
				);
				if (index < 0) continue;
				if (restriction.yes && restriction.yes !== COMPILER_VALUE_KIND_TOP)
					yes.push({ index, mask: restriction.yes, brand: restriction.yesBrand });
				if (restriction.no && restriction.no !== COMPILER_VALUE_KIND_TOP)
					no.push({ index, mask: restriction.no, brand: restriction.noBrand });
			}
			onTrue = join(onTrue, yes);
			onFalse = join(onFalse, no);
			onReturn = join(
				onReturn,
				parameters.flatMap((value, index) => {
					const mask = kinds.kindMask(value, block, instruction);
					const brand = kinds.heapBrand?.(value, block, instruction);
					return mask === COMPILER_VALUE_KIND_TOP ? [] : [{ index, mask, brand }];
				}),
			);
		}
		return onTrue?.length || onFalse?.length || onReturn?.length
			? { onTrue, onFalse, onReturn }
			: undefined;
	};
	let frontier = seeds;
	// A bounded reverse traversal covers forwarding chains without making input
	// facts another fixed point over every function in the program.
	for (let depth = 0; depth < 4 && frontier.size !== 0; depth++) {
		const callers = new Set<CoreFunctionId>();
		for (const callee of frontier) {
			const exactCallers = flow.targets.graph.exactCallers(callee);
			if (exactCallers.length === 0) continue;
			const facts = summarize(callee);
			if (facts === undefined) continue;
			for (const caller of exactCallers) {
				const fn = program.function(caller);
				for (const site of flow.targets.outgoing(caller)) {
					const { instruction, targets } = site;
					if (
						targets.opaque ||
						targets.anyScript ||
						targets.functions.length !== 1 ||
						targets.functions[0] !== callee ||
						site.arguments === undefined ||
						fn.instructionOpcodeName(instruction) !== "call" ||
						fn.instructionAttributes(instruction).argumentMode !== undefined
					)
						continue;
					const start = fn.kernel.instructionOperandStart(instruction);
					const count = fn.kernel.instructionOperandCount(instruction);
					const project = (facts: ReadonlyArray<CoreCallInputFact> | undefined) =>
						facts?.flatMap((fact) => {
							const index = fact.index + 2;
							return index >= count ||
								fn.kernel.operandAt(start + index) !== site.arguments?.[fact.index]
								? []
								: [{ ...fact, index }];
						});
					const onTrue = project(facts.onTrue),
						onFalse = project(facts.onFalse),
						onReturn = project(facts.onReturn);
					if (!(onTrue?.length || onFalse?.length || onReturn?.length)) continue;
					const instructions =
						plans.get(caller) ?? new Map<CoreInstructionId, CoreCallInputFacts>();
					if (
						instructions.has(instruction) ||
						coreCallInputFacts(fn, instruction) !== undefined
					)
						continue;
					instructions.set(instruction, { onTrue, onFalse, onReturn });
					plans.set(caller, instructions);
					callers.add(caller);
				}
			}
		}
		frontier = callers;
	}
}
