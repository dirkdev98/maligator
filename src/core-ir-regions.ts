import type { CompilerGuardPlan } from "./compiler-facts.ts";
import type { RegisterInstruction } from "./semantic-lowering.ts";

/**
 * Post-allocation form of a Core speculative-region certificate. Core owns the
 * proof; register allocation only replaces SSA and instruction identities with
 * the concrete identities consumed by VM target lowering.
 */
export interface CoreAllocatedRegionEnvelope<
	Kind extends string,
	Representation extends string,
	Materialization extends "none" | "on-demand" | "whole-region",
	Anchors extends ReadonlyArray<RegisterInstruction>,
	Guard = CompilerGuardPlan,
> {
	readonly kind: Kind;
	readonly license: {
		readonly guard: Guard;
		readonly genericTwin: "retained";
		readonly materialization: Materialization;
	};
	readonly representation: Representation;
	/** Overlay regions may share instructions with an exclusive representation. */
	readonly composition?: "overlay";
	readonly anchors: Anchors;
	readonly claimedInstructions: ReadonlyArray<RegisterInstruction>;
	readonly controlFlow: {
		readonly ordinaryBlocks: ReadonlyArray<number>;
		readonly exceptionalBlocks: ReadonlyArray<number>;
	};
	readonly cost: {
		readonly score: number;
		readonly metadataOperations: number;
	};
}

/** Closed String#split projected-result certificate after register allocation. */
export interface CoreAllocatedStringSplitProjectionRegion extends CoreAllocatedRegionEnvelope<
	"string-split-projection",
	"projected-elements",
	"whole-region",
	readonly [
		Extract<RegisterInstruction, { type: "call" | "callBuiltin" }>,
		Extract<RegisterInstruction, { type: "loadProperty" | "loadPropertyStatic" }>,
	]
