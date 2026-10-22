import {
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../shared/compiler-value-kinds.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { CORE_PROGRAM_FLOW_VALUE_KIND_SEMANTICS } from "./core-ir-value-kinds.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import {
	CorePrivateFieldFacts,
	corePrivateFieldKeys,
} from "./core-private-field-facts.ts";
import type {
	CorePrivateFieldFact,
	CorePrivateFieldKeys,
	CorePrivateFieldWrite,
} from "./core-private-field-facts.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

const FIELD_KIND_ROUNDS = 16;

// Allocations whose object the current activation is still constructing.
const FRESH_RECEIVERS: ReadonlySet<string> = new Set([
	"createBaseConstructReceiver",
	"createObject",
	"createObjectShaped",
]);

function constructsReceiver(fn: CoreFunctionStore, receiver: CoreValueId): boolean {
	for (let depth = 0; depth < 16; depth++) {
		if (fn.kernel.valueDefinitionKind(receiver) !== 1) return false;
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(receiver));
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode === "move") {
			receiver = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
			continue;
		}
		// A class constructor's own fields are defined on its `this` before any write.
		if (opcode === "loadThis") return fn.metadata.isClassConstructor;
		return FRESH_RECEIVERS.has(opcode);
	}
	return false;
}

interface FieldWriter {
	readonly fn: CoreFunctionStore;
	readonly control: CoreControlFlow;
	readonly writes: ReadonlyArray<CorePrivateFieldWrite>;
}

function fieldReadMask(
	keys: CorePrivateFieldKeys,
	fn: CoreFunctionStore,
	kinds: ReadonlyMap<string, number>,
): (instruction: CoreInstructionId) => number | undefined {
	return (instruction) => {
		const opcode = fn.instructionOpcodeName(instruction);
		// A construction result is always an object, even when the constructor returns a primitive.
		if (opcode === "construct") return COMPILER_VALUE_KIND_OBJECT;
		if (opcode !== "loadPrivate") return undefined;
		const key = keys.key(
			fn,
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + 1),
		);
		return key === undefined ? undefined : (kinds.get(key) ?? 0);
	};
}

/**
 * The kinds each class-private field can hold: the least fixed point over the
 * values its writes store, where a write may itself read private fields. Every
 * value a private field holds comes from such a write, so a successful read
 * returns one of them. Direct eval could name private fields invisibly.
 */
export function analyzeCorePrivateFields(
	program: CoreProgram,
	context: CoreCompilationContext,
): CorePrivateFieldFacts | undefined {
	if (context.facts.world.eval === "runtime") return undefined;
	const keys = corePrivateFieldKeys(program, context);
	const writers: Array<FieldWriter> = [];
	for (const id of program.functionIds()) {
		const fn = program.function(id);
		const writes = keys.writes(fn);
		if (writes === undefined) return undefined;
		if (writes.length > 0)
			writers.push({ fn, control: buildCoreControlFlow(program, id), writes });
	}
	const construction = new Map<string, boolean>();
	for (const { fn, writes } of writers)
		for (const write of writes)
			construction.set(
				write.key,
				(construction.get(write.key) ?? true) && constructsReceiver(fn, write.receiver),
			);
	const kinds = new Map<string, number>();
	let converged = false;
	for (let round = 0; round < FIELD_KIND_ROUNDS && !converged; round++) {
		converged = true;
		for (const { fn, control, writes } of writers) {
			const values = writes.flatMap((write) =>
				write.value === undefined ? [] : [write.value],
			);
			const read = fieldReadMask(keys, fn, kinds);
			const analysis =
				values.length === 0
					? undefined
					: CORE_PROGRAM_FLOW_VALUE_KIND_SEMANTICS.analyze(fn, control, {
							demandedValues: values,
							operationResultMask: read,
						});
			for (const write of writes) {
				const mask =
					write.value === undefined
						? COMPILER_VALUE_KIND_UNDEFINED
						: analysis!.latticeMask(write.value);
				const previous = kinds.get(write.key) ?? 0;
				if ((previous | mask) === previous) continue;
				kinds.set(write.key, previous | mask);
				converged = false;
			}
		}
	}
	const fields = new Map<string, CorePrivateFieldFact>();
	for (const [key, constructionOnly] of construction)
		fields.set(key, {
			kinds: converged ? (kinds.get(key) ?? 0) : COMPILER_VALUE_KIND_TOP,
			constructionOnly,
		});
	return new CorePrivateFieldFacts(keys, fields);
}
