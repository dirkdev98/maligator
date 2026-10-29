import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
} from "../shared/compiler-value-kinds.ts";
import { compilerIntegerRangesEqual } from "../shared/integer-range.ts";
import type { CompilerIntegerRange } from "../shared/integer-range.ts";
import {
	CORE_CALLEE_TARGETS_BOTTOM,
	coreCalleeTargetsEqual,
	joinCoreCalleeTargets,
} from "./core-callee-targets.ts";
import type { CoreCalleeTargets } from "./core-callee-targets.ts";
import { joinCoreHeapBrands } from "./core-heap-brands.ts";
import type { CoreHeapBrandState } from "./core-heap-brands.ts";
import type { CoreControlEdge, CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import { coreBlockId, coreInstructionId } from "./core-ir.ts";
import type { CoreBlockId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

export interface CoreRecordFieldKind {
	// Null keeps an unsolved field separate from an unknown field during range convergence.
	readonly integerRange?: CompilerIntegerRange | null;
	readonly heapBrand?: CoreHeapBrandState;
	readonly calleeTargets?: CoreCalleeTargets;
	readonly key: number;
	readonly mask: number;
}

// Field arrays describe fresh private records; null has no normal result, undefined admits escapes and non-records.
export type CoreRecordValueKind = ReadonlyArray<CoreRecordFieldKind> | null | undefined;

function joinFieldIntegerRanges(
	left: CompilerIntegerRange | null | undefined,
	right: CompilerIntegerRange | null | undefined,
): CompilerIntegerRange | null | undefined {
	if (left === undefined || right === undefined) return undefined;
	if (left === null) return right;
	if (right === null) return left;
	return Object.freeze({
		minimum: Math.min(left.minimum, right.minimum),
		maximum: Math.max(left.maximum, right.maximum),
		exactSafeIntegers: true,
		excludesNegativeZero: true,
	});
}

function joinFieldCalleeTargets(
	left: CoreCalleeTargets | undefined,
	right: CoreCalleeTargets | undefined,
): CoreCalleeTargets | undefined {
	return left === undefined || right === undefined
		? undefined
		: joinCoreCalleeTargets(left, right);
}

export function sameCoreRecordValueKind(
	left: CoreRecordValueKind,
	right: CoreRecordValueKind,
): boolean {
	return (
		left === right ||
		(left !== undefined &&
			left !== null &&
			right !== undefined &&
			right !== null &&
			left.length === right.length &&
			left.every(
				(field, index) =>
					field.key === right[index]!.key &&
					field.mask === right[index]!.mask &&
					field.heapBrand === right[index]!.heapBrand &&
					(field.calleeTargets === right[index]!.calleeTargets ||
						(field.calleeTargets !== undefined &&
							right[index]!.calleeTargets !== undefined &&
							coreCalleeTargetsEqual(
								field.calleeTargets,
								right[index]!.calleeTargets,
							))) &&
					(field.integerRange === right[index]!.integerRange ||
						(field.integerRange !== null &&
							right[index]!.integerRange !== null &&
							compilerIntegerRangesEqual(
								field.integerRange,
								right[index]!.integerRange,
							))),
			))
	);
}

export function joinCoreRecordValueKinds(
	left: CoreRecordValueKind,
	right: CoreRecordValueKind,
): CoreRecordValueKind {
	if (left === undefined || right === undefined) return undefined;
	if (left === null) return right;
	if (right === null) return left;
	const fields: Array<CoreRecordFieldKind> = [];
	for (const field of left) {
		const other = right.find((candidate) => candidate.key === field.key);
		if (other === undefined) continue;
		if (field.mask === 0) {
			fields.push(other);
			continue;
		}
		if (other.mask === 0) {
			fields.push(field);
			continue;
		}
		const mask = field.mask | other.mask;
		const integerRange =
			mask !== COMPILER_VALUE_KIND_NUMBER
				? undefined
				: joinFieldIntegerRanges(field.integerRange, other.integerRange);
		const heapBrand =
			mask === COMPILER_VALUE_KIND_OBJECT
				? joinCoreHeapBrands(field.heapBrand, other.heapBrand)
				: undefined;
		const calleeTargets = joinFieldCalleeTargets(
			field.calleeTargets,
			other.calleeTargets,
		);
		fields.push(
			Object.freeze({
				key: field.key,
				mask,
				...(integerRange === undefined ? {} : { integerRange }),
				...(heapBrand === undefined ? {} : { heapBrand }),
				...(calleeTargets === undefined ? {} : { calleeTargets }),
			}),
		);
	}
	return Object.freeze(fields);
}

const MAXIMUM_RECORD_RETURN_ALIAS_WORK = 256;

interface CoreRecordFieldWrite {
	readonly instruction: CoreInstructionId;
	readonly value: CoreValueId;
	readonly edge?: CoreControlEdge;
}

function returnedValueUseCount(
	fn: CoreFunctionStore,
	value: CoreValueId,
	allowBlockArguments: boolean,
	ownAccess?: (instruction: CoreInstructionId, operand: number) => boolean,
): number | undefined {
	const pending = [value];
	const seen = new Set<CoreValueId>();
	let remaining = MAXIMUM_RECORD_RETURN_ALIAS_WORK;
	let returns = 0;
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (seen.has(current)) continue;
		seen.add(current);
		if (allowBlockArguments && --remaining < 0) return undefined;
		if (fn.kernel.valueHandlerUseCount(current) > 0) return undefined;
		for (
			let use = fn.kernel.valueFirstUse(current);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			if (fn.kernel.useLive(use) === 0) continue;
			if (allowBlockArguments && --remaining < 0) return undefined;
			const instruction = fn.kernel.useInstruction(use);
			const kind = fn.instructionKind(instruction);
			if (kind === "return") {
				returns++;
				continue;
			}
			if (kind !== "operation") {
				if (!allowBlockArguments) return undefined;
				const operand =
					fn.kernel.instructionOperandStart(instruction) + fn.kernel.useOperand(use);
				const start = fn.kernel.terminatorEdgeStart(instruction);
				const count = fn.kernel.terminatorEdgeCount(instruction);
				let forwarded = false;
				for (let edge = start; edge < start + count; edge++) {
					if (--remaining < 0) return undefined;
					const first = fn.kernel.terminatorEdgeArgumentStart(edge);
					const index = operand - first;
					if (index < 0 || index >= fn.kernel.terminatorEdgeArgumentCount(edge)) continue;
					const block = fn.kernel.terminatorEdgeBlock(edge);
					const parameter = fn.kernel.blockParameterStart(block) + index;
					if (fn.kernel.blockParameterRole(parameter) !== 0) return undefined;
					pending.push(fn.kernel.blockParameterValue(parameter));
					forwarded = true;
					break;
				}
				if (!forwarded) return undefined;
				continue;
			}
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "rootUse") continue;
			if (allowBlockArguments && opcode === "throwIfTdz") continue;
			if (opcode !== "move") {
				if (ownAccess?.(instruction, fn.kernel.useOperand(use)) === true) continue;
				return undefined;
			}
			pending.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)));
		}
	}
	return returns;
}

/** Control-flow aliases suffice for field facts; caller-owned record storage needs direct return uses. */
export function coreValueOnlyReturned(
	fn: CoreFunctionStore,
	value: CoreValueId,
	allowBlockArguments = false,
): boolean {
	return returnedValueUseCount(fn, value, allowBlockArguments) !== undefined;
}

