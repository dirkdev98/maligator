import {
	builtinOperationDescriptor,
	directBuiltinOperationIds,
} from "./builtin-registry.ts";
import type { DirectBuiltinOperationId } from "./builtin-registry.ts";
import type { OptimizationPassDelta } from "./compiler-diagnostics.ts";
import { compilerGuardPlan, knownBuiltinCallProves } from "./compiler-facts.ts";
import type { CompilerGuardPlan, EffectKind } from "./compiler-facts.ts";
import type {
	IntermediateProgram,
	IRFunction,
	IRImmediateValue,
	IRInstruction,
	IRNumericHofPlanOperation,
	IRRegion,
} from "./ir.ts";
import { computeSafepointRoots } from "./liveness.ts";
import { buildProfileMetadata } from "./profile-metadata.ts";
import type { CompilerRemark, ProfileSite } from "./profile-metadata.ts";
import type { Binding } from "./semantic-analysis.ts";

type IRBinaryOperator = Extract<IRInstruction, { type: "binary" }>["operator"];
type IRUnaryOperator = Extract<IRInstruction, { type: "unary" }>["operator"];
type IRIntrinsic = Extract<IRInstruction, { type: "loadIntrinsic" }>["intrinsic"];
type IRTypeofResult = Extract<IRInstruction, { type: "typeofCompare" }>["expected"];

const VM_VALUE_UNDEFINED = -1;
const VM_VALUE_NULL = -2;
const VM_VALUE_FALSE = -3;
const VM_VALUE_TRUE = -4;
const VM_VALUE_STRING_BASE = -5;
const VM_VALUE_MAX_PAYLOAD = 0x0fff_ffff;
const VM_VALUE_STRING_MIN = VM_VALUE_STRING_BASE - VM_VALUE_MAX_PAYLOAD;
const VM_VALUE_I28_BASE = -0x2000_0000;
const VM_VALUE_I28_MIN = VM_VALUE_I28_BASE - VM_VALUE_MAX_PAYLOAD;

export type DecodedVmValueOperand =
	| { kind: "register"; register: number }
	| { kind: "undefined" }
	| { kind: "null" }
	| { kind: "boolean"; value: boolean }
	| { kind: "number"; value: number }
	| { kind: "string"; index: number };

export function encodeVmValueOperand(
	register: number,
	value: IRImmediateValue | undefined,
): number {
	if (value === undefined) return register;
	switch (value.kind) {
		case "undefined":
			return VM_VALUE_UNDEFINED;
		case "null":
			return VM_VALUE_NULL;
		case "boolean":
			return value.value ? VM_VALUE_TRUE : VM_VALUE_FALSE;
		case "string":
			return VM_VALUE_STRING_BASE - value.index;
		case "number": {
			const zigzag = value.value >= 0 ? value.value * 2 : -value.value * 2 - 1;
			return VM_VALUE_I28_BASE - zigzag;
		}
	}
}

export function decodeVmValueOperand(operand: number): DecodedVmValueOperand {
	if (operand >= 0) return { kind: "register", register: operand };
	switch (operand) {
		case VM_VALUE_UNDEFINED:
			return { kind: "undefined" };
		case VM_VALUE_NULL:
			return { kind: "null" };
		case VM_VALUE_FALSE:
			return { kind: "boolean", value: false };
		case VM_VALUE_TRUE:
			return { kind: "boolean", value: true };
	}
	if (operand <= VM_VALUE_STRING_BASE && operand >= VM_VALUE_STRING_MIN) {
		return { kind: "string", index: VM_VALUE_STRING_BASE - operand };
	}
	if (operand <= VM_VALUE_I28_BASE && operand >= VM_VALUE_I28_MIN) {
		const payload = VM_VALUE_I28_BASE - operand;
		return {
			kind: "number",
			value: payload % 2 === 0 ? payload / 2 : -(payload + 1) / 2,
		};
	}
	throw new Error(`Invalid VM value operand ${operand}`);
}

export function rebaseVmValueOperand(operand: number, stringBase: number): number {
	const decoded = decodeVmValueOperand(operand);
	return decoded.kind === "string"
		? VM_VALUE_STRING_BASE - (decoded.index + stringBase)
		: operand;
}

export const VM_GUARDED_BUILTIN_OPERATIONS = [
	"Array.prototype.push",
	"String.prototype.charCodeAt",
	"String.prototype.slice",
	"String.prototype.split",
	"String.prototype.trim",
	"Map.prototype.get",
	"Map.prototype.set",
	"Set.prototype.add",
	"Math.abs",
	"Math.floor",
	"Math.ceil",
	"Math.round",
	"Math.trunc",
	"Math.sqrt",
	"Math.cbrt",
	"Math.sign",
	"Math.log",
	"Math.log2",
	"Math.log10",
	"Math.exp",
	"Math.sin",
	"Math.cos",
	"Math.tan",
	"Math.asin",
	"Math.acos",
	"Math.atan",
	"Math.sinh",
	"Math.cosh",
	"Math.tanh",
	"Math.asinh",
	"Math.acosh",
	"Math.atanh",
	"Math.log1p",
	"Math.expm1",
	"Math.fround",
	"Math.min",
	"Math.max",
	"RegExp.prototype.exec",
	"Array.prototype.forEach",
	"Array.prototype.some",
	"Array.prototype.every",
	"Array.prototype.find",
	"Array.prototype.findIndex",
	"Array.prototype.map",
	"Array.prototype.filter",
	"Array.prototype.reduce",
	"Array.prototype.reduceRight",
	"Array.prototype.findLast",
	"Array.prototype.findLastIndex",
	"Array.prototype.flatMap",
] as const;

/** No-fallback numeric Math operation order used by VM instructions and MALW. */
export const VM_MATH_UNARY_NUMBER_OPERATIONS = [
	"Math.abs",
	"Math.floor",
	"Math.ceil",
	"Math.round",
	"Math.trunc",
	"Math.sqrt",
	"Math.cbrt",
	"Math.sign",
	"Math.log",
	"Math.log2",
	"Math.log10",
	"Math.exp",
	"Math.sin",
	"Math.cos",
	"Math.tan",
	"Math.asin",
	"Math.acos",
	"Math.atan",
	"Math.sinh",
	"Math.cosh",
	"Math.tanh",
	"Math.asinh",
	"Math.acosh",
	"Math.atanh",
	"Math.log1p",
	"Math.expm1",
	"Math.fround",
] as const;

export const VM_MATH_BINARY_NUMBER_OPERATIONS = ["Math.min", "Math.max"] as const;

/** Exact builtin calls whose dynamic property/callback seam was erased in IR. */
export const VM_DIRECT_BUILTIN_OPERATIONS = directBuiltinOperationIds;

type VmMathUnaryNumberOperation = (typeof VM_MATH_UNARY_NUMBER_OPERATIONS)[number];
type VmMathBinaryNumberOperation = (typeof VM_MATH_BINARY_NUMBER_OPERATIONS)[number];
type VmDirectBuiltinOperation = DirectBuiltinOperationId;

function vmMathUnaryNumberOperation(operation: string): VmMathUnaryNumberOperation {
	if ((VM_MATH_UNARY_NUMBER_OPERATIONS as ReadonlyArray<string>).includes(operation)) {
		return operation as VmMathUnaryNumberOperation;
	}
	throw new Error(`Unknown unary numeric Math operation ${operation}`);
}

function vmMathBinaryNumberOperation(operation: string): VmMathBinaryNumberOperation {
	if ((VM_MATH_BINARY_NUMBER_OPERATIONS as ReadonlyArray<string>).includes(operation)) {
		return operation as VmMathBinaryNumberOperation;
	}
	throw new Error(`Unknown binary numeric Math operation ${operation}`);
}

function vmDirectBuiltinOperation(operation: string): VmDirectBuiltinOperation {
	if ((VM_DIRECT_BUILTIN_OPERATIONS as ReadonlyArray<string>).includes(operation)) {
		return operation as VmDirectBuiltinOperation;
	}
	throw new Error(`Unknown direct builtin operation ${operation}`);
}

export type VmGuardedBuiltinOperation = (typeof VM_GUARDED_BUILTIN_OPERATIONS)[number];

function isVmGuardedBuiltinOperation(
	operation: string,
): operation is VmGuardedBuiltinOperation {
	return (VM_GUARDED_BUILTIN_OPERATIONS as ReadonlyArray<string>).includes(operation);
}

export type VmSemanticDependency =
	| { readonly kind: "world"; readonly fact: "primordials.locked" }
	| {
			readonly kind: "epoch";
			readonly family:
				| "primitive-methods"
				| "watched-methods"
				| "array-elements"
				| "global-bindings"
				| "object-shapes";
	  };

export type VmGuardObligation = "fallback" | "materialize";

/** Backend-neutral proof contract retained across frontend-cache serialization. */
export interface VmGuardPlan {
	readonly dependencies: ReadonlyArray<VmSemanticDependency>;
	readonly obligations: ReadonlyArray<VmGuardObligation>;
}

/**
 * Complete backend contract for a speculative region. The ordinary VM
 * instructions are always the semantic twin; `materialization` says how a
 * virtual value becomes observable when either the license or a local guard
 * fails. Keeping this beside the named dependencies prevents individual
 * emitters from silently inventing a guard-only fast path with no deopt plan.
 */
export interface VmRegionLicense {
	readonly guard: VmGuardPlan;
	readonly genericTwin: "retained";
	readonly materialization: "none" | "on-demand" | "whole-region";
}

export type VmRuntimeSemanticEpochFamily =
	| "primitive-methods"
	| "watched-methods"
	| "array-elements";

/** Program-level semantic facts available to analyses that run after wire loading. */
export interface VmSemanticProtectorFact {
	readonly family: VmRuntimeSemanticEpochFamily;
	readonly guard: VmGuardPlan;
}

/**
 * Resolve one program semantic fact through the same validation contract for
 * every post-wire analysis and backend. Program facts are canonical: a family
 * occurs at most once, names either its matching mutable epoch or the locked
 * primordial world, and always retains the generic operation as its twin.
 *
 * Keeping this query beside the VM fact representation prevents consumers from
 * acquiring subtly different definitions of a valid protector fact.
 */
export function vmSemanticProtectorGuard(
	facts: ReadonlyArray<VmSemanticProtectorFact> | undefined,
	family: VmRuntimeSemanticEpochFamily,
): VmGuardPlan | undefined {
	let result: VmGuardPlan | undefined;
	for (const fact of facts ?? []) {
		if (fact.family !== family) continue;
		if (result !== undefined) throw new Error(`Duplicate ${family} semantic facts`);
		result = fact.guard;
	}
	if (result === undefined) return undefined;
	const dependency = result.dependencies[0];
	if (
		result.dependencies.length !== 1 ||
		dependency === undefined ||
		(dependency.kind === "world"
			? dependency.fact !== "primordials.locked"
			: dependency.family !== family)
	) {
		throw new Error(`${family} semantic fact has a mismatched dependency`);
	}
	if (result.obligations.length !== 1 || result.obligations[0] !== "fallback") {
		throw new Error(`${family} semantic fact lacks its generic twin`);
	}
	return result;
}

function vmSemanticDependencyKey(dependency: VmSemanticDependency): string {
	return dependency.kind === "world"
		? `world:${dependency.fact}`
		: `epoch:${dependency.family}`;
}

/** Merge site facts into one region-sized license without losing obligations. */
export function vmRegionLicense(
	guards: ReadonlyArray<VmGuardPlan | undefined>,
	materialization: VmRegionLicense["materialization"],
): VmRegionLicense | undefined {
	const dependencies = new Map<string, VmSemanticDependency>();
	const obligations = new Set<VmGuardObligation>();
	for (const guard of guards) {
		if (guard === undefined) return undefined;
		for (const dependency of guard.dependencies) {
			dependencies.set(vmSemanticDependencyKey(dependency), dependency);
		}
		for (const obligation of guard.obligations) obligations.add(obligation);
	}
	if (dependencies.size === 0 || !obligations.has("fallback")) return undefined;
	if (materialization !== "none") obligations.add("materialize");
	return {
		guard: {
			dependencies: [...dependencies.entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([, dependency]) => dependency),
			obligations: [...obligations].sort(),
		},
		genericTwin: "retained",
		materialization,
	};
}

export function vmGuardIsWorldInvariant(guard: VmGuardPlan): boolean {
	return (
		guard.dependencies.length > 0 &&
		guard.dependencies.every((dependency) => dependency.kind === "world")
	);
}

interface VmRegionEnvelope<
	Kind extends string,
	Representation extends string,
	Materialization extends VmRegionLicense["materialization"],
> {
	readonly kind: Kind;
	readonly license: VmRegionLicense & { readonly materialization: Materialization };
	readonly representation: Representation;
	/** Overlay regions may share instruction IPs with an exclusive representation. */
	readonly composition?: "overlay";
	readonly anchors: ReadonlyArray<number>;
	readonly claimedIps: ReadonlyArray<number>;
	readonly controlFlow: {
		readonly ordinaryBlockIps: ReadonlyArray<number>;
		readonly exceptionalHandlerIps: ReadonlyArray<number>;
	};
	readonly cost: {
		readonly score: number;
		readonly metadataOperations: number;
	};
}

export type VmClosedRecordArrayRegion = VmRegionEnvelope<
	"closed-record-array",
	"dense-record-elements-known-slots",
	"none"
> & {
	readonly length: number;
	readonly elementLoadIps: ReadonlyArray<number>;
	readonly accesses: ReadonlyArray<{
		readonly ip: number;
		readonly kind: "load" | "store";
		readonly slot: number;
	}>;
};

export type VmStringSplitCursorRegion = VmRegionEnvelope<
	"string-split-cursor",
	"split-cursor-spans",
	"on-demand"
> & {
	readonly propertyIp: number;
	readonly callee: number;
	readonly receiver: number;
	readonly separator: number;
	readonly result: number;
	readonly index: number;
	readonly elementIp: number;
	readonly trimPropertyIp: number;
	readonly trimIcIndex: number;
	readonly trimCallIp: number;
	readonly primitiveStringLengthIps: ReadonlyArray<number>;
	readonly exitIp: number;
};

export type VmStringSplitProjectionRegion = VmRegionEnvelope<
	"string-split-projection",
	"projected-elements",
	"whole-region"
> & {
	readonly propertyIp: number;
	readonly callIp: number;
	readonly callee: number;
	readonly receiver: number;
	readonly separatorStringIndex: number;
	readonly result: number;
	readonly aliasMoveIps: ReadonlyArray<number>;
	readonly loads: ReadonlyArray<{
		readonly ip: number;
		readonly kind: "element" | "length";
		readonly index?: number;
		readonly dst: number;
	}>;
};

export type VmRegExpExecProjectionRegion = VmRegionEnvelope<
	"regexp-exec-projection",
	"regexp-capture-spans",
	"whole-region"
> & {
	readonly propertyIp: number;
	readonly callIp: number;
	readonly lockedFreshLiteral: boolean;
	readonly lockedLiteral?: {
		readonly constructorIntrinsicIp: number;
		readonly constructIp: number;
	};
	readonly callee: number;
	readonly receiver: number;
	readonly input: number;
	readonly result: number;
	readonly aliasMoveIps: ReadonlyArray<number>;
	readonly nullChecks: ReadonlyArray<{
		readonly comparisonIp: number;
		readonly nullIp: number;
	}>;
	readonly lastIndexEffect: "retained-call-twin";
	readonly loads: ReadonlyArray<{
		readonly ip: number;
		readonly keyIp: number;
		readonly captureIndex: number;
		readonly dst: number;
		readonly consumer?:
			| { readonly kind: "length"; readonly propertyIp: number }
			| {
					readonly kind: "charCodeAtZero";
					readonly propertyIp: number;
					readonly callIp: number;
					readonly zeroIp?: number;
			  }
			| {
					readonly kind: "number";
					readonly intrinsicIp: number;
					readonly callIp: number;
			  }
			| {
					readonly kind: "asciiCaseLength";
					readonly upperPropertyIp: number;
					readonly upperCallIp: number;
					readonly lowerPropertyIp: number;
					readonly lowerIcIndex: number;
					readonly lowerCallIp: number;
					readonly resultMoveIps: ReadonlyArray<number>;
					readonly lengthPropertyIp: number;
			  };
	}>;
};

export type VmRegExpIteratorProjectionRegion = VmRegionEnvelope<
	"regexp-iterator-projection",
	"regexp-iterator-capture-spans",
	"on-demand"
> & {
	readonly stepIp: number;
	readonly doneBranchIp: number;
	readonly exitIp: number;
	readonly iterator: number;
	readonly next: number;
	readonly value: number;
	readonly done: number;
	readonly aliasMoveIps: ReadonlyArray<number>;
	readonly statefulEffect: "iterator-last-index-retained-step";
	readonly runtimeGuard: "exact-brand-next-realm-regexp";
	readonly loads: ReadonlyArray<{
		readonly ip: number;
		readonly keyIp: number;
		readonly captureIndex: number;
		readonly dst: number;
		readonly numberIntrinsicIp: number;
		readonly numberCallIp: number;
	}>;
};

export type VmStringSliceNumberRegion = VmRegionEnvelope<
	"string-slice-number",
	"primitive-string-span-number",
	"none"
> & {
	readonly propertyIp: number;
	readonly sliceCallIp: number;
	readonly numberIntrinsicIp: number;
	readonly numberCallIp: number;
	readonly numberCallee: number;
	readonly receiver: number;
	readonly sliceStart: number;
	readonly result: number;
};

export type VmStringScanRegion = VmRegionEnvelope<
	"string-scan-summary",
	"primitive-string-scan-summary",
	"none"
> & {
	readonly entryIp: number;
	readonly exitIp: number;
	readonly input: number;
	readonly lengthLoadIp: number;
	readonly lengthResult: number;
	readonly matchResult: number;
	readonly matchCodeUnit: number;
};

export type VmPrivateAggregateMemoRegion = VmRegionEnvelope<
	"private-aggregate-memo",
	"private-dense-number-array-result-memo",
	"none"
> & {
	readonly allocationIp: number;
	readonly constructionPushIps: ReadonlyArray<number>;
	readonly callIp: number;
	readonly targetFunctionIndex: number;
	readonly callee: number;
	readonly input: number;
	readonly result: number;
};

export type VmInvariantJsonMapTemplateRegion = VmRegionEnvelope<
	"invariant-json-map-template",
	"activation-local-json-map-template",
	"whole-region"
> & {
	readonly parseCallIp: number;
	readonly mapLoadIp: number;
	readonly mapCallIp: number;
	readonly jsonObject: number;
	readonly parseCallee: number;
	readonly text: number;
	readonly parseResult: number;
	readonly mapCallee: number;
	readonly callback: number;
	readonly mapResult: number;
	readonly targetFunctionIndex: number;
	readonly captures: ReadonlyArray<{ ownerFunctionIndex: number; index: number }>;
	readonly rowPropertyLoads: number;
	readonly primitiveRowStringIndices: ReadonlyArray<number>;
	readonly nestedBaseStringIndex: number;
	readonly nestedValueStringIndex: number;
	readonly excludedStringIndices: ReadonlyArray<number>;
};

export type VmStackObjectPlanRegion = VmRegionEnvelope<
	"stack-object-plan",
	"activation-local-fixed-shape-objects",
	"on-demand"
> & {
	readonly sites: ReadonlyArray<{
		readonly allocationIp: number;
		readonly slotCount: number;
		readonly accesses: ReadonlyArray<{ readonly ip: number; readonly slot: number }>;
		readonly inheritedAccessIp?: number;
		readonly materializations: ReadonlyArray<{
			readonly ip: number;
			readonly kind: "return";
		}>;
	}>;
};

