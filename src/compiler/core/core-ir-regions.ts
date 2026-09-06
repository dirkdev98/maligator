import type { CompilerGuardPlan, KnownBuiltinCall } from "../shared/compiler-facts.ts";
import type { CompilerInstruction } from "../shared/compiler-instruction.ts";
import type { CoreExactCollectionBrand } from "./core-ir-value-classes.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreRepresentation,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreUnsignedArithmeticPlan } from "./core-native-numeric-analysis.ts";
import type { CoreSpecializationRecipeTable } from "./core-specialization-recipes.ts";
import type { CoreFunctionVersions, CoreProgramVersions } from "./core-store.ts";
import type {
	CoreTransformBudgetStatistics,
	CoreTransformDeclineReason,
} from "./core-transform-candidates.ts";

export type CorePlanSpecializationKind =
	| "guarded-direct-call"
	| "stack-object-plan"
	| "dense-array-plan"
	| "numeric-fusion"
	| "string-split-projection"
	| "regexp-exec-projection"
	| "regexp-iterator-projection"
	| "string-slice-number"
	| "string-char-code-at-chain"
	| "builtin-collection-call-chain"
	| "array-values-iterator-cursor"
	| "string-iterator-cursor"
	| "typed-array-iterator-cursor"
	| "map-iterator-cursor"
	| "set-iterator-cursor"
	| "iterator-result-virtualization"
	| "iterator-entry-pair-virtualization"
	| "fresh-array-length"
	| "indexed-length-loop"
	| "function-call-chain"
	| "string-split-cursor";

export type CorePlanRepresentation = Exclude<
	CoreRepresentation,
	"string-span" | "projected-elements" | "dense-elements" | "scalarized-object"
>;

export interface CorePlanVersionStamp {
	readonly key: string;
	readonly program: CoreProgramVersions;
	readonly functions: ReadonlyArray<{
		readonly function: CoreFunctionId;
		readonly versions: CoreFunctionVersions;
	}>;
}

export interface CorePlanCost {
	readonly generatedCode: number;
	readonly compilerWork: number;
	readonly runtimeBenefit: number;
}

export interface CorePlanAdmission {
	readonly anchor: CoreInstructionId;
	readonly mode: "capture" | "stable" | "per-use";
}

interface CorePlanSpecializationBase<Kind extends CorePlanSpecializationKind> {
	readonly id: string;
	readonly kind: Kind;
	readonly function: CoreFunctionId;
	readonly anchors: ReadonlyArray<CoreInstructionId>;
	readonly claimedInstructions: ReadonlyArray<CoreInstructionId>;
	readonly ordinaryBlocks: ReadonlyArray<CoreBlockId>;
	readonly exceptionalBlocks: ReadonlyArray<CoreBlockId>;
	readonly representation: string;
	readonly requiredRepresentations: ReadonlyArray<{
		readonly value: CoreValueId;
		readonly representation: CoreRepresentation;
	}>;
	readonly target: "native";
	readonly fallback: "canonical-core";
	readonly semanticProtectors: ReadonlyArray<string>;
	readonly targetFunctions: ReadonlyArray<CoreFunctionId>;
	readonly admission: CorePlanAdmission;
	readonly composition: "exclusive" | "overlay";
	readonly cost: CorePlanCost;
}

export interface CorePlanStackObjectSpecialization extends CorePlanSpecializationBase<"stack-object-plan"> {
	readonly stackObject: {
		readonly allocation: CoreInstructionId;
		readonly mode: "elided" | "activation-local";
		readonly slotCount: number;
		readonly accesses: ReadonlyArray<{
			readonly instruction: CoreInstructionId;
			readonly slot: number;
		}>;
		readonly materializations: ReadonlyArray<{
			readonly instruction: CoreInstructionId;
			readonly kind: "return";
		}>;
	};
}

export interface CorePlanDenseArraySpecialization extends CorePlanSpecializationBase<"dense-array-plan"> {
	readonly denseArray: {
		readonly allocation: CoreInstructionId;
		readonly store: CoreInstructionId;
		readonly loopHeader: CoreBlockId;
		readonly length: number;
	};
}

export interface CorePlanStringSplitProjectionSpecialization extends CorePlanSpecializationBase<"string-split-projection"> {
	readonly stringSplitProjection: {
		readonly guard: CompilerGuardPlan;
		readonly builtinCall: KnownBuiltinCall;
		readonly property?: CoreInstructionId;
		readonly propertyPlacement: CorePropertyPlacement;
		readonly splitIdentity: CoreBuiltinIdentityDecision;
		readonly call: CoreInstructionId;
		readonly separator: CoreInstructionId;
		readonly separatorStringIndex: number;
		readonly resultValues: ReadonlyArray<CoreValueId>;
		readonly loads: ReadonlyArray<
			| {
					readonly instruction: CoreInstructionId;
					readonly kind: "element";
					readonly index: number;
					readonly key: CoreInstructionId;
			  }
			| {
					readonly instruction: CoreInstructionId;
					readonly kind: "length";
			  }
		>;
	};
}