export function coreReturnedValueDefinition(
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

function recordPropertyKey(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): number | undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	let key =
		opcode === "loadPropertyStatic" || opcode === "storePropertyStatic"
			? fn.instructionAttributes(instruction).stringIndex
			: undefined;
	if (opcode === "loadProperty" || opcode === "storeProperty") {
		const literal = coreReturnedValueDefinition(
			fn,
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + 1),
		);
		if (literal !== undefined && fn.instructionOpcodeName(literal) === "createString")
			key = fn.instructionAttributes(literal).stringIndex;
	}
	return typeof key === "number" ? key : undefined;
}

const EMPTY_RECORD_KEYS: ReadonlyArray<number> = Object.freeze([]);

function recordKeys(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): ReadonlyArray<number> | undefined {
	if (fn.instructionKind(instruction) !== "operation") return undefined;
	const opcode = fn.instructionOpcodeName(instruction);
	if (opcode === "createObject" && fn.kernel.instructionOperandCount(instruction) === 0)
		return EMPTY_RECORD_KEYS;
	if (opcode !== "createObjectShaped") return undefined;
	const keys = fn.instructionAttributes(instruction).keyStringIndices;
	if (
		!Array.isArray(keys) ||
		keys.length > 16 ||
		keys.length !== fn.kernel.instructionOperandCount(instruction) ||
		!keys.every(
			(key) => typeof key === "number" && Number.isSafeInteger(key) && key >= 0,
		) ||
		new Set(keys).size !== keys.length
	)
		return undefined;
	return keys as ReadonlyArray<number>;
}

interface CoreRecordReturnFields {
	readonly literalKeys: ReadonlyArray<number> | undefined;
	readonly requiredKeys: ReadonlyArray<number>;
	readonly writes?: ReadonlyMap<number, ReadonlyArray<CoreRecordFieldWrite>>;
}

interface CoreRecordReturnIndex {
	readonly featureVersion: number;
	readonly fields: ReadonlyMap<CoreInstructionId, CoreRecordReturnFields>;
	readonly inputs: ReadonlyArray<CoreValueId>;
}

const recordReturnIndices = new WeakMap<CoreFunctionStore, CoreRecordReturnIndex>();

function returnedDefinitions(
	fn: CoreFunctionStore,
): ReadonlySet<CoreInstructionId> | undefined {
	const definitions = new Set<CoreInstructionId>();
	const pending: Array<CoreValueId> = [];
	for (const block of fn.blockIds()) {
		const terminator = fn.blockTerminator(block);
		if (fn.instructionKind(terminator) === "return")
			pending.push(fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator)));
	}
	const seen = new Set<CoreValueId>();
	let incoming: Map<CoreBlockId, Array<number>> | undefined;
	let remaining = MAXIMUM_RECORD_RETURN_ALIAS_WORK;
	while (pending.length > 0) {
		const value = pending.pop()!;
		if (seen.has(value)) continue;
		seen.add(value);
		if (--remaining < 0) return undefined;
		if (fn.kernel.valueDefinitionKind(value) === 1) {
			const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
			if (fn.instructionOpcodeName(instruction) === "move")
				pending.push(fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)));
			else definitions.add(instruction);
		} else if (fn.kernel.valueDefinitionKind(value) === 0) {
			if (incoming === undefined) {
				incoming = new Map();
				for (const block of fn.blockIds()) {
					const terminator = fn.blockTerminator(block);
					const start = fn.kernel.terminatorEdgeStart(terminator);
					const count = fn.kernel.terminatorEdgeCount(terminator);
					for (let edge = start; edge < start + count; edge++) {
						if (--remaining < 0) return undefined;
						const target = fn.kernel.terminatorEdgeBlock(edge);
						let row = incoming.get(target);
						if (row === undefined) incoming.set(target, (row = []));
						row.push(edge);
					}
				}
			}
			const block = coreBlockId(fn.kernel.valueDefinitionOwner(value));
			const index = fn.kernel.valueDefinitionIndex(value);
			for (const edge of incoming.get(block) ?? []) {
				if (index < fn.kernel.terminatorEdgeArgumentCount(edge))
					pending.push(
						fn.kernel.operandAt(fn.kernel.terminatorEdgeArgumentStart(edge) + index),
					);
			}
		}
	}
	return definitions;
}

function recordReturnIndex(
	fn: CoreFunctionStore,
): Omit<CoreRecordReturnIndex, "featureVersion"> {
	const featureVersion = fn.hasActiveEditor ? undefined : fn.featureVersion;
	const cached = recordReturnIndices.get(fn);
	if (featureVersion !== undefined && cached?.featureVersion === featureVersion)
		return cached;
	const fields = new Map<CoreInstructionId, CoreRecordReturnFields>();
	const inputs: Array<CoreValueId> = [];
	if (!fn.isAsync && !fn.isGenerator) {
		const returned = returnedDefinitions(fn);
		for (const instruction of fn.instructionIds()) {
			if (returned !== undefined && !returned.has(instruction)) continue;
			const keys = recordKeys(fn, instruction);
			if (keys === undefined) {
				if (
					fn.instructionKind(instruction) !== "operation" ||
					fn.kernel.instructionResultCount(instruction) !== 1
				)
					continue;
				const completion = fn.registry.byId(fn.instructionOpcode(instruction))
					.callTransfer?.result;
				if (completion !== "call-completion" && completion !== "construct-completion")
					continue;
			}
			const requiredKeys = new Set<number>();
			let writes: Map<number, Array<CoreRecordFieldWrite>> | undefined;
			const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
			const returns = returnedValueUseCount(fn, value, true, (access, operand) => {
				if (operand !== 0) return false;
				const key = recordPropertyKey(fn, access);
				if (key === undefined || (keys !== undefined && !keys.includes(key)))
					return false;
				requiredKeys.add(key);
				const opcode = fn.instructionOpcodeName(access);
				if (opcode === "loadPropertyStatic" || opcode === "loadProperty") return true;
				if (opcode !== "storePropertyStatic" && opcode !== "storeProperty") return false;
				writes ??= new Map();
				let row = writes.get(key);
				if (row === undefined) writes.set(key, (row = []));
				row.push(
					Object.freeze({
						instruction: access,
						value: fn.kernel.operandAt(
							fn.kernel.instructionOperandStart(access) +
								(opcode === "storePropertyStatic" ? 1 : 2),
						),
					}),
				);
				return true;
			});
			if (returns === undefined || returns === 0) continue;
			const start = fn.kernel.instructionOperandStart(instruction);
			for (let index = 0; index < (keys?.length ?? 0); index++)
				inputs.push(fn.kernel.operandAt(start + index));
			for (const row of writes?.values() ?? []) {
				Object.freeze(row);
				for (const write of row) inputs.push(write.value);
			}
			fields.set(
				instruction,
				Object.freeze({
					literalKeys: keys === undefined ? undefined : Object.freeze([...keys]),
					requiredKeys: Object.freeze([...requiredKeys]),
					...(writes === undefined ? {} : { writes }),
				}),
			);
		}
	}
	const index = { fields, inputs: Object.freeze(inputs) };
	if (featureVersion !== undefined)
		recordReturnIndices.set(fn, { ...index, featureVersion });
	return index;
}

export function coreRecordReturnKindInputs(
	fn: CoreFunctionStore,
): ReadonlyArray<CoreValueId> {
	return recordReturnIndex(fn).inputs;
}