/**
 * Composite bounded-history representation for one closed Array push/consume
 * corridor. The pushed shaped record belongs to this certificate rather than a
 * second stack-object region, so allocation and materialization ownership stay
 * disjoint across the function-level region table.
 */
export type VmCardinalityArrayRegion = VmRegionEnvelope<
	"cardinality-array",
	"bounded-record-history",
	"whole-region"
> & {
	readonly allocationIp: number;
	readonly pushCallIp: number;
	readonly itemAllocationIp: number;
	readonly maximumLength: number;
	readonly accesses: ReadonlyArray<{
		readonly ip: number;
		readonly role: "push" | "length" | "element" | "field";
		readonly fieldSlot?: number;
	}>;
};

export type VmExactFreshArrayRegion = VmRegionEnvelope<
	"exact-fresh-array",
	"exact-fresh-dense-elements",
	"none"
> & {
	readonly composition: "overlay";
	readonly allocationIp: number;
	readonly runtimeGuard: "dense-storage-or-generic-load";
	readonly accessIps: ReadonlyArray<number>;
};

export type VmNumericFusionRegion = VmRegionEnvelope<
	"numeric-fusion",
	"binary-pairs-f64",
	"none"
> & {
	readonly composition: "overlay";
	readonly runtimeGuard: "number-operands";
	readonly pairs: ReadonlyArray<{
		readonly firstIp: number;
		readonly finishIp: number;
		readonly firstUsePosition: 1 | 2;
	}>;
};

export type VmFinitePropertySelectorRegion = VmRegionEnvelope<
	"finite-property-selector",
	"finite-property-domain",
	"none"
> & {
	readonly composition: "overlay";
	readonly runtimeGuard: "integer-domain-and-shape-or-generic-access";
	readonly selectors: ReadonlyArray<{
		readonly producerIp: number;
		readonly ordinal: number;
		readonly minimum: number;
		readonly stringIndices: ReadonlyArray<number>;
		readonly accesses: ReadonlyArray<{
			readonly ip: number;
			readonly kind: "load" | "store";
		}>;
	}>;
};

/**
 * Complete finite-key construction contract. The allocation, canonical store,
 * optional virtual reads, Number leaves, key table, and shared property IC are
 * one cacheable unit; no instruction-local construction/access backlinks are
 * needed after lowering.
 */
export type VmFiniteObjectConstructionRegion = VmRegionEnvelope<
	"finite-object-construction",
	"finite-key-object-slots",
	"on-demand"
> & {
	readonly allocationIp: number;
	readonly storeIp: number;
	readonly icIndex: number;
	readonly numberGuards: ReadonlyArray<number>;
	readonly keyStringIndices: ReadonlyArray<number>;
	readonly virtualRecord: boolean;
	readonly accessIps: ReadonlyArray<number>;
	readonly runtimeGuard: "number-leaves-and-prototype-shape";
};

export type VmNumericHofRegion = VmRegionEnvelope<
	"numeric-hof",
	"numeric-reduce-f64",
	"none"
> & {
	readonly method: "reduce";
	readonly dispatch:
		| {
				readonly kind: "guarded";
				readonly guardCallIp: number;
				readonly slowCallIp: number;
		  }
		| { readonly kind: "closed"; readonly receiverAllocationIp: number };
	readonly callbackFunctionIndex: number;
	readonly receiver: number;
	readonly initialValue: number;
	readonly pollPolicy: "end-only-no-preempt";
	readonly operations: ReadonlyArray<IRNumericHofPlanOperation>;
	readonly resultOperand: number;
};

export type VmRegion =
	| VmClosedRecordArrayRegion
	| VmExactFreshArrayRegion
	| VmRegExpExecProjectionRegion
	| VmRegExpIteratorProjectionRegion
	| VmStringSliceNumberRegion
	| VmStringScanRegion
	| VmPrivateAggregateMemoRegion
	| VmInvariantJsonMapTemplateRegion
	| VmNumericFusionRegion
	| VmFiniteObjectConstructionRegion
	| VmFinitePropertySelectorRegion
	| VmStackObjectPlanRegion
	| VmCardinalityArrayRegion
	| VmStringSplitProjectionRegion
	| VmStringSplitCursorRegion
	| VmNumericHofRegion;

export interface VmGuardedBuiltinCall {
	readonly operation: VmGuardedBuiltinOperation;
	/** The shared semantic facts and fallback contract for this specialization. */
	readonly guard: VmGuardPlan;
}

export function vmCallProvesBuiltin(
	instruction: Extract<VmInstruction, { opcode: "CALL" }>,
	operation: VmGuardedBuiltinOperation,
	requirements?: {
		readonly lowering: string;
		readonly result: string;
		readonly effects: ReadonlyArray<EffectKind>;
	},
): boolean {
	if (instruction.guardedBuiltinCall?.operation !== operation) return false;
	if (requirements === undefined) return true;
	const descriptor = builtinOperationDescriptor(operation);
	return (
		descriptor !== undefined &&
		descriptor.lowerings.includes(requirements.lowering) &&
		descriptor.result === requirements.result &&
		descriptor.effects.join("\0") === requirements.effects.join("\0")
	);
}

/**
 * Keep inline with the C struct
 */
export interface VmDefinition {
	/** Absolute source entry used for Node-compatible process.argv[1]. */
	entrypointPath: string;
	functionCount: number;
	functions: Array<VmFunction>;
	stringConstants: Array<Array<number>>;
	bigintConstants: Array<bigint>;
	literalTemplateData: Array<number>;
	globalCount: number;
	/** Runtime-backed facts retained for post-wire native analyses. Hand-built
	 * definitions may omit them and conservatively decline those transforms. */
	semanticProtectors?: ReadonlyArray<VmSemanticProtectorFact>;

	/**
	 * Debug-info file table: file id -> source path (relative to the compiler's
	 * working directory). A function's `fileIndex` points here; the runtime
	 * prefixes each with `compiled://` for stack-trace frames.
	 */
	files: Array<string>;

	/**
	 * Debug-info position table: pos id -> (line, column), shared by all
	 * functions (the file is resolved per-function). A function's per-instruction
	 * `positions` index into this.
	 */
	sourcePositions: Array<{
		line: number;
		column: number;
		inlinedFunctionIndex?: number;
		callerPosId?: number;
	}>;

	/** Build-local source sites and structured optimization decisions. Profile
	 * builds emit these; ordinary generated code ignores them. */
	profileSites?: Array<ProfileSite>;
	profileRemarks?: Array<CompilerRemark>;
	optimizationTrace?: Array<OptimizationPassDelta>;

	/**
	 * CommonJS module table: index (module id) -> wrapper function index. Empty
	 * for programs with no CommonJS modules.
	 */
	cjsModuleFunctionIndices: Array<number>;

	/**
	 * Host-install manifest: for each `node:*` built-in whose exports the program
	 * uses, plus the slot-free global `process` installer, the native installer's C
	 * symbol and any global slots it fills. Dead-code elimination drops unused
	 * entries, so an ordinary program's manifest is empty. Installers run after VM
	 * init / host attach and before execution; a definition decoded from the wire
	 * keeps the same name/slot entries but its installer pointer is unresolved (null).
	 */
	hostInstalls: Array<{
		installer: string;
		exports: Array<{ name: string; slot: number }>;
	}>;
}

/**
 * Keep inline with the C struct
 */
export interface VmExceptionHandler {
	startIp: number;
	endIp: number;
	handlerIp: number;
}

export const ARGUMENT_SNAPSHOT_SOURCE_COUNT = -1;
export const ARGUMENT_SNAPSHOT_SOURCE_SCRATCH = -2;

/** One operation in the cycle-safe parallel move performed at frame entry. */
export interface VmArgumentSnapshotMove {
	/** A negative value saves the source to scratch; `~destination` is restored later. */
	destination: number;
	/** Argument index, or one of the ARGUMENT_SNAPSHOT_SOURCE_* sentinels. */
	source: number;
}

/**
 * Keep inline with the C struct
 */
export interface VmFunction {
	nameStringIndex: number;
	isGenerator: boolean;
	isAsync: boolean;
	parameterCount: number;
	mappedArguments: boolean;
	mappedArgumentSlots: Array<number>;
	length: number;
	registerCount: number;
	capturedCount: number;
	strict: boolean;

	/**
	 * Whether the function may retain passed arguments after frame entry. Entry
	 * snapshots do not require the retained slice.
	 */
	needsArguments: boolean;

	/** Number of leading raw-argument snapshot instructions run at frame entry. */
	argumentSnapshotCount: number;

	/** Precomputed parallel-move schedule for the entry snapshot prefix. */
	argumentSnapshotPlan: Array<VmArgumentSnapshotMove>;

	/**
	 * A derived class constructor: `this` starts uninitialized (TDZ) and is bound
	 * only by super(), so the construct site allocates no eager `this` and reads
	 * of `this` before super() throw ReferenceError.
	 */
	isDerivedConstructor: boolean;

	/**
	 * A class constructor (base or derived): its `prototype` property is
	 * non-writable (MakeConstructor with writablePrototype = false), unlike a
	 * normal function's writable prototype.
	 */
	isClassConstructor: boolean;

	/**
	 * Whether this function owns a `prototype` property. False for methods,
	 * getters, setters and arrows (not constructors); true for normal functions,
	 * class constructors and generators. (Async non-generators are excluded at
	 * runtime by kind.)
	 */
	hasPrototype: boolean;

	instructions: Array<VmInstruction>;
	handlers: Array<VmExceptionHandler>;
	/** Serialized tagged region certificates; ordinary instructions remain the twin. */
	regions?: ReadonlyArray<VmRegion>;

	/**
	 * Debug-info: index into VmDefinition.files for this function's source file.
	 */
	fileIndex: number;

	/**
	 * Debug-info: parallel to `instructions` — positions[i] is the source-position
	 * id (index into VmDefinition.sourcePositions) of instruction i, or -1 when
	 * unknown (e.g. prologue code before the first statement marker). Built from
	 * the stripped `sourcePos` markers. The VM resolves a frame's position by its
	 * instruction pointer; the native backend emits coalesced `pos` writes from it.
	 */
	positions: Array<number>;
	/** Dense profile site for each instruction, or -1 when no source is known. */
	profileSiteIds?: Array<number>;
	/** Compile-only bridge from VM instructions to final shared compiler facts. */
	compilerSiteIds?: Array<string | undefined>;

	/**
	 * COMPILE-ONLY (not part of the C `MalFunction` struct): the registers the
	 * native backend must spill into this function's GC root frame — those live at
	 * or used by a GC safepoint (`computeSafepointRoots`), already
	 * in this function's post-allocation register numbering. emit-c roots exactly
	 * the boxed registers in this set; a register absent from it never holds a live
	 * value at a collection point. Undefined for generator/async functions (the
	 * native backend bails on those) — emit-c then falls back to rooting every
	 * boxed register.
	 */
	gcRootRegisters?: ReadonlyArray<number>;
}

/** -1 never retains; INT32_MAX always retains nonempty input; otherwise the
 * largest static index whose absence requires the supplied argument slice. */
export function computeArgumentRetentionLimit(
	fn: Pick<VmFunction, "argumentSnapshotCount" | "instructions">,
): number {
	const argumentInstructions = fn.instructions.slice(fn.argumentSnapshotCount);
	if (
		argumentInstructions.some(
			(instruction) =>
				instruction.opcode === "CREATE_ARGUMENTS_OBJECT" ||
				instruction.opcode === "CREATE_REST_ARGUMENTS" ||
				instruction.opcode === "LOAD_ARGUMENT",
		)
	) {
		return 0x7fffffff;
	}
	return argumentInstructions.reduce(
		(maximum, instruction) =>
			instruction.opcode === "LOAD_STATIC_ARGUMENT"
				? Math.max(maximum, instruction.index)
				: maximum,
		-1,
	);
}

/**
 * Schedule the snapshot prefix as a parallel move. Snapshot destinations are a
 * dense, distinct range after the pinned parameters, which lets frame setup
 * preserve them without a per-call initialized-register bitmap.
 */
export function buildArgumentSnapshotPlan(
	fn: Pick<
		VmFunction,
		"argumentSnapshotCount" | "instructions" | "parameterCount" | "registerCount"
	>,
): Array<VmArgumentSnapshotMove> {
	const snapshots: Array<{ destination: number; source: number | null }> = [];
	if (
		!Number.isInteger(fn.argumentSnapshotCount) ||
		fn.argumentSnapshotCount < 0 ||
		fn.argumentSnapshotCount > fn.instructions.length
	) {
		throw new RangeError("invalid argument snapshot count");
	}
	if (fn.parameterCount + fn.argumentSnapshotCount > fn.registerCount) {
		throw new RangeError("argument snapshot destinations exceed register count");
	}
	for (let i = 0; i < fn.argumentSnapshotCount; i++) {
		const instruction = fn.instructions[i];
		if (
			instruction?.opcode !== "LOAD_ARGUMENT_COUNT" &&
			instruction?.opcode !== "LOAD_ARGUMENT"
		) {
			throw new RangeError("argument snapshot prefix mismatch");
		}
		const destination = instruction.dst;
		if (destination !== fn.parameterCount + i) {
			throw new RangeError(
				"argument snapshot destinations must be dense after parameters",
			);
		}
		if (
			instruction.opcode === "LOAD_ARGUMENT" &&
			(!Number.isInteger(instruction.index) || instruction.index > 0x7fffffff)
		) {
			throw new RangeError("invalid argument snapshot source index");
		}
		if (instruction.opcode === "LOAD_ARGUMENT" && instruction.index < 0) {
			throw new RangeError("negative argument index");
		}
		snapshots.push({
			destination,
			source: instruction.opcode === "LOAD_ARGUMENT" ? instruction.index : null,
		});
	}
	const next = fn.instructions[fn.argumentSnapshotCount];
	if (next?.opcode === "LOAD_ARGUMENT_COUNT" || next?.opcode === "LOAD_ARGUMENT") {
		throw new RangeError("argument snapshot prefix mismatch");
	}

	const remaining = [...snapshots];
	const plan: Array<VmArgumentSnapshotMove> = [];
	const emitDirect = (move: (typeof remaining)[number]): void => {
		plan.push({
			destination: move.destination,
			source: move.source ?? ARGUMENT_SNAPSHOT_SOURCE_COUNT,
		});
	};
	const readyIndex = (): number => {
		const sources = new Set(
			remaining.flatMap((move) => (move.source === null ? [] : [move.source])),
		);
		return remaining.findIndex((move) => !sources.has(move.destination));
	};

	while (remaining.length > 0) {
		// A present self-move is already in place; when missing, runtime writes
		// undefined. It never destroys a source and cannot participate in a cycle.
		const selfIndex = remaining.findIndex(
			(move) => move.source !== null && move.source === move.destination,
		);
		if (selfIndex >= 0) {
			emitDirect(remaining.splice(selfIndex, 1)[0]!);
			continue;
		}

		const ready = readyIndex();
		if (ready >= 0) {
			emitDirect(remaining.splice(ready, 1)[0]!);
			continue;
		}

		// Every remaining destination is still a source, so break one cycle. The
		// destination becomes safe after following ready moves around that cycle.
		const cycle = remaining.find((move) => move.source !== null);
		if (!cycle || cycle.source === null) {
			throw new Error("unable to schedule argument snapshots");
		}
		plan.push({ destination: ~cycle.destination, source: cycle.source });
		remaining.splice(remaining.indexOf(cycle), 1);
		while (remaining.some((move) => move.source === cycle.destination)) {
			const nextReady = readyIndex();
			if (nextReady < 0) {
				throw new Error("unable to resolve argument snapshot cycle");
			}
			emitDirect(remaining.splice(nextReady, 1)[0]!);
		}
		plan.push({
			destination: cycle.destination,
			source: ARGUMENT_SNAPSHOT_SOURCE_SCRATCH,
		});
	}

	return plan;
}

/**
 * Keep inline with the C struct
 */
