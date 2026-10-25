import type { CompilerValueKindMask } from "./compiler-value-kinds.ts";
import {
	compilerValueKindMaskIsValid,
	COMPILER_VALUE_KIND_NUMBER,
} from "./compiler-value-kinds.ts";
import type { EffectSummary } from "./effect-summary.ts";
import { EFFECT_DOMAINS } from "./effect-summary.ts";
import type { CompilerIntegerRange } from "./integer-range.ts";
import {
	compilerIntegerRangeIsValid,
	compilerIntegerRangeIsInt32,
} from "./integer-range.ts";

export const INSTRUCTION_MAY_THROW = 1 << (EFFECT_DOMAINS.length * 2);
export const INSTRUCTION_MAY_SUSPEND = INSTRUCTION_MAY_THROW << 1;
export const INSTRUCTION_MAY_GC = INSTRUCTION_MAY_THROW << 2;
export const INSTRUCTION_CALLS_USER_CODE = INSTRUCTION_MAY_THROW << 3;
const EFFECT_MASK = (INSTRUCTION_CALLS_USER_CODE << 1) - 1;

export interface InstructionFacts {
	readonly inputKindMasks?: ReadonlyArray<CompilerValueKindMask>;
	readonly resultKindMasks?: ReadonlyArray<CompilerValueKindMask>;
	readonly inputIntegerRanges?: ReadonlyArray<CompilerIntegerRange | undefined>;
	readonly registers?: ReadonlyArray<number>;
	readonly inputOffset?: number;
	readonly effectMask?: number;
}

const encodedEffects = new WeakMap<EffectSummary, number>();

export function encodeInstructionEffects(effects: EffectSummary): number {
	const encoded = encodedEffects.get(effects);
	if (encoded !== undefined) return encoded;
	let reads = 0,
		writes = 0;
	for (let index = 0; index < EFFECT_DOMAINS.length; index++) {
		if (effects.reads.includes(EFFECT_DOMAINS[index]!)) reads |= 1 << index;
		if (effects.writes.includes(EFFECT_DOMAINS[index]!)) writes |= 1 << index;
	}
	const mask =
		reads |
		(writes << EFFECT_DOMAINS.length) |
		(effects.mayThrow ? INSTRUCTION_MAY_THROW : 0) |
		(effects.maySuspend ? INSTRUCTION_MAY_SUSPEND : 0) |
		(effects.mayGc ? INSTRUCTION_MAY_GC : 0) |
		(effects.callsUserCode ? INSTRUCTION_CALLS_USER_CODE : 0);
	if (
		Object.isFrozen(effects) &&
		Object.isFrozen(effects.reads) &&
		Object.isFrozen(effects.writes)
	)
		encodedEffects.set(effects, mask);
	return mask;
}

export function decodeInstructionEffects(mask: number): EffectSummary {
	if (!instructionEffectMaskIsValid(mask))
		throw new RangeError("Invalid instruction effects");
	return {
		reads: EFFECT_DOMAINS.filter((_, index) => (mask & (1 << index)) !== 0),
		writes: EFFECT_DOMAINS.filter(
			(_, index) => ((mask >>> EFFECT_DOMAINS.length) & (1 << index)) !== 0,
		),
		mayThrow: (mask & INSTRUCTION_MAY_THROW) !== 0,
		maySuspend: (mask & INSTRUCTION_MAY_SUSPEND) !== 0,
		mayGc: (mask & INSTRUCTION_MAY_GC) !== 0,
		callsUserCode: (mask & INSTRUCTION_CALLS_USER_CODE) !== 0,
	};
}

export function instructionEffectMaskIsValid(mask: unknown): mask is number {
	return (
		typeof mask === "number" &&
		Number.isSafeInteger(mask) &&
		mask >= 0 &&
		mask <= EFFECT_MASK &&
		(mask & ~EFFECT_MASK) === 0
	);
}

export function instructionFactsAreValid(facts: InstructionFacts): boolean {
	return (
		(facts.effectMask === undefined || instructionEffectMaskIsValid(facts.effectMask)) &&
		(facts.inputKindMasks === undefined ||
			facts.inputKindMasks.every((mask) =>
				compilerValueKindMaskIsValid(mask, { allowTop: true }),
			)) &&
		(facts.resultKindMasks === undefined ||
			facts.resultKindMasks.every((mask) =>
				compilerValueKindMaskIsValid(mask, { allowTop: true }),
			)) &&
		(facts.inputIntegerRanges === undefined ||
			(facts.inputIntegerRanges.length === facts.inputKindMasks?.length &&
				facts.inputIntegerRanges.every(
					(range, index) =>
						range === undefined ||
						(compilerIntegerRangeIsValid(range) &&
							facts.inputKindMasks?.[index] === COMPILER_VALUE_KIND_NUMBER),
				))) &&
		(facts.registers === undefined
			? facts.inputOffset === undefined
			: Number.isInteger(facts.inputOffset) &&
				facts.inputOffset! >= (facts.resultKindMasks?.length ?? 0) &&
				facts.inputOffset! + (facts.inputKindMasks?.length ?? 0) ===
					facts.registers.length) &&
		(facts.effectMask !== undefined ||
			facts.inputKindMasks !== undefined ||
			facts.resultKindMasks !== undefined)
	);
}

export function instructionInputKind(
	facts: InstructionFacts | undefined,
	register: number,
): CompilerValueKindMask | undefined {
	if (register < 0 || facts?.inputOffset === undefined) return undefined;
	const index = facts.registers?.indexOf(register, facts.inputOffset) ?? -1;
	return index < facts.inputOffset
		? undefined
		: facts.inputKindMasks?.[index - facts.inputOffset];
}

export function instructionResultKind(
	facts: InstructionFacts | undefined,
	register: number,
): CompilerValueKindMask | undefined {
	const index = facts?.registers?.indexOf(register) ?? -1;
	return index < 0 ? undefined : facts?.resultKindMasks?.[index];
}

export function instructionInputIsInt32(
	facts: InstructionFacts | undefined,
	register: number,
): boolean {
	return compilerIntegerRangeIsInt32(instructionInputIntegerRange(facts, register));
}

export function instructionInputIntegerRange(
	facts: InstructionFacts | undefined,
	register: number,
): CompilerIntegerRange | undefined {
	if (
		register < 0 ||
		facts?.inputIntegerRanges === undefined ||
		facts.inputOffset === undefined
	)
		return undefined;
	const index = facts.registers?.indexOf(register, facts.inputOffset) ?? -1;
	return index >= facts.inputOffset
		? facts.inputIntegerRanges[index - facts.inputOffset]
		: undefined;
}