interface CoreRecordReturnWriteIndex {
	readonly fields: ReadonlyMap<CoreInstructionId, CoreRecordReturnFields>;
	readonly cfg: CoreControlFlow;
	readonly memoryEffectVersion: number | undefined;
	readonly returns: ReadonlyArray<CoreInstructionId>;
	readonly position: (instruction: CoreInstructionId) => number;
	readonly producers: Map<
		CoreInstructionId,
		{
			readonly writes: ReadonlyMap<CoreInstructionId, number>;
			readonly keys: Map<number, ReadonlyArray<CoreRecordFieldAccess> | undefined>;
		}
	>;
}

const recordReturnWriteIndices = new WeakMap<
	CoreFunctionStore,
	CoreRecordReturnWriteIndex
>();
const NO_RECORD_BARRIERS: ReadonlySet<CoreInstructionId> = new Set();

function recordReturnWrites(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	fields: ReadonlyMap<CoreInstructionId, CoreRecordReturnFields>,
	producer: CoreInstructionId,
	key: number,
): ReadonlyArray<CoreRecordFieldAccess> | undefined {
	const memoryEffectVersion =
		fn.handlerBlockCount === 0 ? undefined : fn.version("memoryEffects");
	let index = recordReturnWriteIndices.get(fn);
	if (
		index?.fields !== fields ||
		index.cfg !== cfg ||
		index.memoryEffectVersion !== memoryEffectVersion
	) {
		const positions = new Map<CoreInstructionId, number>();
		const returns: Array<CoreInstructionId> = [];
		let order = 0;
		for (const block of fn.blockIds()) {
			for (const instruction of fn.bodyInstructionIds(block))
				positions.set(instruction, order++);
			const terminator = fn.blockTerminator(block);
			positions.set(terminator, order++);
			if (cfg.reachable.has(block) && fn.instructionKind(terminator) === "return")
				returns.push(terminator);
		}
		index = {
			fields,
			cfg,
			memoryEffectVersion,
			returns,
			position: (instruction) => positions.get(instruction)!,
			producers: new Map(),
		};
		if (!fn.hasActiveEditor) recordReturnWriteIndices.set(fn, index);
	}
	let plan = index.producers.get(producer);
	if (plan === undefined) {
		const writes = new Map<CoreInstructionId, number>();
		for (const [key, row] of fields.get(producer)!.writes!)
			for (const write of row) writes.set(write.instruction, key);
		plan = { writes, keys: new Map() };
		index.producers.set(producer, plan);
	}
	if (plan.keys.has(key)) return plan.keys.get(key);
	const reads = new Map<CoreInstructionId, CoreRecordFieldAccess>();
	// The return-use index admits only private own-data accesses.
	recordAccessPrefixes(
		fn,
		cfg,
		index.position,
		{
			reads: new Map(index.returns.map((consumer) => [consumer, key])),
			writes: plan.writes,
			barriers: NO_RECORD_BARRIERS,
		},
		reads,
	);
	const alternatives: Array<CoreRecordFieldAccess> = [];
	for (const consumer of index.returns) {
		const read = reads.get(consumer);
		if (read === undefined) {
			plan.keys.set(key, undefined);
			return undefined;
		}
		if (read.producers.includes(producer)) alternatives.push(read);
	}
	const result = alternatives.length === 0 ? undefined : Object.freeze(alternatives);
	plan.keys.set(key, result);
	return result;
}

export interface CoreRecordValueQueries {
	readonly mask: (
		value: CoreValueId,
		consumer?: CoreInstructionId,
		edge?: CoreControlEdge,
	) => number;
	readonly integerRange?: (
		value: CoreValueId,
		consumer: CoreInstructionId,
		edge?: CoreControlEdge,
	) => CompilerIntegerRange | null | undefined;
	readonly heapBrand?: (
		value: CoreValueId,
		consumer: CoreInstructionId,
		edge?: CoreControlEdge,
	) => CoreHeapBrandState;
	readonly calleeTargets?: (
		value: CoreValueId,
		consumer: CoreInstructionId,
		edge?: CoreControlEdge,
	) => CoreCalleeTargets | undefined;
}

/** Own data fields on normal return; callers still need a separate mutation/escape proof. */
export function coreReturnedRecordKinds(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	queries: CoreRecordValueQueries,
	call: (instruction: CoreInstructionId) => CoreRecordValueKind,
): CoreRecordValueKind {
	if (fn.isAsync || fn.isGenerator) return undefined;
	const returnedFields = recordReturnIndex(fn).fields;
	let result: CoreRecordValueKind = null;
	const pending: Array<CoreValueId> = [];
	for (const block of cfg.reachable) {
		const terminator = fn.blockTerminator(block);
		if (fn.instructionKind(terminator) !== "return") continue;
		const value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator));
		if (queries.mask(value) === 0) continue;
		pending.push(value);
	}
	const seen = new Set<CoreValueId>();
	let remaining = MAXIMUM_RECORD_RETURN_ALIAS_WORK;
	while (pending.length > 0) {
		const value = pending.pop()!;
		if (seen.has(value)) continue;
		seen.add(value);
		if (--remaining < 0) return undefined;
		if (fn.kernel.valueDefinitionKind(value) === 0) {
			const block = fn.kernel.valueDefinitionOwner(value) as CoreBlockId;
			const index = fn.kernel.valueDefinitionIndex(value);
			if (
				fn.kernel.blockParameterRole(fn.kernel.blockParameterStart(block) + index) !== 0
			)
				return undefined;
			const incoming = cfg.predecessors[block] ?? [];
			if (incoming.length === 0) return undefined;
			for (const edge of incoming) {
				if (!cfg.reachable.has(edge.from)) continue;
				const input = edge.arguments[index];
				if (--remaining < 0 || edge.kind !== "ordinary" || input === undefined)
					return undefined;
				pending.push(input);
			}
			continue;
		}
		if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
		const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (fn.instructionOpcodeName(definition) === "move") {
			pending.push(fn.kernel.operandAt(fn.kernel.instructionOperandStart(definition)));
			continue;
		}
		const initial = returnedFields.get(definition);
		if (initial === undefined) return undefined;
		let fields: CoreRecordValueKind;
		if (initial.literalKeys !== undefined) {
			const start = fn.kernel.instructionOperandStart(definition);
			fields = Object.freeze(
				initial.literalKeys
					.map((key, index) => {
						const value = fn.kernel.operandAt(start + index);
						const kind = queries.mask(value, definition);
						const integerRange =
							kind === COMPILER_VALUE_KIND_NUMBER
								? queries.integerRange?.(value, definition)
								: undefined;
						const heapBrand =
							kind === COMPILER_VALUE_KIND_OBJECT
								? queries.heapBrand?.(value, definition)
								: undefined;
						const calleeTargets = queries.calleeTargets?.(value, definition);
						return Object.freeze({
							key,
							mask: kind,
							...(integerRange === undefined ? {} : { integerRange }),
							...(heapBrand === undefined ? {} : { heapBrand }),
							...(calleeTargets === undefined ? {} : { calleeTargets }),
						});
					})
					.sort((left, right) => left.key - right.key),
			);
		} else {
			const forwarded = call(definition);
			if (
				forwarded !== undefined &&
				forwarded !== null &&
				initial.requiredKeys.some((key) => !forwarded.some((field) => field.key === key))
			)
				return undefined;
			fields = forwarded;
		}
		const writesByKey = initial.writes;
		if (fields !== undefined && fields !== null && writesByKey !== undefined)
			fields = Object.freeze(
				fields.map((field) => {
					const writes = writesByKey.get(field.key);
					// An own write cannot create a normal return before its initial value completes.
					if (writes === undefined || field.mask === 0) return field;
					const alternatives = recordReturnWrites(
						fn,
						cfg,
						returnedFields,
						definition,
						field.key,
					);
					let kind = 0;
					let integerRange: CompilerIntegerRange | null | undefined = null;
					let heapBrand: CoreHeapBrandState = null;
					let calleeTargets: CoreCalleeTargets | undefined =
						queries.calleeTargets === undefined && field.calleeTargets === undefined
							? undefined
							: CORE_CALLEE_TARGETS_BOTTOM;
					for (const alternative of alternatives ?? [undefined]) {
						const initialSurvives =
							alternative?.initialProducers === undefined ||
							alternative.initialProducers.includes(definition);
						let partKind = initialSurvives ? field.mask : 0;
						let partRange = initialSurvives ? field.integerRange : null;
						let partBrand = initialSurvives ? field.heapBrand : null;
						let partTargets = initialSurvives
							? field.calleeTargets
							: CORE_CALLEE_TARGETS_BOTTOM;
						for (const write of alternative === undefined
							? writes
							: (alternative.writes ?? [])) {
							if (!cfg.reachable.has(fn.instructionBlock(write.instruction))) continue;
							const written = queries.mask(write.value, write.instruction, write.edge);
							partKind |= written;
							if (written !== 0) {
								partTargets = joinFieldCalleeTargets(
									partTargets,
									queries.calleeTargets?.(write.value, write.instruction, write.edge),
								);
								partRange =
									partKind === COMPILER_VALUE_KIND_NUMBER
										? joinFieldIntegerRanges(
												partRange,
												queries.integerRange?.(
													write.value,
													write.instruction,
													write.edge,
												),
											)
										: undefined;
								partBrand =
									partKind === COMPILER_VALUE_KIND_OBJECT
										? joinCoreHeapBrands(
												partBrand,
												queries.heapBrand?.(write.value, write.instruction, write.edge),
											)
										: undefined;
							}
						}
						if (partKind !== 0) {
							calleeTargets = joinFieldCalleeTargets(calleeTargets, partTargets);
							kind |= partKind;
							integerRange =
								kind === COMPILER_VALUE_KIND_NUMBER
									? joinFieldIntegerRanges(integerRange, partRange)
									: undefined;
							heapBrand =
								kind === COMPILER_VALUE_KIND_OBJECT
									? joinCoreHeapBrands(heapBrand, partBrand)
									: undefined;
						}
					}
					return Object.freeze({
						key: field.key,
						mask: kind,
						...(integerRange === undefined ? {} : { integerRange }),
						...(heapBrand === undefined ? {} : { heapBrand }),
						...(calleeTargets === undefined ? {} : { calleeTargets }),
					});
				}),
			);
		result = joinCoreRecordValueKinds(result, fields);
		if (result === undefined) return undefined;
	}
	return result;
}