export type VmInstruction =
	| {
			opcode: "MOVE";
			dst: number;
			src: number;
	  }
	| {
			opcode: "RETURN";
			value: number;
	  }
	| {
			opcode: "JUMP_IF";
			cond: number;
			targetIp: number;
	  }
	| {
			opcode: "JUMP";
			targetIp: number;
	  }
	| {
			opcode: "CREATE_NUMBER";
			dst: number;
			value: number;
	  }
	| {
			opcode: "CREATE_F64";
			dst: number;
			value: number;
	  }
	| {
			opcode: "CREATE_BOOLEAN";
			dst: number;
			value: boolean;
	  }
	| {
			opcode: "CREATE_STRING";
			dst: number;
			stringIndex: number;
	  }
	| {
			opcode: "CREATE_BIGINT";
			dst: number;
			bigintIndex: number;
	  }
	| {
			opcode: "CREATE_OBJECT";
			dst: number;
	  }
	| {
			opcode: "CREATE_OBJECT_SHAPED";
			dst: number;
			count: number;
			keyStringIndices: Array<number>;
			valueRegisters: Array<number>;
			shapeCacheIndex: number;
	  }
	| {
			opcode: "CREATE_ARRAY";
			dst: number;
			length: number;
			/** COMPILE-ONLY: exact capacity for a proven pristine indexed fill. */
			nativeFreshDenseReserveLength?: number;
			/** EMITTER-ONLY: private identity-range Array virtualization action. */
			nativeAffineRangeVirtualization?: {
				allocationIp: number;
				role: "allocation";
				guard: VmGuardPlan;
			};
	  }
	| {
			opcode: "INSTANTIATE_LITERAL_TEMPLATE";
			dst: number;
			templateOffset: number;
	  }
	| {
			opcode: "CREATE_MODULE_NAMESPACE";
			dst: number;
			nameIndices: Array<number>;
			slots: Array<number>;
	  }
	| {
			opcode: "CREATE_TEMPLATE_OBJECT";
			dst: number;
			cacheSlot: number;
			cookedIndices: Array<number>;
			rawIndices: Array<number>;
	  }
	| {
			opcode: "CREATE_UNDEFINED";
			dst: number;
	  }
	| {
			opcode: "CREATE_EMPTY";
			dst: number;
	  }
	| {
			opcode: "CREATE_NULL";
			dst: number;
	  }
	| {
			opcode: "CREATE_FUNCTION";
			dst: number;
			functionIndex: number;
	  }
	| {
			opcode: "CREATE_ARGUMENTS_OBJECT";
			dst: number;
	  }
	| {
			opcode: "LOAD_ARGUMENT_COUNT";
			dst: number;
	  }
	| {
			opcode: "LOAD_ARGUMENT";
			dst: number;
			index: number;
	  }
	| {
			opcode: "LOAD_STATIC_ARGUMENT";
			dst: number;
			direct: number;
			fallback: number;
			index: number;
	  }
	| {
			opcode: "LOAD_THIS";
			dst: number;
	  }
	| {
			opcode: "LOAD_NEW_TARGET";
			dst: number;
	  }
	| {
			opcode: "LOAD_CALLEE";
			dst: number;
	  }
	| {
			opcode: "CALL";
			dst: number;
			callee: number;
			thisValue: number;
			argumentCount: number;
			arguments: Array<number>;
			/** COMPILE-ONLY: guarded direct script-function target for native emission. */
			directFunctionIndex?: number;
			/** COMPILE-ONLY: guarded intrinsic Function.prototype.call flattening. */
			directFunctionCall?: true;
			/** COMPILE-ONLY: exact script receiver of directFunctionCall, when known. */
			directCallTargetFunctionIndex?: number;
			/** COMPILE-ONLY: canonical guarded intrinsic identity and fallback plan. */
			guardedBuiltinCall?: VmGuardedBuiltinCall;
			/** COMPILE-ONLY: this exact loop-invariant JSON.parse owns a private clone cache. */
			nativeInvariantJsonParseCache?: true;
			/**
			 * COMPILE-ONLY: exact Math namespace/property producers owned by this call.
			 * Native emission may erase them only after discharging this call's locked
			 * identity and Number-representation obligations.
			 */
			nativeMathExactProducerTwin?: {
				receiverIp: number;
				propertyIp: number;
			};
			/** COMPILE-ONLY: statically proven Number-position strength. */
			directStringCharCodeAtPosition?: "integer" | "inBounds";
			/** COMPILE-ONLY: closed String.prototype.search over a fresh RegExp literal. */
			directStringSearchRegExp?: true;
			/** COMPILE-ONLY: consume an elided fixed RegExp literal search result. */
			directStringSearchLiteralConstructIp?: number;
	  }
	| {
			opcode: "MATH_UNARY_NUMBER";
			dst: number;
			src: number;
			operation: VmMathUnaryNumberOperation;
	  }
	| {
			opcode: "MATH_BINARY_NUMBER";
			dst: number;
			left: number;
			right: number;
			operation: VmMathBinaryNumberOperation;
	  }
	| {
			opcode: "CALL_BUILTIN";
			dst: number;
			thisValue: number;
			argumentCount: number;
			arguments: Array<number>;
			operation: VmDirectBuiltinOperation;
	  }
	| {
			opcode: "CONSTRUCT";
			dst: number;
			callee: number;
			argumentCount: number;
			arguments: Array<number>;
			/** COMPILE-ONLY: guarded direct script-constructor target for native emission. */
			directFunctionIndex?: number;
			/** COMPILE-ONLY: fixed literal search attempted at this construction site. */
			directStringSearchLiteral?: {
				callIp: number;
				searchCallee: number;
				receiver: number;
				patternStringIndex: number;
			};
	  }
	| {
			opcode: "THROW";
			value: number;
	  }
	| {
			opcode: "CATCH";
			dst: number;
	  }
	| {
			/** Legacy wire opcode; new lowering stores only the handler table. */
			opcode: "TRY_BEGIN";
			handlerIp: number;
	  }
	| {
			/** Legacy wire opcode; new lowering stores only the handler table. */
			opcode: "TRY_END";
	  }
	| {
			opcode: "GENERATOR_START";
	  }
	| {
			opcode: "ASYNC_START";
	  }
	| {
			opcode: "YIELD";
			yieldedSrc: number;
			valueDst: number;
			modeDst: number;
	  }
	| {
			opcode: "TERMINAL_YIELD";
			yieldedSrc: number;
	  }
	| {
			opcode: "AWAIT";
			awaitedSrc: number;
			valueDst: number;
			modeDst: number;
	  }
	| {
			opcode: "LOAD_INTRINSIC";
			dst: number;
			intrinsic: IRIntrinsic;
	  }
	| {
			opcode: "LOAD_CAPTURED";
			dst: number;
			ownerFunctionIndex: number;
			index: number;
	  }
	| {
			opcode: "GUARD_FUNCTION_INDEX";
			dst: number;
			callee: number;
			functionIndex: number;
	  }
	| {
			opcode: "LOAD_GLOBAL";
			dst: number;
			index: number;
	  }
	| {
			opcode: "STORE_CAPTURED";
			src: number;
			ownerFunctionIndex: number;
			index: number;
	  }
	| {
			opcode: "ENV_PUSH" | "ENV_COPY";
			scopeId: number;
			slotCount: number;
	  }
	| {
			opcode: "ENV_POP";
	  }
	| {
			opcode: "STORE_GLOBAL";
			src: number;
			index: number;
	  }
	| {
			opcode: "LOAD_PROPERTY";
			dst: number;
			object: number;
			key: number;
			icIndex: number;
			nativeClosedGlobalTable?: {
				baseIndex: number;
				stateIndex: number;
				mask: number;
				direct: boolean;
				guard: VmGuardPlan;
			};
			/** EMITTER-ONLY: load from a private `array[i] = i` virtual range. */
			nativeAffineRangeVirtualization?: {
				allocationIp: number;
				role: "load";
			};
	  }
	| {
			opcode: "LOAD_PROPERTY_STATIC";
			dst: number;
			object: number;
			stringIndex: number;
			icIndex: number;
			/** COMPILE-ONLY: guarded primitive-String `length` fast read. */
			nativePrimitiveStringLength?: true;
	  }
	| {
			opcode: "LOAD_SUPER_PROPERTY";
			dst: number;
			object: number;
			key: number;
			receiver: number;
	  }
	| {
			opcode: "STORE_PROPERTY";
			object: number;
			key: number;
			value: number;
			icIndex: number;
			nativeClosedGlobalTable?: {
				baseIndex: number;
				stateIndex: number;
				mask: number;
				direct: boolean;
				guard: VmGuardPlan;
			};
			/** EMITTER-ONLY: producer store for a private identity virtual range. */
			nativeAffineRangeVirtualization?: {
				allocationIp: number;
				role: "store";
			};
	  }
	| {
			opcode: "STORE_PROPERTY_STATIC";
			object: number;
			value: number;
			stringIndex: number;
			icIndex: number;
	  }
	| {
			opcode: "TO_PROPERTY_KEY";
			dst: number;
			object: number;
			key: number;
	  }
	| {
			opcode: "STORE_SUPER_PROPERTY";
			object: number;
			key: number;
			value: number;
			receiver: number;
	  }
	| {
			opcode: "LOAD_PROTOTYPE";
			dst: number;
			object: number;
	  }
	| {
			opcode: "GET_ITERATOR";
			iteratorDst: number;
			nextDst: number;
			source: number;
	  }
	| {
			opcode: "GET_ASYNC_ITERATOR";
			iteratorDst: number;
			nextDst: number;
			source: number;
	  }
	| {
			opcode: "ITERATOR_NEXT";
			resultDst: number;
			iterator: number;
			next: number;
	  }
	| {
			opcode: "ITERATOR_STEP";
			valueDst: number;
			doneDst: number;
			iterator: number;
			next: number;
	  }
	| {
			opcode: "ITERATOR_CLOSE";
			iterator: number;
			normal: boolean;
	  }
	| {
			opcode: "FOR_IN_KEYS";
			dst: number;
			source: number;
	  }
	| {
			opcode: "CALL_SPREAD";
			dst: number;
			callee: number;
			thisValue: number;
			argumentsArray: number;
	  }
	| {
			opcode: "CALL_SPREAD_ITERABLE";
			dst: number;
			callee: number;
			thisValue: number;
			iterable: number;
	  }
	| {
			opcode: "CONSTRUCT_SPREAD";
			dst: number;
			callee: number;
			argumentsArray: number;
	  }
	| {
			opcode: "CONSTRUCT_SUPER";
			dst: number;
			parent: number;
			argumentsArray: number;
	  }
	| {
			opcode: "CONSTRUCT_SUPER_EXPLICIT";
			dst: number;
			parent: number;
			argumentsArray: number;
			newTarget: number;
	  }
	| {
			opcode: "SET_THIS";
			value: number;
	  }
	| {
			opcode: "MERGE_DATA_PROPERTIES";
			target: number;
			src: number;
	  }
	| {
			opcode: "DELETE_PROPERTY";
			dst: number;
			object: number;
			key: number;
	  }
	| {
			opcode: "DEFINE_ACCESSOR";
			object: number;
			key: number;
			accessor: number;
			isSetter: boolean;
			enumerable: boolean;
	  }
	| {
			opcode: "DEFINE_PROPERTY";
			object: number;
			key: number;
			value: number;
			enumerable: boolean;
			writable: boolean;
			configurable: boolean;
	  }
	| {
			opcode: "SET_FUNCTION_NAME";
			func: number;
			key: number;
			// 0 = no prefix, 1 = "get ", 2 = "set ".
			prefix: number;
	  }
	| {
			opcode: "CREATE_PRIVATE_NAME";
			dst: number;
	  }
	| {
			opcode: "CREATE_PRIVATE_NAMES";
			ownerFunctionIndex: number;
			capturedIndices: Array<number>;
	  }
	| {
			opcode: "DEFINE_PRIVATE";
			object: number;
			key: number;
			value: number;
	  }
	| {
			opcode: "INIT_PRIVATE_FIELDS";
			object: number;
			keyRegisters: Array<number>;
	  }
	| {
			opcode: "LOAD_PRIVATE";
			dst: number;
			object: number;
			key: number;
	  }
	| {
			opcode: "STORE_PRIVATE";
			object: number;
			key: number;
			value: number;
	  }
	| {
			opcode: "HAS_PRIVATE";
			dst: number;
			object: number;
			key: number;
	  }
	| {
			opcode: "SET_PROTOTYPE";
			object: number;
			prototype: number;
			literal: boolean;
	  }
	| {
			opcode: "LOAD_UNDECLARED";
			dst: number;
			nameStringIndex: number;
	  }
	| {
			opcode: "LOAD_GLOBAL_PROPERTY";
			dst: number;
			nameStringIndex: number;
	  }
	| {
			opcode: "STORE_GLOBAL_PROPERTY";
			src: number;
			nameStringIndex: number;
			declaration: boolean;
			declarationConfigurable: boolean;
	  }
	| {
			opcode: "INIT_GLOBAL_VARS";
			nameStringIndices: Array<number>;
			declarationConfigurable: boolean;
	  }
	| {
			opcode: "THROW_IF_TDZ";
			src: number;
			nameStringIndex: number;
	  }
	| {
			opcode: "WITH_ENTER";
			object: number;
	  }
	| {
			opcode: "WITH_EXIT";
	  }
	| {
			opcode: "WITH_GET";
			dst: number;
			nameStringIndex: number;
	  }
	| {
			opcode: "WITH_RESOLVE_BASE";
			dst: number;
			nameStringIndex: number;
	  }
	| {
			opcode: "WITH_SET";
			found: number;
			value: number;
			nameStringIndex: number;
	  }
	| {
			opcode: "IS_EMPTY";
			dst: number;
			src: number;
	  }
	| {
			opcode: "REQUIRE_COERCIBLE";
			src: number;
	  }
	| {
			opcode: "CHECK_SUPER_CLASS";
			parent: number;
	  }
	| {
			opcode: "CREATE_REST_ARGUMENTS";
			dst: number;
			startIndex: number;
	  }
	| {
			opcode: "ARRAY_REST";
			dst: number;
			src: number;
			startIndex: number;
	  }
	| {
			opcode: "COPY_DATA_PROPERTIES";
			dst: number;
			src: number;
			excludedCount: number;
			excluded: Array<number>;
	  }
	| {
			opcode: "BINARY";
			dst: number;
			left: number;
			right: number;
			operator: IRBinaryOperator;
			nativeFiniteString?: {
				minimum: number;
				stringIndices: Array<number>;
			};
	  }
	| {
			opcode: "UNARY";
			dst: number;
			src: number;
			operator: IRUnaryOperator;
	  }
	| {
			opcode: "TYPEOF_COMPARE";
			dst: number;
			src: number;
			expected: IRTypeofResult;
			negated: boolean;
	  };

/** Every physical register defined by an instruction, including multi-result ops. */
export function vmInstructionWriteRegisters(
	instruction: VmInstruction,
): ReadonlyArray<number> {
	switch (instruction.opcode) {
		case "YIELD":
		case "AWAIT":
			return [instruction.valueDst, instruction.modeDst];
		case "GET_ITERATOR":
		case "GET_ASYNC_ITERATOR":
			return [instruction.iteratorDst, instruction.nextDst];
		case "ITERATOR_NEXT":
			return [instruction.resultDst];
		case "ITERATOR_STEP":
			return [instruction.valueDst, instruction.doneDst];
		case "WITH_SET":
			return [instruction.found];
		default: {
			const dst = (instruction as { readonly dst?: number }).dst;
			return dst === undefined ? [] : [dst];
		}
	}
}

export function countPropertyIcSites(instructions: ReadonlyArray<VmInstruction>): number {
	let count = 0;
	for (const instruction of instructions) {
		switch (instruction.opcode) {
			case "LOAD_PROPERTY":
			case "LOAD_PROPERTY_STATIC":
			case "STORE_PROPERTY":
			case "STORE_PROPERTY_STATIC":
				count++;
				break;
		}
	}
	return count;
}

export function countLiteralShapeSites(
	instructions: ReadonlyArray<VmInstruction>,
): number {
	return instructions.filter(
		(instruction) => instruction.opcode === "CREATE_OBJECT_SHAPED",
	).length;
}

export interface VmDefinitionStats {
	functionCount: number;
	instructionCount: number;
}

/**
 * Run-length compress a function's per-instruction position ids into
 * (start_ip, pos_id) entries: a new entry only where the position changes. The
 * runtime resolves a frame's position by finding the last entry with
 * start_ip <= instruction_pointer. Shared by the C-literal emitter (emit-vm)
 * and the wire serializer (serialize-vm); it lives here, alongside the VM
 * definition types, so the self-hostable serializer cone never imports emit-vm
 * (which pulls node:path + the emit-c native backend).
 */
export function compressPositions(
	positions: Array<number>,
): Array<{ startIp: number; posId: number }> {
	const runs: Array<{ startIp: number; posId: number }> = [];
	for (let ip = 0; ip < positions.length; ++ip) {
		const posId = positions[ip]!;
		if (runs.length === 0 || runs[runs.length - 1]!.posId !== posId) {
			runs.push({ startIp: ip, posId });
		}
	}
	return runs;
}

/**
 * Aggregate code-size metrics for a compiled definition: how many functions
 * were emitted and the total instruction count across all of them.
 */
export function vmDefinitionStats(definition: VmDefinition): VmDefinitionStats {
	let instructionCount = 0;
	for (const fn of definition.functions) {
		instructionCount += fn.instructions.length;
	}

	return { functionCount: definition.functions.length, instructionCount };
}

/**
 * Lower optimized IR to a VM definition that can then be emitted as C.
 */
export function lowerIrProgramToVmDefinition(
	program: IntermediateProgram,
	profile = false,
): VmDefinition {
	// Build the debug-info file table: distinct source paths in first-seen order.
	const files: Array<string> = [];
	const fileToIndex = new Map<string, number>();
	const fileIndexFor = (path: string): number => {
		const existing = fileToIndex.get(path);
		if (existing !== undefined) {
			return existing;
		}
		const index = files.push(path) - 1;
		fileToIndex.set(path, index);
		return index;
	};
	const functions = program.functions.map((fn) =>
		lowerFunctionToVmFunction(
			fn,
			fileIndexFor(fn.semanticFile.path),
			program.stringConstants,
			profile ? program.facts.instructionSites : undefined,
		),
	);

	const definition: VmDefinition = {
		entrypointPath: program.semantic.entrypointPath,
		functionCount: program.functions.length,
		functions,
		stringConstants: program.stringConstants,
		bigintConstants: program.bigintConstants,
		literalTemplateData: program.literalTemplateData,
		globalCount: program.nextGlobalIndex,
		semanticProtectors: (
			["primitive-methods", "watched-methods", "array-elements"] as const
		).map((family) => {
			const plan = compilerGuardPlan(
				[program.facts.protectors.get(family)],
				[{ kind: "fallback", id: `semantic-protector:${family}` }],
			);
			const guard = plan === undefined ? undefined : lowerGuardPlan(plan);
			if (guard === undefined || !guard.obligations.includes("fallback")) {
				throw new Error(`Runtime semantic fact ${family} lost its fallback contract`);
			}
			return { family, guard };
		}),
		cjsModuleFunctionIndices: program.cjsWrapperFunctionIndex,
		hostInstalls: buildHostInstalls(program, functions),
		files,
		sourcePositions: program.sourcePositions,
		...(profile ? { optimizationTrace: program.optimizationTrace } : {}),
	};
	if (profile) buildProfileMetadata(program, definition);
	return definition;
}

/**
 * Resolve the linker's host built-in bindings to global slots read by the final
 * VM instruction stream. Slot assignment can outlive an optimized-away read, so
 * the emitted functions, rather than bindingToStorage alone, determine export
 * retention. Process remains statically retained from global-property analysis.
 */
function buildHostInstalls(
	program: IntermediateProgram,
	functions: Array<VmFunction>,
): VmDefinition["hostInstalls"] {
	const readGlobalSlots = new Set<number>();
	for (const fn of functions) {
		for (const instruction of fn.instructions) {
			if (instruction.opcode === "LOAD_GLOBAL") {
				readGlobalSlots.add(instruction.index);
			} else if (instruction.opcode === "CREATE_MODULE_NAMESPACE") {
				for (const slot of instruction.slots) {
					readGlobalSlots.add(slot);
				}
			} else if (instruction.opcode === "CREATE_TEMPLATE_OBJECT") {
				readGlobalSlots.add(instruction.cacheSlot);
			}
		}
	}

	const globalSlotOf = (binding: Binding): number | null => {
		const location = program.bindingToStorage.get(binding);
		return location?.type === "global" && readGlobalSlots.has(location.index)
			? location.index
			: null;
	};

	const manifest: VmDefinition["hostInstalls"] = [];
	const installFor = (installer: string) => {
		let install = manifest.find((entry) => entry.installer === installer);
		if (!install) {
			install = { installer, exports: [] };
			manifest.push(install);
		}
		return install;
	};
	for (const hostModule of program.hostModules) {
		const usedExports: Array<{ name: string; slot: number }> = [];
		for (const { name, binding } of hostModule.exports) {
			const slot = globalSlotOf(binding);
			if (slot !== null) {
				usedExports.push({ name, slot });
			}
		}
		if (usedExports.length > 0) {
			installFor(hostModule.installer).exports.push(...usedExports);
		}
	}

	if (program.hostProcess?.retained) {
		installFor(program.hostProcess.installer);
	}
	if (program.hostBuffer?.retained) {
		installFor(program.hostBuffer.installer);
	}

	return manifest;
}

/**
 * Lower a function to a VM function. Note that we drop blocks and instead move to jumps to
 * absolute instructions.
 */
