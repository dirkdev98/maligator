import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import {
	CORE_LOCAL_FACT_BUNDLE_ANALYSIS,
	analyzeCoreProvenance,
} from "./core-ir-provenance.ts";
import type {
	CoreAccessKey,
	CoreNamedAllocationLayout,
	CoreProvenance,
} from "./core-ir-provenance.ts";
import type {
	CoreAccessMode,
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreProgram } from "./core-store.ts";

export const CORE_SHAPE_ORIGIN_CAP = 4;
export const CORE_KNOWN_OWN_SLOT_ATTRIBUTE = "knownOwnSlot";
export const CORE_EXACT_SHAPE_OWN_SLOT_EFFECT_FACT = "exact-shape-own-slot-effects";
export const CORE_SHAPE_CASE_CANDIDATES_ATTRIBUTE = "shapeCaseCandidates";
export const CORE_SHAPE_CASE_SLOTS_ATTRIBUTE = "shapeCaseSlots";
export const CORE_EXACT_OWN_SLOT_ATTRIBUTE = "exactOwnSlot";

export interface CoreKnownOwnSlotCandidate {
	readonly shapeFunctionIndex: number;
	readonly shapeInstruction: CoreInstructionId;
	readonly slot: number;
}

export interface CoreKnownOwnSlot {
	readonly candidates: ReadonlyArray<CoreKnownOwnSlotCandidate>;
}

export interface CoreShapeCaseCandidate {
	readonly shapeFunctionIndex: number;
	readonly shapeInstruction: CoreInstructionId;
}

export interface CoreExactShapeOwnSlot {
	readonly slot: number;
	readonly origins: ReadonlyArray<CoreShapeCaseCandidate>;
}

function nonnegativeInteger(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		!Object.is(value, -0)
	);
}

export function coreShapeCaseCandidatesFromAttribute(
	value: unknown,
): ReadonlyArray<CoreShapeCaseCandidate> | undefined {
	if (!Array.isArray(value) || value.length < 1 || value.length > CORE_SHAPE_ORIGIN_CAP)
		return undefined;
	const candidates: Array<CoreShapeCaseCandidate> = [];
	for (const entry of value as ReadonlyArray<unknown>) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry))
			return undefined;
		const candidate = entry as Record<string, unknown>;
		if (
			Object.keys(candidate).length !== 2 ||
			!nonnegativeInteger(candidate.shapeFunctionIndex) ||
			!nonnegativeInteger(candidate.shapeInstruction)
		)
			return undefined;
		if (
			candidates.some(
				(existing) =>
					existing.shapeFunctionIndex === candidate.shapeFunctionIndex &&
					existing.shapeInstruction === candidate.shapeInstruction,
			)
		)
			return undefined;
		candidates.push(
			Object.freeze({
				shapeFunctionIndex: candidate.shapeFunctionIndex,
				shapeInstruction: candidate.shapeInstruction as CoreInstructionId,
			}),
		);
	}
	return Object.freeze(candidates);
}

export function coreShapeCaseSlotsFromAttribute(
	value: unknown,
): ReadonlyArray<number> | undefined {
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > CORE_SHAPE_ORIGIN_CAP ||
		!value.every((slot) => nonnegativeInteger(slot) && slot < 64)
	)
		return undefined;
	return Object.freeze([...(value as ReadonlyArray<number>)]);
}

