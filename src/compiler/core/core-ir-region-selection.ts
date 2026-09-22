import { builtinOperationDescriptor } from "../shared/builtin-registry.ts";
import type { CompilerGuardPlan } from "../shared/compiler-facts.ts";
import {
	compilerFactIsWorldInvariant,
	compilerGuardPlan,
} from "../shared/compiler-facts.ts";
import { COMPILER_VALUE_KIND_NUMBER } from "../shared/compiler-value-kinds.ts";
import type { ReturnRepresentation } from "../shared/effect-summary.ts";
import {
	factDependencyEquals,
	factObligationEquals,
} from "../shared/fact-implication.ts";
import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import {
	CORE_FUNCTION_HAS_ALLOCATIONS,
	CORE_FUNCTION_HAS_CANDIDATE_OPCODES,
	CoreFunctionFeatureIndex,
} from "./core-function-features.ts";
import {
	coreInstanceMethodHints,
	coreInstanceMethodTargets,
} from "./core-instance-method-hints.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "./core-internal-attributes.ts";
import {
	coreDirectBuiltinCallbackTarget,
	coreValueIsLoadedGlobalProperty,
} from "./core-ir-call-targets.ts";
import { CORE_CONTROL_FLOW_BUNDLE_ANALYSIS } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreGeneratedCodeCostModel } from "./core-ir-generated-cost.ts";
import type { CoreGeneratedCodeCostModel } from "./core-ir-generated-cost.ts";
import { CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS } from "./core-ir-provenance.ts";
import type {
	CoreIteratorCursorCandidate,
	CoreLocalSpecializationCandidate,
} from "./core-ir-provenance.ts";
import { CORE_LOCAL_FACT_BUNDLE_ANALYSIS } from "./core-ir-provenance.ts";
import { coreTargetSupportsSpecialization } from "./core-ir-region-strategies.ts";
import {
	corePlanAdmissionMode,
	corePlanVersionStamp,
} from "./core-ir-region-validity.ts";
import type {
	CoreDirectEntryCallSite,
	CoreDirectEntryPlan,
	CoreOptimizationPlan,
	CoreOptimizationPlanStatistics,
	CorePlanRepresentation,
	CorePlanSpecialization,
	CorePlanSpecializationKind,
} from "./core-ir-regions.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import { coreInstructionId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreRepresentation,
	CoreValueId,
} from "./core-ir.ts";
import { coreSpecializedOnlyFunctions } from "./core-native-body-reachability.ts";
import {
	coreArgumentObservation,
	analyzeCoreNativeEntry,
} from "./core-native-entry-analysis.ts";
import {
	coreReadOnlyNumericParameterFields,
	coreFieldEntryHasNumericComputations,
	coreNumericFieldArgument,
} from "./core-native-field-analysis.ts";
import {
	coreOperatorInputPlans,
	coreBuiltinInputPlans,
	corePrivateNumericArrayElementPlans,
	corePrivatePackedRestArrayElementPlans,
	coreUnsignedArithmeticPlans,
} from "./core-native-numeric-analysis.ts";
import type {
	CoreBuiltinInputPlan,
	CoreOperatorInputPlan,
	CorePrivateNumericArrayElementPlan,
	CorePrivatePackedRestArrayElementPlan,
	CoreUnsignedArithmeticPlan,
} from "./core-native-numeric-analysis.ts";
import { buildCoreSpecializationRecipeTable } from "./core-specialization-recipes.ts";
import { coreFunctionVersionsAreCurrent } from "./core-store.ts";
import type { CoreFunctionVersions, CoreProgram } from "./core-store.ts";
import {
	CORE_SPECIALIZATION_EXPANSIONS_PER_FUNCTION,
	CoreTransformCandidateService,
	DEFAULT_CORE_SPECIALIZATION_BUDGETS,
} from "./core-transform-candidates.ts";
import type {
	CoreTransformBudgetLimits,
	CoreTransformCandidate,
	CoreTransformDeclineReason,
	CoreTransformDiscoveryCost,
} from "./core-transform-candidates.ts";

type CorePendingClaims = Pick<
	CorePlanSpecialization,
	"function" | "kind" | "composition" | "claimedInstructions"
>;

export interface CorePendingOptimizationCandidate {
	readonly budget: CoreTransformCandidate;
	readonly claims: CorePendingClaims;
	readonly source?: CoreLocalSpecializationCandidate;
	readonly materialize: () => CorePlanSpecialization;
}

interface PendingDirectEntry {
	readonly budget: CoreTransformCandidate;
	readonly function: CoreFunctionId;
	readonly callSites: ReadonlyArray<CoreDirectEntryCallSite>;
	readonly parameterRepresentations: ReadonlyArray<CorePlanRepresentation>;
	readonly resultRepresentation: CorePlanRepresentation;
	readonly valueRepresentations?: ReadonlyArray<CorePlanRepresentation>;
	readonly argumentRepresentations?: ReadonlyArray<CorePlanRepresentation>;
	readonly constantBooleans?: CoreDirectEntryPlan["constantBooleans"];
	readonly operatorInputs?: CoreDirectEntryPlan["operatorInputs"];
	readonly fieldParameters?: CoreDirectEntryPlan["fieldParameters"];
	readonly runtimeBenefit: number;
}

type PendingCandidate = CorePendingOptimizationCandidate | PendingDirectEntry;

interface CorePlanningOpportunity extends CoreTransformDiscoveryCost {
	readonly kind: "local" | "direct-entry" | "guarded-call";
	readonly priorityScore: number;
	readonly resolve: () => ReadonlyArray<PendingCandidate>;
}

export interface CoreLocalCandidateSummary {
	readonly kind: CoreLocalSpecializationCandidate["kind"];
	readonly fanOut: number;
}

export interface CoreLocalOptimizationPlanInput {
	readonly function: CoreFunctionId;
	readonly context: CoreCompilationContext | undefined;
	readonly discovery:
		| { readonly priorityScore: number; readonly compilerWorkCost: number }
		| undefined;
	readonly operatorInputs: ReadonlyArray<CoreOperatorInputPlan>;
	readonly builtinInputs: ReadonlyArray<CoreBuiltinInputPlan>;
	readonly privateNumericArrayElements: ReadonlyArray<CorePrivateNumericArrayElementPlan>;
	readonly privatePackedRestArrayElements: ReadonlyArray<CorePrivatePackedRestArrayElementPlan>;
	readonly unsignedArithmetic: ReadonlyArray<CoreUnsignedArithmeticPlan>;
	readonly blocks: ReadonlyArray<CoreBlockId>;
	readonly omittedBlocks: ReadonlyArray<CoreBlockId>;
	readonly versions: CoreFunctionVersions;
	readonly dataVersion: number;
}

const LOCAL_SPECIALIZATION_OPCODES = Object.freeze([
	"binary",
	"call",
	"callKnown",
	"getIterator",
	"iteratorStep",
]);

export function coreLocalSpecializationFeatureIndex(
	program: CoreProgram,
): CoreFunctionFeatureIndex {
	const candidateOpcodes: Array<number> = [];
	for (const opcode of LOCAL_SPECIALIZATION_OPCODES) {
		const descriptor = program.registry.get(opcode);
		if (descriptor !== undefined) candidateOpcodes[descriptor.id] = 1;
	}
	return new CoreFunctionFeatureIndex(program, candidateOpcodes);
}

function hasLocalSpecializationFeatures(
	features: CoreFunctionFeatureIndex,
	functionId: CoreFunctionId,
): boolean {
	return (
		(features.get(functionId) &
			(CORE_FUNCTION_HAS_ALLOCATIONS | CORE_FUNCTION_HAS_CANDIDATE_OPCODES)) !==
		0
	);
}

function isPendingDirectEntry(
	candidate: PendingCandidate,
): candidate is PendingDirectEntry {
	return "callSites" in candidate;
}