> {
	/** Ordinary property producer retained by a dynamic-call twin. */
	readonly property?: Extract<RegisterInstruction, { type: "loadPropertyStatic" }>;
	readonly separatorStringIndex: number;
	/** Allocated registers for every Core SSA alias licensed as the call result. */
	readonly resultRegisters: ReadonlyArray<number>;
	readonly loads: ReadonlyArray<
		| {
				readonly instruction: Extract<RegisterInstruction, { type: "loadProperty" }>;
				readonly kind: "element";
				readonly index: number;
		  }
		| {
				readonly instruction: Extract<
					RegisterInstruction,
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
		Extract<RegisterInstruction, { type: "call" }>,
		Extract<RegisterInstruction, { type: "loadProperty" }>,
	]
> {
	readonly property: Extract<RegisterInstruction, { type: "loadPropertyStatic" }>;
	readonly resultRegisters: ReadonlyArray<number>;
	readonly nullChecks: ReadonlyArray<{
		readonly comparison: Extract<RegisterInstruction, { type: "binary" }>;
		readonly nullValue: Extract<RegisterInstruction, { type: "createNull" }>;
	}>;
	readonly lockedLiteral?: {
		readonly constructorIntrinsic: Extract<
			RegisterInstruction,
			{ type: "loadIntrinsic" }
		>;
		readonly construct: Extract<RegisterInstruction, { type: "construct" }>;
	};
	readonly lastIndexEffect: "retained-call-twin";
	readonly loads: ReadonlyArray<{
		readonly instruction: Extract<RegisterInstruction, { type: "loadProperty" }>;
		readonly key: Extract<RegisterInstruction, { type: "createNumber" }>;
		readonly captureIndex: number;
		readonly consumer?:
			| {
					readonly kind: "length";
					readonly property: Extract<RegisterInstruction, { type: "loadPropertyStatic" }>;
			  }
			| {
					readonly kind: "charCodeAtZero";
					readonly property: Extract<RegisterInstruction, { type: "loadPropertyStatic" }>;
					readonly call: Extract<RegisterInstruction, { type: "call" }>;
					readonly zero?: Extract<RegisterInstruction, { type: "createNumber" }>;
			  }
			| {
					readonly kind: "number";
					readonly intrinsic: Extract<RegisterInstruction, { type: "loadIntrinsic" }>;
					readonly call: Extract<RegisterInstruction, { type: "call" }>;
			  }
			| {
					readonly kind: "asciiCaseLength";
					readonly upperProperty: Extract<
						RegisterInstruction,
						{ type: "loadPropertyStatic" }
					>;
					readonly upperCall: Extract<RegisterInstruction, { type: "call" }>;
					readonly lowerProperty: Extract<
						RegisterInstruction,
						{ type: "loadPropertyStatic" }
					>;
					readonly lowerCall: Extract<RegisterInstruction, { type: "call" }>;
					readonly resultMoves: ReadonlyArray<
						Extract<RegisterInstruction, { type: "move" }>
					>;
					readonly lengthProperty: Extract<
						RegisterInstruction,
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
		Extract<RegisterInstruction, { type: "iteratorStep" }>,
		Extract<RegisterInstruction, { type: "jumpIf" }>,
		Extract<RegisterInstruction, { type: "loadProperty" }>,
	]
> {
	readonly doneBranch: Extract<RegisterInstruction, { type: "jumpIf" }>;
	readonly exitBlock: number;
	readonly resultRegisters: ReadonlyArray<number>;
	readonly statefulEffect: "iterator-last-index-retained-step";
	readonly runtimeGuard: "exact-brand-next-realm-regexp";
	readonly loads: ReadonlyArray<{
		readonly instruction: Extract<RegisterInstruction, { type: "loadProperty" }>;
		readonly key: Extract<RegisterInstruction, { type: "createNumber" }>;
		readonly captureIndex: number;
		readonly numberIntrinsic: Extract<RegisterInstruction, { type: "loadIntrinsic" }>;
		readonly numberCall: Extract<RegisterInstruction, { type: "call" }>;
	}>;
}

/** Closed String.prototype.slice to Number fusion after register allocation. */
export interface CoreAllocatedStringSliceNumberRegion extends CoreAllocatedRegionEnvelope<
	"string-slice-number",
	"primitive-string-span-number",
	"none",
	readonly [
		Extract<RegisterInstruction, { type: "call" }>,
		Extract<RegisterInstruction, { type: "call" }>,
	]
> {
	readonly property: Extract<RegisterInstruction, { type: "loadPropertyStatic" }>;
	readonly sliceStartInstruction: Extract<
		RegisterInstruction,
		{ type: "createNumber" | "createF64" }
	>;
	readonly numberIntrinsic: Extract<RegisterInstruction, { type: "loadIntrinsic" }>;
	readonly numberCall: Extract<RegisterInstruction, { type: "call" }>;
	readonly sliceStart: number;
}

/** Closed indexed String#split consumer loop after register allocation. */
export interface CoreAllocatedStringSplitCursorRegion extends CoreAllocatedRegionEnvelope<
	"string-split-cursor",
	"split-cursor-spans",
	"on-demand",
	readonly [
		Extract<RegisterInstruction, { type: "call" | "callBuiltin" }>,
		Extract<RegisterInstruction, { type: "jumpIf" }>,
		Extract<RegisterInstruction, { type: "loadPropertyStatic" }>,
		Extract<RegisterInstruction, { type: "jump" }>,
	]
> {
	/** Ordinary property producer retained by a dynamic-call twin. */
	readonly property?: Extract<RegisterInstruction, { type: "loadPropertyStatic" }>;
	readonly compare: Extract<RegisterInstruction, { type: "binary" }>;
	readonly element: Extract<RegisterInstruction, { type: "loadProperty" }>;
	readonly trimProperty: Extract<RegisterInstruction, { type: "loadPropertyStatic" }>;
	readonly trimCall: Extract<RegisterInstruction, { type: "call" }>;
	readonly increment: Extract<RegisterInstruction, { type: "unary" }>;
	readonly resultRegisters: ReadonlyArray<number>;
	readonly primitiveStringLengths: ReadonlyArray<
		Extract<RegisterInstruction, { type: "loadPropertyStatic" }>
	>;
	readonly exitBlock: number;
}

/** Structural one-use binary pair after register allocation. */
export interface CoreAllocatedNumericFusionRegion extends CoreAllocatedRegionEnvelope<
	"numeric-fusion",
	"binary-pairs-f64",
	"none",
	readonly [
		Extract<RegisterInstruction, { type: "binary" }>,
		Extract<RegisterInstruction, { type: "binary" }>,
	],
	"structural"
> {
	readonly composition: "overlay";
	readonly runtimeGuard: "number-operands";
	readonly pairs: ReadonlyArray<{
		readonly first: Extract<RegisterInstruction, { type: "binary" }>;
		readonly finish: Extract<RegisterInstruction, { type: "binary" }>;
		readonly firstUsePosition: 1 | 2;
	}>;
}

/** Fixed-shape stack-object table after register allocation. */
export interface CoreAllocatedStackObjectPlanRegion extends CoreAllocatedRegionEnvelope<
	"stack-object-plan",
	"activation-local-fixed-shape-objects",
	"none" | "on-demand",
	readonly [Extract<RegisterInstruction, { type: "createObject" | "createObjectShaped" }>]
> {
	readonly sites: ReadonlyArray<{
		readonly allocation: Extract<
			RegisterInstruction,
			{ type: "createObject" | "createObjectShaped" }
		>;
		readonly slotCount: number;
		readonly accesses: ReadonlyArray<{
			readonly instruction: Extract<
				RegisterInstruction,
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
			RegisterInstruction,
			{ type: "loadProperty" | "loadPropertyStatic" }
		>;
		readonly materializations: ReadonlyArray<{
			readonly instruction: Extract<RegisterInstruction, { type: "return" }>;
			readonly kind: "return";
		}>;
	}>;
}

/** Tagged post-allocation Core proof table consumed only by VM target lowering. */
export type CoreAllocatedRegion =
	| CoreAllocatedNumericFusionRegion
	| CoreAllocatedRegExpExecProjectionRegion
	| CoreAllocatedRegExpIteratorProjectionRegion
	| CoreAllocatedStackObjectPlanRegion
	| CoreAllocatedStringSliceNumberRegion
	| CoreAllocatedStringSplitProjectionRegion
	| CoreAllocatedStringSplitCursorRegion;
