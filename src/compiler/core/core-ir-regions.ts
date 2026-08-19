import type { CompilerGuardPlan } from "../shared/compiler-facts.ts";
import type { CompilerInstruction } from "../shared/compiler-instruction.ts";

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
	readonly separatorStringIndex: number;
	/** Allocated registers for every Core SSA alias licensed as the call result. */
	readonly resultRegisters: ReadonlyArray<number>;
	readonly loads: ReadonlyArray<
		| {
				readonly instruction: Extract<CompilerInstruction, { type: "loadProperty" }>;
				readonly kind: "element";
				readonly index: number;
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
	readonly sliceStartInstruction: Extract<
		CompilerInstruction,
		{ type: "createNumber" | "createF64" }
	>;
	readonly numberIntrinsic: Extract<CompilerInstruction, { type: "loadIntrinsic" }>;
	readonly numberCall: Extract<CompilerInstruction, { type: "call" }>;
	readonly sliceStart: number;
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
	readonly compare: Extract<CompilerInstruction, { type: "binary" }>;
	readonly element: Extract<CompilerInstruction, { type: "loadProperty" }>;
	readonly trimProperty: Extract<CompilerInstruction, { type: "loadPropertyStatic" }>;
	readonly trimCall: Extract<CompilerInstruction, { type: "call" }>;
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

/** Fixed-shape stack-object table after register allocation. */
export interface CoreAllocatedStackObjectPlanRegion extends CoreAllocatedRegionEnvelope<
	"stack-object-plan",
	"activation-local-fixed-shape-objects",
	"none" | "on-demand",
	readonly [Extract<CompilerInstruction, { type: "createObject" | "createObjectShaped" }>]
> {
	readonly sites: ReadonlyArray<{
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
	| CoreAllocatedNumericFusionRegion
	| CoreAllocatedRegExpExecProjectionRegion
	| CoreAllocatedRegExpIteratorProjectionRegion
	| CoreAllocatedStackObjectPlanRegion
	| CoreAllocatedStringSliceNumberRegion
	| CoreAllocatedStringSplitProjectionRegion
	| CoreAllocatedStringSplitCursorRegion;