export interface CorePlanStringSliceNumberSpecialization extends CorePlanSpecializationBase<"string-slice-number"> {
	readonly stringSliceNumber: {
		readonly guard: CompilerGuardPlan;
		readonly builtinCall: KnownBuiltinCall;
		readonly property: CoreInstructionId;
		readonly propertyPlacement: CorePropertyPlacement;
		readonly builtinIdentities: CoreBuiltinIdentityDecision;
		readonly sliceCall: CoreInstructionId;
		readonly sliceStartInstruction: CoreInstructionId;
		readonly numberIntrinsic: CoreInstructionId;
		readonly numberCall: CoreInstructionId;
		readonly sliceStart: number;
	};
}

export interface CorePlanRegExpExecProjectionSpecialization extends CorePlanSpecializationBase<"regexp-exec-projection"> {
	readonly regexpExecProjection: {
		readonly guard: CompilerGuardPlan;
		readonly builtinCall: KnownBuiltinCall;
		readonly property: CoreInstructionId;
		readonly propertyPlacement: CorePropertyPlacement;
		readonly call: CoreInstructionId;
		readonly resultValues: ReadonlyArray<CoreValueId>;
		readonly nullChecks: ReadonlyArray<{
			readonly comparison: CoreInstructionId;
			readonly nullValue: CoreInstructionId;
		}>;
		readonly lockedLiteral?: {
			readonly constructorIntrinsic: CoreInstructionId;
			readonly construct: CoreInstructionId;
		};
		readonly loads: ReadonlyArray<{
			readonly instruction: CoreInstructionId;
			readonly key: CoreInstructionId;
			readonly captureIndex: number;
			readonly consumer?:
				| { readonly kind: "length"; readonly property: CoreInstructionId }
				| {
						readonly kind: "charCodeAtZero";
						readonly methodIdentity: CoreBuiltinIdentityDecision;
						readonly property: CoreInstructionId;
						readonly call: CoreInstructionId;
						readonly zero?: CoreInstructionId;
				  }
				| {
						readonly kind: "number";
						readonly intrinsic: CoreInstructionId;
						readonly call: CoreInstructionId;
				  }
				| {
						readonly kind: "asciiCaseLength";
						readonly methodIdentity: CoreBuiltinIdentityDecision;
						readonly upperProperty: CoreInstructionId;
						readonly upperCall: CoreInstructionId;
						readonly lowerProperty: CoreInstructionId;
						readonly lowerCall: CoreInstructionId;
						readonly resultMoves: ReadonlyArray<CoreInstructionId>;
						readonly lengthProperty: CoreInstructionId;
				  };
		}>;
	};
}

export interface CorePlanRegExpIteratorProjectionSpecialization extends CorePlanSpecializationBase<"regexp-iterator-projection"> {
	readonly regexpIteratorProjection: {
		readonly guard: CompilerGuardPlan;
		readonly step: CoreInstructionId;
		readonly doneBranch: CoreInstructionId;
		readonly exitBlock: CoreBlockId;
		readonly resultValues: ReadonlyArray<CoreValueId>;
		readonly loads: ReadonlyArray<{
			readonly instruction: CoreInstructionId;
			readonly key: CoreInstructionId;
			readonly captureIndex: number;
			readonly numberIntrinsic: CoreInstructionId;
			readonly numberCall: CoreInstructionId;
		}>;
	};
}

export interface CorePlanStringCharCodeAtSpecialization extends CorePlanSpecializationBase<"string-char-code-at-chain"> {
	readonly stringCharCodeAt: {
		readonly guard: CompilerGuardPlan;
		readonly builtinCall: KnownBuiltinCall;
		readonly property: CoreInstructionId;
		readonly call: CoreInstructionId;
		readonly methodIdentity: CoreBuiltinIdentityDecision;
		readonly bounded?: {
			readonly length: CoreInstructionId;
			readonly comparison: CoreInstructionId;
			readonly update: CoreInstructionId;
		};
	};
}

export interface CorePlanBuiltinCollectionCallSpecialization extends CorePlanSpecializationBase<"builtin-collection-call-chain"> {
	readonly builtinCollectionCall: {
		readonly guard: CompilerGuardPlan;
		readonly builtinCall: KnownBuiltinCall;
		readonly property: CoreInstructionId;
		readonly call: CoreInstructionId;
		readonly operation: CoreCollectionBuiltinOperation;
		readonly exactReceiver?: CoreExactCollectionBrand;
	};
}