export const CORE_RECORD_OWN_DATA_EFFECT_FACT = "returned-record-own-data";

export interface CoreRecordFieldAccess {
	readonly producers: ReadonlyArray<CoreInstructionId>;
	readonly key: number;
	/** Preceding accesses must be own, so getters and setters cannot expose the record. */
	readonly requiredKeys: ReadonlyArray<number>;
	readonly writes?: ReadonlyArray<CoreRecordFieldWrite>;
	/** Omitted means every producer's initial value can reach this observation. */
	readonly initialProducers?: ReadonlyArray<CoreInstructionId>;
}

export function coreRecordAccessProducerFields(
	read: CoreRecordFieldAccess,
	source: (producer: CoreInstructionId) => CoreRecordValueKind,
): CoreRecordValueKind {
	let result: CoreRecordValueKind = null;
	for (const producer of read.producers) {
		result = joinCoreRecordValueKinds(result, source(producer));
		if (result === undefined) break;
	}
	return result;
}

export function coreRecordAccessInitialFields(
	read: CoreRecordFieldAccess,
	producers: CoreRecordValueKind,
	source: (producer: CoreInstructionId) => CoreRecordValueKind,
): CoreRecordValueKind {
	// Payload projection cannot license a key missing from another producer.
	if (read.initialProducers === undefined || !coreRecordFieldIsOwnData(read, producers))
		return producers;
	let result: CoreRecordValueKind = null;
	for (const producer of read.initialProducers) {
		result = joinCoreRecordValueKinds(result, source(producer));
		if (result === undefined) break;
	}
	return result;
}

export function coreRecordFieldInitialKind(
	read: CoreRecordFieldAccess,
	record: CoreRecordValueKind,
	top: number,
): number {
	if (record === null) return 0;
	return coreRecordFieldIsOwnData(read, record)
		? record!.find((field) => field.key === read.key)!.mask
		: top;
}

export function coreRecordFieldInitialHeapBrand(
	read: CoreRecordFieldAccess,
	record: CoreRecordValueKind,
): CoreHeapBrandState {
	const mask = coreRecordFieldInitialKind(read, record, -1);
	return mask === 0
		? null
		: mask === COMPILER_VALUE_KIND_OBJECT
			? record!.find((field) => field.key === read.key)!.heapBrand
			: undefined;
}

export function coreRecordFieldIsOwnData(
	read: CoreRecordFieldAccess,
	record: CoreRecordValueKind,
): boolean {
	return (
		record !== undefined &&
		record !== null &&
		read.requiredKeys.every((key) => record.some((field) => field.key === key))
	);
}

export function coreRecordFieldReadIntegerRange(
	read: CoreRecordFieldAccess,
	record: CoreRecordValueKind,
	initial: CoreRecordValueKind,
	range: (
		value: CoreValueId,
		consumer: CoreInstructionId,
		edge?: CoreControlEdge,
	) => CompilerIntegerRange | null | undefined,
): CompilerIntegerRange | null | undefined {
	if (record === null) return null;
	if (coreRecordFieldInitialKind(read, record, -1) === 0) return null;
	if (!coreRecordFieldIsOwnData(read, record)) return undefined;
	const initialKind = coreRecordFieldInitialKind(read, initial, -1);
	if (initialKind !== 0 && initialKind !== COMPILER_VALUE_KIND_NUMBER) return undefined;
	let result =
		initialKind === 0
			? null
			: initial!.find((field) => field.key === read.key)!.integerRange;
	for (const write of read.writes ?? []) {
		result = joinFieldIntegerRanges(
			result,
			range(write.value, write.instruction, write.edge),
		);
		if (result === undefined) break;
	}
	return result;
}

export function coreRecordFieldReadCalleeTargets(
	read: CoreRecordFieldAccess,
	record: CoreRecordValueKind,
	initial: CoreRecordValueKind,
	targets: NonNullable<CoreRecordValueQueries["calleeTargets"]>,
): CoreCalleeTargets | undefined {
	if (record === null || coreRecordFieldInitialKind(read, record, -1) === 0)
		return CORE_CALLEE_TARGETS_BOTTOM;
	if (!coreRecordFieldIsOwnData(read, record)) return undefined;
	let result =
		initial === null
			? CORE_CALLEE_TARGETS_BOTTOM
			: coreRecordFieldIsOwnData(read, initial)
				? initial!.find((field) => field.key === read.key)!.calleeTargets
				: undefined;
	for (const write of read.writes ?? []) {
		result = joinFieldCalleeTargets(
			result,
			targets(write.value, write.instruction, write.edge),
		);
		if (result === undefined) break;
	}
	return result;
}