function increment(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

function planRepresentation(
	representation: ReturnRepresentation,
): CorePlanRepresentation | undefined {
	switch (representation) {
		case "boxed":
			return "boxed";
		case "f64":
			return "f64";
		case "i32":
			return "i32";
		case "boolean":
			return "boolean";
		case "string":
			return "string";
		case "none":
			return undefined;
	}
}

function localKind(
	kind: CoreLocalSpecializationCandidate["kind"],
): CorePlanSpecializationKind {
	if (kind === "stack-object") return "stack-object-plan";
	if (kind === "dense-array") return "dense-array-plan";
	return kind;
}

function isIteratorCursorCandidate(
	candidate: CoreLocalSpecializationCandidate,
): candidate is CoreIteratorCursorCandidate {
	const kind = candidate.kind;
	return (
		kind === "array-values-iterator-cursor" ||
		kind === "string-iterator-cursor" ||
		kind === "typed-array-iterator-cursor" ||
		kind === "map-iterator-cursor" ||
		kind === "set-iterator-cursor"
	);
}

function structuralMaterializationGuard(
	kind: "iterator-result-virtualization",
	functionId: CoreFunctionId,
	anchor: CoreInstructionId,
) {
	return Object.freeze({
		dependencies: Object.freeze([]),
		obligations: Object.freeze([
			{
				kind: "fallback" as const,
				id: `region-twin:${kind}:${functionId}:${anchor}`,
				cause: "materialization" as const,
			},
			{
				kind: "materialize" as const,
				id: `${kind}:${functionId}:${anchor}`,
				cause: "materialization" as const,
			},
		]),
	});
}

function builtinPlanProof(
	context: CoreCompilationContext | undefined,
	operation: string,
	kind: CorePlanSpecializationKind,
	functionId: CoreFunctionId,
	anchor: CoreInstructionId,
	materialize: boolean,
) {
	const fact = context?.facts.builtinIdentities.get(operation);
	const descriptor = builtinOperationDescriptor(operation);
	if (fact?.kind !== "known" || fact.value !== operation || descriptor === undefined)
		return undefined;
	const builtinCallIdentity = Object.freeze({
		kind: "known" as const,
		value: fact.value,
		proof: Object.freeze({
			...fact.proof,
			obligations: Object.freeze([
				...fact.proof.obligations,
				{
					kind: "fallback" as const,
					id: `loaded-callee:${kind}:${functionId}:${anchor}`,
					cause: "loaded-callee" as const,
				},
			]),
		}),
	});
	const guard = compilerGuardPlan(
		[fact],
		[
			{
				kind: "fallback",
				id: `region-twin:${kind}:${functionId}:${anchor}`,
				cause: "materialization",
			},
			...(materialize
				? [
						{
							kind: "materialize" as const,
							id: `${kind}:${functionId}:${anchor}`,
							cause: "materialization" as const,
						},
					]
				: []),
		],
	);
	return guard === undefined
		? undefined
		: {
				guard,
				builtinCall: Object.freeze({
					operation,
					identity: builtinCallIdentity,
					semantics: {
						kind: "known" as const,
						value: Object.freeze({
							effects: descriptor.effects,
							result: descriptor.result,
							lowerings: descriptor.lowerings,
						}),
						proof: Object.freeze({
							...fact.proof,
							origin: `builtin-registry-semantics:${operation}`,
						}),
					},
				}),
				identity: compilerFactIsWorldInvariant(fact)
					? ("authority-invariant" as const)
					: ("runtime-guarded" as const),
			};
}

function mergePlanGuards(
	left: CompilerGuardPlan,
	right: CompilerGuardPlan,
): CompilerGuardPlan {
	const unique = <Value>(
		values: ReadonlyArray<Value>,
		equals: (left: Value, right: Value) => boolean,
	): ReadonlyArray<Value> => {
		const result: Array<Value> = [];
		for (const value of values) {
			if (!result.some((candidate) => equals(candidate, value))) result.push(value);
		}
		return Object.freeze(result);
	};
	return Object.freeze({
		dependencies: unique(
			[...left.dependencies, ...right.dependencies],
			factDependencyEquals,
		),
		obligations: unique(
			[...left.obligations, ...right.obligations],
			factObligationEquals,
		),
	});
}

function protectorPlanProof(
	context: CoreCompilationContext | undefined,
	family: "watched-methods",
	kind: CorePlanSpecializationKind,
	functionId: CoreFunctionId,
	anchor: CoreInstructionId,
) {
	const fact = context?.facts.protectors.get(family);
	const guard = compilerGuardPlan(
		[fact],
		[
			{
				kind: "fallback",
				id: `region-twin:${kind}:${functionId}:${anchor}`,
				cause: "materialization",
			},
			{
				kind: "materialize",
				id: `${kind}:${functionId}:${anchor}`,
				cause: "materialization",
			},
		],
	);
	return guard === undefined
		? undefined
		: {
				guard,
				identity: compilerFactIsWorldInvariant(fact)
					? ("authority-invariant" as const)
					: ("runtime-guarded" as const),
			};
}

function localRequirements(
	program: CoreProgram,
	candidate: CoreLocalSpecializationCandidate,
	instructions: ReadonlyArray<CoreInstructionId> = candidate.instructions,
): ReadonlyArray<{
	readonly value: CoreValueId;
	readonly representation: CoreRepresentation;
}> {
	const fn = program.function(candidate.function);
	const requirements = new Map<CoreValueId, CoreRepresentation>();
	for (const instruction of instructions) {
		if (!fn.isInstructionLive(instruction)) continue;
		const operandStart = fn.kernel.instructionOperandStart(instruction);
		const operandCount = fn.kernel.instructionOperandCount(instruction);
		for (let offset = 0; offset < operandCount; offset++) {
			const value = fn.kernel.operandAt(operandStart + offset);
			requirements.set(value, fn.valueRepresentation(value));
		}
		const resultStart = fn.kernel.instructionResultStart(instruction);
		const resultCount = fn.kernel.instructionResultCount(instruction);
		for (let offset = 0; offset < resultCount; offset++) {
			const value = fn.kernel.resultAt(resultStart + offset);
			requirements.set(value, fn.valueRepresentation(value));
		}
	}
	return Object.freeze(
		[...requirements]
			.sort(([left], [right]) => left - right)
			.map(([value, representation]) => Object.freeze({ value, representation })),
	);
}

function pendingLocalCandidate(
	program: CoreProgram,
	candidate: CoreLocalSpecializationCandidate,
	cfg: CoreControlFlow,
	costModel: CoreGeneratedCodeCostModel,
	context: CoreCompilationContext | undefined,
): CorePendingOptimizationCandidate | undefined {
	if (candidate.kind === "dense-array" && candidate.mode === "contained") {
		return undefined;
	}
	const fn = program.function(candidate.function);
	const kind = localKind(candidate.kind);
	const builtin =
		candidate.kind === "string-split-projection"
			? builtinPlanProof(
					context,
					"String.prototype.split",
					kind,
					candidate.function,
					candidate.call,
					true,
				)
			: candidate.kind === "string-slice-number"
				? builtinPlanProof(
						context,
						"String.prototype.slice",
						kind,
						candidate.function,
						candidate.sliceCall,
						false,
					)
				: candidate.kind === "regexp-exec-projection"
					? builtinPlanProof(
							context,
							"RegExp.prototype.exec",
							kind,
							candidate.function,
							candidate.call,
							true,
						)
					: candidate.kind === "string-char-code-at-chain"
						? builtinPlanProof(
								context,
								"String.prototype.charCodeAt",
								kind,
								candidate.function,
								candidate.call,
								false,
							)
						: candidate.kind === "builtin-collection-call-chain"
							? builtinPlanProof(
									context,
									candidate.operation,
									kind,
									candidate.function,
									candidate.call,
									false,
								)
							: undefined;
	const protector =
		candidate.kind === "regexp-iterator-projection" ||
		candidate.kind === "iterator-entry-pair-virtualization"
			? protectorPlanProof(
					context,
					"watched-methods",
					kind,
					candidate.function,
					candidate.kind === "regexp-iterator-projection"
						? candidate.step
						: candidate.outerStep,
				)
			: undefined;
	const splitCursorProofs =
		candidate.kind === "string-split-cursor"
			? {
					split: builtinPlanProof(
						context,
						"String.prototype.split",
						kind,
						candidate.function,
						candidate.call,
						true,
					),
					trim: builtinPlanProof(
						context,
						"String.prototype.trim",
						kind,
						candidate.function,
						candidate.trimCall,
						true,
					),
				}
			: undefined;
	if (
		(candidate.kind === "string-split-projection" ||
			candidate.kind === "string-slice-number" ||
			candidate.kind === "regexp-exec-projection" ||
			candidate.kind === "string-char-code-at-chain" ||
			candidate.kind === "builtin-collection-call-chain") &&
		builtin === undefined
	)
		return undefined;
	if (candidate.kind === "regexp-iterator-projection" && protector === undefined)
		return undefined;
	if (candidate.kind === "iterator-entry-pair-virtualization" && protector === undefined)
		return undefined;
	if (
		candidate.kind === "string-split-cursor" &&
		(splitCursorProofs?.split === undefined || splitCursorProofs.trim === undefined)
	)
		return undefined;
	const lockedLiteral =
		candidate.kind === "regexp-exec-projection" &&
		builtin?.identity === "authority-invariant"
			? candidate.lockedLiteral
			: undefined;
	const instructions = Object.freeze([
		...candidate.instructions,
		...(lockedLiteral === undefined
			? []
			: [lockedLiteral.constructorIntrinsic, lockedLiteral.construct]),
	]);
	const cost = costModel.forRegion(instructions, {
		genericTwins: 1,
		...(candidate.kind === "stack-object" ||
		candidate.kind === "string-split-projection" ||
		candidate.kind === "string-split-cursor" ||
		candidate.kind === "regexp-exec-projection" ||
		candidate.kind === "regexp-iterator-projection" ||
		candidate.kind === "iterator-result-virtualization" ||
		candidate.kind === "iterator-entry-pair-virtualization"
			? { materializationPaths: 1 }
			: {}),
	});
	const materialize = (): CorePlanSpecialization => {
		const blocks = Object.freeze(
			[
				...new Set(
					instructions
						.filter((instruction) => fn.isInstructionLive(instruction))
						.map((instruction) => fn.instructionBlock(instruction)),
				),
			].sort((left, right) => left - right),
		);
		const anchors =
			candidate.kind === "fresh-array-length"
				? Object.freeze([candidate.load])
				: candidate.kind === "indexed-length-loop"
					? Object.freeze([candidate.load, candidate.comparison])
					: isIteratorCursorCandidate(candidate)
						? Object.freeze([candidate.initialize, candidate.steps[0]!])
						: candidate.kind === "iterator-result-virtualization"
							? Object.freeze([candidate.steps[0]!])
							: candidate.kind === "iterator-entry-pair-virtualization"
								? Object.freeze([candidate.outerStep, candidate.innerInitialize])
								: candidate.kind === "string-split-cursor"
									? Object.freeze([
											candidate.call,
											candidate.branch,
											candidate.length,
											candidate.backedge,
										])
									: candidate.kind === "string-split-projection"
										? Object.freeze([candidate.call, candidate.loads[0]!.instruction])
										: candidate.kind === "string-slice-number"
											? Object.freeze([candidate.sliceCall, candidate.numberCall])
											: candidate.kind === "regexp-exec-projection"
												? Object.freeze([candidate.call, candidate.loads[0]!.instruction])
												: candidate.kind === "regexp-iterator-projection"
													? Object.freeze([
															candidate.step,
															candidate.doneBranch,
															candidate.loads[0]!.instruction,
														])
													: candidate.kind === "string-char-code-at-chain" ||
														  candidate.kind === "builtin-collection-call-chain" ||
														  candidate.kind === "function-call-chain"
														? Object.freeze([candidate.property, candidate.call])
														: Object.freeze([candidate.root]);
		const exceptionalBlocks =
			candidate.kind === "fresh-array-length" ||
			candidate.kind === "indexed-length-loop" ||
			isIteratorCursorCandidate(candidate) ||
			candidate.kind === "iterator-result-virtualization" ||
			candidate.kind === "iterator-entry-pair-virtualization" ||
			candidate.kind === "string-split-cursor" ||
			candidate.kind === "string-slice-number" ||
			candidate.kind === "regexp-iterator-projection" ||
			candidate.kind === "string-char-code-at-chain" ||
			candidate.kind === "builtin-collection-call-chain" ||
			candidate.kind === "function-call-chain"
				? candidate.exceptionalBlocks
				: Object.freeze([]);
		const admissionAnchor =
			candidate.kind === "string-split-cursor" ||
			candidate.kind === "string-split-projection"
				? (candidate.property ?? candidate.call)
				: candidate.kind === "string-slice-number"
					? (candidate.property ?? candidate.sliceCall)
					: candidate.kind === "regexp-exec-projection"
						? (candidate.property ?? candidate.call)
						: candidate.kind === "string-char-code-at-chain" ||
							  candidate.kind === "builtin-collection-call-chain" ||
							  candidate.kind === "function-call-chain"
							? candidate.property
							: anchors[0]!;
		const admissionDependencies =
			candidate.kind === "string-split-cursor"
				? mergePlanGuards(splitCursorProofs!.split!.guard, splitCursorProofs!.trim!.guard)
						.dependencies
				: candidate.kind === "regexp-iterator-projection" ||
					  candidate.kind === "iterator-entry-pair-virtualization"
					? protector!.guard.dependencies
					: candidate.kind === "string-split-projection" ||
						  candidate.kind === "string-slice-number" ||
						  candidate.kind === "regexp-exec-projection" ||
						  candidate.kind === "string-char-code-at-chain" ||
						  candidate.kind === "builtin-collection-call-chain"
						? builtin!.guard.dependencies
						: Object.freeze([]);
		const admission = Object.freeze({
			anchor: admissionAnchor,
			mode:
				candidate.kind === "string-char-code-at-chain" ||
				candidate.kind === "builtin-collection-call-chain" ||
				candidate.kind === "iterator-entry-pair-virtualization" ||
				candidate.kind === "function-call-chain"
					? ("capture" as const)
					: corePlanAdmissionMode(fn, cfg, {
							anchor: admissionAnchor,
							dependencies: admissionDependencies,
							claimedInstructions: instructions,
							ordinaryBlocks: blocks,
							exceptionalBlocks,
						}),
		});
		const common = {
			id: candidate.key,
			function: candidate.function,
			anchors,
			claimedInstructions: instructions,
			ordinaryBlocks: blocks,
			exceptionalBlocks,
			requiredRepresentations: localRequirements(program, candidate, instructions),
			target: "native",
			fallback: "canonical-core",
			semanticProtectors: Object.freeze([]),
			targetFunctions: Object.freeze(
				candidate.kind === "function-call-chain" && candidate.targetFunction !== undefined
					? [candidate.targetFunction]
					: [],
			),
			admission,
			cost: Object.freeze({
				generatedCode: cost.estimatedCStatements,
				compilerWork: cost.compileScore,
				runtimeBenefit: cost.runtimeScore + candidate.fanOut,
			}),
		} as const;
		const propertyPlacement = (
			property: CoreInstructionId | undefined,
			call: CoreInstructionId,
		) =>
			property !== undefined &&
			builtin?.identity === "authority-invariant" &&
			fn.instructionBlock(property) === fn.instructionBlock(call)
				? ("call-fallback" as const)
				: ("in-place" as const);
		const selection: CorePlanSpecialization = Object.freeze(
			candidate.kind === "fresh-array-length"
				? {
						...common,
						kind: "fresh-array-length",
						representation: "exact-array-length",
						composition: "exclusive",
						freshArrayLength: Object.freeze({
							allocation: candidate.allocation,
							load: candidate.load,
							length: candidate.length,
						}),
					}
				: candidate.kind === "indexed-length-loop"
					? {
							...common,
							kind: "indexed-length-loop",
							representation: "live-indexed-length-loops",
							composition: "exclusive",
							indexedLengthLoop: Object.freeze({
								load: candidate.load,
								comparison: candidate.comparison,
								lengthPosition: candidate.lengthPosition,
								...(candidate.reverseInduction === undefined
									? {}
									: { reverseInduction: candidate.reverseInduction }),
								elements: candidate.elements,
							}),
						}
					: isIteratorCursorCandidate(candidate)
						? {
								...common,
								kind: candidate.kind,
								representation: {
									"array-values-iterator-cursor": "array-values-authoritative-cursor",
									"string-iterator-cursor": "string-authoritative-cursor",
									"typed-array-iterator-cursor": "typed-array-authoritative-cursor",
									"map-iterator-cursor": "map-authoritative-cursor",
									"set-iterator-cursor": "set-authoritative-cursor",
								}[candidate.kind],
								composition: "exclusive",
								iteratorCursor: Object.freeze({
									initialize: candidate.initialize,
									steps: candidate.steps,
									protocol: candidate.protocol,
								}),
							}
						: candidate.kind === "iterator-result-virtualization"
							? {
									...common,
									kind: "iterator-result-virtualization",
									representation: "virtual-iterator-result",
									composition: "overlay",
									iteratorResultVirtualization: Object.freeze({
										guard: structuralMaterializationGuard(
											"iterator-result-virtualization",
											candidate.function,
											candidate.steps[0]!,
										),
										steps: candidate.steps,
									}),
								}
							: candidate.kind === "iterator-entry-pair-virtualization"
								? {
										...common,
										kind: "iterator-entry-pair-virtualization",
										representation: "virtual-iterator-entry-pair",
										composition: "overlay",
										iteratorEntryPairVirtualization: Object.freeze({
											guard: protector!.guard,
											cursorInitialize: candidate.cursorInitialize,
											outerStep: candidate.outerStep,
											innerInitialize: candidate.innerInitialize,
											innerSteps: candidate.innerSteps,
											innerCloses: candidate.innerCloses,
										}),
									}
								: candidate.kind === "stack-object"
									? {
											...common,
											kind: "stack-object-plan",
											representation: "activation-local-fixed-shape-objects",
											composition: "exclusive",
											stackObject: Object.freeze({
												allocation: candidate.allocation,
												mode: candidate.mode,
												slotCount: candidate.slotCount,
												accesses: candidate.accesses,
												materializations: candidate.materializations,
											}),
										}
									: candidate.kind === "dense-array"
										? {
												...common,
												kind: "dense-array-plan",
												representation: "fresh-dense-indexed-fill",
												composition: "exclusive",
												denseArray: Object.freeze({
													allocation: candidate.allocation,
													store: candidate.store,
													loopHeader: candidate.loopHeader,
													length: candidate.length,
												}),
											}
										: candidate.kind === "numeric-fusion"
											? {
													...common,
													kind: "numeric-fusion",
													representation: "binary-pairs-f64",
													composition: "overlay",
												}
											: candidate.kind === "string-split-cursor"
												? {
														...common,
														kind: "string-split-cursor",
														representation: "split-cursor-spans",
														composition: "exclusive",
														stringSplitCursor: Object.freeze({
															guard: mergePlanGuards(
																splitCursorProofs!.split!.guard,
																splitCursorProofs!.trim!.guard,
															),
															splitBuiltinCall: splitCursorProofs!.split!.builtinCall,
															trimBuiltinCall: splitCursorProofs!.trim!.builtinCall,
															...(candidate.property === undefined
																? {}
																: { property: candidate.property }),
															propertyPlacement:
																candidate.property !== undefined &&
																splitCursorProofs!.split!.identity ===
																	"authority-invariant" &&
																fn.instructionBlock(candidate.property) ===
																	fn.instructionBlock(candidate.call)
																	? "call-fallback"
																	: "in-place",
															splitIdentity: splitCursorProofs!.split!.identity,
															trimIdentity: splitCursorProofs!.trim!.identity,
															call: candidate.call,
															length: candidate.length,
															compare: candidate.compare,
															branch: candidate.branch,
															element: candidate.element,
															trimProperty: candidate.trimProperty,
															trimCall: candidate.trimCall,
															...(candidate.advance === undefined
																? {}
																: { advance: candidate.advance }),
															increment: candidate.increment,
															backedge: candidate.backedge,
															resultValues: candidate.resultValues,
															primitiveStringLengths: candidate.primitiveStringLengths,
															exitBlock: candidate.exitBlock,
														}),
													}
												: candidate.kind === "string-split-projection"
													? {
															...common,
															kind: "string-split-projection",
															representation: "projected-elements",
															composition: "exclusive",
															stringSplitProjection: Object.freeze({
																guard: builtin!.guard,
																builtinCall: builtin!.builtinCall,
																...(candidate.property === undefined
																	? {}
																	: { property: candidate.property }),
																propertyPlacement: propertyPlacement(
																	candidate.property,
																	candidate.call,
																),
																splitIdentity: builtin!.identity,
																call: candidate.call,
																separator: candidate.separator,
																separatorStringIndex: candidate.separatorStringIndex,
																resultValues: candidate.resultValues,
																loads: candidate.loads,
															}),
														}
													: candidate.kind === "string-slice-number"
														? {
																...common,
																kind: "string-slice-number",
																representation: "primitive-string-span-number",
																composition: "exclusive",
																stringSliceNumber: Object.freeze({
																	guard: builtin!.guard,
																	builtinCall: builtin!.builtinCall,
																	property: candidate.property,
																	propertyPlacement: propertyPlacement(
																		candidate.property,
																		candidate.sliceCall,
																	),
																	builtinIdentities: builtin!.identity,
																	sliceCall: candidate.sliceCall,
																	sliceStartInstruction: candidate.sliceStartInstruction,
																	numberIntrinsic: candidate.numberIntrinsic,
																	numberCall: candidate.numberCall,
																	sliceStart: candidate.sliceStart,
																}),
															}
														: candidate.kind === "regexp-exec-projection"
															? {
																	...common,
																	kind: "regexp-exec-projection",
																	representation: "regexp-capture-spans",
																	composition: "exclusive",
																	regexpExecProjection: Object.freeze({
																		guard: builtin!.guard,
																		builtinCall: builtin!.builtinCall,
																		property: candidate.property,
																		propertyPlacement:
																			lockedLiteral !== undefined &&
																			candidate.property !== undefined &&
																			fn.instructionBlock(candidate.property) ===
																				fn.instructionBlock(candidate.call)
																				? "call-fallback"
																				: "in-place",
																		call: candidate.call,
																		resultValues: candidate.resultValues,
																		nullChecks: candidate.nullChecks,
																		...(lockedLiteral === undefined
																			? {}
																			: { lockedLiteral }),
																		loads: Object.freeze(
																			candidate.loads.map((load) => {
																				const base = {
																					instruction: load.instruction,
																					key: load.key,
																					captureIndex: load.captureIndex,
																				};
																				const consumer = load.consumer;
																				if (consumer === undefined) return base;
																				if (consumer.kind === "length") {
																					return {
																						...base,
																						consumer: { ...consumer },
																					};
																				}
																				if (consumer.kind === "number") {
																					return {
																						...base,
																						consumer: { ...consumer },
																					};
																				}
																				return {
																					...base,
																					consumer: {
																						...consumer,
																						methodIdentity: builtin!.identity,
																					},
																				};
																			}),
																		),
																	}),
																}
															: candidate.kind === "regexp-iterator-projection"
																? {
																		...common,
																		kind: "regexp-iterator-projection",
																		representation: "regexp-iterator-capture-spans",
																		composition: "exclusive",
																		regexpIteratorProjection: Object.freeze({
																			guard: protector!.guard,
																			step: candidate.step,
																			doneBranch: candidate.doneBranch,
																			exitBlock: candidate.exitBlock,
																			resultValues: candidate.resultValues,
																			loads: candidate.loads,
																		}),
																	}
																: candidate.kind === "string-char-code-at-chain"
																	? {
																			...common,
																			kind: "string-char-code-at-chain",
																			representation: "primitive-string-code-unit",
																			composition: "exclusive",
																			stringCharCodeAt: Object.freeze({
																				guard: builtin!.guard,
																				builtinCall: builtin!.builtinCall,
																				property: candidate.property,
																				call: candidate.call,
																				methodIdentity: builtin!.identity,
																				...(candidate.bounded === undefined
																					? {}
																					: { bounded: candidate.bounded }),
																			}),
																		}
																	: candidate.kind === "function-call-chain"
																		? {
																				...common,
																				kind: "function-call-chain",
																				representation:
																					"guarded-function-call-flattening",
																				composition: "exclusive",
																				functionCall: Object.freeze({
																					property: candidate.property,
																					call: candidate.call,
																					...(candidate.targetFunction === undefined
																						? {}
																						: {
																								targetFunction: candidate.targetFunction,
																							}),
																				}),
																			}
																		: {
																				...common,
																				kind: "builtin-collection-call-chain",
																				representation: "captured-collection-method",
																				composition: "exclusive",
																				builtinCollectionCall: Object.freeze({
																					guard: builtin!.guard,
																					builtinCall: builtin!.builtinCall,
																					property: candidate.property,
																					call: candidate.call,
																					operation: candidate.operation,
																					...(candidate.exactReceiver === undefined
																						? {}
																						: {
																								exactReceiver: candidate.exactReceiver,
																							}),
																				}),
																			},
		);
		return selection;
	};
	return {
		materialize,
		source: candidate,
		claims: {
			function: candidate.function,
			kind,
			claimedInstructions: instructions,
			composition:
				candidate.kind === "numeric-fusion" ||
				candidate.kind === "iterator-result-virtualization" ||
				candidate.kind === "iterator-entry-pair-virtualization"
					? "overlay"
					: "exclusive",
		},
		budget: {
			kind,
			caller: candidate.function,
			site: candidate.root,
			revision: 0,
			priorityClass: 0,
			priorityScore: -(cost.runtimeScore + candidate.fanOut),
			targets: Object.freeze(
				candidate.kind === "function-call-chain" && candidate.targetFunction !== undefined
					? [candidate.targetFunction]
					: [],
			),
			generatedCodeCost: cost.estimatedCStatements,
			compilerWorkCost: cost.compileScore,
			expansive:
				candidate.kind !== "builtin-collection-call-chain" &&
				candidate.kind !== "iterator-entry-pair-virtualization",
			...(!coreTargetSupportsSpecialization(kind)
				? { unsupportedReason: "target-support" as const }
				: !fn.isInstructionLive(candidate.root) ||
					  instructions.some((instruction) => !fn.isInstructionLive(instruction))
					? { unsupportedReason: "stale-anchor" as const }
					: {}),
		},
	};
}

export function buildCoreLocalOptimizationPlanInput(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	features: CoreFunctionFeatureIndex,
	functionId: CoreFunctionId,
	context?: CoreCompilationContext,
	discoverCandidates = true,
): CoreLocalOptimizationPlanInput {
	const fn = program.function(functionId);
	const scanned =
		discoverCandidates && hasLocalSpecializationFeatures(features, functionId);
	const cfg = analyses
		.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
			scope: "function",
			function: functionId,
		})
		.exceptional();
	let priorityScore = 0;
	let operationCount = 0;
	if (scanned) {
		// This only orders function scans; proved candidates still use the full cost model.
		const loopWeights = new Uint8Array(fn.blockCapacity);
		for (const loop of cfg.loops) {
			for (const block of loop.blocks)
				loopWeights[block] = Math.max(loopWeights[block]!, 4 ** Math.min(3, loop.depth));
		}
		for (const instruction of fn.instructionIds()) {
			operationCount++;
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			const benefit =
				opcode === "iteratorStep" || opcode === "getIterator"
					? 24
					: opcode === "createObject" ||
						  opcode === "createObjectShaped" ||
						  opcode === "createArray"
						? 12
						: opcode === "call" || opcode === "callKnown"
							? 8
							: opcode === "binary"
								? 2
								: 0;
			priorityScore = Math.min(
				priorityScore,
				-benefit * Math.max(1, loopWeights[fn.instructionBlock(instruction)]!),
			);
		}
	}
	const blocks = Object.freeze([...cfg.reversePostorder]);
	const included = new Set(blocks);
	const versions = fn.versions;
	return Object.freeze({
		function: functionId,
		context,
		discovery:
			scanned && priorityScore < 0
				? Object.freeze({ priorityScore, compilerWorkCost: operationCount })
				: undefined,
		operatorInputs: coreOperatorInputPlans(program, analyses, [functionId]),
		builtinInputs: coreBuiltinInputPlans(program, analyses, [functionId]),
		privateNumericArrayElements: corePrivateNumericArrayElementPlans(
			program,
			analyses,
			[functionId],
			context,
		),
		privatePackedRestArrayElements: corePrivatePackedRestArrayElementPlans(
			program,
			analyses,
			[functionId],
			context,
		),
		unsignedArithmetic: coreUnsignedArithmeticPlans(program, analyses, [functionId]),
		blocks,
		omittedBlocks: Object.freeze(
			[...fn.blockIds()].filter((block) => !included.has(block)),
		),
		versions: Object.freeze(versions),
		dataVersion: program.programVersion("data"),
	});
}