export type CorePlanIteratorCursorKind =
	| "array-values-iterator-cursor"
	| "string-iterator-cursor"
	| "typed-array-iterator-cursor"
	| "map-iterator-cursor"
	| "set-iterator-cursor";

export type CorePlanIteratorCursorProtocol =
	| "array-values"
	| "string"
	| "typed-array-values"
	| "map"
	| "set";

export interface CorePlanIteratorCursorSpecialization extends CorePlanSpecializationBase<CorePlanIteratorCursorKind> {
	readonly iteratorCursor: {
		readonly initialize: CoreInstructionId;
		readonly steps: ReadonlyArray<CoreInstructionId>;
		readonly protocol: CorePlanIteratorCursorProtocol;
	};
}

export interface CorePlanIteratorResultVirtualizationSpecialization extends CorePlanSpecializationBase<"iterator-result-virtualization"> {
	readonly iteratorResultVirtualization: {
		readonly guard: CompilerGuardPlan;
		readonly steps: ReadonlyArray<CoreInstructionId>;
	};
}

export interface CorePlanIteratorEntryPairVirtualizationSpecialization extends CorePlanSpecializationBase<"iterator-entry-pair-virtualization"> {
	readonly iteratorEntryPairVirtualization: {
		readonly guard: CompilerGuardPlan;
		readonly cursorInitialize: CoreInstructionId;
		readonly outerStep: CoreInstructionId;
		readonly innerInitialize: CoreInstructionId;
		readonly innerSteps: readonly [CoreInstructionId, CoreInstructionId];
		readonly innerCloses: ReadonlyArray<CoreInstructionId>;
	};
}

export interface CorePlanFreshArrayLengthSpecialization extends CorePlanSpecializationBase<"fresh-array-length"> {
	readonly freshArrayLength: {
		readonly allocation: CoreInstructionId;
		readonly load: CoreInstructionId;
		readonly length: number;
	};
}

export interface CorePlanIndexedLengthLoopSpecialization extends CorePlanSpecializationBase<"indexed-length-loop"> {
	readonly indexedLengthLoop: {
		readonly load: CoreInstructionId;
		readonly comparison: CoreInstructionId;
		readonly lengthPosition: 1 | 2;
		readonly elements: ReadonlyArray<{
			readonly instruction: CoreInstructionId;
			readonly kind: "load" | "store";
		}>;
	};
}

export interface CorePlanFunctionCallChainSpecialization extends CorePlanSpecializationBase<"function-call-chain"> {
	readonly functionCall: {
		readonly property: CoreInstructionId;
		readonly call: CoreInstructionId;
		readonly targetFunction?: CoreFunctionId;
	};
}

export interface CorePlanStringSplitCursorSpecialization extends CorePlanSpecializationBase<"string-split-cursor"> {
	readonly stringSplitCursor: {
		readonly guard: CompilerGuardPlan;
		readonly splitBuiltinCall: KnownBuiltinCall;
		readonly trimBuiltinCall: KnownBuiltinCall;
		readonly property?: CoreInstructionId;
		readonly propertyPlacement: CorePropertyPlacement;
		readonly splitIdentity: CoreBuiltinIdentityDecision;
		readonly trimIdentity: CoreBuiltinIdentityDecision;
		readonly call: CoreInstructionId;
		readonly length: CoreInstructionId;
		readonly compare: CoreInstructionId;
		readonly branch: CoreInstructionId;
		readonly element: CoreInstructionId;
		readonly trimProperty: CoreInstructionId;
		readonly trimCall: CoreInstructionId;
		readonly advance?: CoreInstructionId;
		readonly increment: CoreInstructionId;
		readonly backedge: CoreInstructionId;
		readonly resultValues: ReadonlyArray<CoreValueId>;
		readonly primitiveStringLengths: ReadonlyArray<CoreInstructionId>;
		readonly exitBlock: CoreBlockId;
	};
}

export type CorePlanSpecialization =
	| CorePlanSpecializationBase<"guarded-direct-call" | "numeric-fusion">
	| CorePlanStackObjectSpecialization
	| CorePlanDenseArraySpecialization
	| CorePlanStringSplitProjectionSpecialization
	| CorePlanStringSliceNumberSpecialization
	| CorePlanRegExpExecProjectionSpecialization
	| CorePlanRegExpIteratorProjectionSpecialization
	| CorePlanStringCharCodeAtSpecialization
	| CorePlanBuiltinCollectionCallSpecialization
	| CorePlanIteratorCursorSpecialization
	| CorePlanIteratorResultVirtualizationSpecialization
	| CorePlanIteratorEntryPairVirtualizationSpecialization
	| CorePlanFreshArrayLengthSpecialization
	| CorePlanIndexedLengthLoopSpecialization
	| CorePlanFunctionCallChainSpecialization
	| CorePlanStringSplitCursorSpecialization;