interface CoreRecordFieldAccessIndex {
	readonly featureVersion?: number;
	readonly memoryEffectVersion?: number;
	readonly reads: ReadonlyMap<CoreInstructionId, CoreRecordFieldAccess>;
	readonly stores: ReadonlyMap<CoreInstructionId, CoreRecordFieldAccess>;
}

const recordFieldAccessIndices = new WeakMap<
	CoreFunctionStore,
	CoreRecordFieldAccessIndex
>();
const MAXIMUM_RECORD_PREFIX_WORK = 256;
const COMPLETE_RECORD_PREFIX = [Infinity] as const;

function recordAliasParameter(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	operand: number,
): CoreValueId | null | undefined {
	const at = fn.kernel.instructionOperandStart(instruction) + operand;
	const start = fn.kernel.terminatorEdgeStart(instruction);
	const count = fn.kernel.terminatorEdgeCount(instruction);
	let lower = start;
	let upper = start + count;
	// Edge argument ranges share the terminator's operand span, in edge order, including empty ranges.
	while (lower < upper) {
		const middle = lower + ((upper - lower) >>> 1);
		if (fn.kernel.terminatorEdgeArgumentStart(middle) <= at) lower = middle + 1;
		else upper = middle;
	}
	const edge = lower - 1;
	if (edge < start) return undefined;
	const index = at - fn.kernel.terminatorEdgeArgumentStart(edge);
	if (index >= fn.kernel.terminatorEdgeArgumentCount(edge)) return undefined;
	const block = fn.kernel.terminatorEdgeBlock(edge);
	const parameter = fn.kernel.blockParameterStart(block) + index;
	return fn.kernel.blockParameterRole(parameter) === 0
		? fn.kernel.blockParameterValue(parameter)
		: null;
}

interface RecordFieldAccesses {
	readonly reads: ReadonlyMap<CoreInstructionId, number>;
	readonly writes: ReadonlyMap<CoreInstructionId, number>;
	readonly barriers: ReadonlySet<CoreInstructionId>;
}

interface RecordPrefixMemo {
	readonly fullBlocks: Map<CoreBlockId, Map<CoreValueId, number>>;
	partialBlocks?: Map<CoreBlockId, Map<number, Map<CoreValueId, number>>>;
}