function lowerFunctionToVmFunction(
	fn: IRFunction,
	fileIndex: number,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
	instructionSites?: WeakMap<object, { id: string }>,
): VmFunction {
	// Source-position and exception-range markers carry no executable opcode, so
	// block start IPs count only instructions that survive flattening.
	const blockStartIps = new Map<number, number>();
	let nextInstructionPointer = 0;

	for (let i = 0; i < fn.blocks.length; ++i) {
		blockStartIps.set(i, nextInstructionPointer);
		for (const instruction of fn.blocks[i]!.instructions) {
			if (
				instruction.type !== "sourcePos" &&
				instruction.type !== "tryBegin" &&
				instruction.type !== "tryEnd"
			) {
				nextInstructionPointer += 1;
			}
		}
	}

	const instructions: Array<VmInstruction> = [];
	const compilerSiteIds: Array<string | undefined> = [];
	let propertyIcCount = 0;
	const propertyIcIndexByInstruction = new Map<IRInstruction, number>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type === "loadProperty" ||
				instruction.type === "loadPropertyStatic" ||
				instruction.type === "storeProperty" ||
				instruction.type === "storePropertyStatic"
			) {
				propertyIcIndexByInstruction.set(instruction, propertyIcCount++);
			}
		}
	}
	let literalShapeCount = 0;
	const handlers: Array<VmExceptionHandler> = [];
	const openExceptionRanges: Array<{ startIp: number; handlerIp: number }> = [];
	const positions: Array<number> = [];
	const instructionIndexByIrInstruction = new Map<IRInstruction, number>();
	const pendingNativeMathCalls: Array<{
		receiver: Extract<IRInstruction, { type: "loadIntrinsic" }>;
		property: Extract<IRInstruction, { type: "loadPropertyStatic" }>;
		call: Extract<VmInstruction, { opcode: "CALL" }>;
	}> = [];
	let currentPos = -1;
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.type === "sourcePos") {
				currentPos = instruction.pos;
				continue;
			}
			if (instruction.type === "tryBegin") {
				const handlerIp = blockStartIps.get(instruction.blocks[0]);
				if (handlerIp === undefined) {
					throw new Error(`Unknown handler target block ${instruction.blocks[0]}`);
				}
				openExceptionRanges.push({ startIp: instructions.length, handlerIp });
				continue;
			}
			if (instruction.type === "tryEnd") {
				const range = openExceptionRanges.pop();
				if (range === undefined) {
					throw new Error(`Unbalanced try marker at instruction ${instructions.length}`);
				}
				handlers.push({ ...range, endIp: instructions.length });
				continue;
			}
			const instructionIndex = instructions.length;
			instructionIndexByIrInstruction.set(instruction, instructionIndex);
			const vmInstruction = lowerInstructionToVmInstruction(blockStartIps, instruction);
			switch (vmInstruction.opcode) {
				case "LOAD_PROPERTY":
				case "LOAD_PROPERTY_STATIC":
				case "STORE_PROPERTY":
				case "STORE_PROPERTY_STATIC":
					vmInstruction.icIndex = propertyIcIndexByInstruction.get(instruction)!;
					break;
				case "CREATE_OBJECT_SHAPED":
					vmInstruction.shapeCacheIndex = literalShapeCount++;
					break;
			}
			instructions.push(vmInstruction);
			compilerSiteIds.push(instructionSites?.get(instruction)?.id);
			if (
				instruction.type === "call" &&
				vmInstruction.opcode === "CALL" &&
				instruction.knownBuiltinCall?.operation.startsWith("Math.") === true &&
				instruction.knownBuiltinCallExactProducerTwin !== undefined
			) {
				pendingNativeMathCalls.push({
					...instruction.knownBuiltinCallExactProducerTwin,
					call: vmInstruction,
				});
			}
			positions.push(currentPos);
		}
	}
	if (openExceptionRanges.length > 0) {
		throw new Error("Unbalanced try marker at end of function");
	}
	const regions: Array<VmRegion> = [];
	const claimedRegionInstructions = new Set<number>();
	const finiteSelectorByAccess = new Map<
		IRInstruction,
		Extract<IRRegion, { kind: "finite-property-selector" }>["selectors"][number]
	>();
	for (const region of fn.regions ?? []) {
		if (region.kind === "finite-property-selector") {
			for (const selector of region.selectors) {
				for (const access of selector.accesses)
					finiteSelectorByAccess.set(access, selector);
			}
		}
	}
	// Eight specialized regions plus one aggregate stack-object proof table.
	const irRegions = (fn.regions?.length ?? 0) <= 9 ? (fn.regions ?? []) : [];
	for (const region of irRegions) {
		if (region.kind === "finite-property-selector") {
			const anchors = region.anchors.map((instruction) =>
				instructionIndexByIrInstruction.get(instruction),
			);
			const claimedIps = region.claimedInstructions.map((instruction) =>
				instructionIndexByIrInstruction.get(instruction),
			);
			const ordinaryBlockIps = region.controlFlow.ordinaryBlocks.map((blockIndex) =>
				blockStartIps.get(blockIndex),
			);
			const selectors = region.selectors.map((selector) => ({
				producerIp: instructionIndexByIrInstruction.get(selector.source),
				ordinal: selector.source.registers[2],
				minimum: selector.minimum,
				stringIndices: [...selector.stringIndices],
				accesses: selector.accesses.map((access) => ({
					ip: instructionIndexByIrInstruction.get(access),
					kind: access.type === "loadProperty" ? ("load" as const) : ("store" as const),
				})),
			}));
			if (
				region.license.guard !== "structural" ||
				region.license.genericTwin !== "retained" ||
				region.license.materialization !== "none" ||
				region.representation !== "finite-property-domain" ||
				region.composition !== "overlay" ||
				region.runtimeGuard !== "integer-domain-and-shape-or-generic-access" ||
				anchors.some((ip) => ip === undefined) ||
				claimedIps.some((ip) => ip === undefined) ||
				ordinaryBlockIps.some((ip) => ip === undefined) ||
				region.controlFlow.exceptionalBlocks.length !== 0 ||
				selectors.some(
					(selector) =>
						selector.producerIp === undefined ||
						selector.accesses.some((access) => access.ip === undefined),
				)
			) {
				continue;
			}
			const resolvedSelectors = selectors as Array<{
				producerIp: number;
				ordinal: number;
				minimum: number;
				stringIndices: Array<number>;
				accesses: Array<{ ip: number; kind: "load" | "store" }>;
			}>;
			const payloadIps = resolvedSelectors.flatMap((selector) => [
				selector.producerIp,
				...selector.accesses.map((access) => access.ip),
			]);
			if (
				resolvedSelectors.length === 0 ||
				resolvedSelectors.length > 32 ||
				resolvedSelectors.some((selector) => {
					const producer = instructions[selector.producerIp];
					return (
						producer?.opcode !== "BINARY" ||
						producer.operator !== "+" ||
						producer.right !== selector.ordinal ||
						producer.nativeFiniteString?.minimum !== selector.minimum ||
						producer.nativeFiniteString.stringIndices.length !==
							selector.stringIndices.length ||
						producer.nativeFiniteString.stringIndices.some(
							(index, ordinal) => index !== selector.stringIndices[ordinal],
						) ||
						selector.stringIndices.length === 0 ||
						selector.stringIndices.length > 8 ||
						selector.accesses.length === 0 ||
						selector.accesses.some((access) => {
							const instruction = instructions[access.ip];
							return access.kind === "load"
								? instruction?.opcode !== "LOAD_PROPERTY"
								: instruction?.opcode !== "STORE_PROPERTY";
						})
					);
				}) ||
				new Set(payloadIps).size !== payloadIps.length ||
				payloadIps.length !== claimedIps.length ||
				payloadIps.some((ip) => !claimedIps.includes(ip)) ||
				region.cost.score !==
					resolvedSelectors.reduce(
						(total, selector) =>
							total + selector.stringIndices.length + selector.accesses.length,
						0,
					) ||
				region.cost.metadataOperations !== payloadIps.length
			) {
				continue;
			}
			regions.push({
				kind: "finite-property-selector",
				license: {
					guard: { dependencies: [], obligations: ["fallback"] },
					genericTwin: "retained",
					materialization: "none",
				},
				representation: "finite-property-domain",
				composition: "overlay",
				anchors: anchors as [number, number],
				claimedIps: claimedIps as Array<number>,
				controlFlow: {
					ordinaryBlockIps: ordinaryBlockIps as Array<number>,
					exceptionalHandlerIps: [],
				},
				cost: { ...region.cost },
				runtimeGuard: "integer-domain-and-shape-or-generic-access",
				selectors: resolvedSelectors,
			});
			continue;
		}
		if (region.kind === "exact-fresh-array") {
			const allocationIp = instructionIndexByIrInstruction.get(region.anchors[0]);
			const anchorAccessIp = instructionIndexByIrInstruction.get(region.anchors[1]);
			const accessIps = region.accesses.map((instruction) =>
				instructionIndexByIrInstruction.get(instruction),
			);
			const claimedIps = region.claimedInstructions.map((instruction) =>
				instructionIndexByIrInstruction.get(instruction),
			);
			const ordinaryBlockIps = region.controlFlow.ordinaryBlocks.map((blockIndex) =>
				blockStartIps.get(blockIndex),
			);
			if (
				region.license.guard !== "structural" ||
				region.license.genericTwin !== "retained" ||
				region.license.materialization !== "none" ||
				region.representation !== "exact-fresh-dense-elements" ||
				region.composition !== "overlay" ||
				region.runtimeGuard !== "dense-storage-or-generic-load" ||
				allocationIp === undefined ||
				anchorAccessIp === undefined ||
				accessIps.some((ip) => ip === undefined) ||
				claimedIps.some((ip) => ip === undefined) ||
				ordinaryBlockIps.some((ip) => ip === undefined) ||
				region.controlFlow.exceptionalBlocks.length !== 0
			) {
				continue;
			}
			const allocation = instructions[allocationIp];
			const resolvedAccessIps = accessIps as Array<number>;
			const resolvedClaimedIps = claimedIps as Array<number>;
			const payloadIps = [allocationIp, ...resolvedAccessIps];
			if (
				allocation?.opcode !== "CREATE_ARRAY" ||
				resolvedAccessIps.length === 0 ||
				resolvedAccessIps.length > 64 ||
				anchorAccessIp !== resolvedAccessIps[0] ||
				resolvedAccessIps.some((ip) => {
					const access = instructions[ip];
					return access?.opcode !== "LOAD_PROPERTY" || access.object !== allocation.dst;
				}) ||
				new Set(payloadIps).size !== payloadIps.length ||
				payloadIps.length !== resolvedClaimedIps.length ||
				payloadIps.some((ip) => !resolvedClaimedIps.includes(ip)) ||
				region.cost.score !== resolvedAccessIps.length ||
				region.cost.metadataOperations !== payloadIps.length
			) {
				continue;
			}
			regions.push({
				kind: "exact-fresh-array",
				license: {
					guard: { dependencies: [], obligations: ["fallback"] },
					genericTwin: "retained",
					materialization: "none",
				},
				representation: "exact-fresh-dense-elements",
				composition: "overlay",
				anchors: [allocationIp, anchorAccessIp],
				claimedIps: resolvedClaimedIps,
				controlFlow: {
					ordinaryBlockIps: ordinaryBlockIps as Array<number>,
					exceptionalHandlerIps: [],
				},
				cost: { ...region.cost },
				allocationIp,
				runtimeGuard: "dense-storage-or-generic-load",
				accessIps: resolvedAccessIps,
			});
			continue;
		}
		if (region.kind === "finite-object-construction") {
			const allocationIp = instructionIndexByIrInstruction.get(region.anchors[0]);
			const storeIp = instructionIndexByIrInstruction.get(region.anchors[1]);
			const claimedIps = region.claimedInstructions.map((instruction) =>
				instructionIndexByIrInstruction.get(instruction),
			);
			const accessIps = region.accesses.map((instruction) =>
				instructionIndexByIrInstruction.get(instruction),
			);
			const ordinaryBlockIps = region.controlFlow.ordinaryBlocks.map((blockIndex) =>
				blockStartIps.get(blockIndex),
			);
			if (
				region.license.guard !== "structural" ||
				region.license.genericTwin !== "retained" ||
				region.license.materialization !== "on-demand" ||
				region.representation !== "finite-key-object-slots" ||
				region.runtimeGuard !== "number-leaves-and-prototype-shape" ||
				region.controlFlow.ordinaryBlocks.length === 0 ||
				region.controlFlow.exceptionalBlocks.length !== 0 ||
				allocationIp === undefined ||
				storeIp === undefined ||
				claimedIps.some((ip) => ip === undefined) ||
				accessIps.some((ip) => ip === undefined) ||
				ordinaryBlockIps.some((ip) => ip === undefined)
			) {
				continue;
			}
			const allocation = instructions[allocationIp];
			const store = instructions[storeIp];
			const resolvedClaimedIps = claimedIps as Array<number>;
			const resolvedAccessIps = accessIps as Array<number>;
			const payloadIps = [allocationIp, storeIp, ...resolvedAccessIps];
			const numberGuards = region.anchors[0].registers.slice(1);
			const finiteKeysMatch = (instruction: IRInstruction): boolean => {
				const selector = finiteSelectorByAccess.get(instruction);
				return (
					selector !== undefined &&
					selector.stringIndices.length === region.keyStringIndices.length &&
					selector.stringIndices.every(
						(index, ordinal) => index === region.keyStringIndices[ordinal],
					)
				);
			};
			if (
				allocation?.opcode !== "CREATE_OBJECT" ||
				store?.opcode !== "STORE_PROPERTY" ||
				!finiteKeysMatch(region.anchors[1]) ||
				region.keyStringIndices.length === 0 ||
				region.keyStringIndices.length > 32 ||
				region.numberGuardCount !== numberGuards.length ||
				region.numberGuardCount < 0 ||
				region.numberGuardCount > 4 ||
				region.virtualRecord !== resolvedAccessIps.length > 0 ||
				resolvedAccessIps.some(
					(ip, ordinal) =>
						instructions[ip]?.opcode !== "LOAD_PROPERTY" ||
						!finiteKeysMatch(region.accesses[ordinal]!),
				) ||
				new Set(payloadIps).size !== payloadIps.length ||
				payloadIps.length !== resolvedClaimedIps.length ||
				payloadIps.some((ip) => !resolvedClaimedIps.includes(ip)) ||
				region.cost.score !== region.keyStringIndices.length + resolvedAccessIps.length ||
				region.cost.metadataOperations !== payloadIps.length
			) {
				continue;
			}
			regions.push({
				kind: "finite-object-construction",
				license: {
					guard: { dependencies: [], obligations: ["fallback", "materialize"] },
					genericTwin: "retained",
					materialization: "on-demand",
				},
				representation: "finite-key-object-slots",
				anchors: [allocationIp, storeIp],
				claimedIps: resolvedClaimedIps,
				controlFlow: {
					ordinaryBlockIps: ordinaryBlockIps as Array<number>,
					exceptionalHandlerIps: [],
				},
				cost: { ...region.cost },
				allocationIp,
				storeIp,
				icIndex: store.icIndex,
				numberGuards,
				keyStringIndices: [...region.keyStringIndices],
				virtualRecord: region.virtualRecord,
				accessIps: resolvedAccessIps,
				runtimeGuard: "number-leaves-and-prototype-shape",
			});
			continue;
		}
		if (region.kind === "numeric-fusion") {
			const anchors = region.anchors.map((instruction) =>
				instructionIndexByIrInstruction.get(instruction),
			);
			const claimedIps = region.claimedInstructions.map((instruction) =>
				instructionIndexByIrInstruction.get(instruction),
			);
			const ordinaryBlockIps = region.controlFlow.ordinaryBlocks.map((blockIndex) =>
				blockStartIps.get(blockIndex),
			);
			const pairs = region.pairs.map((pair) => ({
				...pair,
				firstIp: instructionIndexByIrInstruction.get(pair.first),
				finishIp: instructionIndexByIrInstruction.get(pair.finish),
			}));
			if (
				region.license.guard !== "structural" ||
				region.license.genericTwin !== "retained" ||
				region.license.materialization !== "none" ||
				region.representation !== "binary-pairs-f64" ||
				region.composition !== "overlay" ||
				region.runtimeGuard !== "number-operands" ||
				region.controlFlow.ordinaryBlocks.length === 0 ||
				region.controlFlow.exceptionalBlocks.length !== 0 ||
				anchors.some((ip) => ip === undefined) ||
				claimedIps.some((ip) => ip === undefined) ||
				ordinaryBlockIps.some((ip) => ip === undefined) ||
				pairs.length === 0 ||
				pairs.length > 32 ||
				pairs.some((pair) => pair.firstIp === undefined || pair.finishIp === undefined)
			) {
				continue;
			}
			const resolvedAnchors = anchors as Array<number>;
			const resolvedClaimedIps = claimedIps as Array<number>;
			const resolvedPairs = pairs as Array<
				(typeof pairs)[number] & { firstIp: number; finishIp: number }
			>;
			const payloadIps = resolvedPairs.flatMap((pair) => [pair.firstIp, pair.finishIp]);
			const startOperators = new Set([
				"+",
				"-",
				"*",
				"/",
				"%",
				"&",
				"|",
				"^",
				"<<",
				">>",
				">>>",
			]);
			const finishOperators = new Set([
				...startOperators,
				"<",
				"<=",
				">",
				">=",
				"==",
				"!=",
				"===",
				"!==",
			]);
			let valid =
				resolvedAnchors.length === 2 &&
				resolvedAnchors[0] === resolvedPairs[0]!.firstIp &&
				resolvedAnchors[1] === resolvedPairs[0]!.finishIp &&
				new Set(payloadIps).size === payloadIps.length &&
				payloadIps.length === resolvedClaimedIps.length &&
				payloadIps.every((ip) => resolvedClaimedIps.includes(ip)) &&
				region.cost.score === resolvedPairs.length &&
				region.cost.metadataOperations === payloadIps.length;
			for (const pair of resolvedPairs) {
				const first = instructions[pair.firstIp];
				const finish = instructions[pair.finishIp];
				if (
					first?.opcode !== "BINARY" ||
					finish?.opcode !== "BINARY" ||
					!startOperators.has(first.operator) ||
					!finishOperators.has(finish.operator) ||
					finish.nativeFiniteString !== undefined ||
					(pair.firstUsePosition !== 1 && pair.firstUsePosition !== 2) ||
					(pair.firstUsePosition === 1 ? finish.left : finish.right) !== first.dst ||
					pair.firstIp >= pair.finishIp
				) {
					valid = false;
				}
			}
			if (valid) {
				regions.push({
					kind: "numeric-fusion",
					license: {
						guard: { dependencies: [], obligations: ["fallback"] },
						genericTwin: "retained",
						materialization: "none",
					},
					representation: "binary-pairs-f64",
					composition: "overlay",
					anchors: resolvedAnchors,
					claimedIps: resolvedClaimedIps,
					controlFlow: {
						ordinaryBlockIps: ordinaryBlockIps as Array<number>,
						exceptionalHandlerIps: [],
					},
					cost: { ...region.cost },
					runtimeGuard: "number-operands",
					pairs: resolvedPairs.map((pair) => ({
						firstIp: pair.firstIp,
						finishIp: pair.finishIp,
						firstUsePosition: pair.firstUsePosition,
					})),
				});
			}
			continue;
		}
		if (region.kind === "stack-object-plan") {
			const guard =
				region.license.guard.dependencies.length === 0
					? {
							dependencies: [] as Array<VmSemanticDependency>,
							obligations: [
								...new Set(
									region.license.guard.obligations.map(
										(obligation): VmGuardObligation => obligation.kind,
									),
								),
							],
						}
					: lowerGuardPlan(region.license.guard);
			const aggregateClaims = region.claimedInstructions.map((instruction) =>
				instructionIndexByIrInstruction.get(instruction),
			);
			const resolvedSites: Array<VmStackObjectPlanRegion["sites"][number]> = [];
			const payloadIps: Array<number> = [];
			let valid =
				guard !== undefined &&
				guard.obligations.includes("fallback") &&
				guard.obligations.includes("materialize") &&
				region.license.genericTwin === "retained" &&
				region.license.materialization === "on-demand" &&
				region.representation === "activation-local-fixed-shape-objects" &&
				region.sites.length > 0 &&
				region.sites.length <= 256 &&
				region.anchors.length === 1 &&
				region.anchors[0] === region.sites[0]!.allocation &&
				region.controlFlow.exceptionalBlocks.length === 0 &&
				aggregateClaims.every((ip) => ip !== undefined);
			for (const site of region.sites) {
				const allocationIp = instructionIndexByIrInstruction.get(site.allocation);
				const allocation =
					allocationIp === undefined ? undefined : instructions[allocationIp];
				const accesses = site.accesses.map((access) => ({
					ip: instructionIndexByIrInstruction.get(access.instruction),
					slot: access.slot,
				}));
				const inheritedAccessIp =
					site.inheritedAccess === undefined
						? undefined
						: instructionIndexByIrInstruction.get(site.inheritedAccess);
				const materializations = site.materializations.map((materialization) => ({
					ip: instructionIndexByIrInstruction.get(materialization.instruction),
					kind: materialization.kind,
				}));
				if (
					allocationIp === undefined ||
					(allocation?.opcode !== "CREATE_OBJECT" &&
						allocation?.opcode !== "CREATE_OBJECT_SHAPED") ||
					(allocation.opcode === "CREATE_OBJECT"
						? site.slotCount !== 0
						: allocation.count !== site.slotCount) ||
					accesses.some(
						(access) =>
							access.ip === undefined ||
							access.slot < 0 ||
							access.slot >= site.slotCount ||
							(instructions[access.ip]?.opcode !== "LOAD_PROPERTY_STATIC" &&
								instructions[access.ip]?.opcode !== "STORE_PROPERTY_STATIC"),
					) ||
					(site.inheritedAccess !== undefined &&
						(inheritedAccessIp === undefined ||
							instructions[inheritedAccessIp]?.opcode !== "LOAD_PROPERTY_STATIC")) ||
					materializations.some(
						(materialization) =>
							materialization.ip === undefined ||
							materialization.kind !== "return" ||
							instructions[materialization.ip]?.opcode !== "RETURN",
					)
				) {
					valid = false;
					break;
				}
				const resolvedAccesses = accesses as Array<{ ip: number; slot: number }>;
				const resolvedMaterializations = materializations as Array<{
					ip: number;
					kind: "return";
				}>;
				const sitePayload = [
					allocationIp,
					...resolvedAccesses.map((access) => access.ip),
					...(inheritedAccessIp === undefined ? [] : [inheritedAccessIp]),
					...resolvedMaterializations.map((materialization) => materialization.ip),
				];
				if (new Set(sitePayload).size !== sitePayload.length || sitePayload.length > 64) {
					valid = false;
					break;
				}
				payloadIps.push(...sitePayload);
				resolvedSites.push({
					allocationIp,
					slotCount: site.slotCount,
					accesses: resolvedAccesses,
					...(inheritedAccessIp === undefined ? {} : { inheritedAccessIp }),
					materializations: resolvedMaterializations,
				});
			}
			const resolvedAggregateClaims = aggregateClaims as Array<number>;
			if (
				!valid ||
				new Set(payloadIps).size !== payloadIps.length ||
				new Set(resolvedAggregateClaims).size !== resolvedAggregateClaims.length ||
				payloadIps.length !== resolvedAggregateClaims.length ||
				payloadIps.some((ip) => !resolvedAggregateClaims.includes(ip)) ||
				payloadIps.some((ip) => claimedRegionInstructions.has(ip)) ||
				region.cost.metadataOperations !== payloadIps.length ||
				region.cost.score !==
					region.sites.reduce((total, site) => total + Math.max(1, site.slotCount), 0)
			) {
				continue;
			}
			const shards: Array<Array<VmStackObjectPlanRegion["sites"][number]>> = [];
			let shard: Array<VmStackObjectPlanRegion["sites"][number]> = [];
			let shardClaimCount = 0;
			for (const site of resolvedSites) {
				const claimCount =
					1 +
					site.accesses.length +
					(site.inheritedAccessIp === undefined ? 0 : 1) +
					site.materializations.length;
				if (shard.length >= 8 || shardClaimCount + claimCount > 64) {
					shards.push(shard);
					shard = [];
					shardClaimCount = 0;
				}
				shard.push(site);
				shardClaimCount += claimCount;
			}
			if (shard.length > 0) shards.push(shard);
			if (shards.length > 32 || regions.length + shards.length > 40) continue;
			for (const sites of shards) {
				const claimedIps = sites.flatMap((site) => [
					site.allocationIp,
					...site.accesses.map((access) => access.ip),
					...(site.inheritedAccessIp === undefined ? [] : [site.inheritedAccessIp]),
					...site.materializations.map((materialization) => materialization.ip),
				]);
				for (const ip of claimedIps) claimedRegionInstructions.add(ip);
				regions.push({
					kind: "stack-object-plan",
					license: {
						guard: guard!,
						genericTwin: "retained",
						materialization: "on-demand",
					},
					representation: "activation-local-fixed-shape-objects",
					anchors: sites.map((site) => site.allocationIp),
					claimedIps,
					controlFlow: { ordinaryBlockIps: claimedIps, exceptionalHandlerIps: [] },
					cost: {
						score: sites.reduce((total, site) => total + Math.max(1, site.slotCount), 0),
						metadataOperations: claimedIps.length,
					},
					sites,
				});
			}
			continue;
		}
		const guard = lowerGuardPlan(region.license.guard);
		const anchors = region.anchors.map((instruction) =>
			instructionIndexByIrInstruction.get(instruction),
		);
		const claimedIps = region.claimedInstructions.map((instruction) =>
			instructionIndexByIrInstruction.get(instruction),
		);
		const ordinaryBlockIps = region.controlFlow.ordinaryBlocks.map((block) =>
			blockStartIps.get(block),
		);
		const exceptionalHandlerIps = region.controlFlow.exceptionalBlocks.map((block) =>
			blockStartIps.get(block),
		);
		if (
			guard === undefined ||
			region.license.genericTwin !== "retained" ||
			anchors.some((ip) => ip === undefined) ||
			claimedIps.some((ip) => ip === undefined) ||
			ordinaryBlockIps.some((ip) => ip === undefined) ||
			region.controlFlow.ordinaryBlocks.length === 0 ||
			new Set(region.controlFlow.ordinaryBlocks).size !==
				region.controlFlow.ordinaryBlocks.length ||
			exceptionalHandlerIps.some((ip) => ip === undefined) ||
			(region.kind !== "regexp-iterator-projection" &&
				region.kind !== "string-slice-number" &&
				region.controlFlow.exceptionalBlocks.length !== 0) ||
			!Number.isSafeInteger(region.cost.score) ||
			region.cost.score <= 0 ||
			region.cost.score > 0xffff_ffff ||
			!Number.isSafeInteger(region.cost.metadataOperations) ||
			region.cost.metadataOperations <= 0 ||
			region.cost.metadataOperations > 96 ||
			region.claimedInstructions.length === 0 ||
			region.claimedInstructions.length > 96 ||
			region.controlFlow.ordinaryBlocks.length > 64 ||
			region.controlFlow.exceptionalBlocks.length > 64
		) {
			continue;
		}
		const resolvedAnchors = anchors as Array<number>;
		const resolvedClaimedIps = claimedIps as Array<number>;
		const resolvedOrdinaryBlockIps = ordinaryBlockIps as Array<number>;
		const resolvedExceptionalHandlerIps = exceptionalHandlerIps as Array<number>;
		if (
			new Set(resolvedAnchors).size !== resolvedAnchors.length ||
			new Set(resolvedClaimedIps).size !== resolvedClaimedIps.length ||
			new Set(resolvedOrdinaryBlockIps).size !== resolvedOrdinaryBlockIps.length ||
			new Set(resolvedExceptionalHandlerIps).size !==
				resolvedExceptionalHandlerIps.length ||
			resolvedOrdinaryBlockIps.some((ip) => ip < 0 || ip >= instructions.length) ||
			resolvedExceptionalHandlerIps.some(
				(ip) =>
					ip < 0 ||
					ip >= instructions.length ||
					resolvedOrdinaryBlockIps.includes(ip) ||
					!handlers.some((handler) => handler.handlerIp === ip),
			) ||
			resolvedClaimedIps.some((ip) => {
				const active = handlers
					.filter((handler) => ip >= handler.startIp && ip < handler.endIp)
					.map((handler) => handler.handlerIp);
				return active.some(
					(handlerIp) => !resolvedExceptionalHandlerIps.includes(handlerIp),
				);
			}) ||
			resolvedExceptionalHandlerIps.some((handlerIp) =>
				resolvedClaimedIps.every(
					(ip) =>
						!handlers.some(
							(handler) =>
								handler.handlerIp === handlerIp &&
								ip >= handler.startIp &&
								ip < handler.endIp,
						),
				),
			) ||
			resolvedClaimedIps.some((ip) => claimedRegionInstructions.has(ip))
		) {
			continue;
		}

		switch (region.kind) {
			case "cardinality-array": {
				const allocationIp = resolvedAnchors[0];
				const pushCallIp = resolvedAnchors[1];
				const itemAllocationIp = resolvedAnchors[2];
				const accesses = region.accesses.map((access) => ({
					ip: instructionIndexByIrInstruction.get(access.instruction),
					role: access.role,
					...(access.fieldSlot === undefined ? {} : { fieldSlot: access.fieldSlot }),
				}));
				if (
					region.representation !== "bounded-record-history" ||
					region.license.materialization !== "whole-region" ||
					!guard.obligations.includes("fallback") ||
					!guard.obligations.includes("materialize") ||
					resolvedAnchors.length !== 3 ||
					accesses.length === 0 ||
					accesses.some((access) => access.ip === undefined)
				) {
					continue;
				}
				const resolvedAccesses = accesses as Array<{
					ip: number;
					role: "push" | "length" | "element" | "field";
					fieldSlot?: number;
				}>;
				const allocation = instructions[allocationIp!];
				const push = instructions[pushCallIp!];
				const item = instructions[itemAllocationIp!];
				const argument =
					push?.opcode === "CALL" && push.arguments[0] !== undefined
						? decodeVmValueOperand(push.arguments[0])
						: undefined;
				const payloadIps = [
					allocationIp!,
					pushCallIp!,
					itemAllocationIp!,
					...resolvedAccesses.map((access) => access.ip),
				];
				const itemProofIps = resolvedClaimedIps.filter((ip) => !payloadIps.includes(ip));
				if (
					allocation?.opcode !== "CREATE_ARRAY" ||
					allocation.length !== 0 ||
					push?.opcode !== "CALL" ||
					push.arguments.length !== 1 ||
					argument?.kind !== "register" ||
					item?.opcode !== "CREATE_OBJECT_SHAPED" ||
					argument.register !== item.dst ||
					region.itemStackObjectProof !== "closed-fixed-shape" ||
					item.count <= 0 ||
					item.count > 8 ||
					!Number.isSafeInteger(region.maximumLength) ||
					region.maximumLength <= 0 ||
					region.maximumLength > 32 ||
					!resolvedAccesses.some((access) => access.role === "push") ||
					!resolvedAccesses.some(
						(access) => access.role === "length" || access.role === "element",
					) ||
					resolvedAccesses.some((access) => {
						const instruction = instructions[access.ip];
						if (
							instruction?.opcode !== "LOAD_PROPERTY" &&
							instruction?.opcode !== "LOAD_PROPERTY_STATIC"
						) {
							return true;
						}
						if (access.role === "element") {
							return instruction.opcode !== "LOAD_PROPERTY";
						}
						if (access.role === "field") {
							return (
								access.fieldSlot === undefined ||
								access.fieldSlot < 0 ||
								access.fieldSlot >= item.count
							);
						}
						return access.fieldSlot !== undefined;
					}) ||
					new Set(payloadIps).size !== payloadIps.length ||
					new Set(resolvedClaimedIps).size !== resolvedClaimedIps.length ||
					payloadIps.some((ip) => !resolvedClaimedIps.includes(ip)) ||
					itemProofIps.some((ip) => {
						const instruction = instructions[ip];
						return (
							(instruction?.opcode !== "LOAD_PROPERTY_STATIC" &&
								instruction?.opcode !== "STORE_PROPERTY_STATIC") ||
							instruction.object !== item.dst
						);
					}) ||
					region.cost.score !== region.maximumLength * item.count ||
					region.cost.metadataOperations !== resolvedClaimedIps.length
				) {
					continue;
				}
				for (const ip of resolvedClaimedIps) claimedRegionInstructions.add(ip);
				regions.push({
					kind: "cardinality-array",
					license: {
						guard,
						genericTwin: "retained",
						materialization: "whole-region",
					},
					representation: "bounded-record-history",
					anchors: resolvedAnchors,
					claimedIps: resolvedClaimedIps,
					controlFlow: {
						ordinaryBlockIps: resolvedOrdinaryBlockIps,
						exceptionalHandlerIps: [],
					},
					cost: region.cost,
					allocationIp: allocationIp!,
					pushCallIp: pushCallIp!,
					itemAllocationIp: itemAllocationIp!,
					maximumLength: region.maximumLength,
					accesses: resolvedAccesses,
				});
				break;
			}
			case "closed-record-array": {
				const allocationIp = resolvedAnchors[0];
				const producerObjectIp = resolvedAnchors[1];
				const elementLoadIps = region.elementLoads.map((instruction) =>
					instructionIndexByIrInstruction.get(instruction),
				);
				const accesses = region.accesses.map((access) => ({
					ip: instructionIndexByIrInstruction.get(access.instruction),
					kind: access.kind,
					slot: access.slot,
				}));
				if (
					region.representation !== "dense-record-elements-known-slots" ||
					region.license.materialization !== "none" ||
					resolvedAnchors.length !== 2 ||
					elementLoadIps.some((ip) => ip === undefined) ||
					accesses.some((access) => access.ip === undefined)
				) {
					continue;
				}
				const allocation = instructions[allocationIp!];
				const producerObject = instructions[producerObjectIp!];
				const resolvedElementLoadIps = elementLoadIps as Array<number>;
				const resolvedAccesses = accesses as Array<{
					ip: number;
					kind: "load" | "store";
					slot: number;
				}>;
				const payloadIps = [allocationIp!, producerObjectIp!, ...resolvedElementLoadIps];
				for (const access of resolvedAccesses) payloadIps.push(access.ip);
				if (
					allocation?.opcode !== "CREATE_ARRAY" ||
					allocation.length !== 0 ||
					producerObject?.opcode !== "CREATE_OBJECT_SHAPED" ||
					producerObject.count === 0 ||
					producerObject.count > 64 ||
					producerObject.count !== producerObject.keyStringIndices.length ||
					region.length <= 0 ||
					region.length > 65_536 ||
					resolvedElementLoadIps.length === 0 ||
					resolvedAccesses.length < 2 ||
					region.cost.metadataOperations !==
						resolvedElementLoadIps.length + resolvedAccesses.length ||
					resolvedElementLoadIps.some(
						(ip) => instructions[ip]?.opcode !== "LOAD_PROPERTY",
					) ||
					resolvedAccesses.some((access) => {
						const instruction = instructions[access.ip];
						return (
							access.slot < 0 ||
							access.slot >= producerObject.count ||
							(access.kind === "load"
								? instruction?.opcode !== "LOAD_PROPERTY_STATIC"
								: instruction?.opcode !== "STORE_PROPERTY_STATIC")
						);
					}) ||
					new Set(payloadIps).size !== payloadIps.length ||
					payloadIps.length !== resolvedClaimedIps.length ||
					payloadIps.some((ip) => !resolvedClaimedIps.includes(ip))
				) {
					continue;
				}
				for (const ip of resolvedClaimedIps) claimedRegionInstructions.add(ip);
				regions.push({
					kind: "closed-record-array",
					license: {
						guard,
						genericTwin: "retained",
						materialization: "none",
					},
					representation: "dense-record-elements-known-slots",
					anchors: resolvedAnchors,
					claimedIps: resolvedClaimedIps,
					controlFlow: {
						ordinaryBlockIps: resolvedOrdinaryBlockIps,
						exceptionalHandlerIps: [],
					},
					cost: region.cost,
					length: region.length,
					elementLoadIps: resolvedElementLoadIps,
					accesses: resolvedAccesses,
				});
				break;
			}
			case "regexp-exec-projection": {
				const callIp = resolvedAnchors[0];
				const firstAliasIp = resolvedAnchors[1];
				const firstLoadIp = resolvedAnchors[2];
				const propertyIp = instructionIndexByIrInstruction.get(region.property);
				const aliasMoveIps = region.aliasMoves.map((candidate) =>
					instructionIndexByIrInstruction.get(candidate),
				);
				const nullChecks = region.nullChecks.map((check) => ({
					comparisonIp: instructionIndexByIrInstruction.get(check.comparison),
					nullIp: instructionIndexByIrInstruction.get(check.nullValue),
				}));
				const lockedLiteral =
					region.lockedLiteral === undefined
						? undefined
						: {
								constructorIntrinsicIp: instructionIndexByIrInstruction.get(
									region.lockedLiteral.constructorIntrinsic,
								),
								constructIp: instructionIndexByIrInstruction.get(
									region.lockedLiteral.construct,
								),
							};
				const loads = region.loads.map((load) => {
					const consumer = load.consumer;
					return {
						ip: instructionIndexByIrInstruction.get(load.instruction),
						keyIp: instructionIndexByIrInstruction.get(load.key),
						captureIndex: load.captureIndex,
						dst: load.instruction.registers[0],
						consumer:
							consumer === undefined
								? undefined
								: consumer.kind === "length"
									? {
											kind: consumer.kind,
											propertyIp: instructionIndexByIrInstruction.get(consumer.property),
										}
									: consumer.kind === "charCodeAtZero"
										? {
												kind: consumer.kind,
												propertyIp: instructionIndexByIrInstruction.get(
													consumer.property,
												),
												callIp: instructionIndexByIrInstruction.get(consumer.call),
												...(consumer.zero === undefined
													? {}
													: {
															zeroIp: instructionIndexByIrInstruction.get(consumer.zero),
														}),
											}
										: consumer.kind === "number"
											? {
													kind: consumer.kind,
													intrinsicIp: instructionIndexByIrInstruction.get(
														consumer.intrinsic,
													),
													callIp: instructionIndexByIrInstruction.get(consumer.call),
												}
											: {
													kind: consumer.kind,
													upperPropertyIp: instructionIndexByIrInstruction.get(
														consumer.upperProperty,
													),
													upperCallIp: instructionIndexByIrInstruction.get(
														consumer.upperCall,
													),
													lowerPropertyIp: instructionIndexByIrInstruction.get(
														consumer.lowerProperty,
													),
													lowerIcIndex: propertyIcIndexByInstruction.get(
														consumer.lowerProperty,
													),
													lowerCallIp: instructionIndexByIrInstruction.get(
														consumer.lowerCall,
													),
													resultMoveIps: consumer.resultMoves.map((move) =>
														instructionIndexByIrInstruction.get(move),
													),
													lengthPropertyIp: instructionIndexByIrInstruction.get(
														consumer.lengthProperty,
													),
												},
					};
				});
				const unresolved =
					propertyIp === undefined ||
					aliasMoveIps.some((ip) => ip === undefined) ||
					nullChecks.some(
						(check) => check.comparisonIp === undefined || check.nullIp === undefined,
					) ||
					(lockedLiteral !== undefined &&
						(lockedLiteral.constructorIntrinsicIp === undefined ||
							lockedLiteral.constructIp === undefined)) ||
					loads.some(
						(load) =>
							load.ip === undefined ||
							load.keyIp === undefined ||
							(load.consumer !== undefined &&
								Object.values(load.consumer).some((value) => value === undefined)) ||
							(load.consumer?.kind === "asciiCaseLength" &&
								load.consumer.resultMoveIps.some((ip) => ip === undefined)),
					);
				if (
					unresolved ||
					region.representation !== "regexp-capture-spans" ||
					region.license.materialization !== "whole-region" ||
					!guard.obligations.includes("fallback") ||
					!guard.obligations.includes("materialize") ||
					region.lastIndexEffect !== "retained-call-twin" ||
					resolvedAnchors.length !== 3
				) {
					continue;
				}
				const resolvedPropertyIp = propertyIp;
				const resolvedAliasMoveIps = aliasMoveIps as Array<number>;
				const resolvedNullChecks = nullChecks as Array<{
					comparisonIp: number;
					nullIp: number;
				}>;
				const resolvedLockedLiteral = lockedLiteral as
					| { constructorIntrinsicIp: number; constructIp: number }
					| undefined;
				const resolvedLoads = loads as Array<
					VmRegExpExecProjectionRegion["loads"][number]
				>;
				const loweredCall = instructions[callIp!];
				const loweredProperty = instructions[resolvedPropertyIp];
				const loweredFirstAlias = instructions[firstAliasIp!];
				const aliases = new Set<number>([
					loweredCall?.opcode === "CALL" ? loweredCall.dst : -1,
				]);
				let operationsValid =
					loweredCall?.opcode === "CALL" &&
					loweredCall.arguments.length === 1 &&
					loweredCall.guardedBuiltinCall?.operation === "RegExp.prototype.exec" &&
					loweredProperty?.opcode === "LOAD_PROPERTY_STATIC" &&
					loweredProperty.dst === loweredCall.callee &&
					loweredProperty.object === loweredCall.thisValue &&
					resolvedPropertyIp + 1 === callIp &&
					loweredFirstAlias?.opcode === "MOVE" &&
					loweredFirstAlias.src === loweredCall.dst;
				for (const aliasIp of resolvedAliasMoveIps) {
					const move = instructions[aliasIp];
					if (move?.opcode !== "MOVE" || !aliases.has(move.src)) {
						operationsValid = false;
						break;
					}
					aliases.add(move.dst);
				}
				for (const check of resolvedNullChecks) {
					const comparison = instructions[check.comparisonIp];
					const nullValue = instructions[check.nullIp];
					if (
						comparison?.opcode !== "BINARY" ||
						(comparison.operator !== "===" && comparison.operator !== "!==") ||
						nullValue?.opcode !== "CREATE_NULL" ||
						(!aliases.has(comparison.left) && !aliases.has(comparison.right)) ||
						(comparison.left !== nullValue.dst && comparison.right !== nullValue.dst)
					) {
						operationsValid = false;
					}
				}
				for (const load of resolvedLoads) {
					const capture = instructions[load.ip];
					const key = instructions[load.keyIp];
					if (
						capture?.opcode !== "LOAD_PROPERTY" ||
						!aliases.has(capture.object) ||
						capture.dst !== load.dst ||
						key?.opcode !== "CREATE_NUMBER" ||
						key.dst !== capture.key ||
						key.value !== load.captureIndex ||
						!Number.isInteger(load.captureIndex) ||
						load.captureIndex <= 0 ||
						load.captureIndex > 0xffff
					) {
						operationsValid = false;
						continue;
					}
					const consumer = load.consumer;
					if (consumer?.kind === "length") {
						const property = instructions[consumer.propertyIp];
						operationsValid &&=
							property?.opcode === "LOAD_PROPERTY_STATIC" && property.object === load.dst;
					} else if (consumer?.kind === "charCodeAtZero") {
						const property = instructions[consumer.propertyIp];
						const call = instructions[consumer.callIp];
						operationsValid &&=
							property?.opcode === "LOAD_PROPERTY_STATIC" &&
							property.object === load.dst &&
							call?.opcode === "CALL" &&
							call.callee === property.dst &&
							call.thisValue === load.dst &&
							call.arguments.length === 1;
					} else if (consumer?.kind === "number") {
						const intrinsic = instructions[consumer.intrinsicIp];
						const call = instructions[consumer.callIp];
						operationsValid &&=
							intrinsic?.opcode === "LOAD_INTRINSIC" &&
							intrinsic.intrinsic === "Number" &&
							call?.opcode === "CALL" &&
							call.callee === intrinsic.dst &&
							call.arguments.length === 1;
					} else if (consumer?.kind === "asciiCaseLength") {
						operationsValid &&=
							instructions[consumer.upperPropertyIp]?.opcode === "LOAD_PROPERTY_STATIC" &&
							instructions[consumer.upperCallIp]?.opcode === "CALL" &&
							instructions[consumer.lowerPropertyIp]?.opcode === "LOAD_PROPERTY_STATIC" &&
							instructions[consumer.lowerCallIp]?.opcode === "CALL" &&
							instructions[consumer.lengthPropertyIp]?.opcode ===
								"LOAD_PROPERTY_STATIC" &&
							consumer.resultMoveIps.every((ip) => instructions[ip]?.opcode === "MOVE");
					}
				}
				if (resolvedLockedLiteral !== undefined) {
					operationsValid &&=
						guard.dependencies.every((dependency) => dependency.kind === "world") &&
						instructions[resolvedLockedLiteral.constructorIntrinsicIp]?.opcode ===
							"LOAD_INTRINSIC" &&
						instructions[resolvedLockedLiteral.constructIp]?.opcode === "CONSTRUCT";
				}
				const payloadIps = new Set<number>([resolvedPropertyIp, callIp!]);
				for (const ip of resolvedAliasMoveIps) payloadIps.add(ip);
				for (const check of resolvedNullChecks) {
					payloadIps.add(check.comparisonIp);
					payloadIps.add(check.nullIp);
				}
				if (resolvedLockedLiteral !== undefined) {
					payloadIps.add(resolvedLockedLiteral.constructorIntrinsicIp);
					payloadIps.add(resolvedLockedLiteral.constructIp);
				}
				for (const load of resolvedLoads) {
					payloadIps.add(load.ip);
					payloadIps.add(load.keyIp);
					const consumer = load.consumer;
					if (consumer?.kind === "length") payloadIps.add(consumer.propertyIp);
					else if (consumer?.kind === "charCodeAtZero") {
						payloadIps.add(consumer.propertyIp);
						payloadIps.add(consumer.callIp);
						if (consumer.zeroIp !== undefined) payloadIps.add(consumer.zeroIp);
					} else if (consumer?.kind === "number") {
						payloadIps.add(consumer.intrinsicIp);
						payloadIps.add(consumer.callIp);
					} else if (consumer?.kind === "asciiCaseLength") {
						payloadIps.add(consumer.upperPropertyIp);
						payloadIps.add(consumer.upperCallIp);
						payloadIps.add(consumer.lowerPropertyIp);
						payloadIps.add(consumer.lowerCallIp);
						for (const ip of consumer.resultMoveIps) payloadIps.add(ip);
						payloadIps.add(consumer.lengthPropertyIp);
					}
				}
				if (
					!operationsValid ||
					loweredCall?.opcode !== "CALL" ||
					firstAliasIp !== resolvedAliasMoveIps[0] ||
					firstLoadIp !== resolvedLoads[0]?.ip ||
					resolvedLoads.length === 0 ||
					resolvedLoads.length > 8 ||
					new Set(resolvedLoads.map((load) => load.captureIndex)).size !==
						resolvedLoads.length ||
					region.cost.metadataOperations !== payloadIps.size ||
					payloadIps.size !== resolvedClaimedIps.length ||
					resolvedClaimedIps.some((ip) => !payloadIps.has(ip))
				) {
					continue;
				}
				for (const ip of resolvedClaimedIps) claimedRegionInstructions.add(ip);
				regions.push({
					kind: "regexp-exec-projection",
					license: { guard, genericTwin: "retained", materialization: "whole-region" },
					representation: "regexp-capture-spans",
					anchors: resolvedAnchors,
					claimedIps: resolvedClaimedIps,
					controlFlow: {
						ordinaryBlockIps: resolvedOrdinaryBlockIps,
						exceptionalHandlerIps: [],
					},
					cost: region.cost,
					propertyIp: resolvedPropertyIp,
					callIp: callIp!,
					lockedFreshLiteral: resolvedLockedLiteral !== undefined,
					...(resolvedLockedLiteral === undefined
						? {}
						: { lockedLiteral: resolvedLockedLiteral }),
					callee: loweredCall.callee,
					receiver: loweredCall.thisValue,
					input: loweredCall.arguments[0]!,
					result: loweredCall.dst,
					aliasMoveIps: resolvedAliasMoveIps,
					nullChecks: resolvedNullChecks,
					lastIndexEffect: "retained-call-twin",
					loads: resolvedLoads,
				});
				break;
			}
			case "regexp-iterator-projection": {
				const stepIp = resolvedAnchors[0];
				const doneBranchIp = resolvedAnchors[1];
				const firstLoadIp = resolvedAnchors[2];
				const exitIp = blockStartIps.get(region.exitBlock);
				const aliasMoveIps = region.aliasMoves.map((move) =>
					instructionIndexByIrInstruction.get(move),
				);
				const loads = region.loads.map((load) => ({
					ip: instructionIndexByIrInstruction.get(load.instruction),
					keyIp: instructionIndexByIrInstruction.get(load.key),
					captureIndex: load.captureIndex,
					dst: load.instruction.registers[0],
					numberIntrinsicIp: instructionIndexByIrInstruction.get(load.numberIntrinsic),
					numberCallIp: instructionIndexByIrInstruction.get(load.numberCall),
				}));
				if (
					region.representation !== "regexp-iterator-capture-spans" ||
					region.license.materialization !== "on-demand" ||
					!guard.obligations.includes("fallback") ||
					!guard.obligations.includes("materialize") ||
					region.statefulEffect !== "iterator-last-index-retained-step" ||
					region.runtimeGuard !== "exact-brand-next-realm-regexp" ||
					resolvedAnchors.length !== 3 ||
					exitIp === undefined ||
					aliasMoveIps.some((ip) => ip === undefined) ||
					loads.some(
						(load) =>
							load.ip === undefined ||
							load.keyIp === undefined ||
							load.numberIntrinsicIp === undefined ||
							load.numberCallIp === undefined,
					)
				) {
					continue;
				}
				const resolvedAliasMoveIps = aliasMoveIps as Array<number>;
				const resolvedLoads = loads as Array<
					VmRegExpIteratorProjectionRegion["loads"][number]
				>;
				const step = instructions[stepIp!];
				const doneBranch = instructions[doneBranchIp!];
				const aliases = new Set<number>([
					step?.opcode === "ITERATOR_STEP" ? step.valueDst : -1,
				]);
				let operationsValid =
					step?.opcode === "ITERATOR_STEP" &&
					doneBranch?.opcode === "JUMP_IF" &&
					doneBranchIp === stepIp! + 1 &&
					doneBranch.cond === step.doneDst &&
					doneBranch.targetIp === exitIp;
				for (const aliasIp of resolvedAliasMoveIps) {
					const move = instructions[aliasIp];
					if (move?.opcode !== "MOVE" || !aliases.has(move.src)) {
						operationsValid = false;
						break;
					}
					aliases.add(move.dst);
				}
				for (const load of resolvedLoads) {
					const capture = instructions[load.ip];
					const key = instructions[load.keyIp];
					const intrinsic = instructions[load.numberIntrinsicIp];
					const numberCall = instructions[load.numberCallIp];
					const argument =
						numberCall?.opcode === "CALL" && numberCall.arguments[0] !== undefined
							? decodeVmValueOperand(numberCall.arguments[0])
							: undefined;
					operationsValid &&=
						capture?.opcode === "LOAD_PROPERTY" &&
						aliases.has(capture.object) &&
						capture.dst === load.dst &&
						key?.opcode === "CREATE_NUMBER" &&
						key.dst === capture.key &&
						key.value === load.captureIndex &&
						Number.isInteger(load.captureIndex) &&
						load.captureIndex > 0 &&
						load.captureIndex <= 0xffff &&
						intrinsic?.opcode === "LOAD_INTRINSIC" &&
						intrinsic.intrinsic === "Number" &&
						numberCall?.opcode === "CALL" &&
						numberCall.callee === intrinsic.dst &&
						numberCall.arguments.length === 1 &&
						argument?.kind === "register" &&
						argument.register === load.dst;
				}
				const payloadIps = new Set<number>([stepIp!, doneBranchIp!]);
				for (const ip of resolvedAliasMoveIps) payloadIps.add(ip);
				for (const load of resolvedLoads) {
					payloadIps.add(load.ip);
					payloadIps.add(load.keyIp);
					payloadIps.add(load.numberIntrinsicIp);
					payloadIps.add(load.numberCallIp);
				}
				if (
					!operationsValid ||
					step?.opcode !== "ITERATOR_STEP" ||
					firstLoadIp !== resolvedLoads[0]?.ip ||
					resolvedLoads.length === 0 ||
					resolvedLoads.length > 8 ||
					new Set(resolvedLoads.map((load) => load.captureIndex)).size !==
						resolvedLoads.length ||
					region.cost.metadataOperations !== payloadIps.size ||
					payloadIps.size !== resolvedClaimedIps.length ||
					resolvedClaimedIps.some((ip) => !payloadIps.has(ip))
				) {
					continue;
				}
				for (const ip of resolvedClaimedIps) claimedRegionInstructions.add(ip);
				regions.push({
					kind: "regexp-iterator-projection",
					license: { guard, genericTwin: "retained", materialization: "on-demand" },
					representation: "regexp-iterator-capture-spans",
					anchors: resolvedAnchors,
					claimedIps: resolvedClaimedIps,
					controlFlow: {
						ordinaryBlockIps: resolvedOrdinaryBlockIps,
						exceptionalHandlerIps: resolvedExceptionalHandlerIps,
					},
					cost: region.cost,
					stepIp: stepIp!,
					doneBranchIp: doneBranchIp!,
					exitIp,
					iterator: step.iterator,
					next: step.next,
					value: step.valueDst,
					done: step.doneDst,
					aliasMoveIps: resolvedAliasMoveIps,
					statefulEffect: "iterator-last-index-retained-step",
					runtimeGuard: "exact-brand-next-realm-regexp",
					loads: resolvedLoads,
				});
				break;
			}
			case "string-slice-number": {
				const sliceCallIp = resolvedAnchors[0];
				const numberCallIp = resolvedAnchors[1];
				const propertyIp = instructionIndexByIrInstruction.get(region.property);
				const numberIntrinsicIp = instructionIndexByIrInstruction.get(
					region.numberIntrinsic,
				);
				if (
					region.representation !== "primitive-string-span-number" ||
					region.license.materialization !== "none" ||
					!guard.obligations.includes("fallback") ||
					guard.obligations.includes("materialize") ||
					resolvedAnchors.length !== 2 ||
					propertyIp === undefined ||
					numberIntrinsicIp === undefined
				) {
					continue;
				}
				const property = instructions[propertyIp];
				const sliceCall = instructions[sliceCallIp!];
				const numberIntrinsic = instructions[numberIntrinsicIp];
				const numberCall = instructions[numberCallIp!];
				const sliceStart =
					sliceCall?.opcode === "CALL" && sliceCall.arguments[0] !== undefined
						? decodeVmValueOperand(sliceCall.arguments[0])
						: undefined;
				const numberArgument =
					numberCall?.opcode === "CALL" && numberCall.arguments[0] !== undefined
						? decodeVmValueOperand(numberCall.arguments[0])
						: undefined;
				const payloadIps = new Set([
					propertyIp,
					sliceCallIp!,
					numberIntrinsicIp,
					numberCallIp!,
				]);
				if (
					property?.opcode !== "LOAD_PROPERTY_STATIC" ||
					String.fromCharCode(...(stringConstants[property.stringIndex] ?? [])) !==
						"slice" ||
					sliceCall?.opcode !== "CALL" ||
					!vmCallProvesBuiltin(sliceCall, "String.prototype.slice", {
						lowering: "number-consumer-fusion",
						result: "string",
						effects: ["coerce", "allocate", "throw", "safepoint"],
					}) ||
					sliceCall.arguments.length !== 1 ||
					property.dst !== sliceCall.callee ||
					property.object !== sliceCall.thisValue ||
					propertyIp + 1 !== sliceCallIp ||
					sliceCallIp + 1 !== numberCallIp ||
					sliceStart?.kind !== "number" ||
					!Object.is(sliceStart.value, region.sliceStart) ||
					!Number.isFinite(region.sliceStart) ||
					numberIntrinsic?.opcode !== "LOAD_INTRINSIC" ||
					numberIntrinsic.intrinsic !== "Number" ||
					numberCall?.opcode !== "CALL" ||
					numberCall.callee !== numberIntrinsic.dst ||
					numberCall.arguments.length !== 1 ||
					numberArgument?.kind !== "register" ||
					numberArgument.register !== sliceCall.dst ||
					region.cost.metadataOperations !== payloadIps.size ||
					payloadIps.size !== resolvedClaimedIps.length ||
					resolvedClaimedIps.some((ip) => !payloadIps.has(ip))
				) {
					continue;
				}
				for (const ip of resolvedClaimedIps) claimedRegionInstructions.add(ip);
				regions.push({
					kind: "string-slice-number",
					license: { guard, genericTwin: "retained", materialization: "none" },
					representation: "primitive-string-span-number",
					anchors: resolvedAnchors,
					claimedIps: resolvedClaimedIps,
					controlFlow: {
						ordinaryBlockIps: resolvedOrdinaryBlockIps,
						exceptionalHandlerIps: resolvedExceptionalHandlerIps,
					},
					cost: region.cost,
					propertyIp,
					sliceCallIp: sliceCallIp,
					numberIntrinsicIp,
					numberCallIp: numberCallIp,
					numberCallee: numberCall.callee,
					receiver: sliceCall.thisValue,
					sliceStart: region.sliceStart,
					result: numberCall.dst,
				});
				break;
			}
			case "string-split-projection": {
				const callIp = resolvedAnchors[0];
				const firstLoadIp = resolvedAnchors[1];
				const propertyIp =
					region.property === undefined
						? -1
						: instructionIndexByIrInstruction.get(region.property);
				const aliasMoveIps = region.aliasMoves.map((instruction) =>
					instructionIndexByIrInstruction.get(instruction),
				);
				const loads = region.loads.map((load) => ({
					ip: instructionIndexByIrInstruction.get(load.instruction),
					kind: load.kind,
					...(load.kind === "element" ? { index: load.index } : {}),
					dst: load.instruction.registers[0],
				}));
				if (
					region.representation !== "projected-elements" ||
					region.license.materialization !== "whole-region" ||
					!guard.obligations.includes("fallback") ||
					!guard.obligations.includes("materialize") ||
					resolvedAnchors.length !== 2 ||
					propertyIp === undefined ||
					aliasMoveIps.some((ip) => ip === undefined) ||
					loads.some((load) => load.ip === undefined)
				) {
					continue;
				}
				const loweredCall = instructions[callIp!];
				const loweredProperty = propertyIp < 0 ? undefined : instructions[propertyIp];
				const resolvedAliasMoveIps = (aliasMoveIps as Array<number>).sort(
					(left, right) => left - right,
				);
				const resolvedLoads = loads as Array<{
					ip: number;
					kind: "element" | "length";
					index?: number;
					dst: number;
				}>;
				resolvedLoads.sort((left, right) => left.ip - right.ip);
				const stringConstantEquals = (index: number, value: string): boolean => {
					const constant = stringConstants[index];
					return (
						constant?.length === value.length &&
						constant.every((codeUnit, offset) => codeUnit === value.charCodeAt(offset))
					);
				};
				const latestDefinition = (
					register: number,
					beforeIp: number,
				): VmInstruction | undefined => {
					for (let ip = beforeIp - 1; ip >= 0; ip--) {
						const candidate = instructions[ip]!;
						if (vmInstructionWriteRegisters(candidate).includes(register))
							return candidate;
					}
					return undefined;
				};
				const guardMatchesCall = (callGuard: VmGuardPlan | undefined): boolean => {
					const regionDependency = guard.dependencies[0];
					const callDependency = callGuard?.dependencies[0];
					return (
						guard.dependencies.length === 1 &&
						callGuard?.dependencies.length === 1 &&
						callGuard.obligations.length === 1 &&
						callGuard.obligations[0] === "fallback" &&
						regionDependency?.kind === callDependency?.kind &&
						(regionDependency?.kind === "world"
							? callDependency?.kind === "world" &&
								regionDependency.fact === callDependency.fact
							: regionDependency?.kind === "epoch" &&
								callDependency?.kind === "epoch" &&
								regionDependency.family === callDependency.family)
					);
				};
				const callMatches =
					loweredCall?.opcode === "CALL"
						? guardMatchesCall(loweredCall.guardedBuiltinCall?.guard) &&
							(guard.dependencies[0]?.kind === "world" ||
								(guard.dependencies[0]?.kind === "epoch" &&
									guard.dependencies[0]?.family === "watched-methods")) &&
							propertyIp >= 0 &&
							loweredProperty?.opcode === "LOAD_PROPERTY_STATIC" &&
							loweredProperty.dst === loweredCall.callee &&
							loweredProperty.object === loweredCall.thisValue &&
							stringConstantEquals(loweredProperty.stringIndex, "split") &&
							loweredCall.guardedBuiltinCall?.operation === "String.prototype.split"
						: loweredCall?.opcode === "CALL_BUILTIN" &&
							guard.dependencies.length === 1 &&
							guard.dependencies[0]?.kind === "world" &&
							propertyIp === -1 &&
							loweredCall.operation === "String.prototype.split";
				const separator =
					(loweredCall?.opcode === "CALL" || loweredCall?.opcode === "CALL_BUILTIN") &&
					loweredCall.arguments.length === 1
						? decodeVmValueOperand(loweredCall.arguments[0]!)
						: undefined;
				const separatorMatches =
					separator?.kind === "string"
						? separator.index === region.separatorStringIndex
						: separator?.kind === "register"
							? (() => {
									const definition = latestDefinition(separator.register, callIp!);
									return (
										definition?.opcode === "CREATE_STRING" &&
										definition.stringIndex === region.separatorStringIndex
									);
								})()
							: false;
				const elementLoads = resolvedLoads.filter((load) => load.kind === "element");
				const lengthLoads = resolvedLoads.filter((load) => load.kind === "length");
				const aliases = new Map<number, VmInstruction>();
				if (loweredCall?.opcode === "CALL" || loweredCall?.opcode === "CALL_BUILTIN") {
					aliases.set(loweredCall.dst, loweredCall);
				}
				const projectionOperations = [
					...resolvedAliasMoveIps.map((ip) => ({ ip, kind: "alias" as const })),
					...resolvedLoads.map((load) => ({ ip: load.ip, kind: "load" as const, load })),
				].sort((left, right) => left.ip - right.ip);
				let operationsValid = true;
				for (const operation of projectionOperations) {
					const lowered = instructions[operation.ip];
					if (operation.kind === "alias") {
						if (
							lowered?.opcode !== "MOVE" ||
							!aliases.has(lowered.src) ||
							latestDefinition(lowered.src, operation.ip) !== aliases.get(lowered.src)
						) {
							operationsValid = false;
							break;
						}
						aliases.set(lowered.dst, lowered);
					} else {
						const load = operation.load;
						if (
							(lowered?.opcode !== "LOAD_PROPERTY" &&
								lowered?.opcode !== "LOAD_PROPERTY_STATIC") ||
							!aliases.has(lowered.object) ||
							latestDefinition(lowered.object, operation.ip) !==
								aliases.get(lowered.object) ||
							lowered.dst !== load.dst
						) {
							operationsValid = false;
							break;
						}
						if (load.kind === "element") {
							const key =
								lowered.opcode === "LOAD_PROPERTY"
									? latestDefinition(lowered.key, operation.ip)
									: undefined;
							if (
								lowered.opcode !== "LOAD_PROPERTY" ||
								!Number.isInteger(load.index) ||
								load.index! < 0 ||
								load.index! > 0xffff ||
								key?.opcode !== "CREATE_NUMBER" ||
								key.value !== load.index
							) {
								operationsValid = false;
								break;
							}
						} else if (
							lowered.opcode !== "LOAD_PROPERTY_STATIC" ||
							load.index !== undefined ||
							!stringConstantEquals(lowered.stringIndex, "length")
						) {
							operationsValid = false;
							break;
						}
					}
				}
				const payloadIps = [
					...(propertyIp < 0 ? [] : [propertyIp]),
					callIp!,
					...resolvedAliasMoveIps,
					...resolvedLoads.map((load) => load.ip),
				];
				if (
					!callMatches ||
					loweredCall === undefined ||
					(loweredCall.opcode !== "CALL" && loweredCall.opcode !== "CALL_BUILTIN") ||
					loweredCall.arguments.length !== 1 ||
					!separatorMatches ||
					region.separatorStringIndex < 0 ||
					(stringConstants[region.separatorStringIndex]?.length ?? 0) === 0 ||
					firstLoadIp !== resolvedLoads[0]?.ip ||
					elementLoads.length === 0 ||
					elementLoads.length > 8 ||
					lengthLoads.length > 1 ||
					new Set(elementLoads.map((load) => load.index)).size !== elementLoads.length ||
					!operationsValid ||
					region.cost.metadataOperations !== payloadIps.length ||
					new Set(payloadIps).size !== payloadIps.length ||
					payloadIps.length !== resolvedClaimedIps.length ||
					payloadIps.some((ip) => !resolvedClaimedIps.includes(ip))
				) {
					continue;
				}
				for (const ip of resolvedClaimedIps) claimedRegionInstructions.add(ip);
				regions.push({
					kind: "string-split-projection",
					license: {
						guard,
						genericTwin: "retained",
						materialization: "whole-region",
					},
					representation: "projected-elements",
					anchors: resolvedAnchors,
					claimedIps: resolvedClaimedIps,
					controlFlow: {
						ordinaryBlockIps: resolvedOrdinaryBlockIps,
						exceptionalHandlerIps: [],
					},
					cost: region.cost,
					propertyIp,
					callIp: callIp!,
					callee: loweredCall.opcode === "CALL" ? loweredCall.callee : -1,
					receiver: loweredCall.thisValue,
					separatorStringIndex: region.separatorStringIndex,
					result: loweredCall.dst,
					aliasMoveIps: resolvedAliasMoveIps,
					loads: resolvedLoads,
				});
				break;
			}
			case "string-split-cursor": {
				const callIp = resolvedAnchors[0];
				const resultAliasIp = resolvedAnchors[1];
				const lengthIp = resolvedAnchors[2];
				const backedgeIp = resolvedAnchors[3];
				const propertyIp =
					region.property === undefined
						? -1
						: instructionIndexByIrInstruction.get(region.property);
				const elementIp = instructionIndexByIrInstruction.get(region.element);
				const trimPropertyIp = instructionIndexByIrInstruction.get(region.trimProperty);
				const trimCallIp = instructionIndexByIrInstruction.get(region.trimCall);
				const exitIp = blockStartIps.get(region.exitBlock);
				const trimIcIndex = propertyIcIndexByInstruction.get(region.trimProperty);
				const primitiveStringLengthIps = region.primitiveStringLengths.map((load) =>
					instructionIndexByIrInstruction.get(load),
				);
				if (
					region.representation !== "split-cursor-spans" ||
					region.license.materialization !== "on-demand" ||
					!guard.obligations.includes("fallback") ||
					!guard.obligations.includes("materialize") ||
					resolvedAnchors.length !== 4 ||
					propertyIp === undefined ||
					elementIp === undefined ||
					trimPropertyIp === undefined ||
					trimCallIp === undefined ||
					exitIp === undefined ||
					trimIcIndex === undefined ||
					primitiveStringLengthIps.some((ip) => ip === undefined)
				) {
					continue;
				}
				const loweredCall = instructions[callIp!];
				const loweredResultAlias = instructions[resultAliasIp!];
				const loweredLength = instructions[lengthIp!];
				const loweredElement = instructions[elementIp];
				if (
					(loweredCall?.opcode !== "CALL" && loweredCall?.opcode !== "CALL_BUILTIN") ||
					loweredCall.arguments.length !== 1 ||
					loweredResultAlias?.opcode !== "MOVE" ||
					loweredResultAlias.src !== loweredCall.dst ||
					loweredLength?.opcode !== "LOAD_PROPERTY_STATIC" ||
					loweredLength.object !== loweredResultAlias.dst ||
					loweredElement?.opcode !== "LOAD_PROPERTY" ||
					loweredElement.object !== loweredResultAlias.dst
				) {
					continue;
				}
				const resolvedPrimitiveStringLengthIps =
					primitiveStringLengthIps as Array<number>;
				const payloadIps = [
					...(propertyIp < 0 ? [] : [propertyIp]),
					callIp!,
					resultAliasIp!,
					lengthIp!,
					lengthIp! + 1,
					lengthIp! + 2,
					lengthIp! + 3,
					elementIp,
					trimPropertyIp,
					trimCallIp,
					...resolvedPrimitiveStringLengthIps,
					backedgeIp! - 1,
					backedgeIp!,
				];
				if (
					region.cost.metadataOperations !== payloadIps.length ||
					new Set(payloadIps).size !== payloadIps.length ||
					payloadIps.length !== resolvedClaimedIps.length ||
					payloadIps.some((ip) => !resolvedClaimedIps.includes(ip))
				) {
					continue;
				}
				for (const ip of resolvedClaimedIps) claimedRegionInstructions.add(ip);
				regions.push({
					kind: "string-split-cursor",
					license: {
						guard,
						genericTwin: "retained",
						materialization: "on-demand",
					},
					representation: "split-cursor-spans",
					anchors: resolvedAnchors,
					claimedIps: resolvedClaimedIps,
					controlFlow: {
						ordinaryBlockIps: resolvedOrdinaryBlockIps,
						exceptionalHandlerIps: [],
					},
					cost: region.cost,
					propertyIp,
					callee: loweredCall.opcode === "CALL" ? loweredCall.callee : -1,
					receiver: loweredCall.thisValue,
					separator: loweredCall.arguments[0]!,
					result: loweredCall.dst,
					index: region.compare.registers[1],
					elementIp,
					trimPropertyIp,
					trimIcIndex,
					trimCallIp,
					primitiveStringLengthIps: resolvedPrimitiveStringLengthIps,
					exitIp,
				});
				break;
			}
			case "numeric-hof": {
				const initialMoveIp = resolvedAnchors[0];
				const elementIp = resolvedAnchors[1];
				const backedgeIp = resolvedAnchors[2];
				const loopExitIp = resolvedAnchors[3];
				const initialMove = instructions[initialMoveIp!];
				const element = instructions[elementIp!];
				const backedge = instructions[backedgeIp!];
				const loopExit = instructions[loopExitIp!];
				const completion =
					loopExit?.opcode === "JUMP" ? instructions[loopExit.targetIp] : undefined;
				if (
					region.representation !== "numeric-reduce-f64" ||
					region.license.materialization !== "none" ||
					!guard.obligations.includes("fallback") ||
					resolvedAnchors.length !== 4 ||
					region.method !== "reduce" ||
					region.pollPolicy !== "end-only-no-preempt" ||
					initialMove?.opcode !== "MOVE" ||
					element?.opcode !== "LOAD_PROPERTY" ||
					backedge?.opcode !== "JUMP" ||
					loopExit?.opcode !== "JUMP" ||
					(completion?.opcode === "MOVE" && completion.src !== initialMove.dst) ||
					region.operations.length === 0 ||
					region.operations.length > 32 ||
					region.cost.metadataOperations !== resolvedClaimedIps.length
				) {
					continue;
				}

				let receiver: number;
				let dispatch: VmNumericHofRegion["dispatch"];
				let dispatchIps: Array<number>;
				if (region.dispatch.kind === "guarded") {
					const guardCallIp = instructionIndexByIrInstruction.get(
						region.dispatch.eligibility,
					);
					const slowCallIp = instructionIndexByIrInstruction.get(
						region.dispatch.slowCall,
					);
					const guardCall =
						guardCallIp === undefined ? undefined : instructions[guardCallIp];
					const slowCall =
						slowCallIp === undefined ? undefined : instructions[slowCallIp];
					const receiverOperand =
						guardCall?.opcode === "CALL"
							? decodeVmValueOperand(guardCall.arguments[1]!)
							: undefined;
					const slowReceiverOperand =
						slowCall?.opcode === "CALL"
							? decodeVmValueOperand(slowCall.thisValue)
							: undefined;
					if (
						guardCallIp === undefined ||
						slowCallIp === undefined ||
						guardCall?.opcode !== "CALL" ||
						slowCall?.opcode !== "CALL" ||
						receiverOperand?.kind !== "register" ||
						slowReceiverOperand?.kind !== "register" ||
						slowReceiverOperand.register !== receiverOperand.register
					) {
						continue;
					}
					receiver = receiverOperand.register;
					dispatch = { kind: "guarded", guardCallIp, slowCallIp };
					dispatchIps = [guardCallIp, slowCallIp];
				} else {
					const receiverAllocationIp = instructionIndexByIrInstruction.get(
						region.dispatch.receiverAllocation,
					);
					const allocation =
						receiverAllocationIp === undefined
							? undefined
							: instructions[receiverAllocationIp];
					if (
						receiverAllocationIp === undefined ||
						allocation?.opcode !== "CREATE_ARRAY" ||
						!guard.dependencies.every((dependency) => dependency.kind === "world") ||
						receiverAllocationIp >= initialMoveIp!
					) {
						continue;
					}
					receiver = allocation.dst;
					dispatch = { kind: "closed", receiverAllocationIp };
					dispatchIps = [receiverAllocationIp];
				}
				if (
					element.object !== receiver ||
					dispatchIps.some((ip) => !resolvedClaimedIps.includes(ip))
				) {
					continue;
				}
				for (const ip of resolvedClaimedIps) claimedRegionInstructions.add(ip);
				regions.push({
					kind: "numeric-hof",
					license: {
						guard,
						genericTwin: "retained",
						materialization: "none",
					},
					representation: "numeric-reduce-f64",
					anchors: resolvedAnchors,
					claimedIps: resolvedClaimedIps,
					controlFlow: {
						ordinaryBlockIps: resolvedOrdinaryBlockIps,
						exceptionalHandlerIps: [],
					},
					cost: region.cost,
					method: "reduce",
					dispatch,
					callbackFunctionIndex: region.callbackFunctionIndex,
					receiver,
					initialValue: region.initialValue,
					pollPolicy: "end-only-no-preempt",
					operations: region.operations,
					resultOperand: region.resultOperand,
				});
				break;
			}
		}
	}
	for (const pending of pendingNativeMathCalls) {
		const receiverIp = instructionIndexByIrInstruction.get(pending.receiver);
		const propertyIp = instructionIndexByIrInstruction.get(pending.property);
		if (
			receiverIp === undefined ||
			propertyIp === undefined ||
			!instructions.includes(pending.call)
		) {
			throw new Error("Known builtin generic twin was removed before lowering");
		}
		pending.call.nativeMathExactProducerTwin = { receiverIp, propertyIp };
	}
	// Classified length/legacy index reads form an entry prefix. Frame creation
	// snapshots that prefix before parameter initialization and starts interpretation
	// after it. Fused static reads retain arguments for their lazy missing-index path.
	let argumentSnapshotCount = 0;
	while (
		instructions[argumentSnapshotCount]?.opcode === "LOAD_ARGUMENT_COUNT" ||
		instructions[argumentSnapshotCount]?.opcode === "LOAD_ARGUMENT"
	) {
		argumentSnapshotCount++;
	}
	const needsArguments =
		computeArgumentRetentionLimit({
			argumentSnapshotCount,
			instructions,
		}) >= 0;
	const argumentSnapshotPlan = buildArgumentSnapshotPlan({
		argumentSnapshotCount,
		instructions,
		parameterCount: fn.parameterCount,
		registerCount: fn.nextRegisterDestination,
	});

	// GC root-frame minimization (C1): the native backend spills only registers
	// live at a safepoint, not every boxed register. The aggregate-only API avoids
	// constructing diagnostic per-safepoint Sets. This runs post-allocation, so a
	// complexity fallback safely returns every physical register. Skipped for
	// generator/async functions, which the native backend does not compile.
	const isResumable = (fn.isGenerator ?? false) || (fn.isAsync ?? false);
	const gcRootRegisters = isResumable
		? undefined
		: [...computeSafepointRoots(fn).registers];

	return {
		nameStringIndex: fn.nameStringIndex,
		isGenerator: fn.isGenerator ?? false,
		isAsync: fn.isAsync ?? false,
		parameterCount: fn.parameterCount,
		mappedArguments: fn.mappedArguments ?? false,
		mappedArgumentSlots: fn.mappedArgumentSlots ?? [],
		length: fn.length,
		registerCount: fn.nextRegisterDestination,
		capturedCount: fn.nextCapturedIndex,
		strict: fn.strict ?? fn.semanticFile.strict,
		needsArguments,
		argumentSnapshotCount,
		argumentSnapshotPlan,
		isDerivedConstructor:
			(fn.classContext?.isConstructor ?? false) &&
			(fn.classContext?.isDerivedConstructor ?? false),
		isClassConstructor: fn.classContext?.isConstructor ?? false,
		hasPrototype: fn.hasPrototype ?? true,
		instructions,
		handlers,
		fileIndex,
		positions,
		compilerSiteIds: compilerSiteIds.some((site) => site !== undefined)
			? compilerSiteIds
			: undefined,
		gcRootRegisters,
		regions: regions.length > 0 ? regions : undefined,
	};
}

