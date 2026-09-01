import { builtinOperationDescriptor } from "../shared/builtin-registry.ts";
import type { CompilerGuardPlan } from "../shared/compiler-facts.ts";
import {
	compilerFactIsWorldInvariant,
	compilerGuardPlan,
} from "../shared/compiler-facts.ts";
import type { ReturnRepresentation } from "../shared/effect-summary.ts";
import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "./core-cross-call-transforms.ts";
import { CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreGeneratedCodeCostModel } from "./core-ir-generated-cost.ts";
import { CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS } from "./core-ir-provenance.ts";
import type {
	CoreIteratorCursorCandidate,
	CoreLocalSpecializationCandidate,
} from "./core-ir-provenance.ts";
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
import type {
	CoreFunctionId,
	CoreInstructionId,
	CoreRepresentation,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreProgram } from "./core-store.ts";
import { CoreTransformCandidateService } from "./core-transform-candidates.ts";
import type {
	CoreTransformBudgetLimits,
	CoreTransformCandidate,
	CoreTransformDeclineReason,
} from "./core-transform-candidates.ts";

export const DEFAULT_CORE_SPECIALIZATION_BUDGETS: CoreTransformBudgetLimits =
	Object.freeze({
		perSiteExpansions: 1,
		perCallerExpansions: 4,
		perCallerGeneratedCode: 512,
		perCallerCompilerWork: 2_048,
		programGeneratedCode: 4_096,
		programCompilerWork: 32_768,
	});

interface PendingSpecialization {
	readonly budget: CoreTransformCandidate;
	readonly selection: CorePlanSpecialization;
}

interface PendingDirectEntry {
	readonly budget: CoreTransformCandidate;
	readonly function: CoreFunctionId;
	readonly callSites: ReadonlyArray<CoreDirectEntryCallSite>;
	readonly parameterRepresentations: ReadonlyArray<CorePlanRepresentation>;
	readonly resultRepresentation: CorePlanRepresentation;
}