function recordAccessPrefixes(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	position: (instruction: CoreInstructionId) => number,
	accesses: RecordFieldAccesses,
	result: Map<CoreInstructionId, CoreRecordFieldAccess>,
	stores?: Map<CoreInstructionId, CoreRecordFieldAccess>,
): void {
	const { reads, writes, barriers } = accesses;
	let exceptionalLimits: Map<CoreBlockId, ReadonlyArray<number> | undefined> | undefined;
	const exceptionalPrefixes = (block: CoreBlockId): ReadonlyArray<number> | undefined => {
		const cached = exceptionalLimits?.get(block);
		if (exceptionalLimits?.has(block)) return cached;
		const limits = new Set<number>();
		let remaining = MAXIMUM_RECORD_PREFIX_WORK;
		for (const instruction of fn.bodyInstructionIds(block)) {
			if (--remaining < 0) {
				(exceptionalLimits ??= new Map()).set(block, undefined);
				return undefined;
			}
			if (fn.instructionKind(instruction) !== "operation") continue;
			if (!coreInstructionEffects(fn, instruction).mayThrow) continue;
			const at = position(instruction);
			// A throwing operation can expose effects both before and after a field overwrite.
			limits.add(at);
			limits.add(at + 1);
		}
		if (fn.instructionKind(fn.blockTerminator(block)) === "throw") limits.add(Infinity);
		const result = Object.freeze([...limits]);
		(exceptionalLimits ??= new Map()).set(block, result);
		return result;
	};
	const events = new Map<CoreBlockId, Array<CoreInstructionId>>();
	for (const instruction of new Set([...reads.keys(), ...writes.keys(), ...barriers])) {
		const block = fn.instructionBlock(instruction);
		let row = events.get(block);
		if (row === undefined) events.set(block, (row = []));
		row.push(instruction);
	}
	for (const row of events.values()) row.sort((a, b) => position(b) - position(a));
	let sourceSets:
		| Map<CoreValueId, ReadonlySet<CoreInstructionId> | undefined>
		| undefined;
	for (const [instruction, key] of stores === undefined ? reads : [...reads, ...writes]) {
		const target = reads.has(instruction) ? result : stores;
		if (target === undefined || target.has(instruction)) continue;
		const block = fn.instructionBlock(instruction);
		if (!cfg.reachable.has(block)) continue;
		const requiredKeys = new Set([key]);
		const reachingWrites = reads.has(instruction)
			? new Set<CoreInstructionId>()
			: undefined;
		const producers = new Set<CoreInstructionId>();
		const initialProducers =
			reachingWrites === undefined ? undefined : new Set<CoreInstructionId>();
		const pending: Array<{
			block: CoreBlockId;
			limit: number;
			value: CoreValueId;
			overwritten: boolean;
			incoming?: CoreControlEdge;
		}> = [
			{
				block,
				limit: position(instruction),
				value: fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)),
				overwritten: false,
			},
		];
		// A backedge can expose writers later than the observation in the previous iteration.
		const ordinaryMemo: RecordPrefixMemo = { fullBlocks: new Map() };
		let incomingMemos: Map<CoreControlEdge, RecordPrefixMemo> | undefined;
		let remaining = MAXIMUM_RECORD_PREFIX_WORK;
		let valid = true;
		let ignoredWrites: Map<CoreInstructionId, Set<CoreInstructionId>> | undefined;
		let writeAlternatives:
			| Map<CoreInstructionId, Map<CoreControlEdge | undefined, CoreValueId>>
			| undefined;
		const moveRoot = (value: CoreValueId): CoreValueId => {
			while (fn.kernel.valueDefinitionKind(value) === 1) {
				const owner = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
				if (fn.instructionOpcodeName(owner) !== "move" || --remaining < 0) break;
				value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(owner));
			}
			return value;
		};
		const sources = (value: CoreValueId): ReadonlySet<CoreInstructionId> | undefined => {
			if (sourceSets?.has(value)) return sourceSets.get(value);
			const pending = [value];
			const seen = new Set<CoreValueId>();
			const definitions = new Set<CoreInstructionId>();
			while (pending.length > 0) {
				const value = moveRoot(pending.pop()!);
				if (seen.has(value)) continue;
				seen.add(value);
				if (--remaining < 0) return undefined;
				if (fn.kernel.valueDefinitionKind(value) === 1) {
					definitions.add(coreInstructionId(fn.kernel.valueDefinitionOwner(value)));
					continue;
				}
				if (fn.kernel.valueDefinitionKind(value) !== 0) return undefined;
				const block = fn.kernel.valueDefinitionOwner(value) as CoreBlockId;
				const index = fn.kernel.valueDefinitionIndex(value);
				if (
					fn.kernel.blockParameterRole(fn.kernel.blockParameterStart(block) + index) !== 0
				)
					return undefined;
				for (const edge of cfg.predecessors[block] ?? []) {
					if (!cfg.reachable.has(edge.from)) continue;
					const argument = edge.arguments[index];
					if (--remaining < 0 || edge.kind !== "ordinary" || argument === undefined)
						return undefined;
					pending.push(argument);
				}
			}
			const result = definitions.size === 0 ? undefined : definitions;
			(sourceSets ??= new Map()).set(value, result);
			return result;
		};
		while (pending.length > 0 && valid) {
			const {
				block,
				limit,
				value: input,
				overwritten: priorOverwrite,
				incoming,
			} = pending.pop()!;
			if (--remaining < 0) {
				valid = false;
				break;
			}
			const value = moveRoot(input);
			let overwritten = priorOverwrite;
			const definition =
				fn.kernel.valueDefinitionKind(value) === 1
					? coreInstructionId(fn.kernel.valueDefinitionOwner(value))
					: undefined;
			if (remaining < 0) {
				valid = false;
				break;
			}
			const sourceBlock =
				definition === undefined
					? (fn.kernel.valueDefinitionOwner(value) as CoreBlockId)
					: fn.instructionBlock(definition);
			const sourcePosition = definition === undefined ? -1 : position(definition);
			if (block === sourceBlock && definition !== undefined && sourcePosition >= limit)
				continue;
			if (
				reachingWrites !== undefined &&
				writes.size !== 0 &&
				definition === undefined &&
				fn.kernel.valueDefinitionKind(value) === 0 &&
				incoming === undefined
			) {
				if (
					fn.kernel.blockParameterRole(
						fn.kernel.blockParameterStart(sourceBlock) +
							fn.kernel.valueDefinitionIndex(value),
					) !== 0
				) {
					valid = false;
					break;
				}
				for (const edge of cfg.predecessors[sourceBlock] ?? []) {
					if (!cfg.reachable.has(edge.from)) continue;
					if (--remaining < 0 || edge.kind !== "ordinary") {
						valid = false;
						break;
					}
					pending.push({ block, limit, value, overwritten, incoming: edge });
				}
				continue;
			}
			const selectedIncoming = incoming !== undefined && sourceBlock === incoming.to;
			let selected = value;
			if (selectedIncoming) {
				const argument = incoming.arguments[fn.kernel.valueDefinitionIndex(value)];
				if (argument === undefined) {
					valid = false;
					break;
				}
				selected = moveRoot(argument);
			}
			for (const event of events.get(block) ?? []) {
				const at = position(event);
				if (at >= limit) continue;
				if (block === sourceBlock && at <= sourcePosition) break;
				if (--remaining < 0 || barriers.has(event)) {
					valid = false;
					break;
				}
				const priorKey = reads.get(event) ?? writes.get(event);
				if (priorKey !== undefined) requiredKeys.add(priorKey);
				if (writes.get(event) === key && reachingWrites !== undefined && !overwritten) {
					let receiver = moveRoot(
						fn.kernel.operandAt(fn.kernel.instructionOperandStart(event)),
					);
					const receiverIncoming =
						incoming !== undefined &&
						fn.kernel.valueDefinitionKind(receiver) === 0 &&
						fn.kernel.valueDefinitionOwner(receiver) === incoming.to;
					if (receiverIncoming) {
						const argument = incoming.arguments[fn.kernel.valueDefinitionIndex(receiver)];
						if (argument === undefined) {
							valid = false;
							break;
						}
						// Backedge arguments refer to an earlier execution; project each phi once.
						receiver = moveRoot(argument);
					}
					const owner = fn.kernel.valueDefinitionOwner(selected);
					const selectedBlock =
						fn.kernel.valueDefinitionKind(selected) === 1
							? fn.instructionBlock(coreInstructionId(owner))
							: (owner as CoreBlockId);
					// A direct value shares a backedge argument's execution only when it precedes the phi.
					overwritten =
						receiver === selected &&
						(selectedIncoming === receiverIncoming ||
							(selectedBlock !== incoming!.to &&
								cfg.dominates(selectedBlock, incoming!.to)));
					let disjoint = false;
					if (!overwritten && receiver !== selected) {
						const selectedSources = sources(selected);
						const receiverSources = sources(receiver);
						if (
							selectedSources !== undefined &&
							receiverSources !== undefined &&
							![...selectedSources].some((source) => receiverSources.has(source))
						) {
							disjoint = true;
							let dependencies = ignoredWrites?.get(event);
							if (dependencies === undefined)
								(ignoredWrites ??= new Map()).set(event, (dependencies = new Set()));
							for (const source of selectedSources) dependencies.add(source);
							for (const source of receiverSources) dependencies.add(source);
						}
					}
					if (remaining < 0) {
						valid = false;
						break;
					}
					if (!disjoint) {
						const valueIndex =
							fn.instructionOpcodeName(event) === "storePropertyStatic" ? 1 : 2;
						const original = fn.kernel.operandAt(
							fn.kernel.instructionOperandStart(event) + valueIndex,
						);
						let written = original;
						let edge: CoreControlEdge | undefined;
						if (incoming !== undefined) {
							const value = moveRoot(original);
							// A cyclic phi's argument can belong to an earlier execution of the writer.
							if (
								fn.kernel.valueDefinitionKind(value) === 0 &&
								fn.kernel.valueDefinitionOwner(value) === incoming.to &&
								!cfg.loops.some((loop) => loop.blocks.has(incoming.to)) &&
								!cfg.irreducibleCycles.some((cycle) => cycle.blocks.has(incoming.to))
							) {
								const argument =
									incoming.arguments[fn.kernel.valueDefinitionIndex(value)];
								if (argument === undefined) {
									valid = false;
									break;
								}
								written = argument;
								edge = incoming;
							}
							if (remaining < 0) {
								valid = false;
								break;
							}
						}
						let alternatives = writeAlternatives?.get(event);
						if (alternatives === undefined && edge !== undefined) {
							alternatives = new Map<CoreControlEdge | undefined, CoreValueId>();
							if (reachingWrites.has(event)) alternatives.set(undefined, original);
							(writeAlternatives ??= new Map()).set(event, alternatives);
						}
						alternatives?.set(edge, written);
						reachingWrites.add(event);
					}
				}
			}
			if (!valid) break;
			// Another producer on this path cannot reset the selected object's lifetime.
			if (block === sourceBlock && definition !== undefined) {
				producers.add(definition);
				if (!overwritten) initialProducers?.add(definition);
				continue;
			}
			for (const edge of cfg.predecessors[block] ?? []) {
				if (incoming !== undefined && block === incoming.to && edge !== incoming)
					continue;
				if (!cfg.reachable.has(edge.from)) continue;
				let argument = value;
				if (block === sourceBlock) {
					const index = fn.kernel.valueDefinitionIndex(value);
					const argumentValue = edge.arguments[index];
					if (edge.kind !== "ordinary" || argumentValue === undefined) {
						valid = false;
						break;
					}
					argument = argumentValue;
				}
				const limits =
					edge.kind === "exceptional"
						? exceptionalPrefixes(edge.from)
						: COMPLETE_RECORD_PREFIX;
				if (limits === undefined) {
					valid = false;
					break;
				}
				const nextIncoming = block === incoming?.to ? undefined : incoming;
				let memo = ordinaryMemo;
				if (nextIncoming !== undefined) {
					let selectedMemo = incomingMemos?.get(nextIncoming);
					if (selectedMemo === undefined)
						(incomingMemos ??= new Map()).set(
							nextIncoming,
							(selectedMemo = { fullBlocks: new Map() }),
						);
					memo = selectedMemo;
				}
				for (const limit of limits) {
					if (edge.kind === "exceptional" && --remaining < 0) {
						valid = false;
						break;
					}
					let values: Map<CoreValueId, number> | undefined;
					if (limit === Infinity) {
						values = memo.fullBlocks.get(edge.from);
						if (values === undefined)
							memo.fullBlocks.set(edge.from, (values = new Map<CoreValueId, number>()));
					} else {
						memo.partialBlocks ??= new Map<
							CoreBlockId,
							Map<number, Map<CoreValueId, number>>
						>();
						let prefixes = memo.partialBlocks.get(edge.from);
						if (prefixes === undefined)
							memo.partialBlocks.set(
								edge.from,
								(prefixes = new Map<number, Map<CoreValueId, number>>()),
							);
						values = prefixes.get(limit);
						if (values === undefined)
							prefixes.set(limit, (values = new Map<CoreValueId, number>()));
					}
					const state = overwritten ? 2 : 1;
					const seen = values.get(argument) ?? 0;
					if ((seen & state) !== 0) continue;
					values.set(argument, seen | state);
					pending.push({
						block: edge.from,
						limit,
						value: argument,
						overwritten,
						incoming: nextIncoming,
					});
				}
				if (!valid) break;
			}
		}
		if (!valid || producers.size === 0) continue;
		for (const [write, dependencies] of ignoredWrites ?? []) {
			// Only sources covered by the fresh returned-record contract prove disjointness.
			if ([...dependencies].some((source) => !producers.has(source))) {
				reachingWrites!.add(write);
				writeAlternatives?.delete(write);
			}
		}
		let fieldWrites: ReadonlyArray<CoreRecordFieldWrite> | undefined;
		if (reachingWrites !== undefined && reachingWrites.size > 0) {
			const rows: Array<CoreRecordFieldWrite> = [];
			for (const instruction of reachingWrites) {
				const alternatives = writeAlternatives?.get(instruction);
				if (alternatives === undefined) {
					const valueIndex =
						fn.instructionOpcodeName(instruction) === "storePropertyStatic" ? 1 : 2;
					rows.push(
						Object.freeze({
							instruction,
							value: fn.kernel.operandAt(
								fn.kernel.instructionOperandStart(instruction) + valueIndex,
							),
						}),
					);
				} else
					for (const [edge, value] of alternatives)
						rows.push(
							Object.freeze({
								instruction,
								value,
								...(edge === undefined ? {} : { edge }),
							}),
						);
			}
			fieldWrites = Object.freeze(rows);
		}
		target.set(
			instruction,
			Object.freeze({
				producers: Object.freeze([...producers]),
				key,
				requiredKeys: Object.freeze([...requiredKeys]),
				...(fieldWrites === undefined ? {} : { writes: fieldWrites }),
				...(initialProducers !== undefined && initialProducers.size !== producers.size
					? { initialProducers: Object.freeze([...initialProducers]) }
					: {}),
			}),
		);
	}
}

