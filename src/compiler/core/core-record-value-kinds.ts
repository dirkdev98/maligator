import { COMPILER_VALUE_KIND_NUMBER } from "../shared/compiler-value-kinds.ts";
import { compilerIntegerRangesEqual } from "../shared/integer-range.ts";
import type { CompilerIntegerRange } from "../shared/integer-range.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreBlockId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

export interface CoreRecordFieldKind {
	// Null keeps an unsolved field separate from an unknown field during range convergence.
	readonly integerRange?: CompilerIntegerRange | null;
	readonly key: number;
	readonly mask: number;
}

// Null is the empty normal-result set; undefined includes non-records and escaped objects.
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
		fields.push(
			Object.freeze({
				key: field.key,
				mask,
				...(integerRange === undefined ? {} : { integerRange }),
			}),
		);
	}
	return Object.freeze(fields);
}

const MAXIMUM_RECORD_RETURN_ALIAS_WORK = 256;

interface CoreRecordFieldWrite {
	readonly instruction: CoreInstructionId;
	readonly value: CoreValueId;
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
	readonly keys: ReadonlyArray<number>;
	readonly writes?: ReadonlyMap<number, ReadonlyArray<CoreRecordFieldWrite>>;
}

interface CoreRecordReturnIndex {
	readonly featureVersion: number;
	readonly fields: ReadonlyMap<CoreInstructionId, CoreRecordReturnFields>;
	readonly inputs: ReadonlyArray<CoreValueId>;
}

const recordReturnIndices = new WeakMap<CoreFunctionStore, CoreRecordReturnIndex>();