export interface CoreDirectEntryCallSite {
	readonly caller: CoreFunctionId;
	readonly instruction: CoreInstructionId;
	readonly guarded?: true;
}

export interface CoreDirectEntryPlan {
	readonly id: number;
	readonly function: CoreFunctionId;
	readonly callSites: ReadonlyArray<CoreDirectEntryCallSite>;
	readonly parameterRepresentations: ReadonlyArray<CorePlanRepresentation>;
	readonly resultRepresentation: CorePlanRepresentation;
	readonly valueRepresentations?: ReadonlyArray<CorePlanRepresentation>;
	readonly argumentRepresentations?: ReadonlyArray<CorePlanRepresentation>;
	readonly constantBooleans?: ReadonlyArray<{
		readonly instruction: CoreInstructionId;
		readonly value: boolean;
	}>;
	readonly target: "native";
	readonly fallback: "canonical-core";
	readonly cost: CorePlanCost;
}

export type CorePlanDeclineReason =
	| CoreTransformDeclineReason
	| "overlap"
	| "stale-anchor"
	| "representation"
	| "target-support";

export interface CoreOptimizationPlanStatistics extends CoreTransformBudgetStatistics {
	readonly admittedFunctions: number;
	readonly discoveredByKind: Readonly<Record<string, number>>;
	readonly selectedByKind: Readonly<Record<string, number>>;
	readonly declinedByPlanReason: Readonly<Record<string, number>>;
	readonly verificationMs: number;
}

/** Immutable target advice. Canonical Core remains complete when every entry is ignored. */
export interface CoreOptimizationPlan {
	readonly version: CorePlanVersionStamp;
	readonly liveFunctions: ReadonlyArray<CoreFunctionId>;
	readonly blockOrders: ReadonlyArray<{
		readonly function: CoreFunctionId;
		readonly blocks: ReadonlyArray<CoreBlockId>;
		readonly omittedBlocks: ReadonlyArray<CoreBlockId>;
	}>;
	readonly directEntries: ReadonlyArray<CoreDirectEntryPlan>;
	readonly unsignedArithmetic?: ReadonlyArray<CoreUnsignedArithmeticPlan>;
	readonly recipes: CoreSpecializationRecipeTable;
	readonly statistics: CoreOptimizationPlanStatistics;
}

declare const VERIFIED_CORE_OPTIMIZATION_PLAN: unique symbol;

export type VerifiedCoreOptimizationPlan = CoreOptimizationPlan & {
	readonly [VERIFIED_CORE_OPTIMIZATION_PLAN]: true;
};

/**
 * Post-allocation form of a Core speculative-region certificate. Core owns the
 * proof; register allocation only replaces SSA and instruction identities with
 * the concrete identities consumed by VM target lowering.
 */
export interface CoreAllocatedRegionEnvelope<
	Kind extends string,
	Representation extends string,
	Materialization extends "none" | "on-demand" | "whole-region",
	Anchors extends ReadonlyArray<CompilerInstruction>,
	Guard = CompilerGuardPlan,
> {
	readonly kind: Kind;
	readonly license: {
		readonly guard: Guard;
		readonly genericTwin: "retained";
		readonly materialization: Materialization;
		/**
		 * Where the license's semantic-epoch dependencies are admitted, and whether
		 * that one admission covers every licensed use. Core owns the proof; a
		 * backend reads the decision instead of rediscovering it from emitted
		 * adjacency. See `core-ir-region-validity.ts`.
		 */
		readonly admission: {
			readonly anchor: CompilerInstruction;
			readonly mode: "capture" | "stable" | "per-use";
		};
	};
	readonly representation: Representation;
	/** Overlay regions may share instructions with an exclusive representation. */
	readonly composition?: "overlay";
	readonly anchors: Anchors;
	readonly claimedInstructions: ReadonlyArray<CompilerInstruction>;
	readonly controlFlow: {
		readonly ordinaryBlocks: ReadonlyArray<number>;
		readonly exceptionalBlocks: ReadonlyArray<number>;
	};
	readonly cost: {
		readonly score: number;
		readonly metadataOperations: number;
	};
}

/**
 * Core's placement decision for a region's ordinary property producer.
 * `call-fallback` licenses a backend to run the load only on the path where the
 * region's fast operation declines; Core owns the proof that the load is
 * unobservable, dead on the fast path, and covered by the call's handler.
 * `in-place` keeps the load exactly where Core scheduled it.
 *
 * A backend must read this field instead of inferring the same choice from the
 * emitted distance between the producer and its call.
 */