export function coreKnownOwnSlotFromAttribute(
	value: unknown,
): CoreKnownOwnSlot | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length !== 1 ||
		!Array.isArray(record.candidates) ||
		record.candidates.length < 1 ||
		record.candidates.length > CORE_SHAPE_ORIGIN_CAP
	)
		return undefined;
	const candidates: Array<CoreKnownOwnSlotCandidate> = [];
	for (const entry of record.candidates as ReadonlyArray<unknown>) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry))
			return undefined;
		const candidate = entry as Record<string, unknown>;
		if (
			Object.keys(candidate).length !== 3 ||
			!nonnegativeInteger(candidate.shapeFunctionIndex) ||
			!nonnegativeInteger(candidate.shapeInstruction) ||
			!nonnegativeInteger(candidate.slot)
		)
			return undefined;
		if (
			candidates.some(
				(existing) =>
					existing.shapeFunctionIndex === candidate.shapeFunctionIndex &&
					existing.shapeInstruction === candidate.shapeInstruction,
			)
		)
			return undefined;
		candidates.push(
			Object.freeze({
				shapeFunctionIndex: candidate.shapeFunctionIndex,
				shapeInstruction: candidate.shapeInstruction as CoreInstructionId,
				slot: candidate.slot,
			}),
		);
	}
	return Object.freeze({ candidates: Object.freeze(candidates) });
}

export function coreExactShapeOwnSlotFromAttribute(
	value: unknown,
): CoreExactShapeOwnSlot | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length !== 2 ||
		!nonnegativeInteger(record.slot) ||
		record.slot >= 64
	)
		return undefined;
	const origins = coreShapeCaseCandidatesFromAttribute(record.origins);
	return origins === undefined
		? undefined
		: Object.freeze({ slot: record.slot, origins });
}

export interface CoreShapeOrigin {
	readonly function: CoreFunctionId;
	readonly instruction: CoreInstructionId;
	readonly keys: ReadonlyArray<number>;
}

export interface CoreShapeCandidates {
	readonly origins: ReadonlyArray<CoreShapeOrigin>;
	readonly opaque: boolean;
}

export const CORE_SHAPE_CANDIDATES_BOTTOM: CoreShapeCandidates = Object.freeze({
	origins: Object.freeze([]),
	opaque: false,
});

export const CORE_SHAPE_CANDIDATES_OPAQUE: CoreShapeCandidates = Object.freeze({
	origins: Object.freeze([]),
	opaque: true,
});

export interface CoreShapeProvenanceStatistics {
	readonly allocations: number;
	readonly contained: number;
	readonly exactSlotQueries: number;
}

export interface CoreShapeProvenanceAnalysis {
	readonly function: CoreFunctionId;
	readonly statistics: CoreShapeProvenanceStatistics;
	candidates(value: CoreValueId, mode?: CoreAccessMode): CoreShapeCandidates;
	exactOwnSlot(
		base: CoreValueId,
		key: CoreAccessKey,
		mode: CoreAccessMode,
	):
		| {
				readonly layout: CoreNamedAllocationLayout;
				readonly slot: number;
				readonly origin: CoreShapeOrigin;
		  }
		| undefined;
}

