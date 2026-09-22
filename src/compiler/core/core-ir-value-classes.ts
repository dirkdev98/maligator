import type { CompilerNumericTypedArrayKind } from "../shared/compiler-instruction.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import {
	CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE,
	CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE,
} from "./core-internal-attributes.ts";
import { buildCoreControlFlow, coreCanonicalValueRoots } from "./core-ir-control-flow.ts";
import type { CoreLoopInductionAnalysis } from "./core-ir-loops.ts";
import type { CoreLocalFactIndex } from "./core-ir-provenance.ts";
import type {
	CoreFunctionId,
	CoreInstructionEffects,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import { coreBlockId, coreInstructionId } from "./core-ir.ts";
import { CORE_OPTIMIZATION_OWNER } from "./core-optimization-owners.ts";
import type { CoreOptimizationOwnerRunner } from "./core-optimization-owners.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";
import { coreFunctionVersionsAreCurrent } from "./core-store.ts";

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
		fn.instructionOpcodeName(instruction) !== "callKnown" ||
		fn.instructionAttributes(instruction).construct ||
		fn.instructionAttributes(instruction).argumentMode !== undefined
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
		readonly containmentChecks: number;
		readonly useVisits: number;
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
	containedFixedNumericTypedArray(
		value: CoreValueId,
		at?: CoreInstructionId,
	): CoreNumericTypedArrayKind | undefined;
}

function isLengthProperty(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
) {
	const stringIndex = fn.instructionAttributes(instruction).stringIndex;
	const value =
		typeof stringIndex === "number" ? program.stringConstants[stringIndex] : undefined;
	return (
		value?.length === 6 &&
		value[0] === 0x6c &&
		value[1] === 0x65 &&
		value[2] === 0x6e &&
		value[3] === 0x67 &&
		value[4] === 0x74 &&
		value[5] === 0x68
	);
}

function numericPropertyKey(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	ranges?: () => CoreLoopInductionAnalysis,
): boolean {
	if (fn.kernel.instructionOperandCount(instruction) < 2) return false;
	const key = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + 1);
	const representation = fn.valueRepresentation(key);
	return (
		representation === "i32" ||
		representation === "f64" ||
		ranges?.().range(key, coreBlockId(fn.kernel.instructionBlock(instruction))) !==
			undefined
	);
}

function constructOwnsFixedTypedArrayStorage(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
): boolean {
	const operandCount = fn.kernel.instructionOperandCount(instruction);
	if (operandCount === 1) return true;
	if (operandCount !== 2) return false;
	const argument = fn.kernel.operandAt(
		fn.kernel.instructionOperandStart(instruction) + 1,
	);
	const argumentRoot = roots.get(argument) ?? argument;
	if (
		fn.valueRepresentation(argument) === "f64" ||
		fn.valueRepresentation(argument) === "i32"
	)
		return true;
	if (fn.kernel.valueDefinitionKind(argumentRoot) !== 1) return false;
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(argumentRoot));
	const opcode = fn.instructionOpcodeName(definition);
	return opcode === "createNumber" || opcode === "createF64";
}