function mergedRecordFieldAccesses(
	fn: CoreFunctionStore,
	parameters: ReadonlySet<CoreValueId>,
	control: () => CoreControlFlow,
	position: (instruction: CoreInstructionId) => number,
	result: Map<CoreInstructionId, CoreRecordFieldAccess>,
	stores: Map<CoreInstructionId, CoreRecordFieldAccess>,
): void {
	const candidates = new Set<CoreValueId>();
	const forwarded = new Set<CoreValueId>();
	for (const parameter of parameters) {
		const pending = [parameter];
		let remaining = MAXIMUM_RECORD_RETURN_ALIAS_WORK;
		while (pending.length > 0 && remaining > 0) {
			const value = pending.pop()!;
			if (forwarded.has(value)) continue;
			forwarded.add(value);
			remaining--;
			for (
				let use = fn.kernel.valueFirstUse(value);
				use >= 0;
				use = fn.kernel.useNext(use)
			) {
				if (fn.kernel.useLive(use) === 0) continue;
				if (--remaining < 0) break;
				const instruction = fn.kernel.useInstruction(use);
				if (fn.instructionKind(instruction) !== "operation") {
					const target = recordAliasParameter(fn, instruction, fn.kernel.useOperand(use));
					if (target !== undefined && target !== null) pending.push(target);
					continue;
				}
				const opcode = fn.instructionOpcodeName(instruction);
				if (opcode === "move")
					pending.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)));
				else if (
					(opcode === "loadPropertyStatic" ||
						opcode === "loadProperty" ||
						opcode === "storePropertyStatic" ||
						opcode === "storeProperty") &&
					fn.kernel.useOperand(use) === 0 &&
					!result.has(instruction) &&
					!stores.has(instruction)
				)
					candidates.add(value);
			}
		}
	}
	if (candidates.size === 0) return;
	const cfg = control();
	const processed = new Set<CoreValueId>();
	for (const candidate of candidates) {
		if (processed.has(candidate)) continue;
		const pending = [candidate];
		const seen = new Set<CoreValueId>();
		const producers = new Set<CoreInstructionId>();
		const reads = new Map<CoreInstructionId, number>();
		const writes = new Map<CoreInstructionId, number>();
		const barriers = new Set<CoreInstructionId>();
		const requiredKeys = new Set<number>();
		let remaining = MAXIMUM_RECORD_RETURN_ALIAS_WORK;
		let valid = true;
		while (pending.length > 0 && valid) {
			const value = pending.pop()!;
			if (seen.has(value)) continue;
			seen.add(value);
			processed.add(value);
			if (--remaining < 0 || fn.kernel.valueHandlerUseCount(value) > 0) {
				valid = false;
				break;
			}
			const owner = fn.kernel.valueDefinitionOwner(value);
			if (fn.kernel.valueDefinitionKind(value) === 0) {
				const block = owner as CoreBlockId;
				const index = fn.kernel.valueDefinitionIndex(value);
				const incoming = cfg.predecessors[block] ?? [];
				if (
					incoming.length === 0 ||
					fn.kernel.blockParameterRole(fn.kernel.blockParameterStart(block) + index) !== 0
				) {
					valid = false;
					break;
				}
				for (const edge of incoming) {
					if (!cfg.reachable.has(edge.from)) continue;
					const argument = edge.arguments[index];
					if (--remaining < 0 || edge.kind !== "ordinary" || argument === undefined) {
						valid = false;
						break;
					}
					pending.push(argument);
				}
			} else if (fn.kernel.valueDefinitionKind(value) === 1) {
				const instruction = coreInstructionId(owner);
				if (fn.instructionOpcodeName(instruction) === "move")
					pending.push(
						fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)),
					);
				else {
					const completion = fn.registry.byId(fn.instructionOpcode(instruction))
						.callTransfer?.result;
					if (
						(completion !== "call-completion" && completion !== "construct-completion") ||
						fn.kernel.instructionResultCount(instruction) !== 1
					) {
						valid = false;
						break;
					}
					producers.add(instruction);
				}
			} else {
				valid = false;
				break;
			}
			for (
				let use = fn.kernel.valueFirstUse(value);
				use >= 0;
				use = fn.kernel.useNext(use)
			) {
				if (fn.kernel.useLive(use) === 0) continue;
				if (--remaining < 0) {
					valid = false;
					break;
				}
				const instruction = fn.kernel.useInstruction(use);
				const kind = fn.instructionKind(instruction);
				if (kind !== "operation") {
					if (kind === "return") continue;
					const target = recordAliasParameter(fn, instruction, fn.kernel.useOperand(use));
					if (target !== undefined && target !== null) pending.push(target);
					else if (target === null || !["branch", "guard", "switch"].includes(kind)) {
						barriers.add(instruction);
					}
					continue;
				}
				const opcode = fn.instructionOpcodeName(instruction);
				const operator = fn.instructionAttributes(instruction).operator;
				if (
					[
						"rootUse",
						"throwIfTdz",
						"requireCoercible",
						"typeofCompare",
						"isEmpty",
					].includes(opcode) ||
					(opcode === "unary" && (operator === "!" || operator === "typeof")) ||
					(opcode === "binary" && (operator === "===" || operator === "!=="))
				)
					continue;
				if (opcode === "move") {
					pending.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)));
					continue;
				}
				const key = recordPropertyKey(fn, instruction);
				if (fn.kernel.useOperand(use) !== 0 || key === undefined) {
					barriers.add(instruction);
					continue;
				}
				requiredKeys.add(key);
				if (opcode === "loadPropertyStatic" || opcode === "loadProperty")
					reads.set(instruction, key);
				else if (opcode === "storePropertyStatic" || opcode === "storeProperty") {
					writes.set(instruction, key);
				} else {
					barriers.add(instruction);
				}
			}
		}
		if (!valid || producers.size === 0) continue;
		if (barriers.size > 0 || writes.size > 0 || requiredKeys.size > 1) {
			recordAccessPrefixes(
				fn,
				cfg,
				position,
				{ reads, writes, barriers },
				result,
				stores,
			);
			continue;
		}
		const sources = Object.freeze([...producers]);
		const keys = Object.freeze([...requiredKeys]);
		for (const [instruction, key] of reads) {
			if (result.has(instruction)) continue;
			result.set(
				instruction,
				Object.freeze({
					producers: sources,
					key,
					requiredKeys: keys,
				}),
			);
		}
	}
}

