import type { CompilerNumericTypedArrayKind } from "../shared/compiler-instruction.ts";
import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import {
	CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	buildCoreControlFlow,
	coreCanonicalValueRoots,
} from "./core-ir-control-flow.ts";
import type {
	CoreFunctionId,
	CoreInstructionEffects,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export const CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE = "exactTypedArrayKind";
export const CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE = "exactCollectionReceiver";
export const CORE_EXACT_COLLECTION_BUILTIN_EFFECT_FACT =
	"exact-collection-builtin-effects";

export type CoreNumericTypedArrayKind = CompilerNumericTypedArrayKind;
export type CoreExactCollectionBrand = "Map" | "Set";
export type CoreExactHeapBrand = CoreNumericTypedArrayKind | CoreExactCollectionBrand;

const NUMERIC_TYPED_ARRAY_KINDS: ReadonlySet<string> = new Set([
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"Float32Array",
	"Float64Array",
]);

export function coreNumericTypedArrayKind(
	value: unknown,
): CoreNumericTypedArrayKind | undefined {
	return typeof value === "string" && NUMERIC_TYPED_ARRAY_KINDS.has(value)
		? (value as CoreNumericTypedArrayKind)
		: undefined;
}

export function coreExactCollectionBrand(
	value: unknown,
): CoreExactCollectionBrand | undefined {
	return value === "Map" || value === "Set" ? value : undefined;
}

export function coreCollectionReceiverBrandForOperation(
	operation: unknown,
): CoreExactCollectionBrand | undefined {
	if (typeof operation !== "string") return undefined;
	if (operation.startsWith("Map.prototype.")) return "Map";
	if (operation.startsWith("Set.prototype.")) return "Set";
	return undefined;
}

export function coreExactCollectionBuiltinEffects(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	provenBrand?: CoreExactCollectionBrand,
): CoreInstructionEffects | undefined {
	if (
		fn.instructionKind(instruction) !== "operation" ||
		fn.instructionOpcodeName(instruction) !== "callBuiltin"
	)
		return undefined;
	const operation = fn.instructionAttributes(instruction).operation;
	const expected = coreCollectionReceiverBrandForOperation(operation);
	const exact =
		provenBrand ??
		coreExactCollectionBrand(
			fn.instructionAttributes(instruction)[CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE],
		);
	if (expected === undefined || exact !== expected) return undefined;
	const writes =
		operation === "Map.prototype.set" ||
		operation === "Map.prototype.delete" ||
		operation === "Set.prototype.add" ||
		operation === "Set.prototype.delete";
	const mayGc = operation === "Map.prototype.set" || operation === "Set.prototype.add";
	const effects: CoreInstructionEffects = {
		reads: Object.freeze(["object-property"]),
		writes: Object.freeze(writes ? ["object-property"] : []),
		mayThrow: false,
		maySuspend: false,
		mayGc,
		callsUserCode: false,
	};
	return Object.freeze(effects);
}

export interface CoreValueClassAnalysis {
	readonly function: CoreFunctionId;
	readonly statistics: {
		readonly seeded: number;
		readonly propagated: number;
	};
	exactHeapBrand(
		value: CoreValueId,
		at?: CoreInstructionId,
	): CoreExactHeapBrand | undefined;
	exactNumericTypedArray(
		value: CoreValueId,
		at?: CoreInstructionId,
	): CoreNumericTypedArrayKind | undefined;
	containedCollection(
		value: CoreValueId,
		at?: CoreInstructionId,
	): CoreExactCollectionBrand | undefined;
}

export function analyzeCoreValueClasses(
	program: CoreProgram,
	functionId: CoreFunctionId,
	context?: CoreCompilationContext,
	canonicalRoots?: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreValueClassAnalysis {
	const fn = program.function(functionId);
	const roots =
		canonicalRoots ??
		coreCanonicalValueRoots(fn, buildCoreControlFlow(program, functionId));
	const brands = new Array<CoreExactHeapBrand | undefined>(fn.valueCapacity);
	const unsafe = new Uint8Array(fn.valueCapacity);
	let seeded = 0;
	if (context?.facts.world.primordialPolicy === "locked") {
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "construct"
			)
				continue;
			if (
				fn.kernel.instructionOperandCount(instruction) === 0 ||
				fn.kernel.instructionResultCount(instruction) === 0
			)
				continue;
			const callee = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
			const output = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
			const calleeRoot = roots.get(callee) ?? callee;
			const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(calleeRoot));
			if (
				fn.kernel.valueDefinitionKind(calleeRoot) !== 1 ||
				fn.instructionKind(definition) !== "operation" ||
				fn.instructionOpcodeName(definition) !== "loadIntrinsic"
			)
				continue;
			const brand =
				coreNumericTypedArrayKind(fn.instructionAttributes(definition).intrinsic) ??
				coreExactCollectionBrand(fn.instructionAttributes(definition).intrinsic);
			if (brand !== undefined) {
				brands[roots.get(output) ?? output] = brand;
				seeded++;
			}
		}
	}
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const attributes = fn.instructionAttributes(instruction);
		const brand =
			coreNumericTypedArrayKind(attributes[CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE]) ??
			coreExactCollectionBrand(attributes[CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE]);
		if (brand === undefined) continue;
		const resultStart = fn.kernel.instructionResultStart(instruction);
		const resultCount = fn.kernel.instructionResultCount(instruction);
		for (let offset = 0; offset < resultCount; offset++) {
			const output = fn.kernel.resultAt(resultStart + offset);
			brands[roots.get(output) ?? output] = brand;
			seeded++;
		}
	}
	let propagated = 0;
	for (const value of fn.valueIds()) {
		if (brands[value] !== undefined) continue;
		const root = roots.get(value);
		if (root === undefined || brands[root] === undefined) continue;
		brands[value] = brands[root];
		propagated++;
	}
	for (const value of fn.valueIds()) {
		const valueRoot = roots.get(value) ?? value;
		const brand = brands[valueRoot];
		if (brand === undefined) continue;
		for (
			let use = fn.kernel.valueFirstUse(value);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			const instruction = fn.kernel.useInstruction(use);
			if (fn.instructionKind(instruction) !== "operation") {
				unsafe[valueRoot] = 1;
				continue;
			}
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "move" || opcode === "rootUse") continue;
			if (opcode === "callBuiltin" && fn.kernel.useOperand(use) === 0) {
				const operation = fn.instructionAttributes(instruction).operation;
				const expected = coreCollectionReceiverBrandForOperation(operation);
				if (expected === brand) {
					let retainedResult = false;
					const resultStart = fn.kernel.instructionResultStart(instruction);
					const resultCount = fn.kernel.instructionResultCount(instruction);
					for (let index = 0; index < resultCount; index++) {
						if (fn.valueUseCount(fn.kernel.resultAt(resultStart + index)) > 0) {
							retainedResult = true;
							break;
						}
					}
					if (
						(operation === "Map.prototype.set" || operation === "Set.prototype.add") &&
						retainedResult
					) {
						unsafe[valueRoot] = 1;
					}
					continue;
				}
			}
			unsafe[valueRoot] = 1;
		}
	}
	const exactHeapBrand = (value: CoreValueId): CoreExactHeapBrand | undefined =>
		brands[roots.get(value) ?? value];
	const result: CoreValueClassAnalysis = {
		function: functionId,
		statistics: Object.freeze({ seeded, propagated }),
		exactHeapBrand,
		exactNumericTypedArray(value) {
			return coreNumericTypedArrayKind(exactHeapBrand(value));
		},
		containedCollection(value) {
			const valueRoot = roots.get(value) ?? value;
			return unsafe[valueRoot] === 0
				? coreExactCollectionBrand(brands[valueRoot])
				: undefined;
		},
	};
	return Object.freeze(result);
}

export const CORE_LOCAL_VALUE_CLASS_ANALYSIS: CoreAnalysisDefinition<CoreValueClassAnalysis> =
	{
		key: "local-value-classes",
		scope: "function",
		functionDependencies: ["body", "cfg", "exceptionFlow", "facts", "representations"],
		contextIdentity: (context) => context.facts.world.primordialPolicy,
		compute({ program, context, request, get }) {
			if (request.scope !== "function")
				throw new Error("Expected function analysis request");
			return analyzeCoreValueClasses(
				program,
				request.function,
				context,
				get(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS, request),
			);
		},
	};

export interface CoreExactHeapSelection {
	readonly program: CoreProgram;
	readonly changed: boolean;
}

export function selectCoreExactHeapAccesses(
	program: CoreProgram,
): CoreExactHeapSelection {
	return Object.freeze({ program, changed: false });
}
