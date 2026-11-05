import { CORE_CALLEE_TARGET_CAP } from "../core/core-callee-targets.ts";
import type { CoreCompilation } from "../core/core-compilation.ts";
import {
	buildCoreControlFlow,
	coreCanonicalValueRoots,
	coreTerminatorInput,
} from "../core/core-ir-control-flow.ts";
import { coreFunctionId, coreInstructionId } from "../core/core-ir.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "../core/core-ir.ts";
import { coreExactArrayFromCallResult } from "../core/core-static-values.ts";
import type { CoreFunctionStore } from "../core/core-store.ts";

function definition(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreInstructionId | undefined {
	const seen = new Set<CoreValueId>();
	for (let depth = 0; depth < 16; depth++) {
		if (seen.has(value) || fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
		seen.add(value);
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (fn.instructionOpcodeName(instruction) !== "move") return instruction;
		value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
	}
	return undefined;
}

/** Advisory targets never strengthen Core facts: every call keeps its identity guard and fallback. */
export function mappedFunctionArrayCallHints(
	compilation: CoreCompilation,
	fn: CoreFunctionStore,
	available: ReadonlyArray<number>,
): ReadonlyMap<CoreInstructionId, ReadonlyArray<CoreFunctionId>> {
	const result = new Map<CoreInstructionId, ReadonlyArray<CoreFunctionId>>();
	const world = compilation.context.facts.world;
	if (world.primordialPolicy !== "locked" || world.eval !== "disabled" || world.realms)
		return result;
	const producers = [...fn.instructionIds()].filter(
		(instruction) =>
			fn.instructionKind(instruction) === "operation" &&
			fn.instructionOpcodeName(instruction) === "callKnown" &&
			fn.instructionAttributes(instruction).operation === "Array.from" &&
			fn.kernel.instructionOperandCount(instruction) >= 3,
	);
	if (producers.length === 0) return result;
	const candidates = new Map<CoreInstructionId, ReadonlyArray<CoreFunctionId>>();
	for (const producer of producers) {
		const mapperDefinition = definition(
			fn,
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(producer) + 2),
		);
		if (
			mapperDefinition === undefined ||
			fn.instructionOpcodeName(mapperDefinition) !== "createFunction"
		)
			continue;
		const mapperIndex = fn.instructionAttributes(mapperDefinition).functionIndex;
		if (
			typeof mapperIndex !== "number" ||
			available[mapperIndex] === undefined ||
			available[mapperIndex] < 0
		)
			continue;
		const mapper = compilation.program.function(coreFunctionId(mapperIndex));
		if (mapper.isAsync || mapper.isGenerator) continue;
		const targets = new Set<CoreFunctionId>();
		for (const block of mapper.blockIds()) {
			const term = coreTerminatorInput(mapper, mapper.blockTerminator(block));
			if (term.kind !== "return") continue;
			const returned = definition(mapper, term.value);
			if (
				returned === undefined ||
				mapper.instructionOpcodeName(returned) !== "createFunction"
			)
				continue;
			const target = mapper.instructionAttributes(returned).functionIndex;
			if (
				typeof target === "number" &&
				available[target] !== undefined &&
				available[target] >= 0
			)
				targets.add(coreFunctionId(target));
		}
		if (targets.size > 0 && targets.size <= CORE_CALLEE_TARGET_CAP)
			candidates.set(
				producer,
				[...targets].sort((a, b) => a - b),
			);
	}
	if (candidates.size === 0) return result;
	const roots = coreCanonicalValueRoots(
		fn,
		buildCoreControlFlow(compilation.program, fn.id, { exceptions: true }),
	);
	const root = (value: CoreValueId) => roots.get(value) ?? value;
	const arrays = new Map<CoreValueId, ReadonlyArray<CoreFunctionId>>();
	for (const [producer, targets] of candidates) {
		const array = coreExactArrayFromCallResult(
			compilation.program,
			fn,
			roots,
			compilation.context,
			producer,
		);
		if (array !== undefined) arrays.set(root(array), targets);
	}
	if (arrays.size === 0) return result;
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionOpcodeName(instruction) !== "call"
		)
			continue;
		const attributes = fn.instructionAttributes(instruction);
		if (attributes.construct || attributes.argumentMode !== undefined) continue;
		const load = definition(
			fn,
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)),
		);
		if (load === undefined || fn.instructionOpcodeName(load) !== "loadProperty") continue;
		const receiver = fn.kernel.operandAt(fn.kernel.instructionOperandStart(load));
		const targets = arrays.get(root(receiver));
		if (targets !== undefined) result.set(instruction, targets);
	}
	return result;
}
