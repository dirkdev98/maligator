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
		const a = field.integerRange,
			b = other.integerRange;
		const integerRange =
			mask !== COMPILER_VALUE_KIND_NUMBER || a === undefined || b === undefined
				? undefined
				: a === null
					? b
					: b === null
						? a
						: Object.freeze({
								minimum: Math.min(a.minimum, b.minimum),
								maximum: Math.max(a.maximum, b.maximum),
								exactSafeIntegers: true as const,
								excludesNegativeZero: true as const,
							});
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

export function coreValueOnlyReturned(
	fn: CoreFunctionStore,
	value: CoreValueId,
): boolean {
	const pending = [value];
	const seen = new Set<CoreValueId>();
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (seen.has(current)) continue;
		seen.add(current);
		if (fn.kernel.valueHandlerUseCount(current) > 0) return false;
		for (
			let use = fn.kernel.valueFirstUse(current);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			if (fn.kernel.useLive(use) === 0) continue;
			const instruction = fn.kernel.useInstruction(use);
			const kind = fn.instructionKind(instruction);
			if (kind === "return") continue;
			if (kind !== "operation") return false;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "rootUse") continue;
			if (opcode !== "move") return false;
			pending.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)));
		}
	}
	return true;
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

const EMPTY_RECORD_KEYS: ReadonlyArray<number> = Object.freeze([]);

function recordKeys(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): ReadonlyArray<number> | undefined {
	if (fn.instructionKind(instruction) !== "operation") return undefined;
	const opcode = fn.instructionOpcodeName(instruction);
	if (opcode === "createObject" && fn.kernel.instructionOperandCount(instruction) === 0)
		return coreValueOnlyReturned(
			fn,
			fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
		)
			? EMPTY_RECORD_KEYS
			: undefined;
	if (opcode !== "createObjectShaped") return undefined;
	const keys = fn.instructionAttributes(instruction).keyStringIndices;
	if (
		!Array.isArray(keys) ||
		keys.length > 16 ||
		keys.length !== fn.kernel.instructionOperandCount(instruction) ||
		!keys.every(
			(key) => typeof key === "number" && Number.isSafeInteger(key) && key >= 0,
		) ||
		new Set(keys).size !== keys.length ||
		!coreValueOnlyReturned(
			fn,
			fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
		)
	)
		return undefined;
	return keys as ReadonlyArray<number>;
}

export function coreRecordReturnKindInputs(
	fn: CoreFunctionStore,
): ReadonlyArray<CoreValueId> {
	const inputs: Array<CoreValueId> = [];
	if (fn.isAsync || fn.isGenerator) return inputs;
	for (const instruction of fn.instructionIds()) {
		const keys = recordKeys(fn, instruction);
		if (keys === undefined) continue;
		const start = fn.kernel.instructionOperandStart(instruction);
		for (let index = 0; index < keys.length; index++)
			inputs.push(fn.kernel.operandAt(start + index));
	}
	return inputs;
}

/** These are initial own data fields; reading them after a call needs a separate mutation/escape proof. */
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
	let result: CoreRecordValueKind = null;
	for (const block of cfg.reachable) {
		const terminator = fn.blockTerminator(block);
		if (fn.instructionKind(terminator) !== "return") continue;
		const value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator));
		if (mask(value) === 0) continue;
		const definition = coreReturnedValueDefinition(fn, value);
		if (definition === undefined) return undefined;
		const keys = recordKeys(fn, definition);
		const completion = fn.registry.byId(fn.instructionOpcode(definition)).callTransfer
			?.result;
		let fields: CoreRecordValueKind;
		if (keys !== undefined) {
			const start = fn.kernel.instructionOperandStart(definition);
			fields = Object.freeze(
				keys
					.map((key, index) => {
						const value = fn.kernel.operandAt(start + index);
						const kind = mask(value);
						const integerRange =
							kind === COMPILER_VALUE_KIND_NUMBER
								? range?.(value, definition)
								: undefined;
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
	/** Earlier reads and sibling writes must be own, so getters and setters cannot escape the record. */
	readonly requiredKeys: ReadonlyArray<number>;
}

export function coreRecordFieldReadKind(
	read: CoreRecordFieldRead,
	record: CoreRecordValueKind,
	top: number,
): number {
	if (record === null) return 0;
	if (
		record === undefined ||
		read.requiredKeys.some((key) => !record.some((field) => field.key === key))
	)
		return top;
	return record.find((field) => field.key === read.key)!.mask;
}

export function coreRecordFieldReadIntegerRange(
	read: CoreRecordFieldRead,
	record: CoreRecordValueKind,
): CompilerIntegerRange | null | undefined {
	if (record === null) return null;
	if (coreRecordFieldReadKind(read, record, -1) !== COMPILER_VALUE_KIND_NUMBER)
		return undefined;
	return record!.find((field) => field.key === read.key)!.integerRange;
}

interface CoreRecordFieldReadIndex {
	readonly featureVersion: number;
	readonly memoryEffectVersion?: number;
	readonly reads: ReadonlyMap<CoreInstructionId, CoreRecordFieldRead>;
}

const recordFieldReadIndices = new WeakMap<CoreFunctionStore, CoreRecordFieldReadIndex>();
const MAXIMUM_RECORD_READ_PREFIX_WORK = 256;

export function coreInitialRecordFieldReads(
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
	const propertyKey = (instruction: CoreInstructionId): number | undefined => {
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
				const key = propertyKey(instruction);
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
					if (--remaining < 0 || barriers.has(event) || writes.get(event) === key) {
						valid = false;
						break;
					}
					const priorKey = reads.get(event) ?? writes.get(event);
					if (priorKey !== undefined) requiredKeys.add(priorKey);
				}
				if (!valid || block === producerBlock) continue;
				for (const edge of cfg.predecessors[block] ?? []) {
					if (!cfg.reachable.has(edge.from) || fullBlocks.has(edge.from)) continue;
					fullBlocks.add(edge.from);
					pending.push({ block: edge.from, limit: Infinity });
				}
			}
			if (valid)
				result.set(
					instruction,
					Object.freeze({
						producer,
						key,
						requiredKeys: Object.freeze([...requiredKeys]),
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