export type CorePropertyPlacement = "in-place" | "call-fallback";

/**
 * Core's decision about a builtin identity used by a selected region.
 * `authority-invariant` permits a backend to erase the property identity check;
 * `runtime-guarded` requires the ordinary watched-method lookup and fallback.
 */
export type CoreBuiltinIdentityDecision = "authority-invariant" | "runtime-guarded";

/** Closed String#split projected-result certificate after register allocation. */
export interface CoreAllocatedStringSplitProjectionRegion extends CoreAllocatedRegionEnvelope<
	"string-split-projection",
	"projected-elements",
	"whole-region",
	readonly [
		Extract<CompilerInstruction, { type: "call" | "callBuiltin" }>,
		Extract<CompilerInstruction, { type: "loadProperty" | "loadPropertyStatic" }>,
	]
> {
	/** Ordinary property producer retained by a dynamic-call twin. */
	readonly property?: Extract<CompilerInstruction, { type: "loadPropertyStatic" }>;
	readonly propertyPlacement: CorePropertyPlacement;
	readonly splitIdentity: CoreBuiltinIdentityDecision;
	readonly separator: Extract<CompilerInstruction, { type: "createString" }>;
	readonly separatorStringIndex: number;
	/** Allocated registers for every Core SSA alias licensed as the call result. */
	readonly resultRegisters: ReadonlyArray<number>;
	readonly loads: ReadonlyArray<
		| {
				readonly instruction: Extract<CompilerInstruction, { type: "loadProperty" }>;
				readonly kind: "element";
				readonly index: number;
				readonly key: Extract<CompilerInstruction, { type: "createNumber" }>;
		  }
		| {
				readonly instruction: Extract<
					CompilerInstruction,
					{ type: "loadPropertyStatic" }
				>;
				readonly kind: "length";
		  }
	>;
}

/** Closed RegExp.prototype.exec capture projection after register allocation. */
export interface CoreAllocatedRegExpExecProjectionRegion extends CoreAllocatedRegionEnvelope<
	"regexp-exec-projection",
	"regexp-capture-spans",
	"whole-region",
	readonly [
		Extract<CompilerInstruction, { type: "call" }>,
		Extract<CompilerInstruction, { type: "loadProperty" }>,
	]
> {
	readonly property: Extract<CompilerInstruction, { type: "loadPropertyStatic" }>;
	readonly propertyPlacement: CorePropertyPlacement;
	readonly resultRegisters: ReadonlyArray<number>;
	readonly nullChecks: ReadonlyArray<{
		readonly comparison: Extract<CompilerInstruction, { type: "binary" }>;
		readonly nullValue: Extract<CompilerInstruction, { type: "createNull" }>;
	}>;
	readonly lockedLiteral?: {
		readonly constructorIntrinsic: Extract<
			CompilerInstruction,
			{ type: "loadIntrinsic" }
		>;
		readonly construct: Extract<CompilerInstruction, { type: "construct" }>;
	};
	readonly lastIndexEffect: "retained-call-twin";
	readonly loads: ReadonlyArray<{
		readonly instruction: Extract<CompilerInstruction, { type: "loadProperty" }>;
		readonly key: Extract<CompilerInstruction, { type: "createNumber" }>;
		readonly captureIndex: number;
		readonly consumer?:
			| {
					readonly kind: "length";
					readonly property: Extract<CompilerInstruction, { type: "loadPropertyStatic" }>;
			  }
			| {
					readonly kind: "charCodeAtZero";
					readonly methodIdentity: CoreBuiltinIdentityDecision;
					readonly property: Extract<CompilerInstruction, { type: "loadPropertyStatic" }>;
					readonly call: Extract<CompilerInstruction, { type: "call" }>;
					readonly zero?: Extract<CompilerInstruction, { type: "createNumber" }>;
			  }
			| {
					readonly kind: "number";
					readonly intrinsic: Extract<CompilerInstruction, { type: "loadIntrinsic" }>;
					readonly call: Extract<CompilerInstruction, { type: "call" }>;
			  }
			| {
					readonly kind: "asciiCaseLength";
					readonly methodIdentity: CoreBuiltinIdentityDecision;
					readonly upperProperty: Extract<
						CompilerInstruction,
						{ type: "loadPropertyStatic" }
					>;
					readonly upperCall: Extract<CompilerInstruction, { type: "call" }>;
					readonly lowerProperty: Extract<
						CompilerInstruction,
						{ type: "loadPropertyStatic" }
					>;
					readonly lowerCall: Extract<CompilerInstruction, { type: "call" }>;
					readonly resultMoves: ReadonlyArray<
						Extract<CompilerInstruction, { type: "move" }>
					>;
					readonly lengthProperty: Extract<
						CompilerInstruction,
						{ type: "loadPropertyStatic" }
					>;
			  };
	}>;
}