export function analyzeCoreValueClasses(
	program: CoreProgram,
	functionId: CoreFunctionId,
	context?: CoreCompilationContext,
	canonicalRoots?: ReadonlyMap<CoreValueId, CoreValueId>,
	index?: () => CoreLocalFactIndex,
	ranges?: () => CoreLoopInductionAnalysis,
	options: {
		readonly runOwner?: CoreOptimizationOwnerRunner;
		readonly onContainment?: () => void;
	} = {},
): CoreValueClassAnalysis {
	const fn = program.function(functionId);
	const generation = program.generation,
		versions = fn.versions,
		dataVersion = program.programVersion("data");
	const assertCurrent = () => {
		if (
			fn.hasActiveEditor ||
			program.generation !== generation ||
			program.function(functionId) !== fn ||
			program.programVersion("data") !== dataVersion ||
			!coreFunctionVersionsAreCurrent(fn, versions)
		)
			throw new Error("Stale value-class analysis");
	};
	assertCurrent();
	const roots =
		canonicalRoots ??
		coreCanonicalValueRoots(fn, buildCoreControlFlow(program, functionId));
	const brands = new Map<CoreValueId, CoreExactHeapBrand>();
	const typedArrayConstructs = new Map<CoreValueId, CoreInstructionId>();
	const operations = [...fn.instructionIds()].filter(
		(instruction) => fn.instructionKind(instruction) === "operation",
	);
	let seeded = 0;
	if (context?.facts.world.primordialPolicy === "locked") {
		const constructs = operations.filter(
			(instruction) =>
				fn.instructionOpcodeName(instruction) === "construct" ||
				(fn.instructionOpcodeName(instruction) === "callKnown" &&
					fn.instructionAttributes(instruction).construct === true &&
					fn.instructionAttributes(instruction).argumentMode === undefined),
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
				fn.instructionKind(definition) !== "operation"
			)
				continue;
			const definitionAttributes = fn.instructionAttributes(definition);
			const intrinsic =
				fn.instructionOpcodeName(definition) === "loadIntrinsic"
					? definitionAttributes.intrinsic
					: fn.instructionOpcodeName(definition) === "loadPrimordial" &&
						  typeof definitionAttributes.nodeIndex === "number"
						? getPrimordialCatalog().nodes[definitionAttributes.nodeIndex]?.[0]
						: undefined;
			if (
				fn.instructionOpcodeName(instruction) === "callKnown" &&
				fn.instructionAttributes(instruction).operation !== intrinsic
			)
				continue;
			const brand =
				coreNumericTypedArrayKind(intrinsic) ?? coreExactCollectionBrand(intrinsic);
			if (brand !== undefined) {
				const outputRoot = roots.get(output) ?? output;
				brands.set(outputRoot, brand);
				if (coreNumericTypedArrayKind(brand) !== undefined)
					typedArrayConstructs.set(outputRoot, instruction);
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
	let propagated: number | undefined;
	let containmentChecks = 0,
		useVisits = 0;
	const containment = new Map<CoreValueId, boolean>();
	let localIndex: CoreLocalFactIndex | undefined;
	let aliases: Map<CoreValueId, Array<CoreValueId>> | undefined;
	const rootAliases = (root: CoreValueId): ReadonlyArray<CoreValueId> => {
		if (aliases === undefined) {
			aliases = new Map();
			for (const value of fn.valueIds()) {
				const valueRoot = roots.get(value) ?? value;
				if (!brands.has(valueRoot)) continue;
				const values = aliases.get(valueRoot) ?? [];
				values.push(value);
				aliases.set(valueRoot, values);
			}
		}
		return aliases.get(root) ?? [];
	};
	const safeUse = (
		brand: CoreExactHeapBrand,
		instruction: CoreInstructionId,
		operand: number,
	): boolean => {
		useVisits++;
		if (fn.instructionKind(instruction) !== "operation") return false;
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode === "move" || opcode === "rootUse" || opcode === "requireCoercible")
			return true;
		if (
			coreNumericTypedArrayKind(brand) !== undefined &&
			operand === 0 &&
			((opcode === "loadPropertyStatic" && isLengthProperty(program, fn, instruction)) ||
				((opcode === "loadProperty" || opcode === "storeProperty") &&
					numericPropertyKey(fn, instruction, ranges)))
		)
			return true;
		if (
			opcode === "callKnown" &&
			operand === 0 &&
			!fn.instructionAttributes(instruction).construct &&
			fn.instructionAttributes(instruction).argumentMode === undefined
		) {
			const operation = fn.instructionAttributes(instruction).operation;
			const expected = coreCollectionReceiverBrandForOperation(operation);
			if (expected === brand) {
				let retainedResult = false;
				const resultStart = fn.kernel.instructionResultStart(instruction);
				const resultCount = fn.kernel.instructionResultCount(instruction);
				for (let index = 0; index < resultCount; index++) {
					const result = fn.kernel.resultAt(resultStart + index);
					if (fn.valueUseCount(result) + fn.kernel.valueHandlerUseCount(result) > 0) {
						retainedResult = true;
						break;
					}
				}
				if (
					(operation === "Map.prototype.set" || operation === "Set.prototype.add") &&
					retainedResult
				) {
					return false;
				}
				return true;
			}
		}
		return false;
	};
	const isContained = (valueRoot: CoreValueId, brand: CoreExactHeapBrand): boolean => {
		const cached = containment.get(valueRoot);
		if (cached !== undefined) return cached;
		const compute = () => {
			containmentChecks++;
			options.onContainment?.();
			const facts = index === undefined ? undefined : (localIndex ??= index());
			if (facts !== undefined) {
				if (facts.controlUses.has(valueRoot)) return false;
				for (const use of facts.uses.get(valueRoot) ?? [])
					if (!safeUse(brand, use.instruction, use.position)) return false;
			} else {
				for (const value of rootAliases(valueRoot)) {
					if (fn.kernel.valueHandlerUseCount(value) > 0) return false;
					for (
						let use = fn.kernel.valueFirstUse(value);
						use >= 0;
						use = fn.kernel.useNext(use)
					)
						if (!safeUse(brand, fn.kernel.useInstruction(use), fn.kernel.useOperand(use)))
							return false;
				}
			}
			return true;
		};
		const result =
			options.runOwner === undefined
				? compute()
				: options.runOwner(
						CORE_OPTIMIZATION_OWNER.localFactAndProvenanceConstruction,
						compute,
					);
		containment.set(valueRoot, result);
		return result;
	};
	const exactHeapBrand = (value: CoreValueId): CoreExactHeapBrand | undefined => {
		assertCurrent();
		return brands.get(roots.get(value) ?? value);
	};
	const result: CoreValueClassAnalysis = {
		function: functionId,
		statistics: Object.freeze({
			seeded,
			get propagated() {
				assertCurrent();
				if (propagated === undefined) {
					propagated = 0;
					for (const value of fn.valueIds()) {
						const root = roots.get(value);
						if (root !== undefined && root !== value && brands.has(root)) propagated++;
					}
				}
				return propagated;
			},
			get containmentChecks() {
				return containmentChecks;
			},
			get useVisits() {
				return useVisits;
			},
		}),
		exactHeapBrand,
		exactNumericTypedArray(value) {
			return coreNumericTypedArrayKind(exactHeapBrand(value));
		},
		containedCollection(value) {
			const brand = coreExactCollectionBrand(exactHeapBrand(value));
			const root = roots.get(value) ?? value;
			return brand !== undefined && isContained(root, brand) ? brand : undefined;
		},
		containedFixedNumericTypedArray(value) {
			const brand = coreNumericTypedArrayKind(exactHeapBrand(value));
			const root = roots.get(value) ?? value;
			const construct = typedArrayConstructs.get(root);
			return brand !== undefined &&
				construct !== undefined &&
				constructOwnsFixedTypedArrayStorage(fn, construct, roots) &&
				isContained(root, brand)
				? brand
				: undefined;
		},
	};
	return Object.freeze(result);
}
