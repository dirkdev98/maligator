import { CoreEditor } from "./core-editor.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { coreStaticArraySearchPlan } from "./core-known-operation-results.ts";
import {
	literalDefinition,
	literalResult,
	literalGraph,
	shallowTemplate,
} from "./core-literal-graph.ts";
import type { LiteralUse } from "./core-literal-graph.ts";
import { coreMaterializationPlan } from "./core-materialization-demands.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import { coreStaticDataQueryPlan } from "./core-static-data-query.ts";
import { CORE_STATIC_VALUE_ANALYSIS } from "./core-static-values.ts";

export const reuseLiteralConstants: CoreFunctionPass = {
	name: "reuse-literal-constants",
	stage: "memory",
	requiredFunctionOpcodesAny: ["callKnown"],
	admission: {
		predicate: "known operation with a private literal storage demand",
		hasOpportunity({ compilationContext }) {
			return (
				compilationContext.facts.world.primordialPolicy === "locked" &&
				!compilationContext.facts.world.realms
			);
		},
	},
	requiredAnalyses: [CORE_STATIC_VALUE_ANALYSIS],
	wakesOn: ["body", "cfg", "memoryEffects"],
	changes: { cfg: false, calls: false, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const { program, item } = context,
			fn = program.function(item.function);
		const roots = new Set<CoreInstructionId>();
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "callKnown"
			)
				continue;
			const attributes = fn.instructionAttributes(instruction);
			if (attributes.construct || attributes.argumentMode !== undefined) continue;
			let value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
			let root = literalDefinition(fn, value);
			while (root !== undefined && fn.instructionOpcodeName(root) === "move") {
				value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(root));
				root = literalDefinition(fn, value);
			}
			if (
				root !== undefined &&
				[
					"createArray",
					"createObject",
					"createObjectShaped",
					"instantiateLiteralTemplate",
				].includes(fn.instructionOpcodeName(root)) &&
				fn.instructionAttributes(root).cacheSlot === undefined
			)
				roots.add(root);
		}
		if (roots.size === 0) return undefined;
		const analysis = context.analysis(CORE_STATIC_VALUE_ANALYSIS);
		const useIndex = new Map<CoreValueId, ReadonlyArray<LiteralUse>>();
		const uses = (value: CoreValueId): ReadonlyArray<LiteralUse> => {
			let entries = useIndex.get(value);
			if (entries !== undefined) return entries;
			const rows: Array<LiteralUse> = [];
			for (
				let use = fn.kernel.valueFirstUse(value);
				use >= 0;
				use = fn.kernel.useNext(use)
			)
				rows.push({
					instruction: fn.kernel.useInstruction(use),
					operand: fn.kernel.useOperand(use),
				});
			entries = rows;
			useIndex.set(value, entries);
			return entries;
		};
		for (const root of roots) {
			const literal = literalGraph(program, fn, root, uses);
			if (literal === undefined) continue;
			const receiver = literalResult(fn, root);
			const plan = coreMaterializationPlan(fn, receiver, {
				initializers: literal.initializers,
				graphAllocations: literal.allocations,
				shallow: shallowTemplate(literal.words),
			});
			if (plan.choice !== "private-read-only") continue;
			if (
				plan.demands
					.filter((demand) => demand.kind !== "alias")
					.every(
						(demand) =>
							coreStaticDataQueryPlan(program, fn, analysis, demand.instruction) !==
								undefined ||
							(shallowTemplate(literal.words) &&
								coreStaticArraySearchPlan(program, fn, analysis, demand.instruction) !==
									undefined),
					)
			)
				continue;
			const block = fn.instructionBlock(root),
				order = new Map<CoreInstructionId, number>();
			for (const instruction of fn.instructionIds(block))
				order.set(instruction, order.size);
			if (
				plan.demands.some(
					(demand) =>
						demand.kind !== "alias" &&
						(fn.instructionBlock(demand.instruction) !== block ||
							[...literal.initializers].some(
								(initializer) =>
									order.get(initializer)! >= order.get(demand.instruction)!,
							)),
				)
			)
				continue;
			if (
				[...literal.allocations].some(
					(allocation) =>
						allocation !== root &&
						(fn.kernel.valueHandlerUseCount(literalResult(fn, allocation)) > 0 ||
							uses(literalResult(fn, allocation)).some(
								(use) =>
									!literal.initializers.has(use.instruction) &&
									!literal.allocations.has(use.instruction),
							)),
				)
			)
				continue;
			const fact = analysis.query(receiver);
			if (fact.kind !== "known") continue;
			analysis.verify(fact);
			const editor = CoreEditor.open(program, item.function);
			const template = editor.appendLiteralTemplate(literal.words, true);
			for (const initializer of literal.initializers)
				editor.removeInstruction(initializer);
			editor.replaceInstruction(root, "instantiateLiteralTemplate", [], {
				attributes: { ...template, materialization: "private-read-only" },
				sourcePosition: fn.instructionSourcePosition(root),
			});
			for (const allocation of literal.allocations)
				if (allocation !== root) editor.removeInstruction(allocation);
			return editor.commit();
		}
		return undefined;
	},
};