/** Closed RegExp String Iterator capture projection after register allocation. */
export interface CoreAllocatedRegExpIteratorProjectionRegion extends CoreAllocatedRegionEnvelope<
	"regexp-iterator-projection",
	"regexp-iterator-capture-spans",
	"on-demand",
	readonly [
		Extract<CompilerInstruction, { type: "iteratorStep" }>,
		Extract<CompilerInstruction, { type: "jumpIf" }>,
		Extract<CompilerInstruction, { type: "loadProperty" }>,
	]
> {
	readonly doneBranch: Extract<CompilerInstruction, { type: "jumpIf" }>;
	readonly exitBlock: number;
	readonly resultRegisters: ReadonlyArray<number>;
	readonly statefulEffect: "iterator-last-index-retained-step";
	readonly runtimeGuard: "exact-brand-next-realm-regexp";
	readonly loads: ReadonlyArray<{
		readonly instruction: Extract<CompilerInstruction, { type: "loadProperty" }>;
		readonly key: Extract<CompilerInstruction, { type: "createNumber" }>;
		readonly captureIndex: number;
		readonly numberIntrinsic: Extract<CompilerInstruction, { type: "loadIntrinsic" }>;
		readonly numberCall: Extract<CompilerInstruction, { type: "call" }>;
	}>;
}

/** Closed String.prototype.slice to Number fusion after register allocation. */
export interface CoreAllocatedStringSliceNumberRegion extends CoreAllocatedRegionEnvelope<
	"string-slice-number",
	"primitive-string-span-number",
	"none",
	readonly [
		Extract<CompilerInstruction, { type: "call" }>,
		Extract<CompilerInstruction, { type: "call" }>,
	]
> {
	readonly property: Extract<CompilerInstruction, { type: "loadPropertyStatic" }>;
	readonly propertyPlacement: CorePropertyPlacement;
	/** Covers both the exact slice method and the exact intrinsic Number consumer. */
	readonly builtinIdentities: CoreBuiltinIdentityDecision;
	readonly sliceStartInstruction: Extract<
		CompilerInstruction,
		{ type: "createNumber" | "createF64" }
	>;
	readonly numberIntrinsic: Extract<CompilerInstruction, { type: "loadIntrinsic" }>;
	readonly numberCall: Extract<CompilerInstruction, { type: "call" }>;
	readonly sliceStart: number;
}

export interface CoreAllocatedStringCharCodeAtChainRegion extends CoreAllocatedRegionEnvelope<
	"string-char-code-at-chain",
	"primitive-string-code-unit",
	"none",
	readonly [
		Extract<CompilerInstruction, { type: "loadPropertyStatic" }>,
		Extract<CompilerInstruction, { type: "call" }>,
	]
> {
	readonly property: Extract<CompilerInstruction, { type: "loadPropertyStatic" }>;
	readonly call: Extract<CompilerInstruction, { type: "call" }>;
	readonly methodIdentity: CoreBuiltinIdentityDecision;
	readonly runtimeGuard: "primitive-string-number-position";
	readonly evaluationOrder: "capture-property-before-arguments";
}

export type CoreCollectionBuiltinOperation =
	| "Map.prototype.get"
	| "Map.prototype.set"
	| "Map.prototype.has"
	| "Map.prototype.delete"
	| "Set.prototype.add"
	| "Set.prototype.has"
	| "Set.prototype.delete";

export interface CoreAllocatedBuiltinCollectionCallChainRegion extends CoreAllocatedRegionEnvelope<
	"builtin-collection-call-chain",
	"captured-collection-method",
	"none",
	readonly [
		Extract<CompilerInstruction, { type: "loadPropertyStatic" }>,
		Extract<CompilerInstruction, { type: "call" }>,
	]
> {
	readonly property: Extract<CompilerInstruction, { type: "loadPropertyStatic" }>;
	readonly call: Extract<CompilerInstruction, { type: "call" }>;
	readonly operation: CoreCollectionBuiltinOperation;
	readonly runtimeGuard: "exact-collection-method";
	readonly evaluationOrder: "capture-property-before-arguments";
}

type CoreAllocatedIteratorCursorRegion<
	Kind extends
		| "array-values-iterator-cursor"
		| "string-iterator-cursor"
		| "typed-array-iterator-cursor"
		| "map-iterator-cursor"
		| "set-iterator-cursor",
	Representation extends string,
	Protocol extends "array-values" | "string" | "typed-array-values" | "map" | "set",