export function analyzeCoreShapeProvenance(
	program: CoreProgram,
	functionId: CoreFunctionId,
	provenance: CoreProvenance = analyzeCoreProvenance(program, functionId),
	closedGlobalSlots: ReadonlySet<number> = new Set(),
): CoreShapeProvenanceAnalysis {
	const fn = program.function(functionId);
	const origins = new Map<CoreInstructionId, CoreShapeOrigin>();
	for (const layout of provenance.layouts) {
		if (layout.kind !== "named-slots") continue;
		origins.set(
			layout.instruction,
			Object.freeze({
				function: functionId,
				instruction: layout.instruction,
				keys: layout.keys,
			}),
		);
	}
	const globalOrigins = new Map<number, ReadonlyArray<CoreShapeOrigin>>();
	const overflowGlobalSlots = new Set<number>();
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionOpcodeName(instruction) !== "storeGlobal"
		) {
			continue;
		}
		const slot = fn.instructionAttributes(instruction).index;
		if (
			typeof slot !== "number" ||
			!closedGlobalSlots.has(slot) ||
			fn.kernel.instructionOperandCount(instruction) === 0
		) {
			continue;
		}
		const value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
		const layout = provenance.allocationOf(value);
		const origin =
			layout?.kind === "named-slots" ? origins.get(layout.instruction) : undefined;
		if (origin === undefined || overflowGlobalSlots.has(slot)) continue;
		const current = globalOrigins.get(slot) ?? [];
		if (
			current.some(
				(candidate) =>
					candidate.function === origin.function &&
					candidate.instruction === origin.instruction,
			)
		) {
			continue;
		}
		if (current.length >= CORE_SHAPE_ORIGIN_CAP) {
			overflowGlobalSlots.add(slot);
			globalOrigins.delete(slot);
			continue;
		}
		globalOrigins.set(slot, Object.freeze([...current, origin]));
	}
	const closedGlobalCandidates = (
		value: CoreValueId,
		seen = new Set<CoreValueId>(),
	): ReadonlyArray<CoreShapeOrigin> | undefined => {
		if (seen.has(value) || fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
		seen.add(value);
		const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		const opcode = fn.instructionOpcodeName(definition);
		if (opcode === "move" && fn.kernel.instructionOperandCount(definition) > 0) {
			return closedGlobalCandidates(
				fn.kernel.operandAt(fn.kernel.instructionOperandStart(definition)),
				seen,
			);
		}
		if (opcode !== "loadGlobal") return undefined;
		const slot = fn.instructionAttributes(definition).index;
		return typeof slot === "number" ? globalOrigins.get(slot) : undefined;
	};
	let exactSlotQueries = 0;
	const result: CoreShapeProvenanceAnalysis = {
		function: functionId,
		statistics: {
			allocations: origins.size,
			contained: [...origins].filter(
				([instruction]) => provenance.escape(instruction) === "contained",
			).length,
			get exactSlotQueries() {
				return exactSlotQueries;
			},
		},
		candidates(value, mode = "read") {
			const layout = provenance.allocationOf(value);
			if (layout?.kind === "named-slots") {
				const origin = origins.get(layout.instruction);
				if (origin !== undefined) {
					return Object.freeze({ origins: Object.freeze([origin]), opaque: false });
				}
			}
			// Closed-slot representatives restore portable read guards; writes retain the local store IC.
			if (mode === "write") return CORE_SHAPE_CANDIDATES_OPAQUE;
			const global = closedGlobalCandidates(value);
			return global === undefined || global.length === 0
				? CORE_SHAPE_CANDIDATES_OPAQUE
				: Object.freeze({ origins: global, opaque: false });
		},
		exactOwnSlot(base, key, mode) {
			exactSlotQueries++;
			const resolved = provenance.ownCell(base, key, mode);
			if (resolved?.layout.kind !== "named-slots" || resolved.cell.kind !== "object-slot")
				return undefined;
			const slot = resolved.layout.keys.indexOf(resolved.cell.key);
			const origin = origins.get(resolved.layout.instruction);
			return slot < 0 || origin === undefined
				? undefined
				: Object.freeze({ layout: resolved.layout, slot, origin });
		},
	};
	return Object.freeze(result);
}

export const CORE_LOCAL_SHAPE_PROVENANCE_ANALYSIS: CoreAnalysisDefinition<CoreShapeProvenanceAnalysis> =
	{
		key: "local-shape-provenance",
		scope: "function",
		functionDependencies: ["body", "cfg", "exceptionFlow", "memoryEffects"],
		programDependencies: ["data"],
		compute({ program, context, request, get }) {
			if (request.scope !== "function")
				throw new Error("Expected function analysis request");
			return analyzeCoreShapeProvenance(
				program,
				request.function,
				get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, request).provenance,
				new Set(context.data.singleAssignmentGlobalSlots),
			);
		},
	};

export function coreExactShapeOwnSlotDigest(value: unknown): string | undefined {
	const claim = coreExactShapeOwnSlotFromAttribute(value);
	return claim === undefined
		? undefined
		: `exact-shape-slot:${claim.slot}:${claim.origins.map((origin) => `${origin.shapeFunctionIndex}:${origin.shapeInstruction}`).join(",")}`;
}