type PendingCandidate = PendingSpecialization | PendingDirectEntry;

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
	const unique = <Value>(values: ReadonlyArray<Value>): ReadonlyArray<Value> => {
		const seen = new Set<string>();
		return Object.freeze(
			values.filter((value) => {
				const key = JSON.stringify(value);
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			}),
		);
	};
	return Object.freeze({
		dependencies: unique([...left.dependencies, ...right.dependencies]),
		obligations: unique([...left.obligations, ...right.obligations]),
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
		for (const value of [
			...fn.instructionOperands(instruction),
			...fn.instructionResults(instruction),
		]) {
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
	context: CoreCompilationContext | undefined,
): PendingSpecialization | undefined {
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
	const cost = coreGeneratedCodeCostModel(fn, cfg).forRegion(instructions, {
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
			: candidate.kind === "string-slice-number" ||
				  candidate.kind === "regexp-exec-projection" ||
				  candidate.kind === "string-char-code-at-chain" ||
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
																				return { ...base, consumer: { ...consumer } };
																			}
																			if (consumer.kind === "number") {
																				return { ...base, consumer: { ...consumer } };
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
																			representation: "guarded-function-call-flattening",
																			composition: "exclusive",
																			functionCall: Object.freeze({
																				property: candidate.property,
																				call: candidate.call,
																				...(candidate.targetFunction === undefined
																					? {}
																					: { targetFunction: candidate.targetFunction }),
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
																					: { exactReceiver: candidate.exactReceiver }),
																			}),
																		},
	);
	return {
		selection,
		budget: {
			key: `0:${String(1_000_000 - selection.cost.runtimeBenefit).padStart(7, "0")}:${candidate.key}`,
			kind,
			caller: candidate.function,
			site: candidate.root,
			targets: Object.freeze(
				candidate.kind === "function-call-chain" && candidate.targetFunction !== undefined
					? [candidate.targetFunction]
					: [],
			),
			generatedCodeCost: selection.cost.generatedCode,
			compilerWorkCost: selection.cost.compilerWork,
			expansive: false,
			...(!coreTargetSupportsSpecialization(kind)
				? { unsupportedReason: "target-support" as const }
				: !fn.isInstructionLive(candidate.root) ||
					  instructions.some((instruction) => !fn.isInstructionLive(instruction))
					? { unsupportedReason: "stale-anchor" as const }
					: {}),
		},
	};
}

function guardedCallCandidates(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	liveFunctions: ReadonlyArray<CoreFunctionId>,
): ReadonlyArray<PendingSpecialization> {
	const candidates: Array<PendingSpecialization> = [];
	for (const caller of liveFunctions) {
		const fn = program.function(caller);
		for (const site of summaries.targets.outgoing(caller)) {
			if (
				site.targets.functions.length === 0 ||
				fn.instructionAttributes(site.instruction)[
					CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE
				] === true
			)
				continue;
			const targetFunctions = Object.freeze([...site.targets.functions]);
			const selection: CorePlanSpecialization = Object.freeze({
				id: `guarded-direct-call:${site.id}:${targetFunctions.join(",")}`,
				kind: "guarded-direct-call",
				function: caller,
				anchors: Object.freeze([site.instruction]),
				claimedInstructions: Object.freeze([site.instruction]),
				ordinaryBlocks: Object.freeze([fn.instructionBlock(site.instruction)]),
				exceptionalBlocks: Object.freeze([]),
				representation:
					targetFunctions.length === 1 ? "exact-function" : "finite-function-set",
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
			candidates.push({
				selection,
				budget: {
					key: `1:${selection.id}`,
					kind: "guarded-direct-call",
					caller,
					site: site.instruction,
					targets: targetFunctions,
					generatedCodeCost: selection.cost.generatedCode,
					compilerWorkCost: selection.cost.compilerWork,
					expansive: false,
				},
			});
		}
	}
	return candidates;
}

function directEntryCandidates(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	live: ReadonlySet<CoreFunctionId>,
): ReadonlyArray<PendingDirectEntry> {
	const callsByTarget = new Map<CoreFunctionId, Array<CoreDirectEntryCallSite>>();
	for (const caller of [...live].sort((left, right) => left - right)) {
		for (const site of summaries.targets.outgoing(caller)) {
			if (site.open || site.targets.functions.length !== 1) continue;
			const target = site.targets.functions[0]!;
			if (!live.has(target)) continue;
			const calls = callsByTarget.get(target) ?? [];
			calls.push(Object.freeze({ caller, instruction: site.instruction }));
			callsByTarget.set(target, calls);
		}
	}
	const candidates: Array<PendingDirectEntry> = [];
	for (const [target, callSites] of [...callsByTarget].sort(
		([left], [right]) => left - right,
	)) {
		const fn = program.function(target);
		const summary = summaries.summary(target);
		const resultRepresentation = planRepresentation(
			summary?.returnRepresentation ?? "none",
		);
		if (
			resultRepresentation === undefined ||
			resultRepresentation === "boxed" ||
			fn.isGenerator ||
			fn.isAsync ||
			fn.metadata.isClassConstructor
		)
			continue;
		const parameterRepresentations = Object.freeze(
			fn.parameters.map(() => "boxed" as const),
		);
		const generatedCode = Math.max(8, [...fn.instructionIds()].length);
		const compilerWork = generatedCode + fn.valueCapacity;
		candidates.push({
			function: target,
			callSites: Object.freeze(
				callSites.sort(
					(left, right) =>
						left.caller - right.caller || left.instruction - right.instruction,
				),
			),
			parameterRepresentations,
			resultRepresentation,
			budget: {
				key: `2:direct-entry:${target}:${resultRepresentation}`,
				kind: "direct-entry",
				caller: target,
				site: callSites[0]!.instruction,
				targets: Object.freeze([target]),
				generatedCodeCost: generatedCode,
				compilerWorkCost: compilerWork,
				expansive: true,
			},
		});
	}
	return candidates;
}

function conflicts(
	selection: CorePlanSpecialization,
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
	selection: CorePlanSpecialization,
	claimed: Map<CoreFunctionId, Map<CoreInstructionId, ClaimState>>,
): void {
	const owned =
		claimed.get(selection.function) ?? new Map<CoreInstructionId, ClaimState>();
	for (const instruction of selection.claimedInstructions) {
		const state = owned.get(instruction) ?? { exclusive: false, overlays: new Set() };
		if (selection.composition === "exclusive") state.exclusive = true;
		else state.overlays.add(selection.kind);
		owned.set(instruction, state);
	}
	claimed.set(selection.function, owned);
}

export interface BuildCoreOptimizationPlanOptions {
	readonly budgets?: CoreTransformBudgetLimits;
	readonly context?: CoreCompilationContext;
}

export function buildCoreOptimizationPlan(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	summaries: CoreProgramSummaries,
	liveFunctions: ReadonlyArray<CoreFunctionId>,
	options: BuildCoreOptimizationPlanOptions = {},
): CoreOptimizationPlan {
	const live = new Set(liveFunctions);
	const pending: Array<PendingCandidate> = [];
	for (const functionId of liveFunctions) {
		const cfg = analyses.get(CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS, {
			scope: "function",
			function: functionId,
		});
		const discovered = analyses.get(CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS, {
			scope: "function",
			function: functionId,
		});
		for (const candidate of discovered.candidates) {
			const planned = pendingLocalCandidate(program, candidate, cfg, options.context);
			if (planned !== undefined) pending.push(planned);
		}
	}
	pending.push(...guardedCallCandidates(program, summaries, liveFunctions));
	pending.push(...directEntryCandidates(program, summaries, live));

	const service = new CoreTransformCandidateService(
		options.budgets ?? DEFAULT_CORE_SPECIALIZATION_BUDGETS,
	);
	const byBudgetKey = new Map<string, PendingCandidate>();
	const discoveredByKind: Record<string, number> = {};
	for (const candidate of pending) {
		increment(discoveredByKind, candidate.budget.kind);
		if (service.offer(candidate.budget)) byBudgetKey.set(candidate.budget.key, candidate);
	}
	const selectedByKind: Record<string, number> = {};
	const declinedByPlanReason: Record<string, number> = {};
	const claimed = new Map<CoreFunctionId, Map<CoreInstructionId, ClaimState>>();
	const specializations: Array<CorePlanSpecialization> = [];
	const directEntriesByFunction = new Map<CoreFunctionId, Array<CoreDirectEntryPlan>>();
	for (let budget = service.next(); budget !== undefined; budget = service.next()) {
		const candidate = byBudgetKey.get(budget.key)!;
		let reason: CoreTransformDeclineReason | undefined = service.admit(budget);
		if (
			reason === undefined &&
			!isPendingDirectEntry(candidate) &&
			conflicts(candidate.selection, claimed)
		) {
			reason = "overlap";
		}
		if (reason !== undefined) {
			service.recordDeclined(reason);
			increment(declinedByPlanReason, reason);
			continue;
		}
		service.recordApplied(budget);
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
					resultRepresentation: candidate.resultRepresentation,
					target: "native",
					fallback: "canonical-core",
					cost: Object.freeze({
						generatedCode: budget.generatedCodeCost,
						compilerWork: budget.compilerWorkCost,
						runtimeBenefit: candidate.callSites.length * 8,
					}),
				}),
			);
			directEntriesByFunction.set(candidate.function, entries);
		} else {
			claim(candidate.selection, claimed);
			specializations.push(candidate.selection);
		}
	}
	const directEntries = [...directEntriesByFunction]
		.sort(([left], [right]) => left - right)
		.flatMap(([, entries]) => entries);
	const budgetStatistics = service.statistics();
	const statistics: CoreOptimizationPlanStatistics = Object.freeze({
		...budgetStatistics,
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
	return Object.freeze({
		version: corePlanVersionStamp(program),
		liveFunctions: Object.freeze([...liveFunctions]),
		blockOrders: Object.freeze(
			liveFunctions.map((functionId) => {
				const fn = program.function(functionId);
				const blocks = Object.freeze([
					...analyses.get(CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS, {
						scope: "function",
						function: functionId,
					}).reversePostorder,
				]);
				const included = new Set(blocks);
				return Object.freeze({
					function: functionId,
					blocks,
					omittedBlocks: Object.freeze(
						[...fn.blockIds()].filter((block) => !included.has(block)),
					),
				});
			}),
		),
		directEntries: Object.freeze(directEntries),
		specializations: Object.freeze(specializations),
		statistics,
	});
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