> = CoreAllocatedRegionEnvelope<
	Kind,
	Representation,
	"none",
	readonly [
		Extract<CompilerInstruction, { type: "getIterator" }>,
		Extract<CompilerInstruction, { type: "iteratorStep" }>,
	],
	"structural"
> & {
	readonly initialize: Extract<CompilerInstruction, { type: "getIterator" }>;
	readonly steps: ReadonlyArray<Extract<CompilerInstruction, { type: "iteratorStep" }>>;
	readonly protocol: Protocol;
	readonly runtimeGuard: "exact-iterator-brand-next-target";
	readonly stateSynchronization: "authoritative-language-object";
	readonly suspension: "forbidden";
};

export type CoreAllocatedArrayValuesIteratorCursorRegion =
	CoreAllocatedIteratorCursorRegion<
		"array-values-iterator-cursor",
		"array-values-authoritative-cursor",
		"array-values"
	>;

export type CoreAllocatedStringIteratorCursorRegion = CoreAllocatedIteratorCursorRegion<
	"string-iterator-cursor",
	"string-authoritative-cursor",
	"string"
>;

export type CoreAllocatedTypedArrayIteratorCursorRegion =
	CoreAllocatedIteratorCursorRegion<
		"typed-array-iterator-cursor",
		"typed-array-authoritative-cursor",
		"typed-array-values"
	>;

export type CoreAllocatedMapIteratorCursorRegion = CoreAllocatedIteratorCursorRegion<
	"map-iterator-cursor",
	"map-authoritative-cursor",
	"map"
>;

export type CoreAllocatedSetIteratorCursorRegion = CoreAllocatedIteratorCursorRegion<
	"set-iterator-cursor",
	"set-authoritative-cursor",
	"set"
>;

export interface CoreAllocatedIteratorResultVirtualizationRegion extends CoreAllocatedRegionEnvelope<
	"iterator-result-virtualization",
	"virtual-iterator-result",
	"on-demand",
	readonly [Extract<CompilerInstruction, { type: "iteratorStep" }>]
> {
	readonly composition: "overlay";
	readonly steps: ReadonlyArray<Extract<CompilerInstruction, { type: "iteratorStep" }>>;
	readonly runtimeGuard: "exact-builtin-iterator-next";
	readonly correspondence: "done-value-observation";
	readonly fallback: "materialize-result-then-observe";
}

export interface CoreAllocatedIteratorEntryPairVirtualizationRegion extends CoreAllocatedRegionEnvelope<
	"iterator-entry-pair-virtualization",
	"virtual-iterator-entry-pair",
	"on-demand",
	readonly [
		Extract<CompilerInstruction, { type: "iteratorStep" }>,
		Extract<CompilerInstruction, { type: "getIterator" }>,
	]
> {
	readonly composition: "overlay";
	readonly cursorInitialize: Extract<CompilerInstruction, { type: "getIterator" }>;
	readonly outerStep: Extract<CompilerInstruction, { type: "iteratorStep" }>;
	readonly innerInitialize: Extract<CompilerInstruction, { type: "getIterator" }>;
	readonly innerSteps: readonly [
		Extract<CompilerInstruction, { type: "iteratorStep" }>,
		Extract<CompilerInstruction, { type: "iteratorStep" }>,
	];
	readonly innerCloses: ReadonlyArray<
		Extract<CompilerInstruction, { type: "iteratorClose" }>
	>;
	readonly runtimeGuard: "exact-map-or-set-entry-cursor";
	readonly correspondence: "entry-pair-elements";
	readonly stateSynchronization: "authoritative-language-object";
	readonly fallback: "materialize-entry-pair-then-iterate";
}

/** Closed indexed String#split consumer loop after register allocation. */
export interface CoreAllocatedStringSplitCursorRegion extends CoreAllocatedRegionEnvelope<
	"string-split-cursor",
	"split-cursor-spans",
	"on-demand",
	readonly [
		Extract<CompilerInstruction, { type: "call" | "callBuiltin" }>,
		Extract<CompilerInstruction, { type: "jumpIf" }>,
		Extract<CompilerInstruction, { type: "loadPropertyStatic" }>,
		Extract<CompilerInstruction, { type: "jump" }>,
	]