/**
 * Map the IR to the VM instruction set.
 */
function lowerGuardPlan(plan: CompilerGuardPlan): VmGuardPlan | undefined {
	const dependencies: Array<VmSemanticDependency> = [];
	for (const dependency of plan.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencies.push({ kind: "world", fact: "primordials.locked" });
			continue;
		}
		if (dependency.kind === "epoch") {
			dependencies.push({ kind: "epoch", family: dependency.family });
			continue;
		}
		return undefined;
	}
	const obligations = [
		...new Set(
			plan.obligations.map(
				(obligation): VmGuardObligation =>
					obligation.kind === "fallback" ? "fallback" : "materialize",
			),
		),
	];
	if (dependencies.length === 0 || obligations.length === 0) return undefined;
	return { dependencies, obligations };
}

function lowerGuardedBuiltinCall(
	instruction: Extract<IRInstruction, { type: "call" }>,
): VmGuardedBuiltinCall | undefined {
	const call = instruction.knownBuiltinCall;
	if (
		call === undefined ||
		call.identity.kind !== "known" ||
		!knownBuiltinCallProves(call, call.operation) ||
		!isVmGuardedBuiltinOperation(call.operation)
	) {
		return undefined;
	}
	const guard = lowerGuardPlan(call.identity.proof);
	if (guard === undefined || !guard.obligations.includes("fallback")) {
		return undefined;
	}
	return {
		operation: call.operation,
		guard,
	};
}