function localOptimizationPlanInputIsCurrent(
	program: CoreProgram,
	input: CoreLocalOptimizationPlanInput,
	context: CoreCompilationContext | undefined,
): boolean {
	return (
		input.context === context &&
		program.programVersion("data") === input.dataVersion &&
		coreFunctionVersionsAreCurrent(program.function(input.function), input.versions)
	);
}

function guardedCallOpportunities(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	liveFunctions: ReadonlyArray<CoreFunctionId>,
	analyses: CoreAnalysisManager,
): ReadonlyArray<CorePlanningOpportunity> {
	const candidates: Array<CorePlanningOpportunity> = [];
	const instanceMethodHints = coreInstanceMethodHints(program);
	for (const caller of liveFunctions) {
		const fn = program.function(caller);
		const targetSites = summaries.targets.outgoing(caller);
		if (targetSites.length === 0) continue;
		const controlFlow = analyses.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
			scope: "function",
			function: caller,
		});
		const reachable = controlFlow.exceptional().reachable;
		const loopBlocks = new Set(
			controlFlow.ordinary().loops.flatMap((loop) => [...loop.blocks]),
		);
		const outgoing = targetSites.filter(
			(site) =>
				fn.isInstructionLive(site.instruction) &&
				reachable.has(fn.instructionBlock(site.instruction)),
		);
		const globalTargetUses = new Map<CoreFunctionId, number>();
		for (const site of outgoing) {
			const target =
				site.targets.functions.length === 1 ? site.targets.functions[0] : undefined;
			if (target === undefined || !coreValueIsLoadedGlobalProperty(fn, site.callee)) {
				continue;
			}
			globalTargetUses.set(target, (globalTargetUses.get(target) ?? 0) + 1);
		}
		for (const site of outgoing) {
			const hintedTargets =
				site.targets.functions.length === 0 &&
				site.open &&
				loopBlocks.has(fn.instructionBlock(site.instruction))
					? coreInstanceMethodTargets(fn, site.callee, site.receiver, instanceMethodHints)
					: undefined;
			const targetFunctions = Object.freeze(
				hintedTargets === undefined ? [...site.targets.functions] : [...hintedTargets],
			);
			if (
				targetFunctions.length === 0 ||
				fn.instructionAttributes(site.instruction)[
					CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE
				] === true
			)
				continue;
			if (
				targetFunctions.length === 1 &&
				coreValueIsLoadedGlobalProperty(fn, site.callee) &&
				(globalTargetUses.get(targetFunctions[0]!) ?? 0) < 2
			) {
				continue;
			}
			candidates.push({
				kind: "guarded-call",
				caller,
				generatedCodeCost: targetFunctions.length,
				compilerWorkCost: 1,
				priorityScore: -(loopBlocks.has(fn.instructionBlock(site.instruction)) ? 32 : 8),
				resolve: () => {
					const materialize = (): CorePlanSpecialization =>
						Object.freeze({
							id: `guarded-direct-call:${site.caller}:${site.instruction}:${targetFunctions.join(",")}`,
							kind: "guarded-direct-call",
							function: caller,
							anchors: Object.freeze([site.instruction]),
							claimedInstructions: Object.freeze([site.instruction]),
							ordinaryBlocks: Object.freeze([fn.instructionBlock(site.instruction)]),
							exceptionalBlocks: Object.freeze([]),
							representation:
								!site.open && targetFunctions.length === 1
									? "exact-function"
									: "finite-function-set",
							requiredRepresentations: Object.freeze([]),
							target: "native",
							fallback: "canonical-core",
							semanticProtectors: Object.freeze([]),
							targetFunctions,
							admission: Object.freeze({
								anchor: site.instruction,
								mode: "per-use" as const,
							}),
							composition: "overlay",
							cost: Object.freeze({
								generatedCode: targetFunctions.length,
								compilerWork: 1,
								runtimeBenefit: 8,
							}),
						});
					return [
						{
							materialize,
							claims: {
								function: caller,
								kind: "guarded-direct-call",
								composition: "overlay",
								claimedInstructions: [site.instruction],
							},
							budget: {
								kind: "guarded-direct-call",
								caller,
								site: site.instruction,
								revision: 0,
								priorityClass: 1,
								priorityScore: 0,
								targets: targetFunctions,
								generatedCodeCost: targetFunctions.length,
								compilerWorkCost: 1,
								expansive: false,
							},
						},
					];
				},
			});
		}
	}
	return candidates;
}