> {
	/** Ordinary property producer retained by a dynamic-call twin. */
	readonly property?: Extract<CompilerInstruction, { type: "loadPropertyStatic" }>;
	readonly propertyPlacement: CorePropertyPlacement;
	readonly splitIdentity: CoreBuiltinIdentityDecision;
	readonly trimIdentity: CoreBuiltinIdentityDecision;
	readonly compare: Extract<CompilerInstruction, { type: "binary" }>;
	readonly element: Extract<CompilerInstruction, { type: "loadProperty" }>;
	readonly trimProperty: Extract<CompilerInstruction, { type: "loadPropertyStatic" }>;
	readonly trimCall: Extract<CompilerInstruction, { type: "call" }>;
	readonly advance?: Extract<CompilerInstruction, { type: "unary" }>;
	readonly increment: Extract<CompilerInstruction, { type: "unary" }>;
	readonly resultRegisters: ReadonlyArray<number>;
	readonly primitiveStringLengths: ReadonlyArray<
		Extract<CompilerInstruction, { type: "loadPropertyStatic" }>
	>;
	readonly exitBlock: number;
}

/** Structural one-use binary pair after register allocation. */
export interface CoreAllocatedNumericFusionRegion extends CoreAllocatedRegionEnvelope<
	"numeric-fusion",
	"binary-pairs-f64",
	"none",
	readonly [
		Extract<CompilerInstruction, { type: "binary" }>,
		Extract<CompilerInstruction, { type: "binary" }>,
	],
	"structural"
> {
	readonly composition: "overlay";
	readonly runtimeGuard: "number-operands";
	readonly pairs: ReadonlyArray<{
		readonly first: Extract<CompilerInstruction, { type: "binary" }>;
		readonly finish: Extract<CompilerInstruction, { type: "binary" }>;
		readonly firstUsePosition: 1 | 2;
	}>;
}

export interface CoreAllocatedIndexedLengthLoopRegion extends CoreAllocatedRegionEnvelope<
	"indexed-length-loop",
	"live-indexed-length-loops",
	"none",
	ReadonlyArray<CompilerInstruction>,
	"structural"
> {
	readonly runtimeGuard: "array-or-numeric-typed-array";
	readonly sites: ReadonlyArray<{
		readonly load: Extract<CompilerInstruction, { type: "loadPropertyStatic" }>;
		readonly comparison: Extract<CompilerInstruction, { type: "binary" }>;
		readonly lengthPosition: 1 | 2;
		readonly elements: ReadonlyArray<{
			readonly instruction: Extract<
				CompilerInstruction,
				{ type: "loadProperty" | "storeProperty" }
			>;
			readonly kind: "load" | "store";
		}>;
	}>;
}

/** Fixed-shape stack-object table after register allocation. */
export interface CoreAllocatedStackObjectPlanRegion extends CoreAllocatedRegionEnvelope<
	"stack-object-plan",
	"activation-local-fixed-shape-objects",
	"none" | "on-demand",
	readonly [Extract<CompilerInstruction, { type: "createObject" | "createObjectShaped" }>]
> {
	readonly sites: ReadonlyArray<{
		readonly mode: "elided" | "activation-local";
		readonly allocation: Extract<
			CompilerInstruction,
			{ type: "createObject" | "createObjectShaped" }
		>;
		readonly slotCount: number;
		readonly accesses: ReadonlyArray<{
			readonly instruction: Extract<
				CompilerInstruction,
				{
					type:
						| "loadProperty"
						| "loadPropertyStatic"
						| "storeProperty"
						| "storePropertyStatic";
				}
			>;
			readonly slot: number;
		}>;
		readonly inheritedAccess?: Extract<
			CompilerInstruction,
			{ type: "loadProperty" | "loadPropertyStatic" }
		>;
		readonly materializations: ReadonlyArray<{
			readonly instruction: Extract<CompilerInstruction, { type: "return" }>;
			readonly kind: "return";
		}>;
	}>;
}

/** Tagged post-allocation Core proof table consumed only by VM target lowering. */
export type CoreAllocatedRegion =
	| CoreAllocatedIndexedLengthLoopRegion
	| CoreAllocatedArrayValuesIteratorCursorRegion
	| CoreAllocatedBuiltinCollectionCallChainRegion
	| CoreAllocatedIteratorEntryPairVirtualizationRegion
	| CoreAllocatedIteratorResultVirtualizationRegion
	| CoreAllocatedMapIteratorCursorRegion
	| CoreAllocatedNumericFusionRegion
	| CoreAllocatedRegExpExecProjectionRegion
	| CoreAllocatedRegExpIteratorProjectionRegion
	| CoreAllocatedStackObjectPlanRegion
	| CoreAllocatedStringCharCodeAtChainRegion
	| CoreAllocatedStringIteratorCursorRegion
	| CoreAllocatedStringSliceNumberRegion
	| CoreAllocatedStringSplitProjectionRegion
	| CoreAllocatedStringSplitCursorRegion
	| CoreAllocatedSetIteratorCursorRegion
	| CoreAllocatedTypedArrayIteratorCursorRegion;