function lowerInstructionToVmInstruction(
	blockStartIps: Map<number, number>,
	instruction: IRInstruction,
): VmInstruction {
	switch (instruction.type) {
		case "sourcePos":
			// Markers are consumed into `positions` and stripped before this point.
			throw new Error("sourcePos marker must be stripped before lowering");
		case "move":
			return {
				opcode: "MOVE",
				dst: instruction.registers[0],
				src: instruction.registers[1],
			};
		case "return":
			return {
				opcode: "RETURN",
				value: instruction.registers[0],
			};
		case "jumpIf": {
			const targetIp = blockStartIps.get(instruction.blocks[0]);
			if (targetIp === undefined) {
				throw new Error(`Unknown jump target block ${instruction.blocks[0]}`);
			}

			return {
				opcode: "JUMP_IF",
				cond: instruction.registers[0],
				targetIp,
			};
		}
		case "jump": {
			const targetIp = blockStartIps.get(instruction.blocks[0]);
			if (targetIp === undefined) {
				throw new Error(`Unknown jump target block ${instruction.blocks[0]}`);
			}

			return {
				opcode: "JUMP",
				targetIp,
			};
		}
		case "createNumber":
			return {
				opcode: "CREATE_NUMBER",
				dst: instruction.registers[0],
				value: instruction.value,
			};
		case "createF64":
			return {
				opcode: "CREATE_F64",
				dst: instruction.registers[0],
				value: instruction.value,
			};
		case "createBoolean":
			return {
				opcode: "CREATE_BOOLEAN",
				dst: instruction.registers[0],
				value: instruction.value,
			};
		case "createString":
			return {
				opcode: "CREATE_STRING",
				dst: instruction.registers[0],
				stringIndex: instruction.stringIndex,
			};
		case "createBigint":
			return {
				opcode: "CREATE_BIGINT",
				dst: instruction.registers[0],
				bigintIndex: instruction.bigintIndex,
			};
		case "createObject":
			return {
				opcode: "CREATE_OBJECT",
				dst: instruction.registers[0],
			};
		case "createObjectShaped":
			return {
				opcode: "CREATE_OBJECT_SHAPED",
				dst: instruction.registers[0],
				count: instruction.registers.length - 1,
				keyStringIndices: instruction.keyStringIndices,
				valueRegisters: instruction.registers.slice(1),
				shapeCacheIndex: -1,
			};
		case "createArray": {
			return {
				opcode: "CREATE_ARRAY",
				dst: instruction.registers[0],
				length: instruction.length,
				nativeFreshDenseReserveLength: instruction.nativeFreshDenseReserveLength,
			};
		}
		case "instantiateLiteralTemplate":
			return {
				opcode: "INSTANTIATE_LITERAL_TEMPLATE",
				dst: instruction.registers[0],
				templateOffset: instruction.templateOffset,
			};
		case "createModuleNamespace":
			return {
				opcode: "CREATE_MODULE_NAMESPACE",
				dst: instruction.registers[0],
				nameIndices: instruction.exports.map((entry) => entry.nameStringIndex),
				slots: instruction.exports.map((entry) => entry.slot),
			};
		case "createTemplateObject":
			return {
				opcode: "CREATE_TEMPLATE_OBJECT",
				dst: instruction.registers[0],
				cacheSlot: instruction.cacheSlot,
				cookedIndices: instruction.cookedIndices,
				rawIndices: instruction.rawIndices,
			};
		case "createUndefined":
			return {
				opcode: "CREATE_UNDEFINED",
				dst: instruction.registers[0],
			};
		case "createEmpty":
			return {
				opcode: "CREATE_EMPTY",
				dst: instruction.registers[0],
			};
		case "createNull":
			return {
				opcode: "CREATE_NULL",
				dst: instruction.registers[0],
			};
		case "createFunction":
			return {
				opcode: "CREATE_FUNCTION",
				dst: instruction.registers[0],
				functionIndex: instruction.functionIndex,
			};
		case "createArgumentsObject":
			return {
				opcode: "CREATE_ARGUMENTS_OBJECT",
				dst: instruction.registers[0],
			};
		case "loadArgumentCount":
			return {
				opcode: "LOAD_ARGUMENT_COUNT",
				dst: instruction.registers[0],
			};
		case "loadArgument":
			return {
				opcode: "LOAD_ARGUMENT",
				dst: instruction.registers[0],
				index: instruction.index,
			};
		case "loadStaticArgument":
			return {
				opcode: "LOAD_STATIC_ARGUMENT",
				dst: instruction.registers[0],
				direct: instruction.registers[2],
				fallback: instruction.registers[1],
				index: instruction.index,
			};
		case "loadThis":
			return {
				opcode: "LOAD_THIS",
				dst: instruction.registers[0],
			};
		case "loadNewTarget":
			return {
				opcode: "LOAD_NEW_TARGET",
				dst: instruction.registers[0],
			};
		case "guardFunctionIndex":
			return {
				opcode: "GUARD_FUNCTION_INDEX",
				dst: instruction.registers[0],
				callee: instruction.registers[1],
				functionIndex: instruction.functionIndex,
			};
		case "loadCallee":
			return {
				opcode: "LOAD_CALLEE",
				dst: instruction.registers[0],
			};
		case "call":
			return {
				opcode: "CALL",
				dst: instruction.registers[0],
				callee: encodeVmValueOperand(
					instruction.registers[1],
					instruction.immediateValues?.[1],
				),
				thisValue: encodeVmValueOperand(
					instruction.registers[2],
					instruction.immediateValues?.[2],
				),
				argumentCount: instruction.registers.length - 3,
				arguments: instruction.registers
					.slice(3)
					.map((register, index) =>
						encodeVmValueOperand(register, instruction.immediateValues?.[index + 3]),
					),
				directFunctionIndex: instruction.directFunctionIndex,
				directFunctionCall: instruction.directFunctionCall,
				directCallTargetFunctionIndex: instruction.directCallTargetFunctionIndex,
				guardedBuiltinCall: lowerGuardedBuiltinCall(instruction),
				directStringCharCodeAtPosition: instruction.directStringCharCodeAtPosition,
			};
		case "mathUnaryNumber":
			return {
				opcode: "MATH_UNARY_NUMBER",
				dst: instruction.registers[0],
				src: instruction.registers[1],
				operation: vmMathUnaryNumberOperation(instruction.operation),
			};
		case "mathBinaryNumber":
			return {
				opcode: "MATH_BINARY_NUMBER",
				dst: instruction.registers[0],
				left: instruction.registers[1],
				right: instruction.registers[2],
				operation: vmMathBinaryNumberOperation(instruction.operation),
			};
		case "callBuiltin":
			return {
				opcode: "CALL_BUILTIN",
				dst: instruction.registers[0],
				thisValue: instruction.registers[1],
				argumentCount: instruction.registers.length - 2,
				arguments: instruction.registers.slice(2),
				operation: vmDirectBuiltinOperation(instruction.operation),
			};
		case "construct":
			return {
				opcode: "CONSTRUCT",
				dst: instruction.registers[0],
				callee: encodeVmValueOperand(
					instruction.registers[1],
					instruction.immediateValues?.[1],
				),
				argumentCount: instruction.registers.length - 2,
				arguments: instruction.registers
					.slice(2)
					.map((register, index) =>
						encodeVmValueOperand(register, instruction.immediateValues?.[index + 2]),
					),
				directFunctionIndex: instruction.directFunctionIndex,
			};
		case "throw":
			return {
				opcode: "THROW",
				value: instruction.registers[0],
			};
		case "catch":
			return {
				opcode: "CATCH",
				dst: instruction.registers[0],
			};
		case "tryBegin": {
			throw new Error("tryBegin marker must be stripped before lowering");
		}
		case "tryEnd":
			throw new Error("tryEnd marker must be stripped before lowering");
		case "generatorStart":
			return {
				opcode: "GENERATOR_START",
			};
		case "asyncStart":
			return {
				opcode: "ASYNC_START",
			};
		case "yield":
			if (instruction.terminal) {
				return {
					opcode: "TERMINAL_YIELD",
					yieldedSrc: instruction.registers[2],
				};
			}
			return {
				opcode: "YIELD",
				valueDst: instruction.registers[0],
				modeDst: instruction.registers[1],
				yieldedSrc: instruction.registers[2],
			};
		case "await":
			return {
				opcode: "AWAIT",
				valueDst: instruction.registers[0],
				modeDst: instruction.registers[1],
				awaitedSrc: instruction.registers[2],
			};
		case "loadIntrinsic":
			return {
				opcode: "LOAD_INTRINSIC",
				dst: instruction.registers[0],
				intrinsic: instruction.intrinsic,
			};
		case "loadCaptured":
			return {
				opcode: "LOAD_CAPTURED",
				dst: instruction.registers[0],
				ownerFunctionIndex: getInstructionFunctionIndex({
					type: instruction.type,
					functionIndex: instruction.functionIndex,
				}),
				index: instruction.index,
			};
		case "storeCaptured":
			return {
				opcode: "STORE_CAPTURED",
				src: instruction.registers[0],
				ownerFunctionIndex: getInstructionFunctionIndex({
					type: instruction.type,
					functionIndex: instruction.functionIndex,
				}),
				index: instruction.index,
			};
		case "envPush":
			return {
				opcode: "ENV_PUSH",
				scopeId: instruction.scopeId,
				slotCount: instruction.slotCount,
			};
		case "envCopy":
			return {
				opcode: "ENV_COPY",
				scopeId: instruction.scopeId,
				slotCount: instruction.slotCount,
			};
		case "envPop":
			return { opcode: "ENV_POP" };
		case "loadGlobal":
			return {
				opcode: "LOAD_GLOBAL",
				dst: instruction.registers[0],
				index: instruction.index,
			};
		case "storeGlobal":
			return {
				opcode: "STORE_GLOBAL",
				src: instruction.registers[0],
				index: instruction.index,
			};
		case "loadProperty": {
			const loadClosedGlobalGuard =
				instruction.nativeClosedGlobalTable === undefined
					? undefined
					: lowerGuardPlan(instruction.nativeClosedGlobalTable.guard);
			if (
				instruction.nativeClosedGlobalTable !== undefined &&
				loadClosedGlobalGuard === undefined
			) {
				throw new Error("Closed-global table lost its semantic guard");
			}
			return {
				opcode: "LOAD_PROPERTY",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				key: instruction.registers[2],
				icIndex: -1,
				nativeClosedGlobalTable:
					instruction.nativeClosedGlobalTable === undefined
						? undefined
						: {
								...instruction.nativeClosedGlobalTable,
								guard: loadClosedGlobalGuard!,
							},
			};
		}
		case "loadPropertyStatic":
			return {
				opcode: "LOAD_PROPERTY_STATIC",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				stringIndex: instruction.stringIndex,
				icIndex: -1,
				nativePrimitiveStringLength: instruction.nativePrimitiveStringLength,
			};
		case "loadSuperProperty":
			return {
				opcode: "LOAD_SUPER_PROPERTY",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				key: instruction.registers[2],
				receiver: instruction.registers[3],
			};
		case "storeProperty": {
			const storeClosedGlobalGuard =
				instruction.nativeClosedGlobalTable === undefined
					? undefined
					: lowerGuardPlan(instruction.nativeClosedGlobalTable.guard);
			if (
				instruction.nativeClosedGlobalTable !== undefined &&
				storeClosedGlobalGuard === undefined
			) {
				throw new Error("Closed-global table lost its semantic guard");
			}
			return {
				opcode: "STORE_PROPERTY",
				object: instruction.registers[0],
				key: instruction.registers[1],
				value: instruction.registers[2],
				icIndex: -1,
				nativeClosedGlobalTable:
					instruction.nativeClosedGlobalTable === undefined
						? undefined
						: {
								...instruction.nativeClosedGlobalTable,
								guard: storeClosedGlobalGuard!,
							},
			};
		}
		case "storePropertyStatic":
			return {
				opcode: "STORE_PROPERTY_STATIC",
				object: instruction.registers[0],
				value: instruction.registers[1],
				stringIndex: instruction.stringIndex,
				icIndex: -1,
			};
		case "toPropertyKey":
			return {
				opcode: "TO_PROPERTY_KEY",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				key: instruction.registers[2],
			};
		case "storeSuperProperty":
			return {
				opcode: "STORE_SUPER_PROPERTY",
				object: instruction.registers[0],
				key: instruction.registers[1],
				value: instruction.registers[2],
				receiver: instruction.registers[3],
			};
		case "loadPrototype":
			return {
				opcode: "LOAD_PROTOTYPE",
				dst: instruction.registers[0],
				object: instruction.registers[1],
			};
		case "getIterator":
			return {
				opcode: "GET_ITERATOR",
				iteratorDst: instruction.registers[0],
				nextDst: instruction.registers[1],
				source: instruction.registers[2],
			};
		case "getAsyncIterator":
			return {
				opcode: "GET_ASYNC_ITERATOR",
				iteratorDst: instruction.registers[0],
				nextDst: instruction.registers[1],
				source: instruction.registers[2],
			};
		case "iteratorNext":
			return {
				opcode: "ITERATOR_NEXT",
				resultDst: instruction.registers[0],
				iterator: instruction.registers[1],
				next: instruction.registers[2],
			};
		case "iteratorStep":
			return {
				opcode: "ITERATOR_STEP",
				valueDst: instruction.registers[0],
				doneDst: instruction.registers[1],
				iterator: instruction.registers[2],
				next: instruction.registers[3],
			};
		case "iteratorClose":
			return {
				opcode: "ITERATOR_CLOSE",
				iterator: instruction.registers[0],
				normal: instruction.normal === true,
			};
		case "forInKeys":
			return {
				opcode: "FOR_IN_KEYS",
				dst: instruction.registers[0],
				source: instruction.registers[1],
			};
		case "callSpread":
			return {
				opcode: "CALL_SPREAD",
				dst: instruction.registers[0],
				callee: instruction.registers[1],
				thisValue: instruction.registers[2],
				argumentsArray: instruction.registers[3],
			};
		case "callSpreadIterable":
			return {
				opcode: "CALL_SPREAD_ITERABLE",
				dst: instruction.registers[0],
				callee: instruction.registers[1],
				thisValue: instruction.registers[2],
				iterable: instruction.registers[3],
			};
		case "constructSpread":
			return {
				opcode: "CONSTRUCT_SPREAD",
				dst: instruction.registers[0],
				callee: instruction.registers[1],
				argumentsArray: instruction.registers[2],
			};
		case "constructSuper":
			return {
				opcode: "CONSTRUCT_SUPER",
				dst: instruction.registers[0],
				parent: instruction.registers[1],
				argumentsArray: instruction.registers[2],
			};
		case "constructSuperExplicit":
			return {
				opcode: "CONSTRUCT_SUPER_EXPLICIT",
				dst: instruction.registers[0],
				parent: instruction.registers[1],
				argumentsArray: instruction.registers[2],
				newTarget: instruction.registers[3],
			};
		case "setThis":
			return { opcode: "SET_THIS", value: instruction.registers[0] };
		case "mergeDataProperties":
			return {
				opcode: "MERGE_DATA_PROPERTIES",
				target: instruction.registers[0],
				src: instruction.registers[1],
			};
		case "deleteProperty":
			return {
				opcode: "DELETE_PROPERTY",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				key: instruction.registers[2],
			};
		case "defineAccessor":
			return {
				opcode: "DEFINE_ACCESSOR",
				object: instruction.registers[0],
				key: instruction.registers[1],
				accessor: instruction.registers[2],
				isSetter: instruction.kind === "set",
				enumerable: instruction.enumerable,
			};
		case "defineProperty":
			return {
				opcode: "DEFINE_PROPERTY",
				object: instruction.registers[0],
				key: instruction.registers[1],
				value: instruction.registers[2],
				enumerable: instruction.enumerable,
				writable: instruction.writable ?? true,
				configurable: instruction.configurable ?? true,
			};
		case "setFunctionName":
			return {
				opcode: "SET_FUNCTION_NAME",
				func: instruction.registers[0],
				key: instruction.registers[1],
				prefix:
					instruction.namePrefix === "get" ? 1 : instruction.namePrefix === "set" ? 2 : 0,
			};
		case "createPrivateName":
			return {
				opcode: "CREATE_PRIVATE_NAME",
				dst: instruction.registers[0],
			};
		case "createPrivateNames":
			return {
				opcode: "CREATE_PRIVATE_NAMES",
				ownerFunctionIndex: instruction.functionIndex,
				capturedIndices: instruction.capturedIndices,
			};
		case "definePrivate":
			return {
				opcode: "DEFINE_PRIVATE",
				object: instruction.registers[0],
				key: instruction.registers[1],
				value: instruction.registers[2],
			};
		case "initPrivateFields":
			return {
				opcode: "INIT_PRIVATE_FIELDS",
				object: instruction.registers[0],
				keyRegisters: instruction.registers.slice(1),
			};
		case "loadPrivate":
			return {
				opcode: "LOAD_PRIVATE",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				key: instruction.registers[2],
			};
		case "storePrivate":
			return {
				opcode: "STORE_PRIVATE",
				object: instruction.registers[0],
				key: instruction.registers[1],
				value: instruction.registers[2],
			};
		case "hasPrivate":
			return {
				opcode: "HAS_PRIVATE",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				key: instruction.registers[2],
			};
		case "setPrototype":
			return {
				opcode: "SET_PROTOTYPE",
				object: instruction.registers[0],
				prototype: instruction.registers[1],
				literal: instruction.literal,
			};
		case "loadUndeclared":
			return {
				opcode: "LOAD_UNDECLARED",
				dst: instruction.registers[0],
				nameStringIndex: instruction.nameStringIndex,
			};
		case "loadGlobalProperty":
			return {
				opcode: "LOAD_GLOBAL_PROPERTY",
				dst: instruction.registers[0],
				nameStringIndex: instruction.nameStringIndex,
			};
		case "storeGlobalProperty":
			return {
				opcode: "STORE_GLOBAL_PROPERTY",
				src: instruction.registers[0],
				nameStringIndex: instruction.nameStringIndex,
				declaration: instruction.declaration ?? false,
				declarationConfigurable: instruction.declarationConfigurable ?? false,
			};
		case "initGlobalVars":
			return {
				opcode: "INIT_GLOBAL_VARS",
				nameStringIndices: instruction.nameStringIndices,
				declarationConfigurable: instruction.declarationConfigurable,
			};
		case "throwIfTdz":
			return {
				opcode: "THROW_IF_TDZ",
				src: instruction.registers[0],
				nameStringIndex: instruction.nameStringIndex,
			};
		case "withEnter":
			return {
				opcode: "WITH_ENTER",
				object: instruction.registers[0],
			};
		case "withExit":
			return { opcode: "WITH_EXIT" };
		case "withGet":
			return {
				opcode: "WITH_GET",
				dst: instruction.registers[0],
				nameStringIndex: instruction.nameStringIndex,
			};
		case "withResolveBase":
			return {
				opcode: "WITH_RESOLVE_BASE",
				dst: instruction.registers[0],
				nameStringIndex: instruction.nameStringIndex,
			};
		case "withSet":
			return {
				opcode: "WITH_SET",
				found: instruction.registers[0],
				value: instruction.registers[1],
				nameStringIndex: instruction.nameStringIndex,
			};
		case "isEmpty":
			return {
				opcode: "IS_EMPTY",
				dst: instruction.registers[0],
				src: instruction.registers[1],
			};
		case "requireCoercible":
			return {
				opcode: "REQUIRE_COERCIBLE",
				src: instruction.registers[0],
			};
		case "checkSuperClass":
			return {
				opcode: "CHECK_SUPER_CLASS",
				parent: instruction.registers[0],
			};
		case "createRestArguments":
			return {
				opcode: "CREATE_REST_ARGUMENTS",
				dst: instruction.registers[0],
				startIndex: instruction.startIndex,
			};
		case "arrayRest":
			return {
				opcode: "ARRAY_REST",
				dst: instruction.registers[0],
				src: instruction.registers[1],
				startIndex: instruction.startIndex,
			};
		case "copyDataProperties":
			return {
				opcode: "COPY_DATA_PROPERTIES",
				dst: instruction.registers[0],
				src: instruction.registers[1],
				excludedCount: instruction.registers.length - 2,
				excluded: instruction.registers.slice(2),
			};
		case "binary": {
			return {
				opcode: "BINARY",
				dst: instruction.registers[0],
				left: instruction.registers[1],
				right: instruction.registers[2],
				operator: instruction.operator,
				...(instruction.nativeFiniteString === undefined
					? {}
					: {
							nativeFiniteString: {
								minimum: instruction.nativeFiniteString.minimum,
								stringIndices: [...instruction.nativeFiniteString.stringIndices],
							},
						}),
			};
		}
		case "unary":
			return {
				opcode: "UNARY",
				dst: instruction.registers[0],
				src: instruction.registers[1],
				operator: instruction.operator,
			};
		case "typeofCompare":
			return {
				opcode: "TYPEOF_COMPARE",
				dst: instruction.registers[0],
				src: instruction.registers[1],
				expected: instruction.expected,
				negated: instruction.negated,
			};
		case "loadLocal":
		case "storeLocal":
			throw new Error(`Unexpected non-optimized local instruction ${instruction.type}`);
	}

	throw new Error(`Unknown instruction ${(instruction as { type: string }).type}`);
}

function getInstructionFunctionIndex(instruction: {
	type: "loadCaptured" | "storeCaptured";
	functionIndex?: number;
}) {
	if (instruction.functionIndex === undefined) {
		throw new Error(`Missing function index for ${instruction.type}`);
	}

	return instruction.functionIndex;
}
