import type {
	CoreBuiltinIdentityDecision,
	CoreCollectionBuiltinOperation,
	CorePropertyPlacement,
} from "../core/core-ir-regions.ts";
import { builtinOperationDescriptor } from "../shared/builtin-registry.ts";
import type { CompilerFactFlowReport } from "../shared/compiler-diagnostics.ts";
import { compilerGuardPlan, knownBuiltinCallProves } from "../shared/compiler-facts.ts";
import type { CompilerGuardPlan, EffectKind } from "../shared/compiler-facts.ts";
import type {
	CompilerExactCollectionBrand,
	CompilerInstruction,
	CompilerNumericTypedArrayKind,
} from "../shared/compiler-instruction.ts";
import type { CompilerValueKindMask } from "../shared/compiler-value-kinds.ts";
import type { ExecutionFunction, ExecutionProgram } from "./execution-ir.ts";
import { collectCompilerFactFlowReport } from "./fact-flow-report.ts";
import { buildProfileMetadata } from "./profile-metadata.ts";
import type { CompilerRemark, ProfileSite } from "./profile-metadata.ts";
import {
	compactRuntimeImageConstants,
	decodeVmValueOperand,
	lowerVerifiedExecutionToRuntimePlan,
} from "./runtime-image.ts";
import type {
	BytecodeExceptionHandler,
	BytecodeFunction,
	BytecodeInstruction,
	RuntimeFunctionLoweringPlan,
	RuntimeImage,
	RuntimeImageConstantRetentionReport,
} from "./runtime-image.ts";

export const VM_GUARDED_BUILTIN_OPERATIONS = [
	"Array.prototype.push",
	"String.prototype.charCodeAt",
	"String.prototype.slice",
	"String.prototype.split",
	"String.prototype.trim",
	"Map.prototype.get",
	"Map.prototype.set",
	"Map.prototype.has",
	"Map.prototype.delete",
	"Set.prototype.add",
	"Set.prototype.has",
	"Set.prototype.delete",
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
	/**
	 * Where the license's semantic-epoch dependencies are admitted, and whether
	 * that one admission covers every licensed use. Core owns the interior proof;
	 * a backend reads this mode instead of rediscovering epoch stability from the
	 * emitted distance between an admission and a use.
	 */
	readonly admission: {
		readonly anchorIp: number;
		readonly mode: "capture" | "stable" | "per-use";
	};
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
	admission: VmRegionLicense["admission"],
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
		admission,
	};
}

/**
 * Check a Core `call-fallback` property placement against the emitted stream.
 * Core owns the proof that the load is unobservable and dead on the fast path;
 * what target lowering still owes is that a load deferred into the call really
 * produces that call's callee and runs under the same exception handlers, so
 * moving it cannot change where its own throw is caught.
 */
