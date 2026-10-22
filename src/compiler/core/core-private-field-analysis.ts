import {
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../shared/compiler-value-kinds.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import {
	buildCoreControlFlow,
	coreCanonicalValueRoots,
	coreTerminatorInput,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import {
	analyzeCoreValueClasses,
	coreNumericTypedArrayKind,
} from "./core-ir-value-classes.ts";
import type { CoreValueClassAnalysis } from "./core-ir-value-classes.ts";
import { CORE_PROGRAM_FLOW_VALUE_KIND_SEMANTICS } from "./core-ir-value-kinds.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreBlockId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import {
	CorePrivateFieldFacts,
	corePrivateFieldKeys,
} from "./core-private-field-facts.ts";
import type {
	CorePrivateFieldBrand,
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

function valueDefinition(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreInstructionId | undefined {
	for (let depth = 0; depth < 16; depth++) {
		if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (fn.instructionOpcodeName(instruction) !== "move") return instruction;
		value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
	}
	return undefined;
}

function receiverOpcode(
	fn: CoreFunctionStore,
	receiver: CoreValueId,
): string | undefined {
	const definition = valueDefinition(fn, receiver);
	return definition === undefined ? undefined : fn.instructionOpcodeName(definition);
}

function instructionPrecedes(
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	earlier: CoreInstructionId,
	later: CoreInstructionId,
): boolean {
	const block = fn.instructionBlock(earlier);
	if (block !== fn.instructionBlock(later))
		return control.dominates(block, fn.instructionBlock(later));
	for (
		let next = fn.instructionNext(earlier);
		next !== undefined;
		next = fn.instructionNext(next)
	)
		if (next === later) return true;
	return false;
}

/** Whether only an activation that added the field to the store's receiver can run it. */
function storesOwnAddition(
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	writes: ReadonlyArray<CorePrivateFieldWrite>,
	write: CorePrivateFieldWrite,
): boolean {
	if (write.defines) return true;
	if (fn.isGenerator || fn.isAsync) return false;
	const opcode = receiverOpcode(fn, write.receiver);
	if (opcode === undefined) return false;
	if (FRESH_RECEIVERS.has(opcode)) return true;
	if (opcode !== "loadThis" || !fn.metadata.isClassConstructor) return false;
	// A base constructor's `this` is fresh, so it holds only fields this activation added.
	if (!fn.metadata.isDerivedConstructor) return true;
	// super() binds `this` before defining fields, so a caught definition failure would
	// leave `this` holding a field that another activation added.
	return (
		fn.handlerBlockCount === 0 &&
		writes.some(
			(definition) =>
				definition.defines &&
				definition.key === write.key &&
				receiverOpcode(fn, definition.receiver) === "loadThis" &&
				instructionPrecedes(fn, control, definition.instruction, write.instruction),
		)
	);
}

interface FieldWriter {
	readonly fn: CoreFunctionStore;
	readonly control: CoreControlFlow;
	readonly writes: ReadonlyArray<CorePrivateFieldWrite>;
	/** Writes whose value some read can return. */
	readonly observable: ReadonlyArray<CorePrivateFieldWrite>;
	readonly classes: CoreValueClassAnalysis;
}

/**
 * Writes a base constructor replaces before its fresh `this` can be read: until
 * `this` is used by anything but a private field write, no other code holds the
 * object, and a constructor without handlers drops it if anything throws.
 */
function overwrittenWrites(
	keys: CorePrivateFieldKeys,
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	writes: ReadonlyArray<CorePrivateFieldWrite>,
): ReadonlySet<CorePrivateFieldWrite> {
	const overwritten = new Set<CorePrivateFieldWrite>();
	if (
		!fn.metadata.isClassConstructor ||
		fn.metadata.isDerivedConstructor ||
		fn.handlerBlockCount > 0
	)
		return overwritten;
	const byInstruction = new Map<CoreInstructionId, Array<CorePrivateFieldWrite>>();
	for (const write of writes) {
		const group = byInstruction.get(write.instruction) ?? [];
		group.push(write);
		byInstruction.set(write.instruction, group);
	}
	const pending = new Map<string, CorePrivateFieldWrite>();
	let block = control.reversePostorder[0];
	const visited = new Set<CoreBlockId>();
	while (block !== undefined && !visited.has(block)) {
		visited.add(block);
		for (const instruction of fn.bodyInstructionIds(block)) {
			const group = byInstruction.get(instruction);
			if (group?.every((write) => receiverOpcode(fn, write.receiver) === "loadThis")) {
				for (const write of group) {
					const earlier = pending.get(write.key);
					if (!write.defines && earlier !== undefined) overwritten.add(earlier);
					pending.set(write.key, write);
				}
				continue;
			}
			const start = fn.kernel.instructionOperandStart(instruction);
			const opcode = fn.instructionOpcodeName(instruction);
			if (
				(opcode === "loadPrivate" || opcode === "hasPrivate") &&
				receiverOpcode(fn, fn.kernel.operandAt(start)) === "loadThis"
			) {
				// Reading one field of `this` observes only that field.
				const key = keys.key(fn, fn.kernel.operandAt(start + 1));
				if (key === undefined) return overwritten;
				pending.delete(key);
				continue;
			}
			for (let index = 0; index < fn.kernel.instructionOperandCount(instruction); index++)
				if (receiverOpcode(fn, fn.kernel.operandAt(start + index)) === "loadThis")
					return overwritten;
		}
		const terminator = coreTerminatorInput(fn, fn.blockTerminator(block));
		block =
			terminator.kind === "jump" &&
			(control.predecessors[terminator.edge.block] ?? []).length === 1
				? terminator.edge.block
				: undefined;
	}
	return overwritten;
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

// Null marks a field whose values do not share one class.
function joinBrand(
	previous: CorePrivateFieldBrand | null | undefined,
	next: CorePrivateFieldBrand | null,
): CorePrivateFieldBrand | null {
	return previous === undefined || previous === next ? next : null;
}

/**
 * The kinds and class each class-private field can hold: the least fixed point
 * over the values its observable writes store, where a write may itself read
 * private fields. Every value a private field holds comes from such a write, so
 * a successful read returns one of them. Direct eval could name private fields
 * invisibly.
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
		if (writes.length === 0) continue;
		const control = buildCoreControlFlow(program, id);
		const overwritten = overwrittenWrites(keys, fn, control, writes);
		writers.push({
			fn,
			control,
			writes,
			observable: writes.filter((write) => !overwritten.has(write)),
			classes: analyzeCoreValueClasses(
				program,
				id,
				context,
				coreCanonicalValueRoots(fn, control),
			),
		});
	}
	const construction = new Map<string, boolean>();
	for (const { fn, control, writes } of writers)
		for (const write of writes)
			construction.set(
				write.key,
				(construction.get(write.key) ?? true) &&
					storesOwnAddition(fn, control, writes, write),
			);
	const kinds = new Map<string, number>();
	const brands = new Map<string, CorePrivateFieldBrand | null>();
	const valueBrand = (
		{ fn, classes }: FieldWriter,
		value: CoreValueId,
	): CorePrivateFieldBrand | null | undefined => {
		const source = valueDefinition(fn, value);
		if (source !== undefined && fn.instructionOpcodeName(source) === "loadPrivate") {
			const key = keys.key(
				fn,
				fn.kernel.operandAt(fn.kernel.instructionOperandStart(source) + 1),
			);
			return key === undefined ? null : brands.get(key);
		}
		const brand = classes.exactHeapBrand(value);
		return brand === "Array" ? brand : (coreNumericTypedArrayKind(brand) ?? null);
	};
	let converged = false;
	for (let round = 0; round < FIELD_KIND_ROUNDS && !converged; round++) {
		converged = true;
		for (const writer of writers) {
			const { fn, control, observable } = writer;
			const values = observable.flatMap((write) =>
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
			for (const write of observable) {
				const brand = write.value === undefined ? null : valueBrand(writer, write.value);
				const mask =
					write.value === undefined
						? COMPILER_VALUE_KIND_UNDEFINED
						: brand !== null && brand !== undefined
							? COMPILER_VALUE_KIND_OBJECT
							: analysis!.latticeMask(write.value);
				const previous = kinds.get(write.key) ?? 0;
				if ((previous | mask) !== previous) {
					kinds.set(write.key, previous | mask);
					converged = false;
				}
				if (brand === undefined) continue;
				const joined = joinBrand(brands.get(write.key), brand);
				if (joined !== brands.get(write.key)) {
					brands.set(write.key, joined);
					converged = false;
				}
			}
		}
	}
	const fields = new Map<string, CorePrivateFieldFact>();
	for (const [key, constructionOnly] of construction)
		fields.set(key, {
			kinds: converged ? (kinds.get(key) ?? 0) : COMPILER_VALUE_KIND_TOP,
			brand: converged ? (brands.get(key) ?? undefined) : undefined,
			constructionOnly,
		});
	return new CorePrivateFieldFacts(keys, fields);
}