function recordFieldAccesses(
	fn: CoreFunctionStore,
	control: () => CoreControlFlow,
): CoreRecordFieldAccessIndex {
	// Edits are visible before their body/control-flow versions advance at commit.
	const featureVersion = fn.hasActiveEditor ? undefined : fn.featureVersion;
	const cached = recordFieldAccessIndices.get(fn);
	if (
		featureVersion !== undefined &&
		cached?.featureVersion === featureVersion &&
		(cached.memoryEffectVersion === undefined ||
			cached.memoryEffectVersion === fn.version("memoryEffects"))
	)
		return cached;
	const result = new Map<CoreInstructionId, CoreRecordFieldAccess>();
	const stores = new Map<CoreInstructionId, CoreRecordFieldAccess>();
	const mergedParameters = new Set<CoreValueId>();
	let cfg: CoreControlFlow | undefined;
	let positions: Map<CoreInstructionId, number> | undefined;
	const position = (instruction: CoreInstructionId): number => {
		if (positions === undefined) {
			positions = new Map();
			let index = 0;
			for (const block of fn.blockIds()) {
				for (const op of fn.bodyInstructionIds(block)) positions.set(op, index++);
				positions.set(fn.blockTerminator(block), index++);
			}
		}
		return positions.get(instruction)!;
	};
	for (const producer of fn.instructionIds()) {
		if (
			fn.instructionKind(producer) !== "operation" ||
			fn.kernel.instructionResultCount(producer) !== 1
		)
			continue;
		const completion = fn.registry.byId(fn.instructionOpcode(producer)).callTransfer
			?.result;
		if (completion !== "call-completion" && completion !== "construct-completion")
			continue;
		const pending = [fn.kernel.resultAt(fn.kernel.instructionResultStart(producer))];
		const seen = new Set<CoreValueId>();
		const reads = new Map<CoreInstructionId, number>();
		const writes = new Map<CoreInstructionId, number>();
		const barriers = new Set<CoreInstructionId>();
		let valid = true;
		while (pending.length > 0 && valid) {
			const value = pending.pop()!;
			if (seen.has(value)) continue;
			seen.add(value);
			if (fn.kernel.valueHandlerUseCount(value) > 0) {
				valid = false;
				break;
			}
			for (
				let use = fn.kernel.valueFirstUse(value);
				use >= 0;
				use = fn.kernel.useNext(use)
			) {
				if (fn.kernel.useLive(use) === 0) continue;
				const instruction = fn.kernel.useInstruction(use);
				if (fn.instructionKind(instruction) !== "operation") {
					const parameter = recordAliasParameter(
						fn,
						instruction,
						fn.kernel.useOperand(use),
					);
					if (parameter !== undefined && parameter !== null)
						mergedParameters.add(parameter);
					barriers.add(instruction);
					continue;
				}
				const opcode = fn.instructionOpcodeName(instruction);
				const operator = fn.instructionAttributes(instruction).operator;
				if (
					[
						"rootUse",
						"throwIfTdz",
						"requireCoercible",
						"typeofCompare",
						"isEmpty",
					].includes(opcode) ||
					(opcode === "unary" && (operator === "!" || operator === "typeof")) ||
					(opcode === "binary" && (operator === "===" || operator === "!=="))
				)
					continue;
				if (opcode === "move") {
					pending.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)));
					continue;
				}
				const key = recordPropertyKey(fn, instruction);
				if (fn.kernel.useOperand(use) !== 0 || key === undefined) {
					barriers.add(instruction);
					continue;
				}
				if (opcode === "storePropertyStatic" || opcode === "storeProperty")
					writes.set(instruction, key);
				else reads.set(instruction, key);
			}
		}
		if (!valid || (reads.size === 0 && writes.size === 0)) continue;
		const producers = Object.freeze([producer]);
		const keys = new Set([...reads.values(), ...writes.values()]);
		if (barriers.size === 0 && keys.size === 1) {
			const requiredKeys = Object.freeze([...keys]);
			for (const [instruction, key] of writes)
				stores.set(instruction, Object.freeze({ producers, key, requiredKeys }));
			if (reads.size === 0) continue;
		}
		if (barriers.size === 0 && writes.size === 0 && keys.size === 1) {
			const requiredKeys = Object.freeze([...keys]);
			for (const [instruction, key] of reads)
				result.set(instruction, Object.freeze({ producers, key, requiredKeys }));
			continue;
		}
		cfg ??= control();
		recordAccessPrefixes(fn, cfg, position, { reads, writes, barriers }, result, stores);
	}
	mergedRecordFieldAccesses(
		fn,
		mergedParameters,
		() => (cfg ??= control()),
		position,
		result,
		stores,
	);
	const index = Object.freeze({
		featureVersion,
		...(cfg === undefined ? {} : { memoryEffectVersion: fn.version("memoryEffects") }),
		reads: result,
		stores,
	});
	if (featureVersion !== undefined) recordFieldAccessIndices.set(fn, index);
	return index;
}

export function coreRecordFieldReads(
	fn: CoreFunctionStore,
	control: () => CoreControlFlow,
): ReadonlyMap<CoreInstructionId, CoreRecordFieldAccess> {
	return recordFieldAccesses(fn, control).reads;
}
export function coreRecordFieldStores(
	fn: CoreFunctionStore,
	control: () => CoreControlFlow,
): ReadonlyMap<CoreInstructionId, CoreRecordFieldAccess> {
	return recordFieldAccesses(fn, control).stores;
}