function vmPropertyPlacementHolds(
	placement: CorePropertyPlacement,
	propertyIp: number,
	callIp: number,
	instructions: ReadonlyArray<BytecodeInstruction>,
	handlers: ReadonlyArray<BytecodeExceptionHandler>,
): boolean {
	if (placement === "in-place") return true;
	if (placement !== "call-fallback") return false;
	const property = instructions[propertyIp];
	const call = instructions[callIp];
	if (property?.opcode !== "LOAD_PROPERTY_STATIC" || call?.opcode !== "CALL")
		return false;
	if (call.callee !== property.dst) return false;
	const covering = (ip: number): string =>
		handlers
			.filter((handler) => ip >= handler.startIp && ip < handler.endIp)
			.map((handler) => handler.handlerIp)
			.sort((left, right) => left - right)
			.join(",");
	return covering(propertyIp) === covering(callIp);
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
	readonly license: VmRegionLicense & {
		readonly materialization: Materialization;
	};
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

export type VmStringSplitCursorRegion = VmRegionEnvelope<
	"string-split-cursor",
	"split-cursor-spans",
	"on-demand"
> & {
	readonly propertyIp: number;
	readonly propertyPlacement: CorePropertyPlacement;
	readonly splitIdentity: CoreBuiltinIdentityDecision;
	readonly trimIdentity: CoreBuiltinIdentityDecision;
	readonly callee: number;
	readonly receiver: number;
	readonly separator: number;
	readonly resultRegisters: ReadonlyArray<number>;
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
	readonly propertyPlacement: CorePropertyPlacement;
	readonly splitIdentity: CoreBuiltinIdentityDecision;
	readonly callIp: number;
	readonly callee: number;
	readonly receiver: number;
	readonly separatorIp: number;
	readonly separatorStringIndex: number;
	readonly resultRegisters: ReadonlyArray<number>;
	readonly loads: ReadonlyArray<
		| {
				readonly ip: number;
				readonly kind: "element";
				readonly keyIp: number;
				readonly index: number;
				readonly dst: number;
		  }
		| {
				readonly ip: number;
				readonly kind: "length";
				readonly dst: number;
		  }
	>;
};

export type VmRegExpExecProjectionRegion = VmRegionEnvelope<
	"regexp-exec-projection",
	"regexp-capture-spans",
	"whole-region"
> & {
	readonly propertyIp: number;
	readonly propertyPlacement: CorePropertyPlacement;
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
	readonly resultRegisters: ReadonlyArray<number>;
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
					readonly methodIdentity: CoreBuiltinIdentityDecision;
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
					readonly methodIdentity: CoreBuiltinIdentityDecision;
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
	readonly resultRegisters: ReadonlyArray<number>;
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
	readonly propertyPlacement: CorePropertyPlacement;
	readonly builtinIdentities: CoreBuiltinIdentityDecision;
	readonly sliceCallIp: number;
	readonly sliceStartIp: number;
	readonly numberIntrinsicIp: number;
	readonly numberCallIp: number;
	readonly numberCallee: number;
	readonly receiver: number;
	readonly sliceStart: number;
	readonly result: number;
};

export type VmStringCharCodeAtChainRegion = VmRegionEnvelope<
	"string-char-code-at-chain",
	"primitive-string-code-unit",
	"none"
> & {
	readonly propertyIp: number;
	readonly callIp: number;
	readonly methodIdentity: CoreBuiltinIdentityDecision;
	readonly runtimeGuard: "primitive-string-number-position";
	readonly evaluationOrder: "capture-property-before-arguments";
	readonly propertyIcIndex: number;
	readonly callee: number;
	readonly receiver: number;
	readonly result: number;
};

export type VmBuiltinCollectionCallChainRegion = VmRegionEnvelope<
	"builtin-collection-call-chain",
	"captured-collection-method",
	"none"
> & {
	readonly propertyIp: number;
	readonly callIp: number;
	readonly operation: CoreCollectionBuiltinOperation;
	readonly runtimeGuard: "exact-collection-method";
	readonly evaluationOrder: "capture-property-before-arguments";
	readonly propertyIcIndex: number;
	readonly callee: number;
	readonly receiver: number;
	readonly result: number;
};

type VmIteratorCursorRegion<
	Kind extends
		| "array-values-iterator-cursor"
		| "string-iterator-cursor"
		| "typed-array-iterator-cursor"
		| "map-iterator-cursor"
		| "set-iterator-cursor",
	Representation extends string,
	Protocol extends "array-values" | "string" | "typed-array-values" | "map" | "set",
> = VmRegionEnvelope<Kind, Representation, "none"> & {
	readonly initializeIp: number;
	readonly stepIps: ReadonlyArray<number>;
	readonly iterator: number;
	readonly next: number;
	readonly protocol: Protocol;
	readonly runtimeGuard: "exact-iterator-brand-next-target";
	readonly stateSynchronization: "authoritative-language-object";
	readonly suspension: "forbidden";
};

export type VmArrayValuesIteratorCursorRegion = VmIteratorCursorRegion<
	"array-values-iterator-cursor",
	"array-values-authoritative-cursor",
	"array-values"
>;

export type VmStringIteratorCursorRegion = VmIteratorCursorRegion<
	"string-iterator-cursor",
	"string-authoritative-cursor",
	"string"
>;

export type VmTypedArrayIteratorCursorRegion = VmIteratorCursorRegion<
	"typed-array-iterator-cursor",
	"typed-array-authoritative-cursor",
	"typed-array-values"
>;

export type VmMapIteratorCursorRegion = VmIteratorCursorRegion<
	"map-iterator-cursor",
	"map-authoritative-cursor",
	"map"
>;

export type VmSetIteratorCursorRegion = VmIteratorCursorRegion<
	"set-iterator-cursor",
	"set-authoritative-cursor",
	"set"
>;

export type VmIteratorResultVirtualizationRegion = VmRegionEnvelope<
	"iterator-result-virtualization",
	"virtual-iterator-result",
	"on-demand"
> & {
	readonly composition: "overlay";
	readonly stepIps: ReadonlyArray<number>;
	readonly runtimeGuard: "exact-builtin-iterator-next";
	readonly correspondence: "done-value-observation";
	readonly fallback: "materialize-result-then-observe";
};

export type VmIteratorEntryPairVirtualizationRegion = VmRegionEnvelope<
	"iterator-entry-pair-virtualization",
	"virtual-iterator-entry-pair",
	"on-demand"
> & {
	readonly composition: "overlay";
	readonly cursorInitializeIp: number;
	readonly outerStepIp: number;
	readonly innerInitializeIp: number;
	readonly innerStepIps: readonly [number, number];
	readonly innerCloseIps: ReadonlyArray<number>;
	readonly runtimeGuard: "exact-map-or-set-entry-cursor";
	readonly correspondence: "entry-pair-elements";
	readonly stateSynchronization: "authoritative-language-object";
	readonly fallback: "materialize-entry-pair-then-iterate";
};

export type VmStackObjectPlanRegion = VmRegionEnvelope<
	"stack-object-plan",
	"activation-local-fixed-shape-objects",
	"none" | "on-demand"
> & {
	readonly sites: ReadonlyArray<{
		readonly allocationIp: number;
		readonly slotCount: number;
		readonly accesses: ReadonlyArray<{
			readonly ip: number;
			readonly slot: number;
		}>;
		readonly inheritedAccessIp?: number;
		readonly materializations: ReadonlyArray<{
			readonly ip: number;
			readonly kind: "return";
		}>;
	}>;
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

export type VmIndexedLengthLoopRegion = VmRegionEnvelope<
	"indexed-length-loop",
	"live-indexed-length-loops",
	"none"
> & {
	readonly runtimeGuard: "array-or-numeric-typed-array";
	readonly sites: ReadonlyArray<{
		readonly loadIp: number;
		readonly comparisonIp: number;
		readonly lengthPosition: 1 | 2;
		readonly elements: ReadonlyArray<{
			readonly ip: number;
			readonly kind: "load" | "store";
		}>;
	}>;
};

export type VmRegion =
	| VmIndexedLengthLoopRegion
	| VmArrayValuesIteratorCursorRegion
	| VmBuiltinCollectionCallChainRegion
	| VmIteratorEntryPairVirtualizationRegion
	| VmIteratorResultVirtualizationRegion
	| VmMapIteratorCursorRegion
	| VmRegExpExecProjectionRegion
	| VmRegExpIteratorProjectionRegion
	| VmStringSliceNumberRegion
	| VmNumericFusionRegion
	| VmStackObjectPlanRegion
	| VmStringCharCodeAtChainRegion
	| VmStringIteratorCursorRegion
	| VmStringSplitProjectionRegion
	| VmStringSplitCursorRegion
	| VmSetIteratorCursorRegion
	| VmTypedArrayIteratorCursorRegion;

/** Physical storage selected by Core target lowering for native emission. */
export type VmRegisterRepresentation =
	| "boxed"
	| "int32"
	| "number"
	| "boolean"
	| "string";

export interface VmGuardedBuiltinCall {
	readonly operation: VmGuardedBuiltinOperation;
	/** The shared semantic facts and fallback contract for this specialization. */
	readonly guard: VmGuardPlan;
}

export function vmCallProvesBuiltin(
	plan: Extract<NativeInstructionPlan, { kind: "call" }> | undefined,
	operation: VmGuardedBuiltinOperation,
	requirements?: {
		readonly lowering: string;
		readonly result: string;
		readonly effects: ReadonlyArray<EffectKind>;
	},
): boolean {
	if (plan?.guardedBuiltinCall?.operation !== operation) return false;
	if (requirements === undefined) return true;
	const descriptor = builtinOperationDescriptor(operation);
	return (
		descriptor !== undefined &&
		descriptor.lowerings.includes(requirements.lowering) &&
		descriptor.result === requirements.result &&
		descriptor.effects.join("\0") === requirements.effects.join("\0")
	);
}

/** Compiler-owned information that must never reach the runtime image. */
export interface ProgramImage {
	readonly runtime: RuntimeImage;
	readonly native: NativePlan;
	readonly diagnostics: {
		profileSites?: Array<ProfileSite>;
		profileRemarks?: Array<CompilerRemark>;
		factFlow?: CompilerFactFlowReport;
	};
}

export interface NativePlan {
	/** Runtime-backed proof contracts consumed only while rendering native code. */
	readonly semanticProtectors: ReadonlyArray<VmSemanticProtectorFact>;
	readonly functions: ReadonlyArray<NativeFunctionPlan>;
}

export type VmRegionActionRole =
	| "access"
	| "allocate"
	| "call"
	| "capture"
	| "charCodeAtCall"
	| "charCodeAtProperty"
	| "caseLength"
	| "caseLowerCall"
	| "caseLowerProperty"
	| "caseUpperCall"
	| "caseUpperProperty"
	| "compare"
	| "element"
	| "finish"
	| "inherited"
	| "innerClose"
	| "innerInitialize"
	| "innerStep"
	| "initialize"
	| "length"
	| "load"
	| "materialize"
	| "number"
	| "outerStep"
	| "property"
	| "slice"
	| "start"
	| "step"
	| "trimCall"
	| "trimProperty";

export interface VmRegionAction {
	readonly ip: number;
	readonly regionIndex: number;
	readonly role: VmRegionActionRole;
	readonly primaryIndex?: number;
	readonly secondaryIndex?: number;
}

export function vmRegionActions(
	regions: ReadonlyArray<VmRegion>,
): ReadonlyArray<VmRegionAction> {
	const actions: Array<VmRegionAction> = [];
	const add = (
		regionIndex: number,
		ip: number,
		role: VmRegionActionRole,
		primaryIndex?: number,
		secondaryIndex?: number,
	): void => {
		actions.push({
			ip,
			regionIndex,
			role,
			...(primaryIndex === undefined ? {} : { primaryIndex }),
			...(secondaryIndex === undefined ? {} : { secondaryIndex }),
		});
	};
	for (const [regionIndex, region] of regions.entries()) {
		switch (region.kind) {
			case "indexed-length-loop":
				for (const [siteIndex, site] of region.sites.entries()) {
					add(regionIndex, site.loadIp, "load", siteIndex);
					add(regionIndex, site.comparisonIp, "compare", siteIndex);
					for (const [elementIndex, element] of site.elements.entries()) {
						add(regionIndex, element.ip, "element", siteIndex, elementIndex);
					}
				}
				break;
			case "array-values-iterator-cursor":
			case "string-iterator-cursor":
			case "typed-array-iterator-cursor":
			case "map-iterator-cursor":
			case "set-iterator-cursor":
				add(regionIndex, region.initializeIp, "initialize");
				for (const [stepIndex, stepIp] of region.stepIps.entries()) {
					add(regionIndex, stepIp, "step", stepIndex);
				}
				break;
			case "iterator-result-virtualization":
				for (const [stepIndex, stepIp] of region.stepIps.entries()) {
					add(regionIndex, stepIp, "step", stepIndex);
				}
				break;
			case "iterator-entry-pair-virtualization":
				add(regionIndex, region.outerStepIp, "outerStep");
				add(regionIndex, region.innerInitializeIp, "innerInitialize");
				for (const [stepIndex, stepIp] of region.innerStepIps.entries()) {
					add(regionIndex, stepIp, "innerStep", stepIndex);
				}
				for (const [closeIndex, closeIp] of region.innerCloseIps.entries()) {
					add(regionIndex, closeIp, "innerClose", closeIndex);
				}
				break;
			case "numeric-fusion":
				for (const [pairIndex, pair] of region.pairs.entries()) {
					add(regionIndex, pair.firstIp, "start", pairIndex);
					add(regionIndex, pair.finishIp, "finish", pairIndex);
				}
				break;
			case "stack-object-plan":
				for (const [siteIndex, site] of region.sites.entries()) {
					add(regionIndex, site.allocationIp, "allocate", siteIndex);
					for (const [accessIndex, access] of site.accesses.entries()) {
						add(regionIndex, access.ip, "access", siteIndex, accessIndex);
					}
					if (site.inheritedAccessIp !== undefined) {
						add(regionIndex, site.inheritedAccessIp, "inherited", siteIndex);
					}
					for (const [
						materializationIndex,
						materialization,
					] of site.materializations.entries()) {
						add(
							regionIndex,
							materialization.ip,
							"materialize",
							siteIndex,
							materializationIndex,
						);
					}
				}
				break;
			case "string-char-code-at-chain":
			case "builtin-collection-call-chain":
				add(regionIndex, region.propertyIp, "property");
				add(regionIndex, region.callIp, "call");
				break;
			case "string-slice-number":
				if (region.propertyPlacement === "call-fallback") {
					add(regionIndex, region.propertyIp, "property");
				}
				add(regionIndex, region.sliceCallIp, "slice");
				add(regionIndex, region.numberCallIp, "number");
				break;
			case "string-split-projection":
				if (region.propertyPlacement === "call-fallback") {
					add(regionIndex, region.propertyIp, "property");
				}
				add(regionIndex, region.callIp, "call");
				for (const [loadIndex, load] of region.loads.entries()) {
					add(regionIndex, load.ip, load.kind, loadIndex);
				}
				break;
			case "string-split-cursor":
				if (region.propertyPlacement === "call-fallback") {
					add(regionIndex, region.propertyIp, "property");
				}
				add(regionIndex, region.anchors[0]!, "call");
				add(regionIndex, region.anchors[2]!, "length");
				add(regionIndex, region.elementIp, "element");
				add(regionIndex, region.trimPropertyIp, "trimProperty");
				add(regionIndex, region.trimCallIp, "trimCall");
				break;
			case "regexp-exec-projection":
				if (region.propertyPlacement === "call-fallback") {
					add(regionIndex, region.propertyIp, "property");
				}
				add(regionIndex, region.callIp, "call");
				for (const [loadIndex, load] of region.loads.entries()) {
					add(regionIndex, load.ip, "capture", loadIndex);
					if (load.consumer?.kind === "length") {
						add(regionIndex, load.consumer.propertyIp, "length", loadIndex);
					} else if (load.consumer?.kind === "charCodeAtZero") {
						add(regionIndex, load.consumer.propertyIp, "charCodeAtProperty", loadIndex);
						add(regionIndex, load.consumer.callIp, "charCodeAtCall", loadIndex);
					} else if (load.consumer?.kind === "number") {
						add(regionIndex, load.consumer.callIp, "number", loadIndex);
					} else if (load.consumer?.kind === "asciiCaseLength") {
						add(
							regionIndex,
							load.consumer.upperPropertyIp,
							"caseUpperProperty",
							loadIndex,
						);
						add(regionIndex, load.consumer.upperCallIp, "caseUpperCall", loadIndex);
						add(
							regionIndex,
							load.consumer.lowerPropertyIp,
							"caseLowerProperty",
							loadIndex,
						);
						add(regionIndex, load.consumer.lowerCallIp, "caseLowerCall", loadIndex);
						add(regionIndex, load.consumer.lengthPropertyIp, "caseLength", loadIndex);
					}
				}
				break;
			case "regexp-iterator-projection":
				add(regionIndex, region.stepIp, "step");
				for (const [loadIndex, load] of region.loads.entries()) {
					add(regionIndex, load.ip, "capture", loadIndex);
					add(regionIndex, load.numberCallIp, "number", loadIndex);
				}
				break;
			default: {
				const unreachable: never = region;
				throw new Error(`Unknown VM region ${(unreachable as VmRegion).kind}`);
			}
		}
	}
	actions.sort(
		(left, right) =>
			left.ip - right.ip ||
			left.regionIndex - right.regionIndex ||
			left.role.localeCompare(right.role) ||
			(left.primaryIndex ?? -1) - (right.primaryIndex ?? -1) ||
			(left.secondaryIndex ?? -1) - (right.secondaryIndex ?? -1),
	);
	return actions;
}

export function vmRegionActionsAreCurrent(
	regions: ReadonlyArray<VmRegion>,
	actions: ReadonlyArray<VmRegionAction>,
): boolean {
	const expected = vmRegionActions(regions);
	return (
		actions.length === expected.length &&
		actions.every(
			(action, index) =>
				action.ip === expected[index]?.ip &&
				action.regionIndex === expected[index]?.regionIndex &&
				action.role === expected[index]?.role &&
				action.primaryIndex === expected[index]?.primaryIndex &&
				action.secondaryIndex === expected[index]?.secondaryIndex,
		)
	);
}

export interface NativeFunctionPlan {
	readonly functionIndex: number;
	readonly mode: "direct" | "resumable";
	readonly registerRepresentations: ReadonlyArray<VmRegisterRepresentation>;
	/** Native-only ordinary-call siblings selected by closed-world call facts. */
	readonly directEntries: ReadonlyArray<NativeDirectEntryPlan>;
	readonly gc: {
		readonly safepoints: ReadonlyArray<{
			readonly kind: "operation" | "loop-backedge" | "conservative";
			readonly instructionIp: number;
			readonly rootRegisters: ReadonlyArray<number>;
		}>;
	};
	/** One native-only decision per bytecode IP; absent entries mean generic lowering. */
	readonly instructions: ReadonlyArray<NativeInstructionPlan | undefined>;
	readonly specializations: ReadonlyArray<VmRegion>;
	readonly regionActions: ReadonlyArray<VmRegionAction>;
	readonly compilerSiteIds?: ReadonlyArray<string | undefined>;
}

export interface NativeDirectEntryPlan {
	readonly id: number;
	readonly parameterRepresentations: ReadonlyArray<VmRegisterRepresentation>;
	readonly resultRepresentation: VmRegisterRepresentation;
	readonly registerRepresentations: ReadonlyArray<VmRegisterRepresentation>;
	readonly gc: NativeFunctionPlan["gc"];
}

export type NativeInstructionPlan =
	| {
			readonly kind: "call";
			readonly directFunctionIndex?: number;
			readonly guardedFunctionIndices?: ReadonlyArray<number>;
			readonly directEntryId?: number;
			readonly directFunctionCall?: true;
			readonly directCallTargetFunctionIndex?: number;
			readonly directCallbackFunctionIndex?: number;
			readonly guardedBuiltinCall?: VmGuardedBuiltinCall;
			readonly exactCollectionReceiver?: CompilerExactCollectionBrand;
			readonly directStringCharCodeAtPosition?: "inBounds";
	  }
	| { readonly kind: "construct"; readonly directFunctionIndex: number }
	| { readonly kind: "fresh-dense-reserve"; readonly length: number }
	| { readonly kind: "exact-own-slot"; readonly slot: number }
	| { readonly kind: "exact-array-length" }
	| { readonly kind: "contained-fixed-typed-array-length" }
	| { readonly kind: "exact-contained-array-element" }
	| {
			readonly kind: "contained-fixed-typed-array-element";
			readonly elementKind: CompilerNumericTypedArrayKind;
	  }
	| {
			readonly kind: "exact-typed-array-element";
			readonly elementKind: CompilerNumericTypedArrayKind;
	  }
	| {
			readonly kind: "exact-binary-input-kinds";
			readonly inputKindMasks: readonly [CompilerValueKindMask, CompilerValueKindMask];
	  }
	| { readonly kind: "primitive-string-length" };

/**
 * Construct the explicit, fully boxed native contract for a hand-authored or
 * runtime-decoded bytecode image. This is a real conservative lowering plan,
 * not a compatibility overlay: native emission may consume it without
 * rediscovering representation or GC policy from bytecode.
 */
export function createConservativeNativePlan(
	functions: ReadonlyArray<BytecodeFunction>,
): NativePlan {
	return {
		semanticProtectors: [],
		functions: functions.map((fn, functionIndex) => ({
			functionIndex,
			mode: fn.isGenerator || fn.isAsync ? "resumable" : "direct",
			registerRepresentations: Array.from(
				{ length: fn.registerCount },
				() => "boxed" as const,
			),
			directEntries: [],
			gc: {
				safepoints: fn.instructions.map((_, instructionIp) => ({
					kind: "conservative" as const,
					instructionIp,
					rootRegisters: Array.from(
						{ length: fn.registerCount },
						(_, register) => register,
					),
				})),
			},
			instructions: Array.from({ length: fn.instructions.length }),
			specializations: [],
			regionActions: [],
		})),
	};
}

/**
 * Validate the native GC contract and materialize the shadow-frame slot union.
 * Producers retain exact maps; the C frame allocates the union once and selects
 * the live subset dynamically at each safepoint.
 */
export function nativeFrameRootRegisters(
	fn: BytecodeFunction,
	native: Pick<NativeFunctionPlan, "registerRepresentations" | "gc">,
): ReadonlyArray<number> {
	const seenIps = new Set<number>();
	const frameRoots = new Set<number>();
	let previousIp = -1;
	for (const safepoint of native.gc.safepoints) {
		if (
			safepoint.kind !== "operation" &&
			safepoint.kind !== "loop-backedge" &&
			safepoint.kind !== "conservative"
		) {
			throw new RangeError("native GC safepoint has an invalid kind");
		}
		if (
			!Number.isSafeInteger(safepoint.instructionIp) ||
			safepoint.instructionIp < 0 ||
			safepoint.instructionIp >= fn.instructions.length ||
			safepoint.instructionIp <= previousIp ||
			seenIps.has(safepoint.instructionIp)
		) {
			throw new RangeError("native GC safepoints must name unique ordered instructions");
		}
		previousIp = safepoint.instructionIp;
		seenIps.add(safepoint.instructionIp);
		const instruction = fn.instructions[safepoint.instructionIp]!;
		const isBackedge =
			(instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") &&
			instruction.targetIp <= safepoint.instructionIp;
		if (safepoint.kind === "loop-backedge" && !isBackedge) {
			throw new RangeError("native loop-backedge safepoint does not name a polling edge");
		}
		let previousRegister = -1;
		for (const register of safepoint.rootRegisters) {
			const representation = native.registerRepresentations[register];
			if (
				!Number.isSafeInteger(register) ||
				register < 0 ||
				register >= fn.registerCount ||
				register <= previousRegister ||
				(representation !== "boxed" && representation !== "string")
			) {
				throw new RangeError(
					"native GC roots must be unique ordered traced function registers",
				);
			}
			previousRegister = register;
			frameRoots.add(register);
		}
	}
	for (const [instructionIp, instruction] of fn.instructions.entries()) {
		if (
			(instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") &&
			instruction.targetIp <= instructionIp &&
			!seenIps.has(instructionIp)
		) {
			throw new RangeError("native polling edge has no GC safepoint");
		}
	}
	return [...frameRoots].sort((left, right) => left - right);
}

export function vmNativeInstructionMayCaptureStack(
	instruction: BytecodeInstruction,
	representations: ReadonlyArray<VmRegisterRepresentation>,
): boolean {
	switch (instruction.opcode) {
		case "MOVE":
		case "CREATE_UNDEFINED":
		case "CREATE_NULL":
		case "CREATE_EMPTY":
		case "CREATE_BOOLEAN":
		case "CREATE_NUMBER":
		case "CREATE_F64":
		case "CREATE_STRING":
		case "CREATE_BIGINT":
		case "LOAD_ARGUMENT_COUNT":
		case "LOAD_ARGUMENT":
		case "LOAD_NEW_TARGET":
		case "LOAD_THIS":
		case "LOAD_CALLEE":
		case "GUARD_FUNCTION_INDEX":
		case "SELECT_SHAPE_CASE":
		case "LOAD_CAPTURED":
		case "STORE_CAPTURED":
		case "LOAD_GLOBAL":
		case "STORE_GLOBAL":
		case "LOAD_INTRINSIC":
		case "IS_EMPTY":
		case "TYPEOF_COMPARE":
		case "MATH_UNARY_NUMBER":
		case "MATH_BINARY_NUMBER":
		case "JUMP":
		case "JUMP_IF":
		case "CATCH":
			return false;
		case "BINARY":
			return !(
				(representations[instruction.left] === "number" &&
					representations[instruction.right] === "number") ||
				instruction.operator === "===" ||
				instruction.operator === "!=="
			);
		case "UNARY":
			return !(
				representations[instruction.src] === "number" || instruction.operator === "!"
			);
		default:
			return true;
	}
}

export interface ProgramImageStats {
	functionCount: number;
	instructionCount: number;
}

export function programImageStats(definition: ProgramImage): ProgramImageStats {
	let instructionCount = 0;
	for (const fn of definition.runtime.functions) {
		instructionCount += fn.instructions.length;
	}

	return {
		functionCount: definition.runtime.functions.length,
		instructionCount,
	};
}

export interface ProgramImageConstantCompactionResult {
	readonly definition: ProgramImage;
	readonly changed: boolean;
	readonly report: RuntimeImageConstantRetentionReport;
}

/** Rebase native consumers after the portable constant pools become final. */
export function compactProgramImageConstants(
	definition: ProgramImage,
): ProgramImageConstantCompactionResult {
	const compacted = compactRuntimeImageConstants(definition.runtime);
	if (!compacted.changed) {
		return { definition, changed: false, report: compacted.report };
	}
	const functions = definition.native.functions.map((fn) => ({
		...fn,
		specializations: fn.specializations.map((region) => {
			if (region.kind !== "string-split-projection") return region;
			const separatorStringIndex = compacted.stringOldToNew.get(
				region.separatorStringIndex,
			);
			if (separatorStringIndex === undefined) {
				throw new Error(
					`RuntimeImage removed String.split separator ${region.separatorStringIndex}`,
				);
			}
			return { ...region, separatorStringIndex };
		}),
	}));
	return {
		definition: {
			...definition,
			runtime: compacted.runtime,
			native: { ...definition.native, functions },
		},
		changed: true,
		report: compacted.report,
	};
}

/** Materialize the native product after its terminal has verified every ABI variant. */
export function lowerVerifiedExecutionToProgramImage(
	program: ExecutionProgram,
	profile = false,
): ProgramImage {
	const runtimePlan = lowerVerifiedExecutionToRuntimePlan(program);
	const runtime = runtimePlan.runtime;
	const context = program.context;
	const nativeFunctions = program.functions.map((fn, functionIndex) =>
		lowerExecutionFunctionToNativePlan(
			fn,
			runtimePlan.functions[functionIndex]!,
			runtime.stringConstants,
			profile ? context.facts.instructionSites : undefined,
		),
	);
	const semanticProtectors = (
		["primitive-methods", "watched-methods", "array-elements"] as const
	).map((family) => {
		const plan = compilerGuardPlan(
			[context.facts.protectors.get(family)],
			[
				{
					kind: "fallback" as const,
					id: `semantic-protector:${family}`,
					cause: "runtime-contract",
				},
			],
		);
		const guard = plan === undefined ? undefined : lowerGuardPlan(plan);
		if (guard === undefined || !guard.obligations.includes("fallback")) {
			throw new Error(`Runtime semantic fact ${family} lost its fallback contract`);
		}
		return { family, guard };
	});
	const definition: ProgramImage = {
		runtime,
		native: {
			semanticProtectors,
			functions: nativeFunctions,
		},
		diagnostics: {},
	};
	if (profile) buildProfileMetadata(program.core, context, definition);
	if (profile) {
		definition.diagnostics.factFlow = collectCompilerFactFlowReport(
			context.facts,
			program.functionMap,
			runtime,
			nativeFunctions,
		);
	}
	return compactProgramImageConstants(definition).definition;
}

/**
 * Resolve the linker's host built-in bindings to global slots read by the final
 * VM instruction stream. Slot assignment can outlive an optimized-away read, so
 * the emitted functions, rather than bindingToStorage alone, determine export
 * retention. Process remains statically retained from global-property analysis.
 */
function nativeInstructionPlanFromExecution(
	instruction: CompilerInstruction,
): NativeInstructionPlan | undefined {
	switch (instruction.type) {
		case "call": {
			const guardedBuiltinCall = lowerGuardedBuiltinCall(instruction);
			const exactCollectionReceiver =
				guardedBuiltinCall === undefined
					? undefined
					: instruction.exactCollectionReceiver;
			if (
				instruction.directFunctionIndex === undefined &&
				instruction.guardedFunctionIndices === undefined &&
				instruction.directEntryId === undefined &&
				instruction.directFunctionCall !== true &&
				instruction.directCallTargetFunctionIndex === undefined &&
				instruction.directCallbackFunctionIndex === undefined &&
				guardedBuiltinCall === undefined &&
				instruction.directStringCharCodeAtPosition === undefined
			)
				return undefined;
			return {
				kind: "call",
				directFunctionIndex: instruction.directFunctionIndex,
				guardedFunctionIndices: instruction.guardedFunctionIndices,
				directEntryId: instruction.directEntryId,
				directFunctionCall: instruction.directFunctionCall,
				directCallTargetFunctionIndex: instruction.directCallTargetFunctionIndex,
				directCallbackFunctionIndex: instruction.directCallbackFunctionIndex,
				guardedBuiltinCall,
				exactCollectionReceiver,
				directStringCharCodeAtPosition:
					guardedBuiltinCall === undefined
						? undefined
						: instruction.directStringCharCodeAtPosition,
			};
		}
		case "construct":
			return instruction.directFunctionIndex === undefined
				? undefined
				: {
						kind: "construct",
						directFunctionIndex: instruction.directFunctionIndex,
					};
		case "createArray":
			return instruction.freshDenseReserveLength === undefined
				? undefined
				: {
						kind: "fresh-dense-reserve",
						length: instruction.freshDenseReserveLength,
					};
		case "loadPropertyStatic":
			return instruction.exactOwnSlot !== undefined
				? { kind: "exact-own-slot", slot: instruction.exactOwnSlot }
				: instruction.exactArrayLength === true
					? { kind: "exact-array-length" }
					: instruction.containedFixedTypedArrayLength === true
						? { kind: "contained-fixed-typed-array-length" }
						: instruction.primitiveStringLength === true
							? { kind: "primitive-string-length" }
							: undefined;
		case "loadProperty":
			return instruction.exactContainedArrayElement === true
				? { kind: "exact-contained-array-element" }
				: instruction.containedFixedTypedArrayKind !== undefined
					? {
							kind: "contained-fixed-typed-array-element",
							elementKind: instruction.containedFixedTypedArrayKind,
						}
					: instruction.exactTypedArrayKind === undefined
						? undefined
						: {
								kind: "exact-typed-array-element",
								elementKind: instruction.exactTypedArrayKind,
							};
		case "storeProperty":
			return instruction.containedFixedTypedArrayKind !== undefined
				? {
						kind: "contained-fixed-typed-array-element",
						elementKind: instruction.containedFixedTypedArrayKind,
					}
				: instruction.exactTypedArrayKind === undefined
					? undefined
					: {
							kind: "exact-typed-array-element",
							elementKind: instruction.exactTypedArrayKind,
						};
		case "storePropertyStatic":
			return instruction.exactOwnSlot === undefined
				? undefined
				: { kind: "exact-own-slot", slot: instruction.exactOwnSlot };
		case "binary":
			return instruction.exactInputKindMasks === undefined
				? undefined
				: {
						kind: "exact-binary-input-kinds",
						inputKindMasks: instruction.exactInputKindMasks,
					};
		default:
			return undefined;
	}
}

function lowerExecutionFunctionToNativePlan(
	fn: ExecutionFunction,
	runtimePlan: RuntimeFunctionLoweringPlan,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
	instructionSites: WeakMap<object, { id: string }> | undefined,
): NativeFunctionPlan {
	const {
		bytecode,
		blockStartIps,
		instructionIndexByTargetInstruction,
		propertyIcIndexByInstruction,
	} = runtimePlan;
	const instructions = bytecode.instructions;
	const handlers = bytecode.handlers;
	const nativeInstructions = new Array<NativeInstructionPlan | undefined>(
		instructions.length,
	);
	const nativePlanByRuntimeInstruction = new WeakMap<object, NativeInstructionPlan>();
	const setNativeInstructionPlan = (ip: number, plan: NativeInstructionPlan): void => {
		nativeInstructions[ip] = plan;
		nativePlanByRuntimeInstruction.set(instructions[ip]!, plan);
	};
	const compilerSiteIds = new Array<string | undefined>(instructions.length);
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			const ip = instructionIndexByTargetInstruction.get(instruction);
			if (ip === undefined) continue;
			const nativePlan = nativeInstructionPlanFromExecution(instruction);
			if (nativePlan !== undefined) setNativeInstructionPlan(ip, nativePlan);
			compilerSiteIds[ip] = instructionSites?.get(instruction)?.id;
		}
	}
	const nativePlanOf = (
		instruction: BytecodeInstruction | undefined,
	): NativeInstructionPlan | undefined =>
		instruction === undefined
			? undefined
			: nativePlanByRuntimeInstruction.get(instruction);
	const guardedBuiltinCallOf = (
		instruction: BytecodeInstruction | undefined,
	): VmGuardedBuiltinCall | undefined => {
		const plan = nativePlanOf(instruction);
		return plan?.kind === "call" ? plan.guardedBuiltinCall : undefined;
	};
	const regions: Array<VmRegion> = [];
	const claimedRegionInstructions = new Set<number>();
	const coreRegionError = (kind: string, reason: string): Error =>
		new Error(`Invalid Core ${kind} region during VM lowering: ${reason}`);
	/**
	 * What target lowering still owes on an admission record. Core owns the interior
	 * proof — it is about dominance, which the emitted instruction order does not
	 * express once a claim legitimately sits in a dominating predecessor block — so
	 * what only the lowered stream can show is that the anchor resolves to an
	 * instruction this region actually claims.
	 */
	const checkAdmission = (
		kind: string,
		claimedIps: ReadonlyArray<number>,
		admission: VmRegionLicense["admission"],
	): void => {
		if (!claimedIps.includes(admission.anchorIp)) {
			throw coreRegionError(kind, "admission outside the claim set");
		}
	};
	for (const region of fn.specializations) {
		// Envelope metadata: resolved once for every kind so no kind-specific branch
		// can hand a backend a different answer.
		const admissionAnchorIp = instructionIndexByTargetInstruction.get(
			region.license.admission.anchor,
		);
		const admissionMode = region.license.admission.mode;
		if (
			admissionAnchorIp === undefined ||
			(admissionMode !== "capture" &&
				admissionMode !== "stable" &&
				admissionMode !== "per-use")
		) {
			throw coreRegionError(region.kind, "license admission");
		}
		const admission = {
			anchorIp: admissionAnchorIp,
			mode: admissionMode,
		};
		if (region.kind === "indexed-length-loop") {
			const anchors = region.anchors.map((instruction) =>
				instructionIndexByTargetInstruction.get(instruction),
			);
			const claimedIps = region.claimedInstructions.map((instruction) =>
				instructionIndexByTargetInstruction.get(instruction),
			);
			const ordinaryBlockIps = region.controlFlow.ordinaryBlocks.map((blockIndex) =>
				blockStartIps.get(blockIndex),
			);
			const sites = region.sites.map(
				({ load, comparison, lengthPosition, elements }) => ({
					loadIp: instructionIndexByTargetInstruction.get(load),
					comparisonIp: instructionIndexByTargetInstruction.get(comparison),
					lengthPosition,
					elements: elements.map(({ instruction, kind }) => ({
						ip: instructionIndexByTargetInstruction.get(instruction),
						kind,
					})),
				}),
			);
			if (
				region.license.guard !== "structural" ||
				region.license.genericTwin !== "retained" ||
				region.license.materialization !== "none" ||
				region.representation !== "live-indexed-length-loops" ||
				region.runtimeGuard !== "array-or-numeric-typed-array" ||
				region.controlFlow.ordinaryBlocks.length === 0 ||
				region.controlFlow.exceptionalBlocks.length !== 0 ||
				anchors.some((ip) => ip === undefined) ||
				claimedIps.some((ip) => ip === undefined) ||
				ordinaryBlockIps.some((ip) => ip === undefined) ||
				sites.length === 0 ||
				sites.length > 32 ||
				sites.some(
					(site) =>
						site.loadIp === undefined ||
						site.comparisonIp === undefined ||
						(site.lengthPosition !== 1 && site.lengthPosition !== 2) ||
						site.elements.length > 8 ||
						site.elements.some(
							(element) =>
								element.ip === undefined ||
								(element.kind !== "load" && element.kind !== "store"),
						),
				)
			) {
				throw coreRegionError(region.kind, "structural contract");
			}
			const resolvedAnchors = anchors as Array<number>;
			const resolvedClaimedIps = claimedIps as Array<number>;
			const resolvedSites = sites as Array<{
				readonly loadIp: number;
				readonly comparisonIp: number;
				readonly lengthPosition: 1 | 2;
				readonly elements: Array<{
					readonly ip: number;
					readonly kind: "load" | "store";
				}>;
			}>;
			const payloadIps = resolvedSites.flatMap(({ loadIp, comparisonIp, elements }) => [
				loadIp,
				comparisonIp,
				...elements.map(({ ip }) => ip),
			]);
			const elementCount = resolvedSites.reduce(
				(total, site) => total + site.elements.length,
				0,
			);
			let valid =
				resolvedAnchors.length === 2 &&
				resolvedAnchors[0] === resolvedSites[0]!.loadIp &&
				resolvedAnchors[1] === resolvedSites[0]!.comparisonIp &&
				new Set(payloadIps).size === payloadIps.length &&
				payloadIps.length === resolvedClaimedIps.length &&
				payloadIps.every((ip) => resolvedClaimedIps.includes(ip)) &&
				!payloadIps.some((ip) => claimedRegionInstructions.has(ip)) &&
				region.cost.score === resolvedSites.length * 4 + elementCount * 3 &&
				region.cost.metadataOperations === payloadIps.length;
			for (const site of resolvedSites) {
				const load = instructions[site.loadIp];
				const comparison = instructions[site.comparisonIp];
				const other =
					comparison?.opcode === "BINARY"
						? site.lengthPosition === 1
							? comparison.right
							: comparison.left
						: -1;
				const length =
					comparison?.opcode === "BINARY"
						? site.lengthPosition === 1
							? comparison.left
							: comparison.right
						: -1;
				if (
					load?.opcode !== "LOAD_PROPERTY_STATIC" ||
					String.fromCharCode(...(stringConstants[load.stringIndex] ?? [])) !==
						"length" ||
					comparison?.opcode !== "BINARY" ||
					!["<", "<=", ">", ">=", "==", "!=", "===", "!=="].includes(
						comparison.operator,
					) ||
					length !== load.dst ||
					site.comparisonIp !== site.loadIp + 1 ||
					(fn.registerRepresentations[other] !== "int32" &&
						fn.registerRepresentations[other] !== "number") ||
					site.elements.some(({ ip, kind }) => {
						const element = instructions[ip];
						return (
							ip <= site.comparisonIp ||
							(kind === "load"
								? element?.opcode !== "LOAD_PROPERTY"
								: element?.opcode !== "STORE_PROPERTY") ||
							(element?.opcode === "LOAD_PROPERTY" || element?.opcode === "STORE_PROPERTY"
								? element.object !== load.object || element.key !== other
								: true)
						);
					})
				) {
					valid = false;
				}
			}
			if (!valid) throw coreRegionError(region.kind, "instruction or cost contract");
			checkAdmission(region.kind, resolvedClaimedIps, admission);
			for (const ip of resolvedClaimedIps) claimedRegionInstructions.add(ip);
			regions.push({
				kind: "indexed-length-loop",
				license: {
					guard: { dependencies: [], obligations: ["fallback"] },
					genericTwin: "retained",
					materialization: "none",
					admission,
				},
				representation: "live-indexed-length-loops",
				anchors: resolvedAnchors,
				claimedIps: resolvedClaimedIps,
				controlFlow: {
					ordinaryBlockIps: ordinaryBlockIps as Array<number>,
					exceptionalHandlerIps: [],
				},
				cost: { ...region.cost },
				runtimeGuard: "array-or-numeric-typed-array",
				sites: resolvedSites,
			});
			continue;
		}
		if (
			region.kind === "array-values-iterator-cursor" ||
			region.kind === "string-iterator-cursor" ||
			region.kind === "typed-array-iterator-cursor" ||
			region.kind === "map-iterator-cursor" ||
			region.kind === "set-iterator-cursor"
		) {
			const anchors = region.anchors.map((instruction) =>
				instructionIndexByTargetInstruction.get(instruction),
			);
			const claimedIps = region.claimedInstructions.map((instruction) =>
				instructionIndexByTargetInstruction.get(instruction),
			);
			const ordinaryBlockIps = region.controlFlow.ordinaryBlocks.map((blockIndex) =>
				blockStartIps.get(blockIndex),
			);
			const exceptionalHandlerIps = region.controlFlow.exceptionalBlocks.map(
				(blockIndex) => blockStartIps.get(blockIndex),
			);
			const initializeIp = instructionIndexByTargetInstruction.get(region.initialize);
			const stepIps = region.steps.map((step) =>
				instructionIndexByTargetInstruction.get(step),
			);
			if (
				region.license.guard !== "structural" ||
				region.license.genericTwin !== "retained" ||
				region.license.materialization !== "none" ||
				region.license.admission.mode !== "stable" ||
				region.runtimeGuard !== "exact-iterator-brand-next-target" ||
				region.stateSynchronization !== "authoritative-language-object" ||
				region.suspension !== "forbidden" ||
				fn.isGenerator ||
				fn.isAsync ||
				initializeIp === undefined ||
				stepIps.length === 0 ||
				stepIps.some((ip) => ip === undefined) ||
				anchors.some((ip) => ip === undefined) ||
				claimedIps.some((ip) => ip === undefined) ||
				ordinaryBlockIps.some((ip) => ip === undefined) ||
				exceptionalHandlerIps.some((ip) => ip === undefined)
			) {
				throw coreRegionError(region.kind, "structural contract");
			}
			const resolvedAnchors = anchors as Array<number>;
			const resolvedClaimedIps = claimedIps as Array<number>;
			const resolvedStepIps = stepIps as Array<number>;
			const initialize = instructions[initializeIp];
			const payloadIps = [initializeIp, ...resolvedStepIps];
			if (
				initialize?.opcode !== "GET_ITERATOR" ||
				resolvedAnchors.length !== 2 ||
				resolvedAnchors[0] !== initializeIp ||
				resolvedAnchors[1] !== resolvedStepIps[0] ||
				new Set(payloadIps).size !== payloadIps.length ||
				payloadIps.length !== resolvedClaimedIps.length ||
				payloadIps.some((ip) => !resolvedClaimedIps.includes(ip)) ||
				payloadIps.some((ip) => claimedRegionInstructions.has(ip)) ||
				resolvedStepIps.some((ip) => {
					const step = instructions[ip];
					return (
						step?.opcode !== "ITERATOR_STEP" ||
						step.iterator !== initialize.iteratorDst ||
						step.next !== initialize.nextDst
					);
				}) ||
				region.cost.score !== resolvedStepIps.length * 8 ||
				region.cost.metadataOperations !== payloadIps.length
			) {
				throw coreRegionError(region.kind, "instruction or claim contract");
			}
			checkAdmission(region.kind, resolvedClaimedIps, admission);
			for (const ip of resolvedClaimedIps) claimedRegionInstructions.add(ip);
			const common = {
				license: {
					guard: { dependencies: [], obligations: ["fallback" as const] },
					genericTwin: "retained" as const,
					materialization: "none" as const,
					admission,
				},
				anchors: resolvedAnchors,
				claimedIps: resolvedClaimedIps,
				controlFlow: {
					ordinaryBlockIps: ordinaryBlockIps as Array<number>,
					exceptionalHandlerIps: exceptionalHandlerIps as Array<number>,
				},
				cost: { ...region.cost },
				initializeIp,
				stepIps: resolvedStepIps,
				iterator: initialize.iteratorDst,
				next: initialize.nextDst,
				runtimeGuard: "exact-iterator-brand-next-target" as const,
				stateSynchronization: "authoritative-language-object" as const,
				suspension: "forbidden" as const,
			};
			switch (region.kind) {
				case "array-values-iterator-cursor":
					regions.push({
						...common,
						kind: region.kind,
						representation: "array-values-authoritative-cursor",
						protocol: "array-values",
					});
					break;
				case "string-iterator-cursor":
					regions.push({
						...common,
						kind: region.kind,
						representation: "string-authoritative-cursor",
						protocol: "string",
					});
					break;
				case "typed-array-iterator-cursor":
					regions.push({
						...common,
						kind: region.kind,
						representation: "typed-array-authoritative-cursor",
						protocol: "typed-array-values",
					});
					break;
				case "map-iterator-cursor":
					regions.push({
						...common,
						kind: region.kind,
						representation: "map-authoritative-cursor",
						protocol: "map",
					});
					break;
				case "set-iterator-cursor":
					regions.push({
						...common,
						kind: region.kind,
						representation: "set-authoritative-cursor",
						protocol: "set",
					});
					break;
			}
			continue;
		}
		if (region.kind === "iterator-result-virtualization") {
			const anchors = region.anchors.map((instruction) =>
				instructionIndexByTargetInstruction.get(instruction),
			);
			const claimedIps = region.claimedInstructions.map((instruction) =>
				instructionIndexByTargetInstruction.get(instruction),
			);
			const ordinaryBlockIps = region.controlFlow.ordinaryBlocks.map((blockIndex) =>
				blockStartIps.get(blockIndex),
			);
			const exceptionalHandlerIps = region.controlFlow.exceptionalBlocks.map(
				(blockIndex) => blockStartIps.get(blockIndex),
			);
			const stepIps = region.steps.map((step) =>
				instructionIndexByTargetInstruction.get(step),
			);
			const obligations = [
				...new Set(region.license.guard.obligations.map(({ kind }) => kind)),
			].sort();
			if (
				region.license.guard.dependencies.length !== 0 ||
				obligations.length !== 2 ||
				obligations[0] !== "fallback" ||
				obligations[1] !== "materialize" ||
				region.license.genericTwin !== "retained" ||
				region.license.materialization !== "on-demand" ||
				region.license.admission.mode !== "stable" ||
				region.representation !== "virtual-iterator-result" ||
				region.composition !== "overlay" ||
				region.runtimeGuard !== "exact-builtin-iterator-next" ||
				region.correspondence !== "done-value-observation" ||
				region.fallback !== "materialize-result-then-observe" ||
				anchors.length !== 1 ||
				anchors.some((ip) => ip === undefined) ||
				claimedIps.some((ip) => ip === undefined) ||
				ordinaryBlockIps.some((ip) => ip === undefined) ||
				exceptionalHandlerIps.some((ip) => ip === undefined) ||
				stepIps.length === 0 ||
				stepIps.length > 64 ||
				stepIps.some((ip) => ip === undefined)
			) {
				throw coreRegionError(region.kind, "virtual-result contract");
			}
			const resolvedAnchors = anchors as Array<number>;
			const resolvedClaimedIps = claimedIps as Array<number>;
			const resolvedStepIps = stepIps as Array<number>;
			if (
				resolvedAnchors[0] !== resolvedStepIps[0] ||
				new Set(resolvedStepIps).size !== resolvedStepIps.length ||
				resolvedStepIps.length !== resolvedClaimedIps.length ||
				resolvedStepIps.some((ip) => !resolvedClaimedIps.includes(ip)) ||
				resolvedStepIps.some((ip) => instructions[ip]?.opcode !== "ITERATOR_STEP") ||
				region.cost.score !== resolvedStepIps.length * 6 ||
				region.cost.metadataOperations !== resolvedStepIps.length
			) {
				throw coreRegionError(region.kind, "instruction or cost contract");
			}
			checkAdmission(region.kind, resolvedClaimedIps, admission);
			regions.push({
				kind: "iterator-result-virtualization",
				license: {
					guard: { dependencies: [], obligations: ["fallback", "materialize"] },
					genericTwin: "retained",
					materialization: "on-demand",
					admission,
				},
				representation: "virtual-iterator-result",
				composition: "overlay",
				anchors: resolvedAnchors,
				claimedIps: resolvedClaimedIps,
				controlFlow: {
					ordinaryBlockIps: ordinaryBlockIps as Array<number>,
					exceptionalHandlerIps: exceptionalHandlerIps as Array<number>,
				},
				cost: { ...region.cost },
				stepIps: resolvedStepIps,
				runtimeGuard: "exact-builtin-iterator-next",
				correspondence: "done-value-observation",
				fallback: "materialize-result-then-observe",
			});
			continue;
		}
		if (region.kind === "iterator-entry-pair-virtualization") {
			const anchors = region.anchors.map((instruction) =>
				instructionIndexByTargetInstruction.get(instruction),
			);
			const claimedIps = region.claimedInstructions.map((instruction) =>
				instructionIndexByTargetInstruction.get(instruction),
			);
			const ordinaryBlockIps = region.controlFlow.ordinaryBlocks.map((blockIndex) =>
				blockStartIps.get(blockIndex),
			);
			const exceptionalHandlerIps = region.controlFlow.exceptionalBlocks.map(
				(blockIndex) => blockStartIps.get(blockIndex),
			);
			const cursorInitializeIp = instructionIndexByTargetInstruction.get(
				region.cursorInitialize,
			);
			const outerStepIp = instructionIndexByTargetInstruction.get(region.outerStep);
			const innerInitializeIp = instructionIndexByTargetInstruction.get(
				region.innerInitialize,
			);
			const innerStepIps = region.innerSteps.map((step) =>
				instructionIndexByTargetInstruction.get(step),
			);
			const innerCloseIps = region.innerCloses.map((close) =>
				instructionIndexByTargetInstruction.get(close),
			);
			const obligations = [
				...new Set(region.license.guard.obligations.map(({ kind }) => kind)),
			].sort();
			const dependency = region.license.guard.dependencies[0];
			const vmDependency: VmSemanticDependency | undefined =
				dependency?.kind === "world" && dependency.fact === "primordials.locked"
					? { kind: "world", fact: "primordials.locked" }
					: dependency?.kind === "epoch" && dependency.family === "watched-methods"
						? { kind: "epoch", family: "watched-methods" }
						: undefined;
			const license = vmRegionLicense(
				[
					{
						dependencies: vmDependency === undefined ? [] : [vmDependency],
						obligations,
					},
				],
				"on-demand",
				admission,
			);
			if (
				license === undefined ||
				region.license.guard.dependencies.length !== 1 ||
				vmDependency === undefined ||
				obligations.length !== 2 ||
				obligations[0] !== "fallback" ||
				obligations[1] !== "materialize" ||
				region.license.genericTwin !== "retained" ||
				region.license.materialization !== "on-demand" ||
				region.license.admission.mode !== "capture" ||
				region.representation !== "virtual-iterator-entry-pair" ||
				region.composition !== "overlay" ||
				region.runtimeGuard !== "exact-map-or-set-entry-cursor" ||
				region.correspondence !== "entry-pair-elements" ||
				region.stateSynchronization !== "authoritative-language-object" ||
				region.fallback !== "materialize-entry-pair-then-iterate" ||
				anchors.some((ip) => ip === undefined) ||
				claimedIps.some((ip) => ip === undefined) ||
				ordinaryBlockIps.some((ip) => ip === undefined) ||
				exceptionalHandlerIps.some((ip) => ip === undefined) ||
				cursorInitializeIp === undefined ||
				outerStepIp === undefined ||
				innerInitializeIp === undefined ||
				innerStepIps.length !== 2 ||
				innerStepIps.some((ip) => ip === undefined) ||
				innerCloseIps.some((ip) => ip === undefined)
			) {
				throw coreRegionError(region.kind, "entry-pair contract");
			}
			const resolvedAnchors = anchors as Array<number>;
			const resolvedClaimedIps = claimedIps as Array<number>;
			const resolvedInnerStepIps = innerStepIps as [number, number];
			const resolvedInnerCloseIps = innerCloseIps as Array<number>;
			const cursorInitialize = instructions[cursorInitializeIp];
			const outerStep = instructions[outerStepIp];
			const innerInitialize = instructions[innerInitializeIp];
			const payloadIps = [
				cursorInitializeIp,
				outerStepIp,
				innerInitializeIp,
				...resolvedInnerStepIps,
				...resolvedInnerCloseIps,
			];
			if (
				resolvedAnchors.length !== 2 ||
				resolvedAnchors[0] !== outerStepIp ||
				resolvedAnchors[1] !== innerInitializeIp ||
				new Set(payloadIps).size !== payloadIps.length ||
				payloadIps.length !== resolvedClaimedIps.length ||
				payloadIps.some((ip) => !resolvedClaimedIps.includes(ip)) ||
				cursorInitialize?.opcode !== "GET_ITERATOR" ||
				outerStep?.opcode !== "ITERATOR_STEP" ||
				outerStep.iterator !== cursorInitialize.iteratorDst ||
				outerStep.next !== cursorInitialize.nextDst ||
				innerInitialize?.opcode !== "GET_ITERATOR" ||
				innerInitialize.source !== outerStep.valueDst ||
				resolvedInnerStepIps.some((ip) => {
					const step = instructions[ip];
					return (
						step?.opcode !== "ITERATOR_STEP" ||
						step.iterator !== innerInitialize.iteratorDst ||
						step.next !== innerInitialize.nextDst
					);
				}) ||
				resolvedInnerCloseIps.some((ip) => {
					const close = instructions[ip];
					return (
						close?.opcode !== "ITERATOR_CLOSE" ||
						close.iterator !== innerInitialize.iteratorDst
					);
				}) ||
				region.cost.score !== 32 ||
				region.cost.metadataOperations !== payloadIps.length
			) {
				throw coreRegionError(region.kind, "entry-pair instruction contract");
			}
			checkAdmission(region.kind, resolvedClaimedIps, admission);
			regions.push({
				kind: "iterator-entry-pair-virtualization",
				license: { ...license, materialization: "on-demand" },
				representation: "virtual-iterator-entry-pair",
				composition: "overlay",
				anchors: resolvedAnchors,
				claimedIps: resolvedClaimedIps,
				controlFlow: {
					ordinaryBlockIps: ordinaryBlockIps as Array<number>,
					exceptionalHandlerIps: exceptionalHandlerIps as Array<number>,
				},
				cost: { ...region.cost },
				cursorInitializeIp,
				outerStepIp,
				innerInitializeIp,
				innerStepIps: resolvedInnerStepIps,
				innerCloseIps: resolvedInnerCloseIps,
				runtimeGuard: "exact-map-or-set-entry-cursor",
				correspondence: "entry-pair-elements",
				stateSynchronization: "authoritative-language-object",
				fallback: "materialize-entry-pair-then-iterate",
			});
			continue;
		}
		if (region.kind === "numeric-fusion") {
			const anchors = region.anchors.map((instruction) =>
				instructionIndexByTargetInstruction.get(instruction),
			);
			const claimedIps = region.claimedInstructions.map((instruction) =>
				instructionIndexByTargetInstruction.get(instruction),
			);
			const ordinaryBlockIps = region.controlFlow.ordinaryBlocks.map((blockIndex) =>
				blockStartIps.get(blockIndex),
			);
			const pairs = region.pairs.map((pair) => ({
				...pair,
				firstIp: instructionIndexByTargetInstruction.get(pair.first),
				finishIp: instructionIndexByTargetInstruction.get(pair.finish),
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
				throw coreRegionError(region.kind, "structural contract");
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
					(pair.firstUsePosition !== 1 && pair.firstUsePosition !== 2) ||
					(pair.firstUsePosition === 1 ? finish.left : finish.right) !== first.dst ||
					pair.firstIp >= pair.finishIp
				) {
					valid = false;
				}
			}
			if (!valid) throw coreRegionError(region.kind, "instruction or cost contract");
			checkAdmission(region.kind, resolvedClaimedIps, admission);
			regions.push({
				kind: "numeric-fusion",
				license: {
					guard: { dependencies: [], obligations: ["fallback"] },
					genericTwin: "retained",
					materialization: "none",
					admission,
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
				instructionIndexByTargetInstruction.get(instruction),
			);
			const resolvedSites: Array<VmStackObjectPlanRegion["sites"][number]> = [];
			const payloadIps: Array<number> = [];
			if (guard === undefined) throw coreRegionError(region.kind, "unsupported guard");
			const needsMaterialization = region.sites.some(
				(site) => site.inheritedAccess !== undefined || site.materializations.length > 0,
			);
			if (!guard.obligations.includes("fallback")) {
				throw coreRegionError(region.kind, "guard obligations");
			}
			if (
				guard.obligations.includes("materialize") !== needsMaterialization ||
				region.license.materialization !== (needsMaterialization ? "on-demand" : "none")
			) {
				throw coreRegionError(region.kind, "materialization contract");
			}
			if (
				region.license.genericTwin !== "retained" ||
				region.representation !== "activation-local-fixed-shape-objects"
			) {
				throw coreRegionError(region.kind, "license or representation");
			}
			if (region.sites.length === 0 || region.sites.length > 256) {
				throw coreRegionError(region.kind, "site count");
			}
			if (
				region.anchors.length !== 1 ||
				region.anchors[0] !== region.sites[0]!.allocation
			) {
				throw coreRegionError(region.kind, "anchor");
			}
			if (region.controlFlow.exceptionalBlocks.length !== 0) {
				throw coreRegionError(region.kind, "exceptional control flow");
			}
			if (aggregateClaims.some((ip) => ip === undefined)) {
				throw coreRegionError(region.kind, "unmapped aggregate claim");
			}
			for (const site of region.sites) {
				const allocationIp = instructionIndexByTargetInstruction.get(site.allocation);
				const allocation =
					allocationIp === undefined ? undefined : instructions[allocationIp];
				const accesses = site.accesses.map((access) => {
					const ip = instructionIndexByTargetInstruction.get(access.instruction);
					const instruction = ip === undefined ? undefined : instructions[ip];
					return { ip, slot: access.slot, instruction };
				});
				const inheritedAccessIp =
					site.inheritedAccess === undefined
						? undefined
						: instructionIndexByTargetInstruction.get(site.inheritedAccess);
				const materializations = site.materializations.map((materialization) => ({
					ip: instructionIndexByTargetInstruction.get(materialization.instruction),
					kind: materialization.kind,
				}));
				if (
					allocationIp === undefined ||
					(allocation?.opcode !== "CREATE_OBJECT" &&
						allocation?.opcode !== "CREATE_OBJECT_SHAPED") ||
					(allocation.opcode === "CREATE_OBJECT"
						? site.slotCount !== 0
						: allocation.count !== site.slotCount) ||
					accesses.some((access) => {
						const property = access.instruction;
						return (
							access.ip === undefined ||
							access.slot < 0 ||
							access.slot >= site.slotCount ||
							(property?.opcode !== "LOAD_PROPERTY_STATIC" &&
								property?.opcode !== "STORE_PROPERTY_STATIC" &&
								property?.opcode !== "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT" &&
								property?.opcode !== "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT") ||
							allocation.opcode !== "CREATE_OBJECT_SHAPED" ||
							allocation.keyStringIndices[access.slot] !== property.stringIndex
						);
					}) ||
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
					throw coreRegionError(region.kind, "site instruction metadata");
				}
				const resolvedAccesses = accesses.map(({ ip, slot }) => ({
					ip: ip!,
					slot,
				}));
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
					throw coreRegionError(region.kind, "site claim set");
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
			if (new Set(payloadIps).size !== payloadIps.length) {
				throw coreRegionError(region.kind, "overlapping site payloads");
			}
			if (new Set(resolvedAggregateClaims).size !== resolvedAggregateClaims.length) {
				throw coreRegionError(region.kind, "duplicate aggregate claims");
			}
			if (
				payloadIps.length !== resolvedAggregateClaims.length ||
				payloadIps.some((ip) => !resolvedAggregateClaims.includes(ip))
			) {
				throw coreRegionError(region.kind, "aggregate claim set");
			}
			if (payloadIps.some((ip) => claimedRegionInstructions.has(ip))) {
				throw coreRegionError(region.kind, "exclusive claims");
			}
			if (region.cost.metadataOperations !== payloadIps.length) {
				throw coreRegionError(region.kind, "metadata cost");
			}
			if (
				region.cost.score !==
				region.sites.reduce((total, site) => total + Math.max(1, site.slotCount), 0)
			) {
				throw coreRegionError(region.kind, "score cost");
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
			if (shards.length > 32) {
				throw coreRegionError(region.kind, "wire region capacity");
			}
			for (const sites of shards) {
				const claimedIps = sites.flatMap((site) => [
					site.allocationIp,
					...site.accesses.map((access) => access.ip),
					...(site.inheritedAccessIp === undefined ? [] : [site.inheritedAccessIp]),
					...site.materializations.map((materialization) => materialization.ip),
				]);
				for (const ip of claimedIps) claimedRegionInstructions.add(ip);
				checkAdmission(region.kind, claimedIps, admission);
				regions.push({
					kind: "stack-object-plan",
					license: {
						guard: guard,
						genericTwin: "retained",
						materialization: region.license.materialization,
						admission,
					},
					representation: "activation-local-fixed-shape-objects",
					anchors: sites.map((site) => site.allocationIp),
					claimedIps,
					controlFlow: {
						ordinaryBlockIps: claimedIps,
						exceptionalHandlerIps: [],
					},
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
			instructionIndexByTargetInstruction.get(instruction),
		);
		const claimedIps = region.claimedInstructions.map((instruction) =>
			instructionIndexByTargetInstruction.get(instruction),
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
				region.kind !== "string-char-code-at-chain" &&
				region.kind !== "builtin-collection-call-chain" &&
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
			throw coreRegionError(region.kind, "license, control-flow, or cost contract");
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
			throw coreRegionError(region.kind, "lowered control-flow or exclusive claims");
		}
		checkAdmission(region.kind, resolvedClaimedIps, admission);

		switch (region.kind) {
			case "regexp-exec-projection": {
				const callIp = resolvedAnchors[0];
				const firstLoadIp = resolvedAnchors[1];
				const propertyIp = instructionIndexByTargetInstruction.get(region.property);
				const nullChecks = region.nullChecks.map((check) => ({
					comparisonIp: instructionIndexByTargetInstruction.get(check.comparison),
					nullIp: instructionIndexByTargetInstruction.get(check.nullValue),
				}));
				const lockedLiteral =
					region.lockedLiteral === undefined
						? undefined
						: {
								constructorIntrinsicIp: instructionIndexByTargetInstruction.get(
									region.lockedLiteral.constructorIntrinsic,
								),
								constructIp: instructionIndexByTargetInstruction.get(
									region.lockedLiteral.construct,
								),
							};
				const loads = region.loads.map((load) => {
					const consumer = load.consumer;
					return {
						ip: instructionIndexByTargetInstruction.get(load.instruction),
						keyIp: instructionIndexByTargetInstruction.get(load.key),
						captureIndex: load.captureIndex,
						dst: load.instruction.registers[0],
						consumer:
							consumer === undefined
								? undefined
								: consumer.kind === "length"
									? {
											kind: consumer.kind,
											propertyIp: instructionIndexByTargetInstruction.get(
												consumer.property,
											),
										}
									: consumer.kind === "charCodeAtZero"
										? {
												kind: consumer.kind,
												methodIdentity: consumer.methodIdentity,
												propertyIp: instructionIndexByTargetInstruction.get(
													consumer.property,
												),
												callIp: instructionIndexByTargetInstruction.get(consumer.call),
												...(consumer.zero === undefined
													? {}
													: {
															zeroIp: instructionIndexByTargetInstruction.get(
																consumer.zero,
															),
														}),
											}
										: consumer.kind === "number"
											? {
													kind: consumer.kind,
													intrinsicIp: instructionIndexByTargetInstruction.get(
														consumer.intrinsic,
													),
													callIp: instructionIndexByTargetInstruction.get(consumer.call),
												}
											: {
													kind: consumer.kind,
													methodIdentity: consumer.methodIdentity,
													upperPropertyIp: instructionIndexByTargetInstruction.get(
														consumer.upperProperty,
													),
													upperCallIp: instructionIndexByTargetInstruction.get(
														consumer.upperCall,
													),
													lowerPropertyIp: instructionIndexByTargetInstruction.get(
														consumer.lowerProperty,
													),
													lowerIcIndex: propertyIcIndexByInstruction.get(
														consumer.lowerProperty,
													),
													lowerCallIp: instructionIndexByTargetInstruction.get(
														consumer.lowerCall,
													),
													resultMoveIps: consumer.resultMoves.map((move) =>
														instructionIndexByTargetInstruction.get(move),
													),
													lengthPropertyIp: instructionIndexByTargetInstruction.get(
														consumer.lengthProperty,
													),
												},
					};
				});
				const unresolved =
					propertyIp === undefined ||
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
					resolvedAnchors.length !== 2 ||
					region.resultRegisters.length === 0
				) {
					throw coreRegionError(region.kind, "projection metadata");
				}
				const resolvedPropertyIp = propertyIp;
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
				const resultRegisters = [...new Set(region.resultRegisters)];
				const loweredCall = instructions[callIp!];
				const loweredProperty = instructions[resolvedPropertyIp];
				const aliases = new Set(resultRegisters);
				const staticPropertyMatches = (
					instruction: BytecodeInstruction | undefined,
					object: number,
					name: string,
				): instruction is Extract<
					BytecodeInstruction,
					{ opcode: "LOAD_PROPERTY_STATIC" }
				> =>
					instruction?.opcode === "LOAD_PROPERTY_STATIC" &&
					instruction.object === object &&
					String.fromCharCode(...(stringConstants[instruction.stringIndex] ?? [])) ===
						name;
				const expectedProjectedStringMethodIdentity = vmGuardIsWorldInvariant(guard)
					? "authority-invariant"
					: "runtime-guarded";
				let operationsValid =
					loweredCall?.opcode === "CALL" &&
					aliases.has(loweredCall.dst) &&
					loweredCall.arguments.length === 1 &&
					guardedBuiltinCallOf(loweredCall)?.operation === "RegExp.prototype.exec" &&
					staticPropertyMatches(loweredProperty, loweredCall.thisValue, "exec") &&
					loweredProperty.dst === loweredCall.callee &&
					loweredProperty.object === loweredCall.thisValue;
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
						operationsValid &&= staticPropertyMatches(property, load.dst, "length");
					} else if (consumer?.kind === "charCodeAtZero") {
						const property = instructions[consumer.propertyIp];
						const call = instructions[consumer.callIp];
						const argument =
							call?.opcode === "CALL" && call.arguments[0] !== undefined
								? decodeVmValueOperand(call.arguments[0])
								: undefined;
						const zero =
							consumer.zeroIp === undefined ? undefined : instructions[consumer.zeroIp];
						const zeroArgument =
							argument?.kind === "number" && Object.is(argument.value, 0)
								? true
								: argument?.kind === "register" &&
									zero?.opcode === "CREATE_NUMBER" &&
									Object.is(zero.value, 0) &&
									argument.register === zero.dst;
						operationsValid &&=
							consumer.methodIdentity === expectedProjectedStringMethodIdentity &&
							staticPropertyMatches(property, load.dst, "charCodeAt") &&
							call?.opcode === "CALL" &&
							call.callee === property.dst &&
							call.thisValue === load.dst &&
							call.arguments.length === 1 &&
							zeroArgument;
					} else if (consumer?.kind === "number") {
						const intrinsic = instructions[consumer.intrinsicIp];
						const call = instructions[consumer.callIp];
						const argument =
							call?.opcode === "CALL" && call.arguments[0] !== undefined
								? decodeVmValueOperand(call.arguments[0])
								: undefined;
						operationsValid &&=
							intrinsic?.opcode === "LOAD_INTRINSIC" &&
							intrinsic.intrinsic === "Number" &&
							call?.opcode === "CALL" &&
							call.callee === intrinsic.dst &&
							call.arguments.length === 1 &&
							argument?.kind === "register" &&
							argument.register === load.dst;
					} else if (consumer?.kind === "asciiCaseLength") {
						const upperProperty = instructions[consumer.upperPropertyIp];
						const upperCall = instructions[consumer.upperCallIp];
						const lowerProperty = instructions[consumer.lowerPropertyIp];
						const lowerCall = instructions[consumer.lowerCallIp];
						let lowerResult = lowerCall?.opcode === "CALL" ? lowerCall.dst : -1;
						let movesValid = lowerResult >= 0;
						for (const ip of consumer.resultMoveIps) {
							const move = instructions[ip];
							if (move?.opcode !== "MOVE" || move.src !== lowerResult) {
								movesValid = false;
								break;
							}
							lowerResult = move.dst;
						}
						const lengthProperty = instructions[consumer.lengthPropertyIp];
						operationsValid &&=
							consumer.methodIdentity === expectedProjectedStringMethodIdentity &&
							staticPropertyMatches(upperProperty, load.dst, "toUpperCase") &&
							upperCall?.opcode === "CALL" &&
							upperCall.callee === upperProperty.dst &&
							upperCall.thisValue === load.dst &&
							upperCall.arguments.length === 0 &&
							staticPropertyMatches(lowerProperty, upperCall.dst, "toLowerCase") &&
							lowerCall?.opcode === "CALL" &&
							lowerCall.callee === lowerProperty.dst &&
							lowerCall.thisValue === upperCall.dst &&
							lowerCall.arguments.length === 0 &&
							movesValid &&
							staticPropertyMatches(lengthProperty, lowerResult, "length");
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
					!vmPropertyPlacementHolds(
						region.propertyPlacement,
						resolvedPropertyIp,
						callIp!,
						instructions,
						handlers,
					) ||
					(region.propertyPlacement === "call-fallback" &&
						resolvedLockedLiteral === undefined) ||
					firstLoadIp !== resolvedLoads[0]?.ip ||
					resultRegisters.some(
						(register) =>
							!Number.isInteger(register) || register < 0 || register >= fn.registerCount,
					) ||
					resolvedLoads.length === 0 ||
					resolvedLoads.length > 8 ||
					new Set(resolvedLoads.map((load) => load.captureIndex)).size !==
						resolvedLoads.length ||
					region.cost.metadataOperations !== payloadIps.size ||
					payloadIps.size !== resolvedClaimedIps.length ||
					resolvedClaimedIps.some((ip) => !payloadIps.has(ip))
				) {
					throw coreRegionError(region.kind, "instruction, register, or claim contract");
				}
				for (const ip of resolvedClaimedIps) claimedRegionInstructions.add(ip);
				regions.push({
					kind: "regexp-exec-projection",
					license: {
						guard,
						genericTwin: "retained",
						materialization: "whole-region",
						admission,
					},
					representation: "regexp-capture-spans",
					anchors: resolvedAnchors,
					claimedIps: resolvedClaimedIps,
					controlFlow: {
						ordinaryBlockIps: resolvedOrdinaryBlockIps,
						exceptionalHandlerIps: [],
					},
					cost: region.cost,
					propertyIp: resolvedPropertyIp,
					propertyPlacement: region.propertyPlacement,
					callIp: callIp!,
					lockedFreshLiteral: resolvedLockedLiteral !== undefined,
					...(resolvedLockedLiteral === undefined
						? {}
						: { lockedLiteral: resolvedLockedLiteral }),
					callee: loweredCall.callee,
					receiver: loweredCall.thisValue,
					input: loweredCall.arguments[0]!,
					result: loweredCall.dst,
					resultRegisters,
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
				const loads = region.loads.map((load) => ({
					ip: instructionIndexByTargetInstruction.get(load.instruction),
					keyIp: instructionIndexByTargetInstruction.get(load.key),
					captureIndex: load.captureIndex,
					dst: load.instruction.registers[0],
					numberIntrinsicIp: instructionIndexByTargetInstruction.get(
						load.numberIntrinsic,
					),
					numberCallIp: instructionIndexByTargetInstruction.get(load.numberCall),
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
					region.resultRegisters.length === 0 ||
					loads.some(
						(load) =>
							load.ip === undefined ||
							load.keyIp === undefined ||
							load.numberIntrinsicIp === undefined ||
							load.numberCallIp === undefined,
					)
				) {
					throw coreRegionError(region.kind, "projection metadata");
				}
				const resolvedLoads = loads as Array<
					VmRegExpIteratorProjectionRegion["loads"][number]
				>;
				const resultRegisters = [...new Set(region.resultRegisters)];
				const step = instructions[stepIp!];
				const doneBranch = instructions[doneBranchIp!];
				const aliases = new Set(resultRegisters);
				let operationsValid =
					step?.opcode === "ITERATOR_STEP" &&
					aliases.has(step.valueDst) &&
					doneBranch?.opcode === "JUMP_IF" &&
					// Encoding only: Core certifies the step as the last instruction of its
					// block and the branch as that block's terminator, so the two must be
					// emitted back to back. Both are named anchors; this rejects a mismatch
					// instead of discovering the region from the distance.
					doneBranchIp === stepIp! + 1 &&
					doneBranch.cond === step.doneDst &&
					doneBranch.targetIp === exitIp;
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
					resultRegisters.some(
						(register) =>
							!Number.isInteger(register) || register < 0 || register >= fn.registerCount,
					) ||
					resolvedLoads.length === 0 ||
					resolvedLoads.length > 8 ||
					new Set(resolvedLoads.map((load) => load.captureIndex)).size !==
						resolvedLoads.length ||
					region.cost.metadataOperations !== payloadIps.size ||
					payloadIps.size !== resolvedClaimedIps.length ||
					resolvedClaimedIps.some((ip) => !payloadIps.has(ip))
				) {
					throw coreRegionError(region.kind, "instruction, register, or claim contract");
				}
				for (const ip of resolvedClaimedIps) claimedRegionInstructions.add(ip);
				regions.push({
					kind: "regexp-iterator-projection",
					license: {
						guard,
						genericTwin: "retained",
						materialization: "on-demand",
						admission,
					},
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
					resultRegisters,
					statefulEffect: "iterator-last-index-retained-step",
					runtimeGuard: "exact-brand-next-realm-regexp",
					loads: resolvedLoads,
				});
				break;
			}
			case "string-slice-number": {
				const sliceCallIp = resolvedAnchors[0];
				const numberCallIp = resolvedAnchors[1];
				const propertyIp = instructionIndexByTargetInstruction.get(region.property);
				const sliceStartIp = instructionIndexByTargetInstruction.get(
					region.sliceStartInstruction,
				);
				const numberIntrinsicIp = instructionIndexByTargetInstruction.get(
					region.numberIntrinsic,
				);
				if (
					region.representation !== "primitive-string-span-number" ||
					region.license.materialization !== "none" ||
					!guard.obligations.includes("fallback") ||
					guard.obligations.includes("materialize") ||
					resolvedAnchors.length !== 2 ||
					propertyIp === undefined ||
					sliceStartIp === undefined ||
					numberIntrinsicIp === undefined
				) {
					throw coreRegionError(region.kind, "fusion metadata");
				}
				const property = instructions[propertyIp];
				const sliceCall = instructions[sliceCallIp!];
				const sliceStartInstruction = instructions[sliceStartIp];
				const numberIntrinsic = instructions[numberIntrinsicIp];
				const numberCall = instructions[numberCallIp!];
				const numberArgument =
					numberCall?.opcode === "CALL" && numberCall.arguments[0] !== undefined
						? decodeVmValueOperand(numberCall.arguments[0])
						: undefined;
				const expectedBuiltinIdentities =
					sliceCall?.opcode === "CALL" &&
					guardedBuiltinCallOf(sliceCall) !== undefined &&
					vmGuardIsWorldInvariant(guardedBuiltinCallOf(sliceCall)!.guard)
						? "authority-invariant"
						: "runtime-guarded";
				const payloadIps = new Set([
					propertyIp,
					sliceCallIp!,
					sliceStartIp,
					numberIntrinsicIp,
					numberCallIp!,
				]);
				if (
					property?.opcode !== "LOAD_PROPERTY_STATIC" ||
					String.fromCharCode(...(stringConstants[property.stringIndex] ?? [])) !==
						"slice" ||
					sliceCall?.opcode !== "CALL" ||
					!vmCallProvesBuiltin(
						(() => {
							const plan = nativePlanOf(sliceCall);
							return plan?.kind === "call" ? plan : undefined;
						})(),
						"String.prototype.slice",
						{
							lowering: "number-consumer-fusion",
							result: "string",
							effects: ["coerce", "allocate", "throw", "safepoint"],
						},
					) ||
					sliceCall.arguments.length !== 1 ||
					property.dst !== sliceCall.callee ||
					property.object !== sliceCall.thisValue ||
					(sliceStartInstruction?.opcode !== "CREATE_NUMBER" &&
						sliceStartInstruction?.opcode !== "CREATE_F64") ||
					!Object.is(sliceStartInstruction.value, region.sliceStart) ||
					!Number.isFinite(region.sliceStart) ||
					numberIntrinsic?.opcode !== "LOAD_INTRINSIC" ||
					numberIntrinsic.intrinsic !== "Number" ||
					numberCall?.opcode !== "CALL" ||
					numberCall.callee !== numberIntrinsic.dst ||
					numberCall.arguments.length !== 1 ||
					numberArgument?.kind !== "register" ||
					numberArgument.register !== sliceCall.dst ||
					region.builtinIdentities !== expectedBuiltinIdentities ||
					!vmPropertyPlacementHolds(
						region.propertyPlacement,
						propertyIp,
						sliceCallIp!,
						instructions,
						handlers,
					) ||
					(region.propertyPlacement === "call-fallback" &&
						region.builtinIdentities !== "authority-invariant") ||
					region.cost.metadataOperations !== payloadIps.size ||
					payloadIps.size !== resolvedClaimedIps.length ||
					resolvedClaimedIps.some((ip) => !payloadIps.has(ip))
				) {
					throw coreRegionError(region.kind, "instruction or claim contract");
				}
				for (const ip of resolvedClaimedIps) claimedRegionInstructions.add(ip);
				regions.push({
					kind: "string-slice-number",
					license: {
						guard,
						genericTwin: "retained",
						materialization: "none",
						admission,
					},
					representation: "primitive-string-span-number",
					anchors: resolvedAnchors,
					claimedIps: resolvedClaimedIps,
					controlFlow: {
						ordinaryBlockIps: resolvedOrdinaryBlockIps,
						exceptionalHandlerIps: resolvedExceptionalHandlerIps,
					},
					cost: region.cost,
					propertyIp,
					propertyPlacement: region.propertyPlacement,
					builtinIdentities: region.builtinIdentities,
					sliceCallIp: sliceCallIp!,
					sliceStartIp,
					numberIntrinsicIp,
					numberCallIp: numberCallIp!,
					numberCallee: numberCall.callee,
					receiver: sliceCall.thisValue,
					sliceStart: region.sliceStart,
					result: numberCall.dst,
				});
				break;
			}
			case "string-char-code-at-chain": {
				const propertyIp = instructionIndexByTargetInstruction.get(region.property);
				const callIp = instructionIndexByTargetInstruction.get(region.call);
				const propertyIcIndex = propertyIcIndexByInstruction.get(region.property);
				const property = propertyIp === undefined ? undefined : instructions[propertyIp];
				const call = callIp === undefined ? undefined : instructions[callIp];
				const expectedMethodIdentity = vmGuardIsWorldInvariant(guard)
					? "authority-invariant"
					: "runtime-guarded";
				const payloadIps = new Set([propertyIp, callIp]);
				if (
					region.representation !== "primitive-string-code-unit" ||
					region.license.materialization !== "none" ||
					region.license.admission.mode !== "capture" ||
					region.runtimeGuard !== "primitive-string-number-position" ||
					region.evaluationOrder !== "capture-property-before-arguments" ||
					region.methodIdentity !== expectedMethodIdentity ||
					propertyIp === undefined ||
					callIp === undefined ||
					propertyIcIndex === undefined ||
					property?.opcode !== "LOAD_PROPERTY_STATIC" ||
					String.fromCharCode(...(stringConstants[property.stringIndex] ?? [])) !==
						"charCodeAt" ||
					call?.opcode !== "CALL" ||
					!vmCallProvesBuiltin(
						(() => {
							const plan = nativePlanOf(call);
							return plan?.kind === "call" ? plan : undefined;
						})(),
						"String.prototype.charCodeAt",
						{
							lowering: "guarded-primitive-string",
							result: "number",
							effects: ["coerce", "throw"],
						},
					) ||
					call.arguments.length > 1 ||
					property.dst !== call.callee ||
					property.object !== call.thisValue ||
					resolvedAnchors.length !== 2 ||
					resolvedAnchors[0] !== propertyIp ||
					resolvedAnchors[1] !== callIp ||
					payloadIps.size !== 2 ||
					resolvedClaimedIps.length !== 2 ||
					resolvedClaimedIps.some((ip) => !payloadIps.has(ip)) ||
					region.cost.metadataOperations !== 2
				) {
					throw coreRegionError(region.kind, "instruction or claim contract");
				}
				for (const ip of resolvedClaimedIps) claimedRegionInstructions.add(ip);
				regions.push({
					kind: "string-char-code-at-chain",
					license: {
						guard,
						genericTwin: "retained",
						materialization: "none",
						admission,
					},
					representation: "primitive-string-code-unit",
					anchors: resolvedAnchors,
					claimedIps: resolvedClaimedIps,
					controlFlow: {
						ordinaryBlockIps: resolvedOrdinaryBlockIps,
						exceptionalHandlerIps: resolvedExceptionalHandlerIps,
					},
					cost: region.cost,
					propertyIp,
					callIp,
					methodIdentity: region.methodIdentity,
					runtimeGuard: "primitive-string-number-position",
					evaluationOrder: "capture-property-before-arguments",
					propertyIcIndex,
					callee: call.callee,
					receiver: call.thisValue,
					result: call.dst,
				});
				break;
			}
			case "builtin-collection-call-chain": {
				const propertyIp = instructionIndexByTargetInstruction.get(region.property);
				const callIp = instructionIndexByTargetInstruction.get(region.call);
				const propertyIcIndex = propertyIcIndexByInstruction.get(region.property);
				const property = propertyIp === undefined ? undefined : instructions[propertyIp];
				const call = callIp === undefined ? undefined : instructions[callIp];
				const callPlan =
					call === undefined
						? undefined
						: (() => {
								const plan = nativePlanOf(call);
								return plan?.kind === "call" ? plan : undefined;
							})();
				const payloadIps = new Set([propertyIp, callIp]);
				if (
					region.representation !== "captured-collection-method" ||
					region.license.materialization !== "none" ||
					region.license.admission.mode !== "capture" ||
					region.runtimeGuard !== "exact-collection-method" ||
					region.evaluationOrder !== "capture-property-before-arguments" ||
					propertyIp === undefined ||
					callIp === undefined ||
					propertyIcIndex === undefined ||
					property?.opcode !== "LOAD_PROPERTY_STATIC" ||
					String.fromCharCode(...(stringConstants[property.stringIndex] ?? [])) !==
						region.operation.split(".").at(-1) ||
					call?.opcode !== "CALL" ||
					!vmCallProvesBuiltin(callPlan, region.operation) ||
					property.dst !== call.callee ||
					property.object !== call.thisValue ||
					resolvedAnchors.length !== 2 ||
					resolvedAnchors[0] !== propertyIp ||
					resolvedAnchors[1] !== callIp ||
					payloadIps.size !== 2 ||
					resolvedClaimedIps.length !== 2 ||
					resolvedClaimedIps.some((ip) => !payloadIps.has(ip)) ||
					region.cost.score !== 14 ||
					region.cost.metadataOperations !== 2
				) {
					throw coreRegionError(region.kind, "instruction or claim contract");
				}
				for (const ip of resolvedClaimedIps) claimedRegionInstructions.add(ip);
				regions.push({
					kind: "builtin-collection-call-chain",
					license: {
						guard,
						genericTwin: "retained",
						materialization: "none",
						admission,
					},
					representation: "captured-collection-method",
					anchors: resolvedAnchors,
					claimedIps: resolvedClaimedIps,
					controlFlow: {
						ordinaryBlockIps: resolvedOrdinaryBlockIps,
						exceptionalHandlerIps: resolvedExceptionalHandlerIps,
					},
					cost: region.cost,
					propertyIp,
					callIp,
					operation: region.operation,
					runtimeGuard: "exact-collection-method",
					evaluationOrder: "capture-property-before-arguments",
					propertyIcIndex,
					callee: call.callee,
					receiver: call.thisValue,
					result: call.dst,
				});
				break;
			}
			case "string-split-projection": {
				const callIp = resolvedAnchors[0];
				const firstLoadIp = resolvedAnchors[1];
				const propertyIp =
					region.property === undefined
						? -1
						: instructionIndexByTargetInstruction.get(region.property);
				const separatorIp = instructionIndexByTargetInstruction.get(region.separator);
				const loads = region.loads.map((load) => ({
					ip: instructionIndexByTargetInstruction.get(load.instruction),
					kind: load.kind,
					...(load.kind === "element"
						? {
								index: load.index,
								keyIp: instructionIndexByTargetInstruction.get(load.key),
							}
						: {}),
					dst: load.instruction.registers[0],
				}));
				if (
					region.representation !== "projected-elements" ||
					region.license.materialization !== "whole-region" ||
					!guard.obligations.includes("fallback") ||
					!guard.obligations.includes("materialize") ||
					resolvedAnchors.length !== 2 ||
					propertyIp === undefined ||
					separatorIp === undefined ||
					loads.some(
						(load) =>
							load.ip === undefined ||
							(load.kind === "element" && load.keyIp === undefined),
					)
				) {
					throw coreRegionError(region.kind, "projection metadata");
				}
				const loweredCall = instructions[callIp!];
				const loweredProperty = propertyIp < 0 ? undefined : instructions[propertyIp];
				const loweredSeparator = instructions[separatorIp];
				const resultRegisters = [...new Set(region.resultRegisters)];
				const resolvedLoads = loads as Array<{
					ip: number;
					kind: "element" | "length";
					index?: number;
					keyIp?: number;
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
				// Core names the exact producers because flattened order cannot distinguish
				// register definitions on mutually exclusive CFG paths after allocation.
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
						? guardMatchesCall(guardedBuiltinCallOf(loweredCall)?.guard) &&
							(guard.dependencies[0]?.kind === "world" ||
								(guard.dependencies[0]?.kind === "epoch" &&
									guard.dependencies[0]?.family === "watched-methods")) &&
							propertyIp >= 0 &&
							loweredProperty?.opcode === "LOAD_PROPERTY_STATIC" &&
							loweredProperty.dst === loweredCall.callee &&
							loweredProperty.object === loweredCall.thisValue &&
							stringConstantEquals(loweredProperty.stringIndex, "split") &&
							guardedBuiltinCallOf(loweredCall)?.operation === "String.prototype.split"
						: loweredCall?.opcode === "CALL_BUILTIN" &&
							guard.dependencies.length === 1 &&
							guard.dependencies[0]?.kind === "world" &&
							propertyIp === -1 &&
							loweredCall.operation === "String.prototype.split";
				const expectedSplitIdentity =
					loweredCall?.opcode === "CALL_BUILTIN" ||
					(loweredCall?.opcode === "CALL" &&
						guardedBuiltinCallOf(loweredCall) !== undefined &&
						vmGuardIsWorldInvariant(guardedBuiltinCallOf(loweredCall)!.guard))
						? "authority-invariant"
						: "runtime-guarded";
				const separator =
					(loweredCall?.opcode === "CALL" || loweredCall?.opcode === "CALL_BUILTIN") &&
					loweredCall.arguments.length === 1
						? decodeVmValueOperand(loweredCall.arguments[0]!)
						: undefined;
				const separatorMatches =
					separator?.kind === "string"
						? separator.index === region.separatorStringIndex
						: separator?.kind === "register" &&
							loweredSeparator?.opcode === "CREATE_STRING" &&
							loweredSeparator.dst === separator.register &&
							loweredSeparator.stringIndex === region.separatorStringIndex;
				const elementLoads = resolvedLoads.filter((load) => load.kind === "element");
				const lengthLoads = resolvedLoads.filter((load) => load.kind === "length");
				const aliases = new Set(resultRegisters);
				let operationsValid = true;
				for (const load of resolvedLoads) {
					const lowered = instructions[load.ip];
					if (
						(lowered?.opcode !== "LOAD_PROPERTY" &&
							lowered?.opcode !== "LOAD_PROPERTY_STATIC") ||
						!aliases.has(lowered.object) ||
						lowered.dst !== load.dst
					) {
						operationsValid = false;
						break;
					}
					if (load.kind === "element") {
						const key = load.keyIp === undefined ? undefined : instructions[load.keyIp];
						if (
							lowered.opcode !== "LOAD_PROPERTY" ||
							!Number.isInteger(load.index) ||
							load.index! < 0 ||
							load.index! > 0xffff ||
							key?.opcode !== "CREATE_NUMBER" ||
							key.dst !== lowered.key ||
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
				const payloadIps = [
					...(propertyIp < 0 ? [] : [propertyIp]),
					separatorIp,
					callIp!,
					...resolvedLoads.flatMap((load) =>
						load.keyIp === undefined ? [load.ip] : [load.keyIp, load.ip],
					),
				];
				if (
					!callMatches ||
					loweredCall === undefined ||
					(loweredCall.opcode !== "CALL" && loweredCall.opcode !== "CALL_BUILTIN") ||
					loweredCall.arguments.length !== 1 ||
					resultRegisters.length === 0 ||
					!resultRegisters.includes(loweredCall.dst) ||
					resultRegisters.some(
						(register) =>
							!Number.isInteger(register) || register < 0 || register >= fn.registerCount,
					) ||
					!separatorMatches ||
					region.splitIdentity !== expectedSplitIdentity ||
					!vmPropertyPlacementHolds(
						region.propertyPlacement,
						propertyIp,
						callIp!,
						instructions,
						handlers,
					) ||
					(region.propertyPlacement === "call-fallback" &&
						region.splitIdentity !== "authority-invariant") ||
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
					throw coreRegionError(region.kind, "instruction, register, or claim contract");
				}
				for (const ip of resolvedClaimedIps) claimedRegionInstructions.add(ip);
				regions.push({
					kind: "string-split-projection",
					license: {
						guard,
						genericTwin: "retained",
						materialization: "whole-region",
						admission,
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
					propertyPlacement: region.propertyPlacement,
					splitIdentity: region.splitIdentity,
					callIp: callIp!,
					callee: loweredCall.opcode === "CALL" ? loweredCall.callee : -1,
					receiver: loweredCall.thisValue,
					separatorIp,
					separatorStringIndex: region.separatorStringIndex,
					resultRegisters,
					loads: resolvedLoads as VmStringSplitProjectionRegion["loads"],
				});
				break;
			}
			case "string-split-cursor": {
				const callIp = resolvedAnchors[0];
				const headerBranchIp = resolvedAnchors[1];
				const lengthIp = resolvedAnchors[2];
				const backedgeIp = resolvedAnchors[3];
				const propertyIp =
					region.property === undefined
						? -1
						: instructionIndexByTargetInstruction.get(region.property);
				const elementIp = instructionIndexByTargetInstruction.get(region.element);
				const trimPropertyIp = instructionIndexByTargetInstruction.get(
					region.trimProperty,
				);
				const trimCallIp = instructionIndexByTargetInstruction.get(region.trimCall);
				const compareIp = instructionIndexByTargetInstruction.get(region.compare);
				const advanceIp =
					region.advance === undefined
						? undefined
						: instructionIndexByTargetInstruction.get(region.advance);
				const incrementIp = instructionIndexByTargetInstruction.get(region.increment);
				const exitIp = blockStartIps.get(region.exitBlock);
				const trimIcIndex = propertyIcIndexByInstruction.get(region.trimProperty);
				const primitiveStringLengthIps = region.primitiveStringLengths.map((load) =>
					instructionIndexByTargetInstruction.get(load),
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
					compareIp === undefined ||
					incrementIp === undefined ||
					exitIp === undefined ||
					trimIcIndex === undefined ||
					primitiveStringLengthIps.some((ip) => ip === undefined)
				) {
					throw coreRegionError(region.kind, "cursor metadata");
				}
				const loweredCall = instructions[callIp!];
				const loweredHeaderBranch = instructions[headerBranchIp!];
				const loweredLength = instructions[lengthIp!];
				const loweredCompare = instructions[compareIp];
				const loweredElement = instructions[elementIp];
				const loweredTrimCall = instructions[trimCallIp];
				const loweredAdvance =
					advanceIp === undefined ? undefined : instructions[advanceIp];
				const loweredIncrement = instructions[incrementIp];
				const resultRegisters = [...new Set(region.resultRegisters)];
				const expectedSplitIdentity =
					loweredCall?.opcode === "CALL_BUILTIN" ||
					(loweredCall?.opcode === "CALL" &&
						guardedBuiltinCallOf(loweredCall) !== undefined &&
						vmGuardIsWorldInvariant(guardedBuiltinCallOf(loweredCall)!.guard))
						? "authority-invariant"
						: "runtime-guarded";
				const expectedTrimIdentity =
					loweredTrimCall?.opcode === "CALL" &&
					guardedBuiltinCallOf(loweredTrimCall) !== undefined &&
					vmGuardIsWorldInvariant(guardedBuiltinCallOf(loweredTrimCall)!.guard)
						? "authority-invariant"
						: "runtime-guarded";
				if (
					(loweredCall?.opcode !== "CALL" && loweredCall?.opcode !== "CALL_BUILTIN") ||
					loweredCall.arguments.length !== 1 ||
					(loweredCall.opcode === "CALL_BUILTIN" &&
						(loweredCall.operation !== "String.prototype.split" ||
							propertyIp !== -1 ||
							guard.dependencies.length !== 1 ||
							guard.dependencies[0]?.kind !== "world")) ||
					(loweredCall.opcode === "CALL" && propertyIp < 0) ||
					loweredHeaderBranch?.opcode !== "JUMP_IF" ||
					loweredLength?.opcode !== "LOAD_PROPERTY_STATIC" ||
					!resultRegisters.includes(loweredLength.object) ||
					loweredCompare?.opcode !== "BINARY" ||
					loweredCompare.operator !== "<" ||
					loweredCompare.right !== loweredLength.dst ||
					loweredHeaderBranch.cond !== loweredCompare.dst ||
					loweredElement?.opcode !== "LOAD_PROPERTY" ||
					!resultRegisters.includes(loweredElement.object) ||
					loweredElement.key !== loweredCompare.left ||
					region.splitIdentity !== expectedSplitIdentity ||
					region.trimIdentity !== expectedTrimIdentity ||
					(region.advance !== undefined && advanceIp === undefined) ||
					(loweredAdvance !== undefined &&
						(loweredAdvance.opcode !== "UNARY" ||
							loweredAdvance.operator !== "tonumeric" ||
							loweredAdvance.src !== loweredCompare.left)) ||
					loweredIncrement?.opcode !== "UNARY" ||
					loweredIncrement.operator !== "increment" ||
					loweredIncrement.src !==
						(loweredAdvance?.opcode === "UNARY"
							? loweredAdvance.dst
							: loweredCompare.left) ||
					loweredIncrement.dst !== loweredCompare.left ||
					resultRegisters.length === 0 ||
					!resultRegisters.includes(loweredCall.dst) ||
					resultRegisters.some(
						(register) =>
							!Number.isInteger(register) || register < 0 || register >= fn.registerCount,
					)
				) {
					throw coreRegionError(region.kind, "instruction or register contract");
				}
				const resolvedPrimitiveStringLengthIps =
					primitiveStringLengthIps as Array<number>;
				for (const ip of resolvedPrimitiveStringLengthIps) {
					const load = instructions[ip];
					if (load?.opcode !== "LOAD_PROPERTY_STATIC") {
						throw coreRegionError(region.kind, "primitive String length operation");
					}
					setNativeInstructionPlan(ip, { kind: "primitive-string-length" });
				}
				const payloadIps = [
					...(propertyIp < 0 ? [] : [propertyIp]),
					callIp!,
					lengthIp!,
					compareIp,
					headerBranchIp!,
					elementIp,
					trimPropertyIp,
					trimCallIp,
					...resolvedPrimitiveStringLengthIps,
					...(advanceIp === undefined ? [] : [advanceIp]),
					incrementIp,
					backedgeIp!,
				];
				if (
					region.cost.metadataOperations !== payloadIps.length ||
					new Set(payloadIps).size !== payloadIps.length ||
					payloadIps.length !== resolvedClaimedIps.length ||
					payloadIps.some((ip) => !resolvedClaimedIps.includes(ip))
				) {
					throw coreRegionError(region.kind, "claim or cost contract");
				}
				if (
					!vmPropertyPlacementHolds(
						region.propertyPlacement,
						propertyIp,
						callIp!,
						instructions,
						handlers,
					) ||
					(region.propertyPlacement === "call-fallback" &&
						region.splitIdentity !== "authority-invariant")
				) {
					throw coreRegionError(region.kind, "property placement contract");
				}
				for (const ip of resolvedClaimedIps) claimedRegionInstructions.add(ip);
				regions.push({
					kind: "string-split-cursor",
					license: {
						guard,
						genericTwin: "retained",
						materialization: "on-demand",
						admission,
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
					propertyPlacement: region.propertyPlacement,
					splitIdentity: region.splitIdentity,
					trimIdentity: region.trimIdentity,
					callee: loweredCall.opcode === "CALL" ? loweredCall.callee : -1,
					receiver: loweredCall.thisValue,
					separator: loweredCall.arguments[0]!,
					resultRegisters,
					index: loweredCompare.left,
					elementIp,
					trimPropertyIp,
					trimIcIndex,
					trimCallIp,
					primitiveStringLengthIps: resolvedPrimitiveStringLengthIps,
					exitIp,
				});
				break;
			}
		}
	}
	const safepoints = fn.gc.safepoints.flatMap(({ kind, instruction, rootRegisters }) => {
		const instructionIp = instructionIndexByTargetInstruction.get(instruction);
		return instructionIp === undefined
			? []
			: [{ kind, instructionIp, rootRegisters: [...rootRegisters] }];
	});
	const directEntries: Array<NativeDirectEntryPlan> = fn.directEntries.map((entry) => ({
		id: entry.id,
		parameterRepresentations: [...entry.parameterRepresentations],
		resultRepresentation: entry.resultRepresentation,
		registerRepresentations: [...entry.registerRepresentations],
		gc: {
			safepoints: entry.gc.safepoints.flatMap(({ kind, instruction, rootRegisters }) => {
				const instructionIp = instructionIndexByTargetInstruction.get(instruction);
				return instructionIp === undefined
					? []
					: [{ kind, instructionIp, rootRegisters: [...rootRegisters] }];
			}),
		},
	}));
	return {
		functionIndex: fn.functionIndex,
		mode: fn.isGenerator || fn.isAsync ? "resumable" : "direct",
		registerRepresentations: [...fn.registerRepresentations],
		directEntries,
		gc: { safepoints },
		instructions: nativeInstructions,
		specializations: regions,
		regionActions: vmRegionActions(regions),
		...(compilerSiteIds.some((site) => site !== undefined) ? { compilerSiteIds } : {}),
	};
}

/**
 * Map the allocated Core target instruction to the VM instruction set.
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
	instruction: Extract<CompilerInstruction, { type: "call" }>,
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