function directEntryOpportunities(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	live: ReadonlySet<CoreFunctionId>,
	analyses: CoreAnalysisManager,
	localCandidates: (
		functionId: CoreFunctionId,
	) => ReadonlyArray<CorePendingOptimizationCandidate>,
): ReadonlyArray<CorePlanningOpportunity> {
	const loopWeights = new Map<CoreFunctionId, Uint8Array>();
	const callWeight = (site: CoreDirectEntryCallSite): number => {
		const caller = program.function(site.caller);
		let weights = loopWeights.get(site.caller);
		if (weights === undefined) {
			weights = new Uint8Array(caller.blockCapacity);
			weights.fill(1);
			const cfg = analyses
				.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
					scope: "function",
					function: site.caller,
				})
				.ordinary();
			// Unknown trip counts justify only a capped preference for repeated sites.
			for (const loop of cfg.loops) {
				const weight = loop.depth > 1 ? 8 : 4;
				for (const block of loop.blocks)
					weights[block] = Math.max(weights[block]!, weight);
			}
			for (const cycle of cfg.irreducibleCycles) {
				for (const block of cycle.blocks) weights[block] = Math.max(weights[block]!, 4);
			}
			loopWeights.set(site.caller, weights);
		}
		return (
			weights[caller.instructionBlock(site.instruction)]! *
			(site.numericSortCallback === undefined ? 1 : 4)
		);
	};
	const callsByTarget = new Map<CoreFunctionId, Array<CoreDirectEntryCallSite>>();
	const methods = new Map<number, Array<CoreFunctionId>>();
	for (const target of live) {
		const fn = program.function(target);
		if (
			fn.parameterCount !== 1 ||
			fn.metadata.hasPrototype ||
			fn.metadata.isClassConstructor ||
			fn.isGenerator ||
			fn.isAsync
		)
			continue;
		const candidates = methods.get(fn.metadata.nameStringIndex) ?? [];
		candidates.push(target);
		methods.set(fn.metadata.nameStringIndex, candidates);
	}
	for (const caller of [...live].sort((left, right) => left - right)) {
		const fn = program.function(caller);
		const outgoing = summaries.targets.outgoing(caller);
		if (outgoing.length === 0) continue;
		const reachable = analyses
			.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
				scope: "function",
				function: caller,
			})
			.exceptional().reachable;
		const propertyName = (value: CoreValueId | undefined): string | undefined => {
			if (value === undefined || fn.kernel.valueDefinitionKind(value) !== 1)
				return undefined;
			const load = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
			if (fn.instructionOpcodeName(load) !== "loadPropertyStatic") return undefined;
			const key = fn.instructionAttributes(load).stringIndex;
			const units = typeof key === "number" ? program.stringConstants[key] : undefined;
			return units === undefined || units.length > 8
				? undefined
				: String.fromCharCode(...units);
		};
		for (const site of outgoing) {
			if (
				!fn.isInstructionLive(site.instruction) ||
				!reachable.has(fn.instructionBlock(site.instruction)) ||
				fn.instructionOpcodeName(site.instruction) !== "call"
			)
				continue;

			if (
				site.targets.functions.length === 0 &&
				(site.arguments?.length === 1 || site.arguments?.length === 2)
			) {
				const viaCall = propertyName(site.callee) === "call";
				const operation = propertyName(viaCall ? site.receiver : site.callee);
				if (
					site.arguments.length === (viaCall ? 2 : 1) &&
					(operation === "sort" || operation === "toSorted")
				) {
					const callbackTargets = summaries.targets.targets(
						caller,
						site.arguments[viaCall ? 1 : 0]!,
					);
					const target =
						callbackTargets.functions.length === 1
							? callbackTargets.functions[0]
							: undefined;
					if (target !== undefined && live.has(target)) {
						const callback = program.function(target);
						const observation = coreArgumentObservation(callback);
						if (
							callback.parameterCount === 2 &&
							callback.metadata.capturedCount === 0 &&
							observation.kind !== "general" &&
							!observation.readsCount &&
							observation.indices.length === 0 &&
							observation.restStarts.length === 0
						) {
							const calls = callsByTarget.get(target) ?? [];
							// Property names nominate candidates; runtime admission proves both calls.
							calls.push({
								caller,
								instruction: site.instruction,
								guarded: true,
								numericSortCallback: operation,
								...(viaCall ? { numericSortCallbackViaCall: true as const } : {}),
							});
							callsByTarget.set(target, calls);
						}
					}
				}
			}
			let targets = site.targets.functions;
			let speculative = false;
			if (
				targets.length === 0 &&
				site.arguments?.length === 1 &&
				fn.kernel.valueDefinitionKind(site.callee) === 1
			) {
				const load = coreInstructionId(fn.kernel.valueDefinitionOwner(site.callee));
				if (fn.instructionOpcodeName(load) === "loadPropertyStatic") {
					const key = fn.instructionAttributes(load).stringIndex;
					if (typeof key === "number") {
						targets = methods.get(key) ?? [];
						speculative = true;
					}
				}
			}
			if (targets.length === 0 || targets.length > 4) continue;
			for (const target of targets) {
				if (!live.has(target)) continue;
				const calls = callsByTarget.get(target) ?? [];
				calls.push(
					Object.freeze({
						caller,
						instruction: site.instruction,
						...(speculative || site.open || targets.length > 1
							? { guarded: true as const }
							: {}),
					}),
				);
				callsByTarget.set(target, calls);
			}
		}
	}
	const candidates: Array<CorePlanningOpportunity> = [];
	for (const [target, callSites] of [...callsByTarget].sort(
		([left], [right]) => left - right,
	)) {
		const fn = program.function(target);
		const generatedCodeCost = Math.max(8, [...fn.instructionIds()].length);
		candidates.push({
			kind: "direct-entry",
			caller: target,
			generatedCodeCost,
			compilerWorkCost: generatedCodeCost + fn.valueCapacity,
			priorityScore: -callSites.reduce((sum, site) => sum + callWeight(site), 0) * 8,
			resolve: () => {
				const fn = program.function(target);
				const summary = summaries.summary(target);
				let resultRepresentation = planRepresentation(
					summary?.returnRepresentation ?? "none",
				);
				const observation = coreArgumentObservation(fn);
				if (
					fn.isGenerator ||
					fn.isAsync ||
					fn.metadata.isClassConstructor ||
					fn.metadata.isDerivedConstructor ||
					observation.kind === "general"
				)
					return [];
				const inBoundsRestElements = new Map<CoreFunctionId, Set<CoreInstructionId>>();
				const exactRestLengths = new Map<CoreFunctionId, Set<CoreInstructionId>>();
				if (observation.restStarts.length > 0) {
					for (const candidate of localCandidates(target)) {
						const source = candidate.source;
						if (source?.kind !== "indexed-length-loop") continue;
						const fn = program.function(target);
						const length = source.load;
						const lengthReceiver = fn.kernel.operandAt(
							fn.kernel.instructionOperandStart(length),
						);
						if (fn.kernel.valueDefinitionKind(lengthReceiver) === 1) {
							const allocation = coreInstructionId(
								fn.kernel.valueDefinitionOwner(lengthReceiver),
							);
							if (fn.instructionOpcodeName(allocation) === "createRestArguments") {
								const lengths = exactRestLengths.get(target) ?? new Set();
								lengths.add(length);
								exactRestLengths.set(target, lengths);
							}
						}
						for (const element of source.elements) {
							if (element.kind !== "load" || !element.arrayIndexIsUint32) continue;
							const receiver = fn.kernel.operandAt(
								fn.kernel.instructionOperandStart(element.instruction),
							);
							if (fn.kernel.valueDefinitionKind(receiver) !== 1) continue;
							const allocation = coreInstructionId(
								fn.kernel.valueDefinitionOwner(receiver),
							);
							if (fn.instructionOpcodeName(allocation) !== "createRestArguments")
								continue;
							const elements = inBoundsRestElements.get(target) ?? new Set();
							elements.add(element.instruction);
							inBoundsRestElements.set(target, elements);
						}
					}
				}
				const needsArity =
					observation.readsCount ||
					observation.indices.length > 0 ||
					observation.restStarts.length > 0;
				let parameterRepresentations: ReadonlyArray<CorePlanRepresentation> = Array.from(
					{ length: fn.parameterCount },
					() => "boxed",
				);
				let valueRepresentations: ReadonlyArray<CorePlanRepresentation> | undefined;
				let argumentRepresentations: ReadonlyArray<CorePlanRepresentation> | undefined;
				let constantBooleans: CoreDirectEntryPlan["constantBooleans"];
				let operatorInputs: CoreDirectEntryPlan["operatorInputs"];
				let selectedCalls = callSites.filter(
					(call) =>
						call.numericSortCallback !== undefined ||
						summaries.targets.site(call.caller, call.instruction)?.targets.functions
							.length === 1,
				);
				let fieldParameters: CoreDirectEntryPlan["fieldParameters"];
				if (!needsArity && fn.parameterCount === 1) {
					const cfg = analyses
						.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
							scope: "function",
							function: target,
						})
						.exceptional();
					const fields = coreReadOnlyNumericParameterFields(fn, cfg);
					if (fields !== undefined) {
						const fieldCalls = callSites.flatMap((call) => {
							const site = summaries.targets.site(call.caller, call.instruction);
							if (site?.arguments?.length !== 1) return [];
							const facts = analyses.get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, {
								scope: "function",
								function: call.caller,
							});
							const fieldObject = coreNumericFieldArgument(
								program.function(call.caller),
								facts,
								call.instruction,
								site.arguments[0]!,
								fields,
							);
							return fieldObject === undefined
								? []
								: [Object.freeze({ ...call, fieldObject })];
						});
						if (fieldCalls.length > 0) {
							const variant = analyzeCoreNativeEntry(
								fn,
								cfg,
								parameterRepresentations,
								undefined,
								fieldCalls,
								fields,
							);
							if (
								coreFieldEntryHasNumericComputations(
									fn,
									variant.valueRepresentations,
									variant.operatorInputs,
								)
							) {
								fieldParameters = fields;
								selectedCalls = fieldCalls;
								valueRepresentations = variant.valueRepresentations;
								operatorInputs = variant.operatorInputs;
								resultRepresentation = variant.resultRepresentation;
							}
						}
					}
				}
				if (
					fieldParameters === undefined &&
					(fn.parameterCount > 0 || needsArity) &&
					[...fn.instructionIds()].length <= 512
				) {
					const signatures = new Map<
						string,
						{
							representations: Array<CorePlanRepresentation>;
							calls: Array<CoreDirectEntryCallSite>;
							scalars: number;
							weight: number;
						}
					>();
					for (const call of selectedCalls) {
						const site = summaries.targets.site(call.caller, call.instruction);
						if (
							needsArity &&
							(site?.arguments === undefined ||
								site.arguments.length > 16 ||
								observation.indices.some((index) => index >= site.arguments!.length) ||
								observation.restStarts.some((index) => index > site.arguments!.length))
						)
							continue;
						const kinds = analyses.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, {
							scope: "function",
							function: call.caller,
						});
						const representations = Array.from(
							{ length: needsArity ? site!.arguments!.length : fn.parameterCount },
							(_, index): CorePlanRepresentation => {
								if (call.numericSortCallback !== undefined) return "f64";
								const argument = site?.arguments?.[index];
								const scalar =
									argument === undefined ? undefined : kinds.exactScalar(argument);
								return scalar === "int32" || scalar === "number"
									? "f64"
									: (scalar ?? "boxed");
							},
						);
						const key = representations.join(",");
						const signature = signatures.get(key) ?? {
							representations,
							calls: [],
							weight: 0,
							scalars:
								representations.filter((representation) => representation !== "boxed")
									.length + (needsArity ? 1 : 0),
						};
						signature.calls.push(call);
						signature.weight += callWeight(call);
						signatures.set(key, signature);
					}
					const signature = [...signatures.values()]
						.filter(({ scalars }) => scalars > 0)
						.sort(
							(left, right) => right.weight * right.scalars - left.weight * left.scalars,
						)[0];
					if (signature !== undefined) {
						argumentRepresentations = needsArity ? signature.representations : undefined;
						parameterRepresentations = Array.from(
							{ length: fn.parameterCount },
							(_, index) => signature.representations[index] ?? "boxed",
						);
						selectedCalls = signature.calls;
						const cfg = analyses
							.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
								scope: "function",
								function: target,
							})
							.exceptional();
						const exactOperationResultMasks = new Map<CoreInstructionId, number>();
						for (const instruction of exactRestLengths.get(target) ?? []) {
							exactOperationResultMasks.set(instruction, COMPILER_VALUE_KIND_NUMBER);
						}
						for (const instruction of inBoundsRestElements.get(target) ?? []) {
							const receiver = fn.kernel.operandAt(
								fn.kernel.instructionOperandStart(instruction),
							);
							const allocation = coreInstructionId(
								fn.kernel.valueDefinitionOwner(receiver),
							);
							const startIndex = fn.instructionAttributes(allocation).startIndex;
							if (
								typeof startIndex === "number" &&
								startIndex < signature.representations.length &&
								signature.representations
									.slice(startIndex)
									.every((representation) => representation === "f64")
							)
								exactOperationResultMasks.set(instruction, COMPILER_VALUE_KIND_NUMBER);
						}
						const variant = analyzeCoreNativeEntry(
							fn,
							cfg,
							parameterRepresentations,
							argumentRepresentations,
							selectedCalls,
							undefined,
							exactOperationResultMasks,
						);
						valueRepresentations = variant.valueRepresentations;
						operatorInputs = variant.operatorInputs;
						constantBooleans = variant.constantBooleans;
						resultRepresentation = variant.resultRepresentation;
					}
				}
				if (
					selectedCalls.length === 0 ||
					(selectedCalls.some((call) => call.numericSortCallback !== undefined) &&
						resultRepresentation !== "f64") ||
					(needsArity && argumentRepresentations === undefined) ||
					resultRepresentation === undefined ||
					(resultRepresentation === "boxed" && valueRepresentations === undefined)
				)
					return [];
				const generatedCode = Math.max(8, [...fn.instructionIds()].length);
				const compilerWork = generatedCode + fn.valueCapacity;
				const runtimeBenefit =
					selectedCalls.reduce((sum, site) => sum + callWeight(site), 0) * 8;
				return [
					{
						function: target,
						runtimeBenefit,
						callSites: Object.freeze(
							selectedCalls.sort(
								(left, right) =>
									left.caller - right.caller || left.instruction - right.instruction,
							),
						),
						parameterRepresentations,
						resultRepresentation,
						...(valueRepresentations === undefined ? {} : { valueRepresentations }),
						...(argumentRepresentations === undefined ? {} : { argumentRepresentations }),
						...(constantBooleans === undefined ? {} : { constantBooleans }),
						...(operatorInputs === undefined ? {} : { operatorInputs }),
						...(fieldParameters === undefined ? {} : { fieldParameters }),
						budget: {
							kind: "direct-entry",
							caller: target,
							site: callSites[0]!.instruction,
							revision: 0,
							priorityClass: 2,
							priorityScore: -runtimeBenefit,
							targets: Object.freeze([target]),
							generatedCodeCost: generatedCode,
							compilerWorkCost: compilerWork,
							expansive: true,
						},
					},
				];
			},
		});
	}
	return candidates;
}