function recordReturnIndex(
	fn: CoreFunctionStore,
): Omit<CoreRecordReturnIndex, "featureVersion"> {
	const featureVersion = fn.hasActiveEditor ? undefined : fn.featureVersion;
	const cached = recordReturnIndices.get(fn);
	if (featureVersion !== undefined && cached?.featureVersion === featureVersion)
		return cached;
	const fields = new Map<CoreInstructionId, CoreRecordReturnFields>();
	const inputs: Array<CoreValueId> = [];
	if (!fn.isAsync && !fn.isGenerator)
		for (const instruction of fn.instructionIds()) {
			const keys = recordKeys(fn, instruction);
			if (keys === undefined) continue;
			let writes: Map<number, Array<CoreRecordFieldWrite>> | undefined;
			const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
			const returns = returnedValueUseCount(fn, value, true, (access, operand) => {
				if (operand !== 0) return false;
				const key = recordPropertyKey(fn, access);
				if (key === undefined || !keys.includes(key)) return false;
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
			for (let index = 0; index < keys.length; index++)
				inputs.push(fn.kernel.operandAt(start + index));
			for (const row of writes?.values() ?? []) {
				Object.freeze(row);
				for (const write of row) inputs.push(write.value);
			}
			fields.set(
				instruction,
				Object.freeze({
					keys: Object.freeze([...keys]),
					...(writes === undefined ? {} : { writes }),
				}),
			);
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

/** Own data fields on normal return; callers still need a separate mutation/escape proof. */
export function coreReturnedRecordKinds(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	mask: (value: CoreValueId) => number,
	call: (instruction: CoreInstructionId) => CoreRecordValueKind,
	range?: (
		value: CoreValueId,
		consumer: CoreInstructionId,
	) => CompilerIntegerRange | null | undefined,
): CoreRecordValueKind {
	if (fn.isAsync || fn.isGenerator) return undefined;
	const returnedFields = recordReturnIndex(fn).fields;
	let result: CoreRecordValueKind = null;
	const pending: Array<CoreValueId> = [];
	for (const block of cfg.reachable) {
		const terminator = fn.blockTerminator(block);
		if (fn.instructionKind(terminator) !== "return") continue;
		const value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator));
		if (mask(value) === 0) continue;
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
		const completion = fn.registry.byId(fn.instructionOpcode(definition)).callTransfer
			?.result;
		let fields: CoreRecordValueKind;
		if (initial !== undefined) {
			const start = fn.kernel.instructionOperandStart(definition);
			fields = Object.freeze(
				initial.keys
					.map((key, index) => {
						const value = fn.kernel.operandAt(start + index);
						let kind = mask(value);
						let integerRange =
							kind === COMPILER_VALUE_KIND_NUMBER
								? range?.(value, definition)
								: undefined;
						// A write cannot execute before its initial field value completes normally.
						if (kind !== 0)
							for (const write of initial.writes?.get(key) ?? []) {
								if (!cfg.reachable.has(fn.instructionBlock(write.instruction))) continue;
								const written = mask(write.value);
								kind |= written;
								if (written !== 0)
									integerRange =
										kind === COMPILER_VALUE_KIND_NUMBER
											? joinFieldIntegerRanges(
													integerRange,
													range?.(write.value, write.instruction),
												)
											: undefined;
							}
						return Object.freeze({
							key,
							mask: kind,
							...(integerRange === undefined ? {} : { integerRange }),
						});
					})
					.sort((left, right) => left.key - right.key),
			);
		} else if (
			(completion === "call-completion" || completion === "construct-completion") &&
			coreValueOnlyReturned(
				fn,
				fn.kernel.resultAt(fn.kernel.instructionResultStart(definition)),
				true,
			)
		)
			fields = call(definition);
		else return undefined;
		result = joinCoreRecordValueKinds(result, fields);
		if (result === undefined) return undefined;
	}
	return result;
}

export interface CoreRecordFieldRead {
	readonly producer: CoreInstructionId;
	readonly key: number;
	/** Preceding accesses must be own, so getters and setters cannot expose the record. */
	readonly requiredKeys: ReadonlyArray<number>;
	readonly writes?: ReadonlyArray<CoreRecordFieldWrite>;
}

export function coreRecordFieldInitialKind(
	read: CoreRecordFieldRead,
	record: CoreRecordValueKind,
	top: number,
): number {
	if (record === null) return 0;
	return coreRecordFieldIsOwnData(read, record)
		? record!.find((field) => field.key === read.key)!.mask
		: top;
}

export function coreRecordFieldIsOwnData(
	read: CoreRecordFieldRead,
	record: CoreRecordValueKind,
): boolean {
	return (
		record !== undefined &&
		record !== null &&
		read.requiredKeys.every((key) => record.some((field) => field.key === key))
	);
}

export function coreRecordFieldReadIntegerRange(
	read: CoreRecordFieldRead,
	record: CoreRecordValueKind,
	range: (
		value: CoreValueId,
		consumer: CoreInstructionId,
	) => CompilerIntegerRange | null | undefined,
): CompilerIntegerRange | null | undefined {
	if (record === null) return null;
	if (coreRecordFieldInitialKind(read, record, -1) !== COMPILER_VALUE_KIND_NUMBER)
		return undefined;
	let result = record!.find((field) => field.key === read.key)!.integerRange;
	for (const write of read.writes ?? []) {
		result = joinFieldIntegerRanges(result, range(write.value, write.instruction));
		if (result === undefined) break;
	}
	return result;
}

interface CoreRecordFieldReadIndex {
	readonly featureVersion: number;
	readonly memoryEffectVersion?: number;
	readonly reads: ReadonlyMap<CoreInstructionId, CoreRecordFieldRead>;
}

const recordFieldReadIndices = new WeakMap<CoreFunctionStore, CoreRecordFieldReadIndex>();
const MAXIMUM_RECORD_READ_PREFIX_WORK = 256;

export function coreRecordFieldReads(
	fn: CoreFunctionStore,
	control: () => CoreControlFlow,
): ReadonlyMap<CoreInstructionId, CoreRecordFieldRead> {
	// Edits are visible before their body/control-flow versions advance at commit.
	const featureVersion = fn.hasActiveEditor ? undefined : fn.featureVersion;
	const cached = recordFieldReadIndices.get(fn);
	if (
		featureVersion !== undefined &&
		cached?.featureVersion === featureVersion &&
		(cached.memoryEffectVersion === undefined ||
			cached.memoryEffectVersion === fn.version("memoryEffects"))
	)
		return cached.reads;
	const result = new Map<CoreInstructionId, CoreRecordFieldRead>();
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
		if (!valid || reads.size === 0) continue;
		const keys = new Set(reads.values());
		if (barriers.size === 0 && writes.size === 0 && keys.size === 1) {
			const requiredKeys = Object.freeze([...keys]);
			for (const [instruction, key] of reads)
				result.set(instruction, Object.freeze({ producer, key, requiredKeys }));
			continue;
		}
		cfg ??= control();
		const producerBlock = fn.instructionBlock(producer);
		const producerPosition = position(producer);
		const events = new Map<CoreBlockId, Array<CoreInstructionId>>();
		for (const instruction of new Set([...reads.keys(), ...writes.keys(), ...barriers])) {
			const block = fn.instructionBlock(instruction);
			let row = events.get(block);
			if (row === undefined) events.set(block, (row = []));
			row.push(instruction);
		}
		for (const row of events.values()) row.sort((a, b) => position(b) - position(a));
		for (const [instruction, key] of reads) {
			const block = fn.instructionBlock(instruction);
			if (!cfg.reachable.has(block) || !cfg.dominates(producerBlock, block)) continue;
			const requiredKeys = new Set([key]);
			const reachingWrites = new Set<CoreInstructionId>();
			const pending = [{ block, limit: position(instruction) }];
			const fullBlocks = new Set<CoreBlockId>();
			let remaining = MAXIMUM_RECORD_READ_PREFIX_WORK;
			let valid = true;
			// Reexecuting the producer starts a fresh object lifetime, including on a backedge.
			while (pending.length > 0 && valid) {
				const { block, limit } = pending.pop()!;
				if (--remaining < 0) {
					valid = false;
					break;
				}
				for (const event of events.get(block) ?? []) {
					const at = position(event);
					if (at >= limit) continue;
					if (block === producerBlock && at <= producerPosition) break;
					if (--remaining < 0 || barriers.has(event)) {
						valid = false;
						break;
					}
					const priorKey = reads.get(event) ?? writes.get(event);
					if (priorKey !== undefined) requiredKeys.add(priorKey);
					if (writes.get(event) === key) reachingWrites.add(event);
				}
				if (!valid || block === producerBlock) continue;
				for (const edge of cfg.predecessors[block] ?? []) {
					if (!cfg.reachable.has(edge.from) || fullBlocks.has(edge.from)) continue;
					fullBlocks.add(edge.from);
					pending.push({ block: edge.from, limit: Infinity });
				}
			}
			if (!valid) continue;
			const fieldWrites =
				reachingWrites.size === 0
					? undefined
					: Object.freeze(
							[...reachingWrites].map((instruction) => {
								const valueIndex =
									fn.instructionOpcodeName(instruction) === "storePropertyStatic" ? 1 : 2;
								return Object.freeze({
									instruction,
									value: fn.kernel.operandAt(
										fn.kernel.instructionOperandStart(instruction) + valueIndex,
									),
								});
							}),
						);
			result.set(
				instruction,
				Object.freeze({
					producer,
					key,
					requiredKeys: Object.freeze([...requiredKeys]),
					...(fieldWrites === undefined ? {} : { writes: fieldWrites }),
				}),
			);
		}
	}
	if (featureVersion !== undefined)
		recordFieldReadIndices.set(fn, {
			featureVersion,
			...(cfg === undefined ? {} : { memoryEffectVersion: fn.version("memoryEffects") }),
			reads: result,
		});
	return result;
}
