import { exactBuiltinCallDescriptor } from "../shared/builtin-registry.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { coreGlobalSlotBrands } from "./core-global-slot-facts.ts";
import {
	coreExactHeapBrand,
	coreNumericTypedArrayKind,
	coreExactCollectionBrand,
	joinCoreHeapBrands,
} from "./core-heap-brands.ts";
import type {
	CoreExactHeapBrand,
	CoreNumericTypedArrayKind,
	CoreExactCollectionBrand,
	CoreHeapBrandState,
} from "./core-heap-brands.ts";
import {
	CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE,
	CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE,
	CORE_NORMAL_RESULT_HEAP_BRAND_ATTRIBUTE,
} from "./core-internal-attributes.ts";
import { buildCoreControlFlow, coreCanonicalValueRoots } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
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
import { corePrivateFieldFacts } from "./core-private-field-facts.ts";
import type { CoreValueAlternatives } from "./core-program-flow.ts";
import { coreExactArrayFromCallResult } from "./core-static-values.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";
import { coreFunctionVersionsAreCurrent } from "./core-store.ts";

export const CORE_EXACT_COLLECTION_BUILTIN_EFFECT_FACT =
	"exact-collection-builtin-effects";

export function coreCollectionReceiverBrandForOperation(
	operation: unknown,
): CoreExactCollectionBrand | undefined {
	if (typeof operation !== "string") return undefined;
	if (operation.startsWith("Map.prototype.")) return "Map";
	if (operation.startsWith("Set.prototype.")) return "Set";
	if (operation.startsWith("WeakMap.prototype.")) return "WeakMap";
	if (operation.startsWith("WeakSet.prototype.")) return "WeakSet";
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
	if (
		typeof operation !== "string" ||
		exactBuiltinCallDescriptor(operation) === undefined
	)
		return undefined;
	const expected = coreCollectionReceiverBrandForOperation(operation);
	const exact =
		provenBrand ??
		coreExactCollectionBrand(
			fn.instructionAttributes(instruction)[CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE],
		);
	if (expected === undefined || exact !== expected) return undefined;
	const weakMutation =
		operation === "WeakMap.prototype.set" || operation === "WeakSet.prototype.add";
	const writes =
		weakMutation ||
		operation === "Map.prototype.set" ||
		operation === "Map.prototype.delete" ||
		operation === "Set.prototype.add" ||
		operation === "Set.prototype.delete" ||
		operation === "WeakMap.prototype.delete" ||
		operation === "WeakSet.prototype.delete";
	const mayGc =
		weakMutation ||
		operation === "Map.prototype.set" ||
		operation === "Set.prototype.add";
	const effects: CoreInstructionEffects = {
		reads: Object.freeze(["object-property"]),
		writes: Object.freeze(writes ? ["object-property"] : []),
		mayThrow: weakMutation,
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
	heapBrandState(value: CoreValueId): CoreHeapBrandState;
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
		readonly controlFlow?: CoreControlFlow;
		readonly operationResultBrand?: (
			instruction: CoreInstructionId,
		) => CoreHeapBrandState;
		readonly operationResultAlternatives?: (
			instruction: CoreInstructionId,
			result: CoreValueId,
		) => CoreValueAlternatives | undefined;
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
		coreCanonicalValueRoots(
			fn,
			options.controlFlow ?? buildCoreControlFlow(program, functionId),
		);
	const brands = new Map<CoreValueId, CoreExactHeapBrand>();
	const entryBrands = new Map<CoreValueId, CoreExactHeapBrand>();
	const localConstructs = new Map<CoreValueId, CoreInstructionId>();
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
				coreNumericTypedArrayKind(intrinsic) ??
				coreExactCollectionBrand(intrinsic) ??
				(intrinsic === "Array" ? "Array" : undefined);
			if (brand !== undefined) {
				const outputRoot = roots.get(output) ?? output;
				brands.set(outputRoot, brand);
				localConstructs.set(outputRoot, instruction);
				seeded++;
			}
		}
	}
	const fields = corePrivateFieldFacts(program);
	const globals = coreGlobalSlotBrands(program);
	const isArrayIntrinsic = (value: CoreValueId): boolean => {
		const root = roots.get(value) ?? value;
		if (fn.kernel.valueDefinitionKind(root) !== 1) return false;
		const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(root));
		return (
			fn.instructionOpcodeName(definition) === "loadIntrinsic" &&
			fn.instructionAttributes(definition).intrinsic === "Array"
		);
	};
	for (const instruction of operations) {
		const opcode = fn.instructionOpcodeName(instruction);
		const operandStart = fn.kernel.instructionOperandStart(instruction);
		const brand =
			opcode === "createArray" ||
			(context !== undefined &&
				((opcode === "call" &&
					fn.kernel.instructionOperandCount(instruction) > 1 &&
					isArrayIntrinsic(fn.kernel.operandAt(operandStart + 1))) ||
					(opcode === "callKnown" &&
						fn.instructionAttributes(instruction).operation === "Array.from")) &&
				coreExactArrayFromCallResult(program, fn, roots, context, instruction) !==
					undefined)
				? "Array"
				: opcode === "loadPrivate"
					? fields?.field(fn, fn.kernel.operandAt(operandStart + 1))?.brand
					: opcode === "loadGlobal"
						? globals?.get(fn.instructionAttributes(instruction).index as number)
						: undefined;
		if (brand === undefined) continue;
		const output = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
		brands.set(roots.get(output) ?? output, brand);
		seeded++;
	}
	if (options.operationResultBrand === undefined) {
		for (const instruction of operations) {
			const brand = coreExactHeapBrand(
				fn.instructionAttributes(instruction)[CORE_NORMAL_RESULT_HEAP_BRAND_ATTRIBUTE],
			);
			if (brand === undefined || fn.kernel.instructionResultCount(instruction) !== 1)
				continue;
			const output = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
			brands.set(roots.get(output) ?? output, brand);
			seeded++;
		}
	}
	// These attributes record a proven receiver brand; an element or call result is unrelated.
	for (const instruction of operations) {
		const attributes = fn.instructionAttributes(instruction);
		const brand =
			coreNumericTypedArrayKind(attributes[CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE]) ??
			coreExactCollectionBrand(attributes[CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE]);
		if (brand === undefined || fn.kernel.instructionOperandCount(instruction) === 0)
			continue;
		const receiver = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
		const receiverRoot = roots.get(receiver) ?? receiver;
		if (options.operationResultBrand !== undefined) continue;
		if (
			fn.kernel.valueDefinitionKind(receiver) === 0 &&
			fn.kernel.valueDefinitionOwner(receiver) === fn.entry
		) {
			entryBrands.set(receiver, brand);
			continue;
		}
		if (fn.kernel.valueDefinitionKind(receiverRoot) === 0) continue;
		const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(receiverRoot));
		if (
			["call-completion", "construct-completion"].includes(
				fn.registry.byId(fn.instructionOpcode(definition)).callTransfer?.result ?? "",
			)
		)
			continue;
		brands.set(receiverRoot, brand);
		seeded++;
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
					(operation === "Map.prototype.set" ||
						operation === "Set.prototype.add" ||
						operation === "WeakMap.prototype.set" ||
						operation === "WeakSet.prototype.add") &&
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
		if (!localConstructs.has(valueRoot)) return false;
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
	let controlFlow = options.controlFlow;
	const states = new Map<CoreValueId, CoreHeapBrandState>();
	const heapBrandState = (value: CoreValueId): CoreHeapBrandState => {
		assertCurrent();
		const root = (input: CoreValueId): CoreValueId =>
			fn.kernel.valueDefinitionKind(input) === 0 &&
			fn.kernel.valueDefinitionOwner(input) === fn.entry
				? input
				: (roots.get(input) ?? input);
		const start = root(value);
		if (states.has(start)) return states.get(start);
		if (
			fn.kernel.valueDefinitionKind(start) === 0 &&
			fn.kernel.valueDefinitionOwner(start) === fn.entry
		)
			return entryBrands.get(start);
		const declared = brands.get(start);
		if (declared !== undefined) return declared;
		if (
			options.operationResultBrand === undefined &&
			fn.kernel.valueDefinitionKind(start) === 1 &&
			fn.instructionOpcodeName(
				coreInstructionId(fn.kernel.valueDefinitionOwner(start)),
			) !== "move"
		)
			return undefined;
		const dependencies = new Map<CoreValueId, ReadonlyArray<CoreValueId>>();
		let initialBrands: Map<CoreValueId, CoreHeapBrandState> | undefined;
		const users = new Map<CoreValueId, Array<CoreValueId>>();
		const pending = [start];
		while (pending.length > 0) {
			const current = pending.pop()!;
			if (states.has(current)) continue;
			const kind = fn.kernel.valueDefinitionKind(current);
			if (kind === 0 && fn.kernel.valueDefinitionOwner(current) === fn.entry) {
				states.set(current, entryBrands.get(current));
				continue;
			}
			const brand = brands.get(current);
			if (brand !== undefined) {
				states.set(current, brand);
				continue;
			}
			let inputs: ReadonlyArray<CoreValueId> | undefined;
			if (kind === 0) {
				controlFlow ??= buildCoreControlFlow(program, functionId);
				const block = coreBlockId(fn.kernel.valueDefinitionOwner(current));
				const position = fn.kernel.valueDefinitionIndex(current);
				const incoming = (controlFlow.predecessors[block] ?? []).filter((edge) =>
					controlFlow!.reachable.has(edge.from),
				);
				if (
					incoming.length > 0 &&
					incoming.every(
						(edge) => edge.kind === "ordinary" && edge.arguments[position] !== undefined,
					)
				)
					inputs = incoming.map((edge) => root(edge.arguments[position]!));
			} else if (kind === 1) {
				const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(current));
				if (fn.instructionOpcodeName(instruction) === "move")
					inputs = [
						root(fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction))),
					];
				else if (options.operationResultBrand !== undefined) {
					const alternatives = options.operationResultAlternatives?.(
						instruction,
						current,
					);
					if (alternatives?.hasNormalResult === false) {
						states.set(current, null);
						continue;
					}
					const initial = options.operationResultBrand(instruction);
					if (
						initial === undefined ||
						alternatives === undefined ||
						alternatives.values.length === 0
					) {
						states.set(current, initial);
						continue;
					}
					inputs = alternatives.values.map(({ value }) => root(value));
					(initialBrands ??= new Map()).set(current, initial);
				}
			}
			if (inputs === undefined) {
				states.set(current, undefined);
				continue;
			}
			states.set(current, null);
			dependencies.set(current, inputs);
			for (const input of inputs) {
				const uses = users.get(input) ?? [];
				uses.push(current);
				users.set(input, uses);
				pending.push(input);
			}
		}
		const queue = [...dependencies.keys()];
		const queued = new Set(queue);
		for (let cursor = 0; cursor < queue.length; cursor++) {
			const current = queue[cursor]!;
			queued.delete(current);
			let next: CoreHeapBrandState =
				initialBrands?.has(current) === true ? initialBrands.get(current) : null;
			for (const input of dependencies.get(current)!)
				next = joinCoreHeapBrands(next, states.get(input));
			if (next === states.get(current)) continue;
			states.set(current, next);
			for (const user of users.get(current) ?? []) {
				if (queued.has(user)) continue;
				queued.add(user);
				queue.push(user);
			}
		}
		return states.get(start);
	};
	const exactHeapBrand = (value: CoreValueId): CoreExactHeapBrand | undefined =>
		heapBrandState(value) ?? undefined;
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
		heapBrandState,
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
			const construct = localConstructs.get(root);
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