function conflicts(
	selection: CorePendingClaims,
	claimed: ReadonlyMap<CoreFunctionId, ReadonlyMap<CoreInstructionId, ClaimState>>,
): boolean {
	const owned = claimed.get(selection.function);
	return selection.claimedInstructions.some((instruction) => {
		const state = owned?.get(instruction);
		if (state === undefined) return false;
		if (selection.kind === "guarded-direct-call" && state.exclusive) return true;
		if (
			selection.composition === "exclusive" &&
			state.overlays.has("guarded-direct-call")
		) {
			return true;
		}
		return selection.composition === "exclusive"
			? state.exclusive
			: state.overlays.has(selection.kind);
	});
}

interface ClaimState {
	exclusive: boolean;
	readonly overlays: Set<CorePlanSpecializationKind>;
}

function claim(
	selection: CorePendingClaims,
	claimed: Map<CoreFunctionId, Map<CoreInstructionId, ClaimState>>,
): void {
	const owned =
		claimed.get(selection.function) ?? new Map<CoreInstructionId, ClaimState>();
	for (const instruction of selection.claimedInstructions) {
		const state = owned.get(instruction) ?? {
			exclusive: false,
			overlays: new Set(),
		};
		if (selection.composition === "exclusive") state.exclusive = true;
		else state.overlays.add(selection.kind);
		owned.set(instruction, state);
	}
	claimed.set(selection.function, owned);
}

