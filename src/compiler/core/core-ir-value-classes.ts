import type { CompilerNumericTypedArrayKind } from "../shared/compiler-instruction.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { buildCoreControlFlow, coreCanonicalValueRoots } from "./core-ir-control-flow.ts";
import type { CoreLocalFactIndex } from "./core-ir-provenance.ts";
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
	index?: CoreLocalFactIndex,
): CoreValueClassAnalysis {
	const fn = program.function(functionId);
	const roots =
		canonicalRoots ??
		coreCanonicalValueRoots(fn, buildCoreControlFlow(program, functionId));
	const brands = new Map<CoreValueId, CoreExactHeapBrand>();
	const unsafe = new Set<CoreValueId>();
	const operations =
		index?.operations ??
		[...fn.instructionIds()].filter(
			(instruction) => fn.instructionKind(instruction) === "operation",
		);
	let seeded = 0;
	if (context?.facts.world.primordialPolicy === "locked") {
		const constructs =
			index?.opcodes.get("construct") ??
			operations.filter(
				(instruction) => fn.instructionOpcodeName(instruction) === "construct",
			);
		for (const instruction of constructs) {
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
				brands.set(roots.get(output) ?? output, brand);
				seeded++;
			}
		}
	}
	for (const instruction of operations) {
		const attributes = fn.instructionAttributes(instruction);
		const brand =
			coreNumericTypedArrayKind(attributes[CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE]) ??
			coreExactCollectionBrand(attributes[CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE]);
		if (brand === undefined) continue;
		const resultStart = fn.kernel.instructionResultStart(instruction);
		const resultCount = fn.kernel.instructionResultCount(instruction);
		for (let offset = 0; offset < resultCount; offset++) {
			const output = fn.kernel.resultAt(resultStart + offset);
			brands.set(roots.get(output) ?? output, brand);
			seeded++;
		}
	}
	let propagated = 0;
	if (index === undefined) {
		for (const value of fn.valueIds()) {
			const root = roots.get(value);
			if (root !== undefined && root !== value && brands.has(root)) propagated++;
		}
	} else {
		for (const [root, values] of index.valuesByRoot) {
			if (!brands.has(root)) continue;
			for (const value of values) if (value !== root) propagated++;
		}
	}
	const inspectUse = (
		valueRoot: CoreValueId,
		brand: CoreExactHeapBrand,
		instruction: CoreInstructionId,
		operand: number,
	): void => {
		if (fn.instructionKind(instruction) !== "operation") {
			unsafe.add(valueRoot);
			return;
		}
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode === "move" || opcode === "rootUse") return;
		if (opcode === "callBuiltin" && operand === 0) {
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
					unsafe.add(valueRoot);
				}
				return;
			}
		}
		unsafe.add(valueRoot);
	};
	for (const [valueRoot, brand] of brands) {
		if (index === undefined) {
			for (const value of fn.valueIds()) {
				if ((roots.get(value) ?? value) !== valueRoot) continue;
				for (
					let use = fn.kernel.valueFirstUse(value);
					use >= 0;
					use = fn.kernel.useNext(use)
				) {
					inspectUse(
						valueRoot,
						brand,
						fn.kernel.useInstruction(use),
						fn.kernel.useOperand(use),
					);
				}
			}
		} else {
			if (index.controlUses.has(valueRoot)) unsafe.add(valueRoot);
			for (const use of index.uses.get(valueRoot) ?? []) {
				inspectUse(valueRoot, brand, use.instruction, use.position);
			}
		}
	}
	const exactHeapBrand = (value: CoreValueId): CoreExactHeapBrand | undefined =>
		brands.get(roots.get(value) ?? value);
	const result: CoreValueClassAnalysis = {
		function: functionId,
		statistics: Object.freeze({ seeded, propagated }),
		exactHeapBrand,
		exactNumericTypedArray(value) {
			return coreNumericTypedArrayKind(exactHeapBrand(value));
		},
		containedCollection(value) {
			const valueRoot = roots.get(value) ?? value;
			return !unsafe.has(valueRoot)
				? coreExactCollectionBrand(brands.get(valueRoot))
				: undefined;
		},
	};
	return Object.freeze(result);
}

export interface CoreExactHeapSelection {
	readonly program: CoreProgram;
	readonly changed: boolean;
}

export function selectCoreExactHeapAccesses(
	program: CoreProgram,
): CoreExactHeapSelection {
	return Object.freeze({ program, changed: false });
}