export interface BuildCoreOptimizationPlanOptions {
	readonly budgets?: CoreTransformBudgetLimits;
	readonly candidateService?: CoreTransformCandidateService;
	readonly perFunctionExpansions?: number;
	readonly context?: CoreCompilationContext;
	readonly localInputs?: ReadonlyArray<CoreLocalOptimizationPlanInput>;
	readonly discoverCandidates?: boolean;
	readonly onPhase?: (phase: "discovery" | "selection", elapsedMs: number) => void;
	readonly onMaterialize?: () => void;
	readonly onLocalCandidates?: (
		functionId: CoreFunctionId,
		candidates: ReadonlyArray<CoreLocalCandidateSummary>,
	) => void;
}

export function buildCoreOptimizationPlan(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	summaries: CoreProgramSummaries,
	liveFunctions: ReadonlyArray<CoreFunctionId>,
	options: BuildCoreOptimizationPlanOptions = {},
): CoreOptimizationPlan {
	const discoveryStartedAt = options.onPhase === undefined ? 0 : Date.now();
	const live = new Set(liveFunctions);
	const opportunities: Array<CorePlanningOpportunity> = [];
	const localInputs = new Map<CoreFunctionId, CoreLocalOptimizationPlanInput>();
	for (const input of options.localInputs ?? []) {
		if (localInputs.has(input.function)) {
			throw new Error(
				`Duplicate local optimization input for function ${input.function}`,
			);
		}
		localInputs.set(input.function, input);
	}
	let features: CoreFunctionFeatureIndex | undefined;
	const resolvedLocalInputs: Array<CoreLocalOptimizationPlanInput> = [];
	for (const functionId of liveFunctions) {
		const prepared = localInputs.get(functionId);
		const input =
			prepared !== undefined &&
			localOptimizationPlanInputIsCurrent(program, prepared, options.context)
				? prepared
				: buildCoreLocalOptimizationPlanInput(
						program,
						analyses,
						(features ??= coreLocalSpecializationFeatureIndex(program)),
						functionId,
						options.context,
						options.discoverCandidates !== false,
					);
		resolvedLocalInputs.push(input);
	}
	const provenLocal = new Map<
		CoreFunctionId,
		ReadonlyArray<CorePendingOptimizationCandidate>
	>();
	const resolveLocal = (
		functionId: CoreFunctionId,
	): ReadonlyArray<CorePendingOptimizationCandidate> => {
		const known = provenLocal.get(functionId);
		if (known !== undefined) return known;
		const candidates = analyses.get(CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS, {
			scope: "function",
			function: functionId,
		}).candidates;
		options.onLocalCandidates?.(functionId, candidates);
		const fn = program.function(functionId);
		const cfg = analyses
			.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, { scope: "function", function: functionId })
			.exceptional();
		const costModel = coreGeneratedCodeCostModel(fn, cfg);
		const pending: Array<CorePendingOptimizationCandidate> = [];
		for (const candidate of candidates) {
			const planned = pendingLocalCandidate(
				program,
				candidate,
				cfg,
				costModel,
				options.context,
			);
			if (planned !== undefined) pending.push(planned);
		}
		provenLocal.set(functionId, pending);
		return pending;
	};
	if (options.discoverCandidates !== false) {
		for (const input of resolvedLocalInputs) {
			if (input.discovery === undefined) continue;
			opportunities.push({
				kind: "local",
				caller: input.function,
				generatedCodeCost: 1,
				...input.discovery,
				resolve: () => resolveLocal(input.function),
			});
		}
		opportunities.push(
			...guardedCallOpportunities(program, summaries, liveFunctions, analyses),
		);
		opportunities.push(
			...directEntryOpportunities(program, summaries, live, analyses, resolveLocal),
		);
	}
	opportunities.sort(
		(left, right) =>
			left.priorityScore - right.priorityScore ||
			left.generatedCodeCost - right.generatedCodeCost ||
			left.caller - right.caller ||
			left.kind.localeCompare(right.kind),
	);
	options.onPhase?.("discovery", Date.now() - discoveryStartedAt);
	const selectionStartedAt = options.onPhase === undefined ? 0 : Date.now();
	const service =
		options.candidateService ??
		new CoreTransformCandidateService(
			options.budgets ?? DEFAULT_CORE_SPECIALIZATION_BUDGETS,
		);
	service.beginPhase();
	const budgetBaseline = service.statistics();
	const byBudget = new WeakMap<CoreTransformCandidate, PendingCandidate>();
	const discoveredByKind: Record<string, number> = {};
	const discovery = {
		opportunities: opportunities.length,
		attempted: 0,
		skipped: 0,
		compilerWork: 0,
		skippedByReason: {} as Record<string, number>,
	};

	const selectedByKind: Record<string, number> = {};
	const declinedByPlanReason: Record<string, number> = {};
	const selectedExpansionsByFunction = new Map<CoreFunctionId, number>();
	const perFunctionExpansions =
		options.perFunctionExpansions ??
		options.budgets?.perCallerExpansions ??
		CORE_SPECIALIZATION_EXPANSIONS_PER_FUNCTION;
	const claimed = new Map<CoreFunctionId, Map<CoreInstructionId, ClaimState>>();
	const specializations: Array<CorePlanSpecialization> = [];
	const directEntriesByFunction = new Map<CoreFunctionId, Array<CoreDirectEntryPlan>>();
	for (const opportunity of opportunities) {
		const cost =
			opportunity.kind === "local" && provenLocal.has(opportunity.caller)
				? { ...opportunity, compilerWorkCost: 0 }
				: opportunity;
		// Admission must leave enough work for applying a successful proof.
		const applicationWork =
			opportunity.kind === "local" ? 1 : opportunity.compilerWorkCost;
		const reason =
			service.programBudgetExhaustionReason() ??
			service.admitDiscovery({
				...cost,
				compilerWorkCost: cost.compilerWorkCost + applicationWork,
			});
		if (reason !== undefined) {
			discovery.skipped++;
			increment(discovery.skippedByReason, reason);
			continue;
		}
		service.recordDiscovery(cost);
		discovery.attempted++;
		discovery.compilerWork += cost.compilerWorkCost;
		for (const candidate of opportunity.resolve()) {
			increment(discoveredByKind, candidate.budget.kind);
			const budget = candidate.budget;
			if (service.offer(budget)) byBudget.set(budget, candidate);
		}

		for (let budget = service.next(); budget !== undefined; budget = service.next()) {
			const exhausted = service.programBudgetExhaustionReason();
			if (exhausted !== undefined) {
				service.recordDeclined(exhausted);
				const discarded = service.discardPending(exhausted) + 1;
				declinedByPlanReason[exhausted] =
					(declinedByPlanReason[exhausted] ?? 0) + discarded;
				break;
			}
			const candidate = byBudget.get(budget)!;
			let reason: CoreTransformDeclineReason | undefined = service.admit(budget);
			if (
				reason === undefined &&
				budget.expansive &&
				(selectedExpansionsByFunction.get(budget.caller) ?? 0) >= perFunctionExpansions
			) {
				reason = "expansion-limit";
			}
			if (
				reason === undefined &&
				!isPendingDirectEntry(candidate) &&
				conflicts(candidate.claims, claimed)
			) {
				reason = "overlap";
			}
			if (reason !== undefined) {
				service.recordDeclined(reason);
				increment(declinedByPlanReason, reason);
				continue;
			}
			service.recordApplied(budget);
			if (budget.expansive) {
				selectedExpansionsByFunction.set(
					budget.caller,
					(selectedExpansionsByFunction.get(budget.caller) ?? 0) + 1,
				);
			}
			increment(selectedByKind, budget.kind);
			if (isPendingDirectEntry(candidate)) {
				const entries = directEntriesByFunction.get(candidate.function) ?? [];
				if (entries.length >= 4) {
					increment(declinedByPlanReason, "expansion-limit");
					continue;
				}
				entries.push(
					Object.freeze({
						id: entries.length,
						function: candidate.function,
						callSites: candidate.callSites,
						parameterRepresentations: candidate.parameterRepresentations,
						...(candidate.fieldParameters === undefined
							? {}
							: { fieldParameters: candidate.fieldParameters }),
						resultRepresentation: candidate.resultRepresentation,
						...(candidate.valueRepresentations === undefined
							? {}
							: { valueRepresentations: candidate.valueRepresentations }),
						...(candidate.argumentRepresentations === undefined
							? {}
							: { argumentRepresentations: candidate.argumentRepresentations }),
						...(candidate.constantBooleans === undefined
							? {}
							: { constantBooleans: candidate.constantBooleans }),
						...(candidate.operatorInputs === undefined
							? {}
							: { operatorInputs: candidate.operatorInputs }),
						target: "native",
						fallback: "canonical-core",
						cost: Object.freeze({
							generatedCode: budget.generatedCodeCost,
							compilerWork: budget.compilerWorkCost,
							runtimeBenefit: candidate.runtimeBenefit,
						}),
					}),
				);
				directEntriesByFunction.set(candidate.function, entries);
			} else {
				claim(candidate.claims, claimed);
				specializations.push(candidate.materialize());
				options.onMaterialize?.();
			}
		}
	}
	const directEntries = [...directEntriesByFunction]
		.sort(([left], [right]) => left - right)
		.flatMap(([, entries]) => entries);
	const budgetStatistics = service.statisticsSince(budgetBaseline);
	const statistics: CoreOptimizationPlanStatistics = Object.freeze({
		...budgetStatistics,
		discovery: Object.freeze({
			...discovery,
			skippedByReason: Object.freeze(discovery.skippedByReason),
		}),
		admittedFunctions: new Set([
			...specializations.map(({ function: functionId }) => functionId),
			...directEntries.map(({ function: functionId }) => functionId),
		]).size,
		discoveredByKind: Object.freeze({ ...discoveredByKind }),
		selectedByKind: Object.freeze({ ...selectedByKind }),
		declinedByPlanReason: Object.freeze({ ...declinedByPlanReason }),
		verificationMs: 0,
	});
	specializations.sort(
		(left, right) =>
			left.function - right.function ||
			left.anchors[0]! - right.anchors[0]! ||
			left.id.localeCompare(right.id),
	);
	const plan = Object.freeze({
		version: corePlanVersionStamp(program),
		liveFunctions: Object.freeze([...liveFunctions]),
		blockOrders: Object.freeze(
			resolvedLocalInputs.map((input) =>
				Object.freeze({
					function: input.function,
					blocks: input.blocks,
					omittedBlocks: input.omittedBlocks,
				}),
			),
		),
		directEntries: Object.freeze(directEntries),
		directBuiltinCallbacks: Object.freeze(
			resolvedLocalInputs.flatMap((input) => {
				const fn = program.function(input.function);
				return input.blocks.flatMap((block) =>
					[...fn.bodyInstructionIds(block)].flatMap((instruction) => {
						const target = coreDirectBuiltinCallbackTarget(fn, instruction);
						return target === undefined || !live.has(target)
							? []
							: [
									Object.freeze({
										caller: input.function,
										instruction,
										target,
									}),
								];
					}),
				);
			}),
		),
		specializedOnlyFunctions: Object.freeze(
			coreSpecializedOnlyFunctions(
				program,
				options.context,
				summaries.targets,
				liveFunctions,
				directEntries,
			),
		),
		operatorInputs: Object.freeze(
			resolvedLocalInputs.flatMap((input) => input.operatorInputs),
		),
		builtinInputs: Object.freeze(
			resolvedLocalInputs.flatMap((input) => input.builtinInputs),
		),
		privateNumericArrayElements: Object.freeze(
			resolvedLocalInputs.flatMap((input) => input.privateNumericArrayElements),
		),
		privatePackedRestArrayElements: Object.freeze(
			resolvedLocalInputs.flatMap((input) => input.privatePackedRestArrayElements),
		),
		unsignedArithmetic: Object.freeze(
			resolvedLocalInputs.flatMap((input) => input.unsignedArithmetic),
		),
		recipes: buildCoreSpecializationRecipeTable(specializations),
		statistics,
	});
	options.onPhase?.("selection", Date.now() - selectionStartedAt);
	return plan;
}

export function withCorePlanVerificationTime(
	plan: CoreOptimizationPlan,
	verificationMs: number,
): CoreOptimizationPlan {
	return Object.freeze({
		...plan,
		statistics: Object.freeze({ ...plan.statistics, verificationMs }),
	});
}
