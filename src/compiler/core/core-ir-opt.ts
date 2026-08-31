import {
	builtinOperations,
	exactBuiltinCallDescriptor,
	mathUnaryOperationKeys,
} from "../shared/builtin-registry.ts";
import type {
	CompilerOptimizationDecision,
	OptimizationAblation,
	OptimizationDecisionReason,
	OptimizationMetrics,
	OptimizationPassDelta,
} from "../shared/compiler-diagnostics.ts";
import {
	compilerGuardPlan,
	compilerFactIsWorldInvariant,
	knownFact,
	sourceSiteId,
} from "../shared/compiler-facts.ts";
import type {
	FactDependency,
	FactObligation,
	FactObligationCause,
	SemanticEpochFamily,
	WorldFactId,
} from "../shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_UNDEFINED,
	compilerValueKindMaskIsSubset,
} from "../shared/compiler-value-kinds.ts";
import type { CompilerValueKindMask } from "../shared/compiler-value-kinds.ts";
import { effectSummariesEqual } from "../shared/effect-summary.ts";
import {
	authorityFallback,
	normalizeFactRequirements,
} from "../shared/fact-implication.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import {
	CORE_CALLEE_TARGETS_ATTRIBUTE,
	CORE_FINITE_DISPATCH_TARGET_ATTRIBUTE,
	analyzeCoreCalleeTargets,
	coreCalleeTargetsAttribute,
	coreCalleeTargetsClosedFunction,
	coreCalleeTargetsSingleFunction,
} from "./core-ir-call-targets.ts";
import type {
	CoreCalleeTargetAnalysis,
	CoreCalleeTargets,
} from "./core-ir-call-targets.ts";
import {
	buildCoreControlFlow,
	coreCanonicalValueRoots,
	coreTerminatorEdges,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow, CoreNaturalLoop } from "./core-ir-control-flow.ts";
import { analyzeCoreLocalExceptionFlows } from "./core-ir-exception-flow.ts";
import {
	coreFactFamilyKeys,
	coreFactImplies,
	normalizeCoreFact,
} from "./core-ir-fact-implication.ts";
import {
	coreGeneratedCodeAdmitsRegion,
	coreGeneratedCodeCostModel,
	coreGeneratedCodeCostForInstructions,
	coreGeneratedCodeOverheadCost,
} from "./core-ir-generated-cost.ts";
import type { CoreGeneratedCodeCost } from "./core-ir-generated-cost.ts";
import { analyzeCoreLoopInductions } from "./core-ir-loops.ts";
import type {
	CoreInductionVariable,
	CoreLoopComparison,
	CoreLoopInductionAnalysis,
} from "./core-ir-loops.ts";
import {
	coreMemoryAccesses,
	coreMemoryLocationFamily,
	coreMemoryLocationIsExact,
	coreMemoryPartition,
	coreMemoryVersions,
} from "./core-ir-memory.ts";
import type {
	CoreMemoryAccess,
	CoreMemoryPartition,
	CoreMemoryResolution,
	CoreMemoryVersions,
} from "./core-ir-memory.ts";
import { removeUnreachableCoreBlocks } from "./core-ir-normalize.ts";
import { coreInstructionEffects, coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import {
	CORE_CONTAINED_AGGREGATE_OWN_SLOT_FACT,
	CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE,
	CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE,
	CORE_OWN_DATA_CELL_FACT,
	coreContainedAggregateProvenance,
	coreOwnCellsEqual,
	coreOwnCellResolver,
	coreProvenance,
} from "./core-ir-provenance.ts";
import type { CoreOwnCell, CoreProvenance } from "./core-ir-provenance.ts";
import {
	analyzeCoreFunctionReachability,
	compactCoreProgramFunctions,
} from "./core-ir-reachability.ts";
import {
	CORE_REGION_STRATEGIES,
	coreRegionStrategy,
} from "./core-ir-region-strategies.ts";
import type { RegisteredCoreRegionKind } from "./core-ir-region-strategies.ts";
import {
	coreRegionAdmission,
	coreRegionAdmissionQuery,
	coreRegionAdmissionMode,
	coreRegionLicense,
	coreRegionValidityModel,
} from "./core-ir-region-validity.ts";
import type { CoreRegionValidityModel } from "./core-ir-region-validity.ts";
import type { CorePropertyPlacement } from "./core-ir-regions.ts";
import {
	CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE,
	CORE_EXACT_SHAPE_OWN_SLOT_EFFECT_FACT,
	analyzeCoreShapeProvenance,
	coreExactShapeOwnSlotDigest,
	coreExactShapeOwnSlotEffects,
	retractCoreKnownOwnSlots,
	selectCoreExactShapeOwnSlots,
	selectCoreKnownOwnSlots,
} from "./core-ir-shape-provenance.ts";
import {
	CORE_CALL_EFFECT_SUMMARY_FACT,
	CORE_CALL_SUMMARY_ATTRIBUTE,
	analyzeCoreProgramSummaries,
	coreCallResultRepresentation,
	coreCallSummaryAttribute,
	coreCallSummaryClaimFromAttribute,
	coreCallSummaryDigest,
	coreCallSummaryFactValue,
	coreCallValueSummaryDigest,
	coreFunctionEffectSummaries,
	coreModuleEffectSummaries,
	deriveCoreCallEffectRefinement,
} from "./core-ir-summaries.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import {
	CORE_EXACT_COLLECTION_BUILTIN_EFFECT_FACT,
	coreExactCollectionBuiltinEffects,
	selectCoreExactHeapAccesses,
} from "./core-ir-value-classes.ts";
import {
	CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE,
	CORE_PRIMITIVE_OPERATOR_EFFECT_FACT,
	analyzeCoreValueKinds,
	corePrimitiveOperatorEffectRefinement,
	materializeCoreExactScalarRepresentations,
	selectCoreExactValueFacts,
} from "./core-ir-value-kinds.ts";
import type { CoreValueKindAnalysis } from "./core-ir-value-kinds.ts";
import {
	CoreIrVerificationError,
	verifyCoreFunction,
	verifyCoreProgram,
} from "./core-ir-verifier.ts";
import type {
	CoreVerificationContext,
	CoreVerificationProfile,
} from "./core-ir-verifier.ts";
import type {
	CoreBlock,
	CoreBlockId,
	CoreAttributeValue,
	CoreEdge,
	CoreEffectDomain,
	CoreFact,
	CoreFactClaim,
	CoreFactId,
	CoreFunction,
	CoreImmediate,
	CoreInstruction,
	CoreInstructionId,
	CoreProgram,
	CoreRegion,
	CoreRepresentation,
	CoreTerminator,
	CoreValueId,
} from "./core-ir.ts";
import {
	CORE_MEMORY_FAMILY_DOMAINS,
	coreBlockId,
	coreFactId,
	coreInstructionId,
	coreValueId,
} from "./core-ir.ts";

export interface CoreOptimizationOptions {
	/** Explicit frontend/world context; absent for standalone open-world Core tests. */
	readonly context?: CoreCompilationContext;
	readonly maxRounds?: number;
	readonly ablations?: ReadonlySet<OptimizationAblation>;
	/** Run Core's value simplifiers. Disable only while importing an already optimized graph. */
	readonly simplifyValues?: boolean;
	/** Development profile: verify the whole program after every mutating pass. */
	readonly verification?: CoreVerificationProfile;
}

const ALLOCATION_OPCODES = new Set([
	"createObject",
	"createObjectShaped",
	"createArray",
	"instantiateLiteralTemplate",
	"createFunction",
	"createArgumentsObject",
	"createRestArguments",
	"createModuleNamespace",
	"createTemplateObject",
	"createBigint",
]);

const DYNAMIC_CALL_OPCODES = new Set([
	"callSpread",
	"callSpreadIterable",
	"constructSpread",
	"constructSuper",
	"constructSuperExplicit",
]);

const BOXED_OPERATION_OPCODES = new Set([
	"binary",
	"unary",
	"toPropertyKey",
	"requireCoercible",
]);

const PROPERTY_HELPER_OPCODES = new Set([
	"loadProperty",
	"loadPropertyStatic",
	"storeProperty",
	"storePropertyStatic",
	"deleteProperty",
	"loadSuperProperty",
	"storeSuperProperty",
	"loadPrototype",
	"setPrototype",
	"loadGlobalProperty",
	"storeGlobalProperty",
	"copyDataProperties",
	"mergeDataProperties",
	"defineProperty",
]);

const IDEMPOTENT_MATH_UNARY_OPERATIONS = new Set([
	"Math.abs",
	"Math.ceil",
	"Math.floor",
	"Math.fround",
	"Math.round",
	"Math.sign",
	"Math.trunc",
]);

const NUMERIC_BINARY_REPRESENTATION_OPERATORS = new Set([
	"+",
	"-",
	"*",
	"/",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
	"%",
]);

const INT32_BINARY_REPRESENTATION_OPERATORS = new Set(["&", "|", "^", "<<", ">>"]);

const COMPARISON_REPRESENTATION_OPERATORS = new Set([
	"<",
	"<=",
	">",
	">=",
	"==",
	"!=",
	"===",
	"!==",
]);

function attributeObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
}

function coreAttribute(value: unknown, path: string): CoreAttributeValue {
	if (
		value === undefined ||
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string"
	) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((entry, index) => coreAttribute(entry, `${path}[${index}]`));
	}
	if (typeof value !== "object") {
		throw new Error(`Unsupported Core attribute ${path}: ${typeof value}`);
	}
	return coreAttributeObject(value as Readonly<Record<string, unknown>>, path);
}

function coreAttributeObject(
	value: Readonly<Record<string, unknown>>,
	path: string,
): Readonly<Record<string, CoreAttributeValue>> {
	const result: Record<string, CoreAttributeValue> = {};
	for (const [key, entry] of Object.entries(value)) {
		result[key] = coreAttribute(entry, `${path}.${key}`);
	}
	return result;
}

function knownBuiltinIdentity(instruction: CoreInstruction): boolean {
	const call = attributeObject(instruction.attributes.knownBuiltinCall);
	const identity = attributeObject(call?.identity);
	return identity?.kind === "known";
}

function isDynamicCall(instruction: CoreInstruction): boolean {
	if (DYNAMIC_CALL_OPCODES.has(instruction.opcode)) return true;
	if (instruction.opcode === "construct") {
		return instruction.attributes.directFunctionIndex === undefined;
	}
	if (instruction.opcode !== "call") return false;
	return (
		instruction.attributes.directFunctionIndex === undefined &&
		instruction.attributes.directCallTargetFunctionIndex === undefined &&
		!knownBuiltinIdentity(instruction)
	);
}

function carriesWorldGuard(instruction: CoreInstruction): boolean {
	if (instruction.opcode === "guardFunctionIndex") return true;
	if (instruction.opcode !== "call") return false;
	const call = attributeObject(instruction.attributes.knownBuiltinCall);
	const identity = attributeObject(call?.identity);
	if (identity?.kind !== "known") return false;
	const proof = attributeObject(identity.proof);
	const dependencies = Array.isArray(proof?.dependencies) ? proof.dependencies : [];
	const obligations = Array.isArray(proof?.obligations) ? proof.obligations : [];
	return (
		dependencies.some((dependency) => {
			const kind = attributeObject(dependency)?.kind;
			return kind === "epoch" || kind === "guard";
		}) ||
		obligations.some((obligation) => attributeObject(obligation)?.kind === "fallback")
	);
}

function coreRootedValueCount(fn: CoreFunction): number {
	const uses = fn.blocks.map(() => new Set<CoreValueId>());
	const definitions = fn.blocks.map(() => new Set<CoreValueId>());
	const successors = fn.blocks.map(() => new Set<CoreBlockId>());
	const terminatorValues = fn.blocks.map((block): ReadonlyArray<CoreValueId> => {
		const edgeArguments = coreTerminatorEdges(block.terminator).flatMap(
			(edge) => edge.arguments,
		);
		switch (block.terminator.kind) {
			case "branch":
			case "guard":
				return [block.terminator.condition, ...edgeArguments];
			case "switch":
				return [block.terminator.discriminant, ...edgeArguments];
			case "return":
			case "throw":
				return [block.terminator.value];
			case "jump":
				return edgeArguments;
			case "unreachable":
				return [];
		}
	});
	const handlerParameters = fn.blocks.map((block): ReadonlyArray<CoreValueId> => {
		if (block.handler === undefined) return [];
		const target = fn.blocks[block.handler.block];
		return target?.parameters[0]?.role === "exception"
			? target.parameters.slice(1).map(({ value }) => value)
			: [];
	});
	for (const block of fn.blocks) {
		const blockUses = uses[block.id]!;
		const blockDefinitions = definitions[block.id]!;
		for (const { value } of block.parameters) blockDefinitions.add(value);
		const addUse = (value: CoreValueId): void => {
			if (!blockDefinitions.has(value)) blockUses.add(value);
		};
		for (const instruction of block.instructions) {
			for (const input of instruction.inputs) addUse(input);
			for (const output of instruction.outputs) blockDefinitions.add(output);
		}
		for (const value of terminatorValues[block.id]!) addUse(value);
		for (const argument of block.handler?.arguments ?? []) addUse(argument);
		for (const edge of coreTerminatorEdges(block.terminator)) {
			successors[block.id]!.add(edge.block);
		}
		if (block.handler !== undefined) successors[block.id]!.add(block.handler.block);
	}
	const liveIn = fn.blocks.map((_, index) => new Set(uses[index]));
	const liveOut = fn.blocks.map(() => new Set<CoreValueId>());
	let changed = true;
	while (changed) {
		changed = false;
		for (let index = fn.blocks.length - 1; index >= 0; index--) {
			const nextOut = new Set<CoreValueId>();
			for (const successor of successors[index]!) {
				for (const value of liveIn[successor]!) nextOut.add(value);
			}
			const nextIn = new Set(uses[index]);
			for (const value of nextOut) {
				if (!definitions[index]!.has(value)) nextIn.add(value);
			}
			if (
				nextOut.size !== liveOut[index]!.size ||
				[...nextOut].some((value) => !liveOut[index]!.has(value)) ||
				nextIn.size !== liveIn[index]!.size ||
				[...nextIn].some((value) => !liveIn[index]!.has(value))
			) {
				liveOut[index] = nextOut;
				liveIn[index] = nextIn;
				changed = true;
			}
		}
	}
	const cfg = buildCoreControlFlow(fn, coreOpcodeRegistry);
	const loopBackedges = new Set(cfg.loops.flatMap(({ latches }) => [...latches]));
	const rooted = new Set<CoreValueId>();
	for (const block of fn.blocks) {
		const live = new Set(liveOut[block.id]);
		for (const value of terminatorValues[block.id]!) live.add(value);
		for (const value of block.handler?.arguments ?? []) live.add(value);
		for (const value of handlerParameters[block.id]!) live.add(value);
		if (loopBackedges.has(block.id)) {
			for (const value of live) rooted.add(value);
		}
		for (let index = block.instructions.length - 1; index >= 0; index--) {
			const instruction = block.instructions[index]!;
			if (
				(
					instruction.effectRefinement?.effects ??
					coreOpcodeRegistry.require(instruction.opcode).effects
				).mayGc
			) {
				for (const value of live) rooted.add(value);
				for (const value of instruction.inputs) rooted.add(value);
			}
			for (const output of instruction.outputs) live.delete(output);
			for (const input of instruction.inputs) live.add(input);
		}
		if (block.parameters[0]?.role === "exception") {
			for (const value of live) rooted.add(value);
			rooted.add(block.parameters[0].value);
		}
	}
	const representations = new Map(
		fn.values.map(({ id, representation }) => [id, representation] as const),
	);
	return [...rooted].filter((value) => representations.get(value) === "boxed").length;
}

/** Measure the residual Core program itself, never a reconstructed frontend graph. */
export function coreOptimizationMetrics(program: CoreProgram): OptimizationMetrics {
	const metrics = {
		instructions: 0,
		blocks: 0,
		values: 0,
		facts: 0,
		regions: 0,
		allocationSites: 0,
		dynamicCalls: 0,
		boxedOperations: 0,
		propertyHelpers: 0,
		worldGuards: 0,
		rootedValues: 0,
		safepoints: 0,
	};
	for (const fn of program.functions) {
		metrics.blocks += fn.blocks.length;
		metrics.values += fn.values.length;
		metrics.facts += fn.facts.length;
		metrics.regions += fn.regions.length;
		metrics.rootedValues += coreRootedValueCount(fn);
		for (const block of fn.blocks) {
			// Terminators are instructions with stable Core instruction identities too.
			metrics.instructions += block.instructions.length + 1;
			if (block.terminator.kind === "guard") metrics.worldGuards++;
			for (const instruction of block.instructions) {
				if (ALLOCATION_OPCODES.has(instruction.opcode)) metrics.allocationSites++;
				if (isDynamicCall(instruction)) metrics.dynamicCalls++;
				if (BOXED_OPERATION_OPCODES.has(instruction.opcode)) metrics.boxedOperations++;
				if (PROPERTY_HELPER_OPCODES.has(instruction.opcode)) metrics.propertyHelpers++;
				if (carriesWorldGuard(instruction)) metrics.worldGuards++;
				if (
					(
						instruction.effectRefinement?.effects ??
						coreOpcodeRegistry.require(instruction.opcode).effects
					).mayGc
				)
					metrics.safepoints++;
			}
		}
	}
	return metrics;
}

function metricDelta(
	before: OptimizationMetrics,
	after: OptimizationMetrics,
): OptimizationMetrics {
	return {
		instructions: after.instructions - before.instructions,
		blocks: after.blocks - before.blocks,
		values: after.values - before.values,
		facts: after.facts - before.facts,
		regions: after.regions - before.regions,
		allocationSites: after.allocationSites - before.allocationSites,
		dynamicCalls: after.dynamicCalls - before.dynamicCalls,
		boxedOperations: after.boxedOperations - before.boxedOperations,
		propertyHelpers: after.propertyHelpers - before.propertyHelpers,
		worldGuards: after.worldGuards - before.worldGuards,
		rootedValues: after.rootedValues - before.rootedValues,
		safepoints: after.safepoints - before.safepoints,
	};
}

function optimizationPassDelta(
	pass: Omit<OptimizationPassDelta, "before" | "after" | "delta">,
	before: OptimizationMetrics,
	after: OptimizationMetrics,
): OptimizationPassDelta {
	return { ...pass, before, after, delta: metricDelta(before, after) };
}

const BUILTIN_OPERATIONS_BY_KEY = new Map<
	string,
	Array<(typeof builtinOperations)[number]>
>();
for (const operation of builtinOperations) {
	const candidates = BUILTIN_OPERATIONS_BY_KEY.get(operation.key);
	if (candidates === undefined) {
		BUILTIN_OPERATIONS_BY_KEY.set(operation.key, [operation]);
	} else {
		candidates.push(operation);
	}
}
const BUILTIN_OPERATION_BY_ID = new Map(
	builtinOperations.map((operation) => [operation.id, operation] as const),
);
const MATH_UNARY_OPERATIONS: ReadonlySet<string> = new Set(
	mathUnaryOperationKeys.map(([operation]) => operation),
);

function decodeString(program: CoreProgram, index: number): string | undefined {
	const units = program.stringConstants[index];
	return units === undefined ? undefined : String.fromCodePoint(...units);
}

function builtinSourceSite(
	program: CoreProgram,
	fn: CoreFunction,
	positionId: number | undefined,
	operation: string,
): ReturnType<typeof sourceSiteId> | undefined {
	if (positionId === undefined) return undefined;
	const position = program.sourcePositions[positionId];
	if (position === undefined) return undefined;
	const owner =
		position.inlinedFunctionIndex === undefined
			? fn
			: program.functions.find(
					(candidate) => candidate.functionIndex === position.inlinedFunctionIndex,
				);
	return owner === undefined
		? undefined
		: sourceSiteId(
				owner.metadata.sourcePath,
				position.line,
				position.column,
				`builtin-call:${operation}`,
			);
}

/**
 * Attach guarded builtin identity and semantics to an ordinary property call.
 * A property key can name methods on multiple owners, so colliding candidates
 * are admitted only when the receiver proves the corresponding intrinsic or
 * primitive prototype. Where the loaded callee remains an SSA input, the fact
 * keeps a `loaded-callee` fallback in every world: a locked prototype slot
 * proves nothing about an own shadowing property on the receiver, so the
 * runtime identity check must stay.
 */
const annotateKnownBuiltinCalls: CoreFunctionPass = {
	name: "annotate-known-builtin-calls",
	run(fn, analyses, program) {
		const compilation = analyses.context;
		if (compilation === undefined) return fn;
		if (
			!fn.blocks.some((block) =>
				block.instructions.some(
					(instruction) =>
						instruction.opcode === "call" &&
						instruction.attributes.knownBuiltinCall === undefined &&
						instruction.inputs.length >= 2,
				),
			)
		) {
			return fn;
		}
		const valueCount = (fn.values.at(-1)?.id ?? -1) + 1;
		const definitions = new Array<CoreInstruction | undefined>(valueCount).fill(
			undefined,
		);
		const canonical = analyses.canonicalValues(fn);
		const canonicalRoots = new Array<CoreValueId | undefined>(valueCount).fill(undefined);
		const representations = new Array<
			CoreFunction["values"][number]["representation"] | undefined
		>(valueCount).fill(undefined);
		for (const { id, representation } of fn.values) {
			canonicalRoots[id] = canonical.get(id) ?? id;
			representations[id] = representation;
		}
		const useCounts = new Uint32Array(valueCount);
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				for (const output of instruction.outputs) definitions[output] = instruction;
				for (const input of instruction.inputs) {
					useCounts[input] = useCounts[input]! + 1;
				}
			}
		}
		let changed = false;
		let guardOrdinal = 0;
		const removedInstructions = new Set<CoreInstructionId>();
		const removedValues = new Set<CoreValueId>();
		const numericOutputs = new Set<CoreValueId>();
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					if (
						instruction.opcode !== "call" ||
						instruction.attributes.knownBuiltinCall !== undefined ||
						instruction.inputs.length < 2
					) {
						return instruction;
					}
					const property =
						definitions[canonicalRoots[instruction.inputs[0]!] ?? instruction.inputs[0]!];
					const stringIndex = property?.attributes.stringIndex;
					if (
						property?.opcode !== "loadPropertyStatic" ||
						property.inputs.length !== 1 ||
						(canonicalRoots[property.inputs[0]!] ?? property.inputs[0]) !==
							(canonicalRoots[instruction.inputs[1]!] ?? instruction.inputs[1]) ||
						typeof stringIndex !== "number"
					) {
						return instruction;
					}
					const key = decodeString(program, stringIndex);
					const receiverValue =
						canonicalRoots[instruction.inputs[1]!] ?? instruction.inputs[1]!;
					const receiver = definitions[receiverValue];
					const receiverRepresentation = representations[receiverValue];
					const candidates =
						key === undefined ? undefined : BUILTIN_OPERATIONS_BY_KEY.get(key);
					const exactReceiverFor = (
						candidate: (typeof builtinOperations)[number],
					): boolean => {
						const exact = exactBuiltinCallDescriptor(candidate.id);
						switch (exact?.receiverProof) {
							case "intrinsic-object":
								return (
									receiver?.opcode === "loadIntrinsic" &&
									receiver.attributes.intrinsic === candidate.owner
								);
							case "primitive-boolean":
								return receiverRepresentation === "boolean";
							case "primitive-number":
								return (
									receiverRepresentation === "f64" || receiverRepresentation === "i32"
								);
							case "primitive-string":
								return receiver?.opcode === "createString";
							default:
								return false;
						}
					};
					const constructedCollectionOwnerFor = (
						candidate: (typeof builtinOperations)[number],
					): boolean => {
						if (candidate.receiver !== "map" && candidate.receiver !== "set") {
							return false;
						}
						if (receiver?.opcode !== "construct" || receiver.inputs.length < 1) {
							return false;
						}
						const constructor =
							definitions[canonicalRoots[receiver.inputs[0]!] ?? receiver.inputs[0]!];
						return (
							constructor?.opcode === "loadIntrinsic" &&
							constructor.attributes.intrinsic ===
								(candidate.receiver === "map" ? "Map" : "Set")
						);
					};
					const ownerMatches =
						candidates?.filter(
							(candidate) =>
								exactReceiverFor(candidate) || constructedCollectionOwnerFor(candidate),
						) ?? [];
					// Map/Set `has` and `delete` have identical declared semantics and
					// share one guarded native dispatcher. When provenance cannot name
					// the owner (for example a long-lived global/captured collection),
					// the loaded callee identity plus runtime receiver brand safely
					// disambiguates the pair. All other collisions stay conservative.
					const compatibleCollectionCollision =
						candidates?.length === 2 &&
						(key === "has" || key === "delete") &&
						candidates.some((candidate) => candidate.owner === "Map.prototype") &&
						candidates.some((candidate) => candidate.owner === "Set.prototype");
					const descriptor =
						candidates?.length === 1
							? candidates[0]
							: ownerMatches.length === 1
								? ownerMatches[0]
								: compatibleCollectionCollision
									? candidates?.[0]
									: undefined;
					if (descriptor === undefined) return instruction;
					const site = builtinSourceSite(
						program,
						fn,
						instruction.sourcePosition,
						descriptor.id,
					);
					const sharedIdentity = compilation.facts.builtinIdentities.get(descriptor.id);
					const worldInvariantIdentity = compilerFactIsWorldInvariant(sharedIdentity);
					const arguments_ = instruction.inputs.slice(2);
					const mathOpcode = MATH_UNARY_OPERATIONS.has(descriptor.id)
						? "mathUnaryNumber"
						: descriptor.id === "Math.min" || descriptor.id === "Math.max"
							? "mathBinaryNumber"
							: undefined;
					const calleeIsSoleUse =
						property.outputs.length === 1 && useCounts[property.outputs[0]!] === 1;
					const numericRewrite =
						mathOpcode !== undefined &&
						worldInvariantIdentity &&
						descriptor.nativeNumberArity === arguments_.length &&
						arguments_.every((argument) => representations[argument] === "f64") &&
						instruction.outputs.length === 1
							? mathOpcode
							: undefined;
					const exact = exactBuiltinCallDescriptor(descriptor.id);
					const exactReceiver = exactReceiverFor(descriptor);
					const exactRewrite =
						exact !== undefined &&
						exactReceiver &&
						worldInvariantIdentity &&
						calleeIsSoleUse
							? exact
							: undefined;
					const calleeObligationId = `generic-call:${site ?? `${fn.functionIndex}:${guardOrdinal}`}`;
					// Three different duties shared one obligation until now. An exact
					// intrinsic-receiver rewrite proves both callee identity and the current
					// Realm, so it owes only primordial authority. Every other site keeps an
					// ordinary loaded callee: a locked prototype slot never disproves an own
					// shadowing property, and realm-sensitive operations separately retain
					// their calling-Realm duty.
					const calleeObligations: ReadonlyArray<FactObligation> =
						exactRewrite !== undefined
							? [
									authorityFallback(calleeObligationId, {
										kind: "world",
										fact: "primordials.locked",
									}),
								]
							: [
									{
										kind: "fallback",
										id: calleeObligationId,
										cause: "loaded-callee",
									},
									...(descriptor.realm === "realm-object-identity"
										? ([
												{
													kind: "fallback",
													id: calleeObligationId,
													cause: "realm",
												},
											] as const)
										: []),
								];
					const identity =
						sharedIdentity?.kind === "known"
							? knownFact(
									sharedIdentity.value,
									normalizeFactRequirements({
										scope:
											site === undefined
												? { kind: "function" as const, id: fn.functionIndex }
												: { kind: "site" as const, id: site },
										dependencies: sharedIdentity.proof.dependencies,
										obligations: [
											...sharedIdentity.proof.obligations,
											...calleeObligations,
										],
										origin: `guarded-builtin-site-analysis:${sharedIdentity.proof.origin}`,
									}),
								)
							: (sharedIdentity ?? {
									kind: "unknown" as const,
									reason: "not-analyzed" as const,
								});
					guardOrdinal++;
					changed = true;
					const knownBuiltinCall = {
						operation: descriptor.id,
						identity,
						semantics:
							identity.kind === "known"
								? knownFact(
										{
											effects: descriptor.effects,
											result: descriptor.result,
											lowerings: descriptor.lowerings,
										},
										{
											...identity.proof,
											origin: `builtin-registry-semantics:${descriptor.id}`,
										},
									)
								: identity,
						...(site === undefined ? {} : { sourceSite: site }),
					};
					if (numericRewrite !== undefined) {
						if (calleeIsSoleUse) {
							removedInstructions.add(property.id);
							for (const output of property.outputs) removedValues.add(output);
						}
						numericOutputs.add(instruction.outputs[0]!);
						return withoutEffectRefinement({
							...instruction,
							opcode: numericRewrite,
							inputs: arguments_,
							attributes: { operation: descriptor.id },
						});
					}
					if (exactRewrite !== undefined) {
						removedInstructions.add(property.id);
						for (const output of property.outputs) removedValues.add(output);
						const forwardedArguments =
							exactRewrite.forwardedArgumentLimit === undefined
								? arguments_
								: arguments_.slice(0, exactRewrite.forwardedArgumentLimit);
						return withoutEffectRefinement({
							...instruction,
							opcode: "callBuiltin",
							inputs: [instruction.inputs[1]!, ...forwardedArguments],
							attributes: {
								operation: exactRewrite.id,
								knownBuiltinCall: coreAttribute(knownBuiltinCall, "knownBuiltinCall"),
							},
						});
					}
					return {
						...instruction,
						attributes: {
							...instruction.attributes,
							knownBuiltinCall: coreAttribute(knownBuiltinCall, "knownBuiltinCall"),
						},
					};
				}),
			}),
		);
		const filteredBlocks = blocks.map((block) => ({
			...block,
			instructions: block.instructions.filter(({ id }) => !removedInstructions.has(id)),
		}));
		return changed
			? {
					...fn,
					blocks: filteredBlocks,
					values: fn.values
						.filter(({ id }) => !removedValues.has(id))
						.map((value) =>
							numericOutputs.has(value.id) ? { ...value, representation: "f64" } : value,
						),
					mutationEpoch: fn.mutationEpoch + 1,
				}
			: fn;
	},
};

const CONTAINED_FRESH_ARRAY_OPERATIONS = new Set([
	"Array.prototype.push",
	"Array.prototype.pop",
]);

/**
 * Erase the property and generic call seams for private worklist arrays.
 *
 * A locked world proves the intrinsic method identity. Allocation provenance
 * then proves the stronger local half: the initially dense fresh Array never
 * leaves this activation and every use of its reference is a non-escaping dense
 * read, an ordinary length read, or the receiver of one of these exact builtin
 * calls. The receiver exemptions
 * are admitted only while proving containment; passing the same Array as an
 * argument, storing it, returning it, editing its shape, or using any other
 * method still escapes the allocation and rejects every candidate on it.
 *
 * This is a whole-lifetime representation fact. The backend may therefore enter
 * the contained dense Array algorithm directly, without a callee cache, own-
 * shadow check, prototype/protector guard, or generic fallback.
 */
const rewriteContainedFreshArrayBuiltins: CoreFunctionPass = {
	name: "rewrite-contained-fresh-array-builtins",
	run(fn, analyses, _program) {
		if (analyses.context?.facts.world.primordialPolicy !== "locked") return fn;

		const canonical = analyses.canonicalValues(fn);
		const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
		const definitions = new Map<CoreValueId, CoreInstruction>();
		const useCounts = new Map<CoreValueId, number>();
		const representations = analyses.representations(fn);
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				for (const output of instruction.outputs) definitions.set(output, instruction);
				for (const input of instruction.inputs) {
					useCounts.set(input, (useCounts.get(input) ?? 0) + 1);
				}
			}
		}

		interface Candidate {
			readonly call: CoreInstruction;
			readonly property: CoreInstruction;
			readonly allocation: CoreInstructionId;
			readonly operation: "Array.prototype.push" | "Array.prototype.pop";
			readonly forwardedArguments: ReadonlyArray<CoreValueId>;
		}
		const candidates: Array<Candidate> = [];
		const assumedNonEscapingOperands = new Map<CoreInstructionId, Set<number>>();
		const assumeNonEscaping = (instruction: CoreInstructionId, operand: number): void => {
			const existing = assumedNonEscapingOperands.get(instruction);
			if (existing === undefined) {
				assumedNonEscapingOperands.set(instruction, new Set([operand]));
			} else {
				existing.add(operand);
			}
		};
		const ordinaryProvenance = analyses.provenance(fn);

		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.opcode !== "call" || instruction.inputs.length < 2) continue;
				const known = attributeObject(instruction.attributes.knownBuiltinCall);
				const operation = known?.operation;
				if (
					typeof operation !== "string" ||
					!CONTAINED_FRESH_ARRAY_OPERATIONS.has(operation)
				) {
					continue;
				}
				const exact = exactBuiltinCallDescriptor(operation);
				const proof = coreKnownBuiltinProof(instruction, operation, {
					lowering: "exact-builtin-call",
				});
				if (
					exact?.receiverProof !== "fresh-array" ||
					proof === undefined ||
					!coreProofIsWorldInvariant(proof.proof)
				) {
					continue;
				}

				const callee = instruction.inputs[0]!;
				const receiver = instruction.inputs[1]!;
				const property = definitions.get(root(callee));
				if (
					property?.opcode !== "loadPropertyStatic" ||
					property.outputs.length !== 1 ||
					property.outputs[0] !== callee ||
					property.inputs.length !== 1 ||
					root(property.inputs[0]!) !== root(receiver) ||
					useCounts.get(callee) !== 1 ||
					coreValueUsedByControlFlow(fn, root, callee)
				) {
					continue;
				}
				const layout = ordinaryProvenance.allocationOf(receiver);
				if (layout?.kind !== "indexed" || layout.elements.size !== layout.length) {
					continue;
				}

				const arguments_ = instruction.inputs.slice(2);
				candidates.push({
					call: instruction,
					property,
					allocation: layout.instruction,
					operation: operation as Candidate["operation"],
					forwardedArguments:
						exact.forwardedArgumentLimit === undefined
							? arguments_
							: arguments_.slice(0, exact.forwardedArgumentLimit),
				});
				assumeNonEscaping(property.id, 0);
				assumeNonEscaping(instruction.id, 1);
			}
		}
		if (candidates.length === 0) return fn;

		// A numeric computed read cannot coerce user code, and a locked primordial
		// chain contains no indexed accessor that could retain the receiver. It does
		// not change the Array's dense representation even when the number is outside
		// the current length. Let the lifetime proof use this independently
		// established non-escape fact; retained reads become exact below.
		const candidateAllocations = new Set(candidates.map(({ allocation }) => allocation));
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.opcode !== "loadProperty" || instruction.inputs.length < 2) {
					continue;
				}
				const layout = ordinaryProvenance.allocationOf(instruction.inputs[0]!);
				const keyRepresentation = representations.get(root(instruction.inputs[1]!));
				if (
					layout?.kind === "indexed" &&
					candidateAllocations.has(layout.instruction) &&
					(keyRepresentation === "f64" || keyRepresentation === "i32")
				) {
					assumeNonEscaping(instruction.id, 0);
				}
			}
		}

		const conditionalProvenance = ordinaryProvenance.withAssumedNonEscapingOperands(
			assumedNonEscapingOperands,
		);
		const retained = candidates.filter(
			(candidate) => conditionalProvenance.escape(candidate.allocation) === "contained",
		);
		if (retained.length === 0) return fn;

		const byCall = new Map(retained.map((candidate) => [candidate.call.id, candidate]));
		const removedInstructions = new Set(
			retained.map((candidate) => candidate.property.id),
		);
		const removedValues = new Set(
			retained.flatMap((candidate) => candidate.property.outputs),
		);
		const retainedAllocations = new Set(retained.map(({ allocation }) => allocation));
		const exactElementLoads = new Set<CoreInstructionId>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.opcode !== "loadProperty" || instruction.inputs.length < 2) {
					continue;
				}
				const layout = ordinaryProvenance.allocationOf(instruction.inputs[0]!);
				const keyRepresentation = representations.get(root(instruction.inputs[1]!));
				if (
					layout?.kind === "indexed" &&
					retainedAllocations.has(layout.instruction) &&
					(keyRepresentation === "f64" || keyRepresentation === "i32")
				) {
					exactElementLoads.add(instruction.id);
				}
			}
		}
		return {
			...fn,
			blocks: fn.blocks.map((block) => ({
				...block,
				instructions: block.instructions
					.filter((instruction) => !removedInstructions.has(instruction.id))
					.map((instruction): CoreInstruction => {
						const candidate = byCall.get(instruction.id);
						if (candidate !== undefined) {
							return withoutEffectRefinement({
								...instruction,
								opcode: "callBuiltin",
								inputs: [instruction.inputs[1]!, ...candidate.forwardedArguments],
								attributes: {
									operation: candidate.operation,
									knownBuiltinCall: instruction.attributes.knownBuiltinCall!,
								},
							});
						}
						return exactElementLoads.has(instruction.id)
							? {
									...instruction,
									attributes: {
										...instruction.attributes,
										[CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE]: true,
									},
								}
							: instruction;
					}),
			})),
			values: fn.values.filter(({ id }) => !removedValues.has(id)),
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

/**
 * Materialize transitive private-aggregate ownership as exact object slots.
 *
 * This runs after region selection has finished. It therefore never competes
 * with a larger projection certificate: residual property accesses either get
 * this exact slot or keep their original generic semantics. The proof records
 * only diagnostic coordinates; both the verifier and lowering reconstruct the
 * physical slot from the final Core graph.
 */
const materializeContainedAggregateOwnSlots: CoreFunctionPass = {
	name: "materialize-contained-aggregate-own-slots",
	run(fn, analyses, program) {
		const claimed = new Set(
			fn.regions.flatMap(({ claimedInstructions }) => claimedInstructions),
		);
		const analysis = coreContainedAggregateProvenance(
			fn,
			analyses.controlFlow(fn),
			program.stringConstants,
		);
		const facts = [...fn.facts];
		let nextFact = nextFactId(fn);
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					if (instruction.effectRefinement !== undefined || claimed.has(instruction.id)) {
						return instruction;
					}
					const slot = analysis.ownSlot(instruction);
					if (slot === undefined) return instruction;
					const effects = coreInstructionEffects(instruction);
					const refined = {
						reads: effects.reads.filter((domain) => domain !== "host"),
						writes: effects.writes.filter((domain) => domain !== "host"),
						mayThrow: false,
						maySuspend: false,
						mayGc: false,
						callsUserCode: false,
					};
					const proof = coreFactId(nextFact++);
					facts.push({
						id: proof,
						kind: CORE_CONTAINED_AGGREGATE_OWN_SLOT_FACT,
						value: {
							slot: slot.slot,
							origins: slot.origins.map((origin) => ({
								$coreInstruction: origin,
							})),
						},
						claims: [{ kind: "effect", instruction: instruction.id, effects: refined }],
						validity: {
							kind: "summary",
							digest: `contained-aggregate-slot:${slot.slot}:${slot.origins.join(",")}`,
						},
						obligations: [],
						origin: "core-contained-aggregate-provenance",
					});
					changed = true;
					return {
						...instruction,
						effectRefinement: { effects: refined, proof },
					};
				}),
			}),
		);
		return changed ? { ...fn, blocks, facts, mutationEpoch: fn.mutationEpoch + 1 } : fn;
	},
};

const MAX_INLINE_INSTRUCTIONS = 40;
const MAX_INLINE_TOTAL_COST = MAX_INLINE_INSTRUCTIONS * 8;
const MAX_GUARDED_INLINE_STATEMENTS = 64;
const MAX_FINITE_DISPATCH_TARGETS = 4;
const MAX_FINITE_DISPATCH_COST = 40;
const INLINE_DISQUALIFYING_OPCODES = new Set([
	"loadThis",
	"loadNewTarget",
	"loadCallee",
	"loadArgumentCount",
	"loadArgument",
	"loadStaticArgument",
	"loadCaptured",
	"storeCaptured",
	"envPush",
	"envCopy",
	"envPop",
	"createFunction",
	"createArgumentsObject",
	"createRestArguments",
	"withEnter",
	"withExit",
	"withGet",
	"withResolveBase",
	"withSet",
	"yield",
	"await",
	"asyncStart",
	"generatorStart",
]);

interface LinearInlineTarget {
	readonly blocks: ReadonlyArray<CoreBlock>;
	readonly instructionCount: number;
	readonly generatedCost: CoreGeneratedCodeCost;
}

interface GuardedInlineCandidate {
	readonly target: CoreFunction;
	readonly linear: LinearInlineTarget;
}

interface InlineProgramResult {
	readonly program: CoreProgram;
	readonly context?: CoreCompilationContext;
	readonly changed: boolean;
}

interface LinearInlineClone {
	readonly instructions: ReadonlyArray<CoreInstruction>;
	readonly values: ReadonlyArray<CoreFunction["values"][number]>;
	readonly returnValue: CoreValueId;
	readonly relocatedTargets: ReadonlyMap<CoreValueId, CoreCalleeTargets>;
	readonly nextInstruction: number;
	readonly nextValue: number;
}

function functionDefinitions(fn: CoreFunction): Map<CoreValueId, CoreInstruction> {
	const definitions = new Map<CoreValueId, CoreInstruction>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			for (const output of instruction.outputs) definitions.set(output, instruction);
		}
	}
	return definitions;
}

const ARRAY_ITERATION_CALLBACK_OPERATIONS: ReadonlySet<string> = new Set([
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
]);

/**
 * Annotate call and construct sites from the program's bounded callee-target
 * lattice.
 *
 * `mal_vm_construct_direct` re-checks the live constructor's function index and
 * falls back to generic dispatch on a mismatch, so construct keeps a guarded
 * singleton even when the lattice remains open. Ordinary calls use a narrower
 * generated-code admission rule: the guarded inliner consumes eligible open
 * candidates before this pass, while a residual call receives a direct-entry hint
 * only from a closed singleton. The backend still validates that hint against the
 * live callee; this avoids adding a speculative ABI path to an open residual call
 * merely because the bounded lattice retained one advisory candidate.
 *
 * `%Function.prototype.call%` flattening remains guarded by the runtime's retained
 * primordial identity. Its shifted script target is admitted only when the
 * receiver is a closed singleton; otherwise flattening preserves the generic
 * receiver dispatch without speculating on one receiver candidate. The complete
 * bounded set and its opacity bits stay in Core metadata for other consumers.
 * Declines are recorded only by the final refresh: the normalization-time graph
 * may still close or eliminate a site during the optimization fixed point.
 */
function annotateCoreDirectCallTargets(
	program: CoreProgram,
	context: CoreCompilationContext | undefined,
	analysis: CoreCalleeTargetAnalysis = analyzeCoreCalleeTargets(
		program,
		coreOpcodeRegistry,
		context,
	),
	recordDeclines = false,
): InlineProgramResult {
	const decisions =
		!recordDeclines || context?.optimizationDecisions === undefined
			? undefined
			: [...context.optimizationDecisions];
	const decisionCount = decisions?.length;
	const functionsByIndex = new Map(
		program.functions.map((fn) => [fn.functionIndex, fn] as const),
	);
	let changed = false;
	const functions = program.functions.map((fn): CoreFunction => {
		if (
			!fn.blocks.some((block) =>
				block.instructions.some(
					({ opcode }) => opcode === "call" || opcode === "construct",
				),
			)
		) {
			return fn;
		}
		let definitions: Map<CoreValueId, CoreInstruction> | undefined;
		const definition = (value: CoreValueId): CoreInstruction | undefined =>
			(definitions ??= functionDefinitions(fn)).get(value);
		const closedTarget = (value: CoreValueId): number | undefined =>
			coreCalleeTargetsClosedFunction(analysis.targets(fn.functionIndex, value));
		const moveRoot = (initial: CoreValueId): CoreValueId => {
			let value = initial;
			const seen = new Set<CoreValueId>();
			while (!seen.has(value)) {
				seen.add(value);
				const producer = definition(value);
				if (producer?.opcode !== "move" || producer.inputs.length !== 1) break;
				value = producer.inputs[0]!;
			}
			return value;
		};
		let functionChanged = false;
		const blocks = fn.blocks.map((block): CoreBlock => {
			let blockChanged = false;
			const instructions = block.instructions.map((instruction): CoreInstruction => {
				if (instruction.opcode !== "call" && instruction.opcode !== "construct") {
					return instruction;
				}
				const callee = instruction.inputs[0];
				if (callee === undefined) return instruction;
				const targets = analysis.targets(fn.functionIndex, callee);
				const singletonTarget = coreCalleeTargetsSingleFunction(targets);
				const closedCallTarget = coreCalleeTargetsClosedFunction(targets);
				const target = instruction.opcode === "call" ? closedCallTarget : singletonTarget;
				const targetFunction =
					target === undefined ? undefined : functionsByIndex.get(target);
				const attributes: Record<string, CoreAttributeValue> = {
					...instruction.attributes,
				};
				// This pass owns these advisory attributes. Re-running it on a later
				// graph must be able to retract a target that is no longer justified,
				// not merely add a more precise one.
				delete attributes.directFunctionIndex;
				delete attributes.directFunctionCall;
				delete attributes.directCallTargetFunctionIndex;
				delete attributes.directCallbackFunctionIndex;
				delete attributes[CORE_CALLEE_TARGETS_ATTRIBUTE];
				if (
					instruction.opcode === "call" &&
					target === undefined &&
					singletonTarget !== undefined &&
					functionsByIndex.has(singletonTarget)
				) {
					recordCallOptimizationDecision(
						decisions,
						fn,
						instruction,
						"declined",
						"generated-code-cost",
					);
				}
				const finiteDispatchTarget =
					typeof instruction.attributes[CORE_FINITE_DISPATCH_TARGET_ATTRIBUTE] ===
					"number"
						? instruction.attributes[CORE_FINITE_DISPATCH_TARGET_ATTRIBUTE]
						: undefined;
				if (
					finiteDispatchTarget !== undefined &&
					functionsByIndex.has(finiteDispatchTarget)
				) {
					attributes.directFunctionIndex = finiteDispatchTarget;
				} else if (
					targetFunction !== undefined &&
					(instruction.opcode === "call" ||
						(!targetFunction.isGenerator &&
							!targetFunction.isAsync &&
							targetFunction.metadata.hasPrototype))
				) {
					attributes.directFunctionIndex = targetFunction.functionIndex;
				}
				if (targets.functions.length > 0) {
					attributes[CORE_CALLEE_TARGETS_ATTRIBUTE] = coreCalleeTargetsAttribute(targets);
				}
				const knownBuiltin = attributeObject(instruction.attributes.knownBuiltinCall);
				const callback = instruction.inputs[2];
				if (
					instruction.opcode === "call" &&
					callback !== undefined &&
					knownBuiltinIdentity(instruction) &&
					typeof knownBuiltin?.operation === "string" &&
					ARRAY_ITERATION_CALLBACK_OPERATIONS.has(knownBuiltin.operation)
				) {
					const callbackTarget = closedTarget(callback);
					if (callbackTarget !== undefined && functionsByIndex.has(callbackTarget)) {
						attributes.directCallbackFunctionIndex = callbackTarget;
					}
				}
				if (instruction.opcode === "call" && instruction.inputs.length >= 2) {
					const calleeDefinition = definition(moveRoot(callee));
					const receiver = calleeDefinition?.inputs[0];
					const thisValue = instruction.inputs[1]!;
					const staticKey =
						calleeDefinition?.opcode === "loadPropertyStatic" &&
						typeof calleeDefinition.attributes.stringIndex === "number"
							? decodeString(program, calleeDefinition.attributes.stringIndex)
							: calleeDefinition?.opcode === "loadProperty" &&
								  calleeDefinition.inputs[1] !== undefined
								? (() => {
										const key = definition(moveRoot(calleeDefinition.inputs[1]));
										return key?.opcode === "createString" &&
											typeof key.attributes.stringIndex === "number"
											? decodeString(program, key.attributes.stringIndex)
											: undefined;
									})()
								: undefined;
					if (
						(calleeDefinition?.opcode === "loadPropertyStatic" ||
							calleeDefinition?.opcode === "loadProperty") &&
						staticKey === "call" &&
						receiver !== undefined &&
						moveRoot(receiver) === moveRoot(thisValue)
					) {
						const receiverTarget = closedTarget(thisValue) ?? closedTarget(receiver);
						// The runtime validates the loaded method against the realm's exact
						// %Function.prototype.call% object. A miss invokes the original
						// method with the original receiver and arguments, so no static
						// callable/provenance assumption is required for flattening.
						attributes.directFunctionCall = true;
						if (receiverTarget !== undefined && functionsByIndex.has(receiverTarget)) {
							attributes.directCallTargetFunctionIndex = receiverTarget;
						}
					}
				}
				if (stableAttributeValue(attributes) === stableAttributes(instruction)) {
					return instruction;
				}
				blockChanged = true;
				functionChanged = true;
				return { ...instruction, attributes };
			});
			return blockChanged ? { ...block, instructions } : block;
		});
		if (!functionChanged) return fn;
		changed = true;
		return { ...fn, blocks, mutationEpoch: fn.mutationEpoch + 1 };
	});
	const decisionsChanged =
		decisions !== undefined &&
		decisionCount !== undefined &&
		decisions.length !== decisionCount;
	const annotated = changed ? { ...program, functions } : program;
	return {
		program: annotated,
		...(context === undefined
			? {}
			: {
					context:
						decisionsChanged && decisions !== undefined
							? { ...context, optimizationDecisions: decisions }
							: context,
				}),
		changed: changed || decisionsChanged,
	};
}

function linearInlineTarget(target: CoreFunction): LinearInlineTarget | undefined {
	if (
		target.isGenerator ||
		target.isAsync ||
		target.metadata.isClassConstructor ||
		target.metadata.capturedCount > 0 ||
		target.regions.length > 0
	) {
		return undefined;
	}
	const blocks: Array<CoreBlock> = [];
	const visited = new Set<CoreBlockId>();
	let block = target.blocks[target.entry];
	let instructionCount = 0;
	while (block !== undefined && !visited.has(block.id)) {
		visited.add(block.id);
		if (
			block.handler !== undefined ||
			block.parameters.some(({ role }) => role === "exception")
		) {
			return undefined;
		}
		for (const instruction of block.instructions) {
			if (
				INLINE_DISQUALIFYING_OPCODES.has(instruction.opcode) ||
				instruction.effectRefinement !== undefined
			) {
				return undefined;
			}
			instructionCount++;
			if (instructionCount > MAX_INLINE_INSTRUCTIONS) return undefined;
		}
		blocks.push(block);
		if (block.terminator.kind === "return") {
			return instructionCount === 0
				? undefined
				: {
						blocks,
						instructionCount,
						generatedCost: coreGeneratedCodeCostForInstructions(
							target,
							blocks.flatMap((candidate) =>
								candidate.instructions.map((instruction) => ({ instruction })),
							),
							{ duplicatedInstructions: instructionCount },
						),
					};
		}
		if (block.terminator.kind !== "jump") return undefined;
		block = target.blocks[block.terminator.edge.block];
	}
	return undefined;
}

function targetShapeDeclineReason(target: CoreFunction): OptimizationDecisionReason {
	if (
		target.blocks.some(
			(block) =>
				block.handler !== undefined ||
				block.parameters.some(({ role }) => role === "exception"),
		)
	) {
		return "exception-region";
	}
	if (
		target.blocks.some((block) =>
			block.instructions.some(({ opcode }) => opcode === "createFunction"),
		)
	) {
		return "inner-closure";
	}
	return "relocation";
}

function recordCallOptimizationDecision(
	decisions: Array<CompilerOptimizationDecision> | undefined,
	fn: CoreFunction,
	call: CoreInstruction,
	outcome: "applied" | "declined",
	reason: OptimizationDecisionReason | "finite-dispatch" | "inline",
): void {
	const positionId = call.sourcePosition;
	if (decisions === undefined || positionId === undefined) return;
	const code: CompilerOptimizationDecision["code"] =
		outcome === "applied"
			? `optimization.applied.${reason}`
			: `optimization.declined.${reason as OptimizationDecisionReason}`;
	if (
		decisions.some(
			(decision) =>
				decision.functionIndex === fn.functionIndex &&
				decision.positionId === positionId &&
				decision.code === code,
		)
	) {
		return;
	}
	decisions.push({
		functionIndex: fn.functionIndex,
		positionId,
		operation: "call",
		phase: "optimization",
		code,
		outcome,
		...(outcome === "declined" ? { reason: reason as OptimizationDecisionReason } : {}),
	});
}

function nextInstructionId(fn: CoreFunction): number {
	let next = 0;
	for (const block of fn.blocks) {
		for (const instruction of block.instructions)
			next = Math.max(next, instruction.id + 1);
		next = Math.max(next, block.terminator.id + 1);
	}
	return next;
}

function inlineSourcePosition(
	positions: Array<CoreProgram["sourcePositions"][number]>,
	targetFunctionIndex: number,
	positionId: number | undefined,
	callerPositionId: number | undefined,
): number | undefined {
	if (positionId === undefined || callerPositionId === undefined) return positionId;
	const position = positions[positionId];
	if (position === undefined || position.inlinedFunctionIndex !== undefined) {
		return positionId;
	}
	return (
		positions.push({
			line: position.line,
			column: position.column,
			inlinedFunctionIndex: targetFunctionIndex,
			callerPosId: callerPositionId,
		}) - 1
	);
}

function cloneLinearInlineBody(
	fn: CoreFunction,
	call: CoreInstruction,
	target: CoreFunction,
	linear: LinearInlineTarget,
	positions: Array<CoreProgram["sourcePositions"][number]>,
	targetAnalysis: CoreCalleeTargetAnalysis,
	callerTargets: (value: CoreValueId) => CoreCalleeTargets,
	instructionStart = nextInstructionId(fn),
	valueStart = fn.values.reduce((next, value) => Math.max(next, value.id + 1), 0),
): LinearInlineClone | undefined {
	let instructionNumber = instructionStart;
	let valueNumber = valueStart;
	const values = [...fn.values];
	const valueMap = new Map<CoreValueId, CoreValueId>();
	const relocatedTargets = new Map<CoreValueId, CoreCalleeTargets>();
	const relocatedTarget = (value: CoreValueId): CoreCalleeTargets =>
		relocatedTargets.get(value) ?? callerTargets(value);
	const cloned: Array<CoreInstruction> = [];
	const arguments_ = call.inputs.slice(2);
	for (const [index, parameter] of target.parameters.entries()) {
		const argument = arguments_[index];
		if (argument !== undefined) {
			valueMap.set(parameter, argument);
			continue;
		}
		const instructionId = coreInstructionId(instructionNumber++);
		const valueId = coreValueId(valueNumber++);
		cloned.push({
			id: instructionId,
			opcode: "createUndefined",
			inputs: [],
			outputs: [valueId],
			attributes: {},
			...(call.sourcePosition === undefined
				? {}
				: { sourcePosition: call.sourcePosition }),
		});
		values.push({
			id: valueId,
			representation: "boxed",
			definition: { kind: "instruction", instruction: instructionId, index: 0 },
		});
		valueMap.set(parameter, valueId);
	}
	const targetValues = new Map(target.values.map((value) => [value.id, value] as const));
	const resolveTarget = (value: CoreValueId): CoreValueId | undefined =>
		valueMap.get(value);
	let returnValue: CoreValueId | undefined;
	for (const [blockIndex, targetBlock] of linear.blocks.entries()) {
		if (blockIndex > 0) {
			const predecessor = linear.blocks[blockIndex - 1]!;
			if (predecessor.terminator.kind !== "jump") return undefined;
			for (const [index, parameter] of targetBlock.parameters.entries()) {
				const argument = predecessor.terminator.edge.arguments[index];
				const resolved = argument === undefined ? undefined : resolveTarget(argument);
				if (resolved === undefined) return undefined;
				valueMap.set(parameter.value, resolved);
			}
		}
		for (const instruction of targetBlock.instructions) {
			const inputs = instruction.inputs.map(resolveTarget);
			if (inputs.some((input) => input === undefined)) return undefined;
			const instructionId = coreInstructionId(instructionNumber++);
			const outputs = instruction.outputs.map((output, outputIndex) => {
				const source = targetValues.get(output);
				if (source === undefined) throw new Error(`Missing Core inline value ${output}`);
				const valueId = coreValueId(valueNumber++);
				values.push({
					id: valueId,
					representation: source.representation,
					definition: {
						kind: "instruction",
						instruction: instructionId,
						index: outputIndex,
					},
				});
				valueMap.set(output, valueId);
				relocatedTargets.set(
					valueId,
					instruction.opcode === "move" && inputs[0] !== undefined
						? relocatedTarget(inputs[0])
						: targetAnalysis.targets(target.functionIndex, output),
				);
				return valueId;
			});
			cloned.push({
				...instruction,
				id: instructionId,
				inputs: inputs as Array<CoreValueId>,
				outputs,
				...(instruction.sourcePosition === undefined
					? {}
					: {
							sourcePosition: inlineSourcePosition(
								positions,
								target.functionIndex,
								instruction.sourcePosition,
								call.sourcePosition,
							),
						}),
			});
		}
		if (targetBlock.terminator.kind === "return") {
			returnValue = resolveTarget(targetBlock.terminator.value);
		}
	}
	if (returnValue === undefined) return undefined;
	return {
		instructions: cloned,
		values,
		returnValue,
		relocatedTargets,
		nextInstruction: instructionNumber,
		nextValue: valueNumber,
	};
}

function inlineLinearCall(
	fn: CoreFunction,
	block: CoreBlock,
	call: CoreInstruction,
	target: CoreFunction,
	linear: LinearInlineTarget,
	positions: Array<CoreProgram["sourcePositions"][number]>,
	targetAnalysis: CoreCalleeTargetAnalysis,
	callerTargets: (value: CoreValueId) => CoreCalleeTargets,
):
	| {
			readonly fn: CoreFunction;
			readonly relocatedTargets: ReadonlyMap<CoreValueId, CoreCalleeTargets>;
	  }
	| undefined {
	if (call.outputs.length !== 1 || call.inputs.length < 2) return undefined;
	const clone = cloneLinearInlineBody(
		fn,
		call,
		target,
		linear,
		positions,
		targetAnalysis,
		callerTargets,
	);
	if (clone === undefined) return undefined;
	const blocks = fn.blocks.map(
		(candidate): CoreBlock =>
			candidate.id === block.id
				? {
						...candidate,
						instructions: candidate.instructions.flatMap((instruction) =>
							instruction.id === call.id ? clone.instructions : [instruction],
						),
					}
				: candidate,
	);
	return {
		fn: rewriteFunction(
			{ ...fn, values: clone.values },
			blocks,
			new Map([[call.outputs[0]!, clone.returnValue]]),
			new Set([call.id]),
		),
		relocatedTargets: clone.relocatedTargets,
	};
}

/**
 * Inline one named candidate without trusting that it is the live callee.
 *
 * The original call moves to a cold semantic twin. `guardFunctionIndex` checks
 * the actual function object, so a rebinding, builtin, Proxy, or other opaque
 * value takes that generic path with the original receiver and argument order.
 * Both paths pass their result through one explicit join parameter; every use
 * of the old call result therefore keeps the same SSA identity, including uses
 * in successor blocks. Splitting the source block also copies its exceptional
 * edge to the inlined body, generic call, and continuation so the transformation
 * preserves the caller's catch region.
 */
function inlineGuardedLinearCalls(
	fn: CoreFunction,
	block: CoreBlock,
	call: CoreInstruction,
	candidates: ReadonlyArray<GuardedInlineCandidate>,
	positions: Array<CoreProgram["sourcePositions"][number]>,
	targetAnalysis: CoreCalleeTargetAnalysis,
	callerTargets: (value: CoreValueId) => CoreCalleeTargets,
):
	| {
			readonly fn: CoreFunction;
			readonly relocatedTargets: ReadonlyMap<CoreValueId, CoreCalleeTargets>;
			readonly fallbackCall: CoreInstructionId;
	  }
	| undefined {
	if (candidates.length === 0 || call.outputs.length !== 1 || call.inputs.length < 2) {
		return undefined;
	}
	const callIndex = block.instructions.findIndex(({ id }) => id === call.id);
	if (callIndex < 0) return undefined;
	const clones: Array<LinearInlineClone> = [];
	const relocatedTargets = new Map<CoreValueId, CoreCalleeTargets>();
	let staged = fn;
	let instructionNumber = nextInstructionId(fn);
	let valueNumber = fn.values.reduce((next, value) => Math.max(next, value.id + 1), 0);
	for (const { target, linear } of candidates) {
		const clone = cloneLinearInlineBody(
			staged,
			call,
			target,
			linear,
			positions,
			targetAnalysis,
			callerTargets,
			instructionNumber,
			valueNumber,
		);
		if (clone === undefined) return undefined;
		clones.push(clone);
		staged = { ...staged, values: clone.values };
		instructionNumber = clone.nextInstruction;
		valueNumber = clone.nextValue;
		for (const [value, targets] of clone.relocatedTargets) {
			relocatedTargets.set(value, targets);
		}
	}

	const fallbackOutput = coreValueId(valueNumber++);
	const guardValues = candidates.map(() => coreValueId(valueNumber++));
	const controls = candidates.map(() => ({
		guard: coreInstructionId(instructionNumber++),
		branch: coreInstructionId(instructionNumber++),
		fastTerminator: coreInstructionId(instructionNumber++),
	}));
	const fallbackTerminator = coreInstructionId(instructionNumber++);
	const blockBase = fn.blocks.length;
	const fastBlock = (index: number): CoreBlockId => coreBlockId(blockBase + index * 2);
	const guardBlock = (index: number): CoreBlockId =>
		index === 0 ? block.id : coreBlockId(blockBase + index * 2 - 1);
	const fallbackBlock = coreBlockId(blockBase + candidates.length * 2 - 1);
	const joinBlock = coreBlockId(blockBase + candidates.length * 2);
	const originalOutput = call.outputs[0]!;
	const output = fn.values.find(({ id }) => id === originalOutput);
	if (output === undefined) return undefined;
	const handler = block.handler === undefined ? {} : { handler: block.handler };
	const guardedBlock = (
		index: number,
		prefix: ReadonlyArray<CoreInstruction> = [],
		parameters: CoreBlock["parameters"] = [],
	): CoreBlock => {
		const control = controls[index]!;
		const candidate = candidates[index]!;
		const guard: CoreInstruction = {
			id: control.guard,
			opcode: "guardFunctionIndex",
			inputs: [call.inputs[0]!],
			outputs: [guardValues[index]!],
			attributes: { functionIndex: candidate.target.functionIndex },
			...(call.sourcePosition === undefined
				? {}
				: { sourcePosition: call.sourcePosition }),
		};
		return {
			id: guardBlock(index),
			parameters,
			instructions: [...prefix, guard],
			terminator: {
				id: control.branch,
				kind: "branch",
				condition: guardValues[index]!,
				consequent: { block: fastBlock(index), arguments: [] },
				alternate: {
					block: index + 1 < candidates.length ? guardBlock(index + 1) : fallbackBlock,
					arguments: [],
				},
				...(call.sourcePosition === undefined
					? {}
					: { sourcePosition: call.sourcePosition }),
			},
			...handler,
		};
	};
	const fallbackCall: CoreInstruction = {
		...call,
		outputs: [fallbackOutput],
	};
	const blocks: Array<CoreBlock> = fn.blocks.map((candidate) =>
		candidate.id === block.id
			? guardedBlock(0, candidate.instructions.slice(0, callIndex), candidate.parameters)
			: candidate,
	);
	for (const [index, clone] of clones.entries()) {
		blocks.push({
			id: fastBlock(index),
			parameters: [],
			instructions: clone.instructions,
			terminator: {
				id: controls[index]!.fastTerminator,
				kind: "jump",
				edge: { block: joinBlock, arguments: [clone.returnValue] },
			},
			...handler,
		});
		if (index + 1 < clones.length) blocks.push(guardedBlock(index + 1));
	}
	blocks.push(
		{
			id: fallbackBlock,
			parameters: [],
			instructions: [fallbackCall],
			terminator: {
				id: fallbackTerminator,
				kind: "jump",
				edge: { block: joinBlock, arguments: [fallbackOutput] },
			},
			...handler,
		},
		{
			id: joinBlock,
			parameters: [
				{
					value: originalOutput,
					representation: output.representation,
					role: "value",
				},
			],
			instructions: block.instructions.slice(callIndex + 1),
			terminator: block.terminator,
			...handler,
		},
	);
	const values = staged.values
		.map((value) =>
			value.id === originalOutput
				? {
						...value,
						definition: {
							kind: "block-parameter" as const,
							block: joinBlock,
							index: 0,
						},
					}
				: value,
		)
		.concat([
			{
				id: fallbackOutput,
				representation: output.representation,
				definition: {
					kind: "instruction" as const,
					instruction: call.id,
					index: 0,
				},
			},
			...guardValues.map((guardValue, index) => ({
				id: guardValue,
				representation: "boolean" as const,
				definition: {
					kind: "instruction" as const,
					instruction: controls[index]!.guard,
					index: 0,
				},
			})),
		]);
	return {
		fn: { ...fn, blocks, values, mutationEpoch: fn.mutationEpoch + 1 },
		relocatedTargets,
		fallbackCall: call.id,
	};
}

function dispatchFiniteDirectCalls(
	fn: CoreFunction,
	block: CoreBlock,
	call: CoreInstruction,
	targets: ReadonlyArray<number>,
): CoreFunction | undefined {
	if (targets.length === 0 || call.outputs.length !== 1 || call.inputs.length < 2) {
		return undefined;
	}
	const callIndex = block.instructions.findIndex(({ id }) => id === call.id);
	if (callIndex < 0) return undefined;
	let nextInstruction = nextInstructionId(fn);
	let nextValue = fn.values.reduce((next, value) => Math.max(next, value.id + 1), 0);
	const fallbackOutput = coreValueId(nextValue++);
	const directOutputs = targets.map(() => coreValueId(nextValue++));
	const guardValues = targets.map(() => coreValueId(nextValue++));
	const controls = targets.map(() => ({
		guard: coreInstructionId(nextInstruction++),
		branch: coreInstructionId(nextInstruction++),
		directCall: coreInstructionId(nextInstruction++),
		directTerminator: coreInstructionId(nextInstruction++),
	}));
	const fallbackTerminator = coreInstructionId(nextInstruction++);
	const blockBase = fn.blocks.length;
	const directBlock = (index: number): CoreBlockId => coreBlockId(blockBase + index * 2);
	const guardBlock = (index: number): CoreBlockId =>
		index === 0 ? block.id : coreBlockId(blockBase + index * 2 - 1);
	const fallbackBlock = coreBlockId(blockBase + targets.length * 2 - 1);
	const joinBlock = coreBlockId(blockBase + targets.length * 2);
	const originalOutput = call.outputs[0]!;
	const output = fn.values.find(({ id }) => id === originalOutput);
	if (output === undefined) return undefined;
	const handler = block.handler === undefined ? {} : { handler: block.handler };
	const guardedBlock = (
		index: number,
		prefix: ReadonlyArray<CoreInstruction> = [],
		parameters: CoreBlock["parameters"] = [],
	): CoreBlock => {
		const control = controls[index]!;
		const guard: CoreInstruction = {
			id: control.guard,
			opcode: "guardFunctionIndex",
			inputs: [call.inputs[0]!],
			outputs: [guardValues[index]!],
			attributes: { functionIndex: targets[index]! },
			...(call.sourcePosition === undefined
				? {}
				: { sourcePosition: call.sourcePosition }),
		};
		return {
			id: guardBlock(index),
			parameters,
			instructions: [...prefix, guard],
			terminator: {
				id: control.branch,
				kind: "branch",
				condition: guardValues[index]!,
				consequent: { block: directBlock(index), arguments: [] },
				alternate: {
					block: index + 1 < targets.length ? guardBlock(index + 1) : fallbackBlock,
					arguments: [],
				},
				...(call.sourcePosition === undefined
					? {}
					: { sourcePosition: call.sourcePosition }),
			},
			...handler,
		};
	};
	const fallbackCall: CoreInstruction = { ...call, outputs: [fallbackOutput] };
	const blocks: Array<CoreBlock> = fn.blocks.map((candidate) =>
		candidate.id === block.id
			? guardedBlock(0, candidate.instructions.slice(0, callIndex), candidate.parameters)
			: candidate,
	);
	for (const [index, target] of targets.entries()) {
		const attributes: Record<string, CoreAttributeValue> = {
			...call.attributes,
			directFunctionIndex: target,
			[CORE_FINITE_DISPATCH_TARGET_ATTRIBUTE]: target,
		};
		delete attributes[CORE_CALLEE_TARGETS_ATTRIBUTE];
		blocks.push({
			id: directBlock(index),
			parameters: [],
			instructions: [
				{
					...call,
					id: controls[index]!.directCall,
					outputs: [directOutputs[index]!],
					attributes,
					effectRefinement: undefined,
				},
			],
			terminator: {
				id: controls[index]!.directTerminator,
				kind: "jump",
				edge: { block: joinBlock, arguments: [directOutputs[index]!] },
			},
			...handler,
		});
		if (index + 1 < targets.length) blocks.push(guardedBlock(index + 1));
	}
	blocks.push(
		{
			id: fallbackBlock,
			parameters: [],
			instructions: [fallbackCall],
			terminator: {
				id: fallbackTerminator,
				kind: "jump",
				edge: { block: joinBlock, arguments: [fallbackOutput] },
			},
			...handler,
		},
		{
			id: joinBlock,
			parameters: [
				{
					value: originalOutput,
					representation: output.representation,
					role: "value",
				},
			],
			instructions: block.instructions.slice(callIndex + 1),
			terminator: block.terminator,
			...handler,
		},
	);
	const values = fn.values
		.map((value) =>
			value.id === originalOutput
				? {
						...value,
						definition: {
							kind: "block-parameter" as const,
							block: joinBlock,
							index: 0,
						},
					}
				: value,
		)
		.concat([
			{
				id: fallbackOutput,
				representation: output.representation,
				definition: {
					kind: "instruction" as const,
					instruction: call.id,
					index: 0,
				},
			},
			...directOutputs.map((value, index) => ({
				id: value,
				representation: output.representation,
				definition: {
					kind: "instruction" as const,
					instruction: controls[index]!.directCall,
					index: 0,
				},
			})),
			...guardValues.map((value, index) => ({
				id: value,
				representation: "boolean" as const,
				definition: {
					kind: "instruction" as const,
					instruction: controls[index]!.guard,
					index: 0,
				},
			})),
		]);
	return { ...fn, blocks, values, mutationEpoch: fn.mutationEpoch + 1 };
}

/** Generic twins already protected by a function-index guard in this graph. */
function guardedInlineFallbackCalls(fn: CoreFunction): ReadonlySet<CoreInstructionId> {
	const definitions = functionDefinitions(fn);
	const calls = new Set<CoreInstructionId>();
	for (const block of fn.blocks) {
		if (block.terminator.kind !== "branch") continue;
		const guard = definitions.get(block.terminator.condition);
		if (guard?.opcode !== "guardFunctionIndex") continue;
		const fallback = fn.blocks[block.terminator.alternate.block];
		if (
			fallback?.instructions.length === 1 &&
			fallback.instructions[0]!.opcode === "call" &&
			fallback.terminator.kind === "jump"
		) {
			calls.add(fallback.instructions[0]!.id);
		}
	}
	return calls;
}

/**
 * Replace a call with callee bodies from its bounded target fact.
 *
 * A closed singleton erases the call. Inlinable open targets use guarded bodies;
 * a small residual set in a natural loop instead guards direct calls and retains
 * the generic mismatch twin. Target identity still comes from the whole-program
 * lattice: a local scan cannot know that a nested closure rebinds a captured cell.
 */
function inlineSimpleCoreFunctions(
	program: CoreProgram,
	verification: CoreVerificationProfile,
	context: CoreCompilationContext | undefined,
): InlineProgramResult {
	const decisions =
		context?.optimizationDecisions === undefined
			? undefined
			: [...context.optimizationDecisions];
	const positions = program.sourcePositions.map((position) => ({
		...position,
	}));
	const calleeTargets = analyzeCoreCalleeTargets(program, coreOpcodeRegistry, context);
	const functionsByIndex = new Map(
		program.functions.map((fn) => [fn.functionIndex, fn] as const),
	);
	let changed = false;
	const functions = program.functions.map((original) => {
		let fn = original;
		let totalCost = 0;
		const relocatedTargets = new Map<CoreValueId, CoreCalleeTargets>();
		const guardedFallbacks = new Set(guardedInlineFallbackCalls(original));
		const targetsForValue = (value: CoreValueId): CoreCalleeTargets =>
			relocatedTargets.get(value) ?? calleeTargets.targets(original.functionIndex, value);
		// Inline admission bounds emitted statements; compile score also charges
		// optimizer work that does not survive into the cloned fast path.
		for (let expansion = 0; expansion < MAX_INLINE_TOTAL_COST; expansion++) {
			let next: CoreFunction | undefined;
			let loopBlocks: ReadonlySet<CoreBlockId> | undefined;
			for (const block of fn.blocks) {
				for (const call of block.instructions) {
					if (
						call.opcode !== "call" ||
						call.inputs.length < 2 ||
						guardedFallbacks.has(call.id) ||
						typeof call.attributes[CORE_FINITE_DISPATCH_TARGET_ATTRIBUTE] === "number"
					) {
						continue;
					}
					const targets = targetsForValue(call.inputs[0]!);
					const closedTargetIndex = coreCalleeTargetsClosedFunction(targets);
					const targetIndices =
						closedTargetIndex === undefined ? targets.functions : [closedTargetIndex];
					if (
						targetIndices.length === 0 ||
						targetIndices.some((targetIndex) => targetIndex === fn.functionIndex)
					) {
						continue;
					}
					const candidates: Array<GuardedInlineCandidate> = [];
					let declineReason: OptimizationDecisionReason | undefined;
					for (const targetIndex of targetIndices) {
						const target = functionsByIndex.get(targetIndex);
						if (target === undefined) {
							declineReason = "relocation";
							break;
						}
						const linear = linearInlineTarget(target);
						if (linear === undefined) {
							declineReason = targetShapeDeclineReason(target);
							break;
						}
						candidates.push({ target, linear });
					}
					const guarded = closedTargetIndex === undefined || candidates.length > 1;
					const guardedOverhead =
						guarded && declineReason === undefined
							? coreGeneratedCodeOverheadCost({
									guards: candidates.length,
									genericTwins: 1,
								})
							: undefined;
					const codeCost =
						declineReason === undefined
							? candidates.reduce(
									(total, { linear }) =>
										total + linear.generatedCost.estimatedCStatements,
									guardedOverhead?.estimatedCStatements ?? 0,
								)
							: Number.POSITIVE_INFINITY;
					const inlineAdmitted =
						declineReason === undefined &&
						(!guarded || codeCost <= MAX_GUARDED_INLINE_STATEMENTS) &&
						totalCost + codeCost <= MAX_INLINE_TOTAL_COST;
					const inlined = !inlineAdmitted
						? undefined
						: guarded
							? (() => {
									const result = inlineGuardedLinearCalls(
										fn,
										block,
										call,
										candidates,
										positions,
										calleeTargets,
										targetsForValue,
									);
									if (result !== undefined) {
										guardedFallbacks.add(result.fallbackCall);
									}
									return result;
								})()
							: inlineLinearCall(
									fn,
									block,
									call,
									candidates[0]!.target,
									candidates[0]!.linear,
									positions,
									calleeTargets,
									targetsForValue,
								);
					if (inlined !== undefined) {
						next = inlined.fn;
						totalCost += codeCost;
						for (const [value, targets] of inlined.relocatedTargets) {
							relocatedTargets.set(value, targets);
						}
						recordCallOptimizationDecision(decisions, fn, call, "applied", "inline");
					} else if (closedTargetIndex === undefined) {
						loopBlocks ??= new Set(
							buildCoreControlFlow(fn, coreOpcodeRegistry).loops.flatMap((loop) => [
								...loop.blocks,
							]),
						);
						const dispatchCost = coreGeneratedCodeOverheadCost({
							guards: targetIndices.length,
							duplicatedInstructions: targetIndices.length,
							genericTwins: 1,
						}).compileScore;
						if (
							loopBlocks.has(block.id) &&
							targetIndices.length <= MAX_FINITE_DISPATCH_TARGETS &&
							dispatchCost <= MAX_FINITE_DISPATCH_COST &&
							totalCost + dispatchCost <= MAX_INLINE_TOTAL_COST
						) {
							next = dispatchFiniteDirectCalls(fn, block, call, targetIndices);
							if (next !== undefined) {
								guardedFallbacks.add(call.id);
								totalCost += dispatchCost;
								recordCallOptimizationDecision(
									decisions,
									fn,
									call,
									"applied",
									"finite-dispatch",
								);
							}
						}
					}
					if (next === undefined) {
						recordCallOptimizationDecision(
							decisions,
							fn,
							call,
							"declined",
							declineReason ?? "expansion-limit",
						);
						continue;
					} else if (verification === "per-pass") {
						verifyCoreFunction(next, coreOpcodeRegistry, {
							stage: "normalization",
							pass:
								inlined === undefined
									? "dispatch-finite-call-targets"
									: "inline-small-functions",
						});
					}
					break;
				}
				if (next !== undefined) break;
			}
			if (next === undefined) break;
			fn = next;
			changed = true;
		}
		return fn;
	});
	return {
		program: {
			...program,
			functions,
			sourcePositions: positions,
		},
		...(context === undefined
			? {}
			: {
					context:
						decisions === undefined
							? context
							: { ...context, optimizationDecisions: decisions },
				}),
		changed,
	};
}

function coreInstructionBlock(
	fn: CoreFunction,
	instructionId: CoreInstructionId,
): CoreBlockId | undefined {
	return fn.blocks.find((block) =>
		[...block.instructions, block.terminator].some(({ id }) => id === instructionId),
	)?.id;
}

type CoreAggregateCellContent = "uninitialized" | "i32" | "f64" | "boolean" | "boxed";

interface CoreStackObjectRegionSelection {
	readonly region: CoreFunction["regions"][number];
	readonly accesses: ReadonlyArray<{
		readonly instruction: CoreInstruction;
		readonly slot: number;
	}>;
	readonly slotContents: ReadonlyArray<CoreAggregateCellContent>;
}

function aggregateCellContent(
	representation: CoreRepresentation | undefined,
): CoreAggregateCellContent {
	return representation === "i32" ||
		representation === "f64" ||
		representation === "boolean"
		? representation
		: "boxed";
}

function joinAggregateCellContent(
	left: CoreAggregateCellContent,
	right: CoreAggregateCellContent,
): CoreAggregateCellContent {
	if (left === "uninitialized") return right;
	if (right === "uninitialized" || left === right) return left;
	return "boxed";
}

function stackObjectRegion(
	fn: CoreFunction,
	allocation: CoreInstruction,
	analyses: CoreAnalysisManager,
	_program: CoreProgram,
): CoreStackObjectRegionSelection | undefined {
	if (allocation.opcode !== "createObjectShaped" || allocation.outputs.length !== 1) {
		return undefined;
	}
	const keyStringIndices = allocation.attributes.keyStringIndices;
	if (
		!Array.isArray(keyStringIndices) ||
		!keyStringIndices.every((index) => typeof index === "number") ||
		new Set(keyStringIndices).size !== keyStringIndices.length
	) {
		return undefined;
	}
	const slotByStringIndex = new Map(
		keyStringIndices.map((stringIndex, slot) => [stringIndex, slot] as const),
	);
	const cfg = analyses.controlFlow(fn);
	const aliases = new Set<CoreValueId>([allocation.outputs[0]!]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					instruction.opcode === "move" &&
					instruction.inputs.length === 1 &&
					aliases.has(instruction.inputs[0]!) &&
					instruction.outputs.length === 1 &&
					!aliases.has(instruction.outputs[0]!)
				) {
					aliases.add(instruction.outputs[0]!);
					changed = true;
				}
			}
			const incoming = cfg.predecessors[block.id]!.filter(
				(edge) => edge.kind === "ordinary",
			);
			for (const [index, parameter] of block.parameters.entries()) {
				if (
					incoming.length > 0 &&
					incoming.every((edge) => {
						const argument = edge.arguments[index];
						return argument !== undefined && aliases.has(argument);
					}) &&
					!aliases.has(parameter.value)
				) {
					aliases.add(parameter.value);
					changed = true;
				}
			}
		}
	}
	// An alias that enters a block parameter alongside any non-alias value no
	// longer has an exact stack-object identity after the join. Treat that edge
	// as an escape. Otherwise a later return of the mixed parameter can bypass
	// materialization and leak the activation-local object into its caller.
	for (const block of fn.blocks) {
		const incoming = cfg.predecessors[block.id]!.filter(
			(edge) => edge.kind === "ordinary",
		);
		for (const [index, parameter] of block.parameters.entries()) {
			if (
				!aliases.has(parameter.value) &&
				incoming.some((edge) => {
					const argument = edge.arguments[index];
					return argument !== undefined && aliases.has(argument);
				})
			) {
				return undefined;
			}
		}
	}

	const accesses: Array<{
		readonly instruction: CoreInstruction;
		readonly slot: number;
	}> = [];
	let inheritedAccess: CoreInstruction | undefined;
	let hasOwnStore = false;
	const materializations: Array<CoreTerminator & { readonly kind: "return" }> = [];
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			for (const [position, input] of instruction.inputs.entries()) {
				if (!aliases.has(input)) continue;
				if (instruction.opcode === "move" && position === 0) continue;
				if (instruction.opcode === "throwIfTdz" && position === 0) continue;
				if (
					(instruction.opcode === "loadPropertyStatic" ||
						instruction.opcode === "storePropertyStatic") &&
					position === 0
				) {
					const stringIndex = instruction.attributes.stringIndex;
					const slot =
						typeof stringIndex === "number"
							? slotByStringIndex.get(stringIndex)
							: undefined;
					if (slot === undefined) {
						if (
							instruction.opcode !== "loadPropertyStatic" ||
							inheritedAccess !== undefined
						) {
							return undefined;
						}
						inheritedAccess = instruction;
						continue;
					}
					accesses.push({ instruction, slot });
					hasOwnStore ||= instruction.opcode === "storePropertyStatic";
					continue;
				}
				if (
					instruction.opcode === "binary" &&
					(instruction.attributes.operator === "===" ||
						instruction.attributes.operator === "!==")
				) {
					continue;
				}
				if (
					(instruction.opcode === "loadPrototype" ||
						instruction.opcode === "typeofCompare" ||
						(instruction.opcode === "unary" &&
							instruction.attributes.operator === "typeof")) &&
					position === 0
				) {
					continue;
				}
				return undefined;
			}
		}
		if (block.handler?.arguments.some((value) => aliases.has(value)) === true) {
			return undefined;
		}
		const terminator = block.terminator;
		if (terminator.kind === "return" && aliases.has(terminator.value)) {
			materializations.push(terminator);
		} else if (
			(terminator.kind === "throw" && aliases.has(terminator.value)) ||
			((terminator.kind === "branch" || terminator.kind === "guard") &&
				aliases.has(terminator.condition)) ||
			(terminator.kind === "switch" && aliases.has(terminator.discriminant))
		) {
			return undefined;
		}
	}

	let inheritedGuard: ReturnType<typeof compilerGuardPlan>;
	if (inheritedAccess !== undefined) {
		if (materializations.length > 0 || hasOwnStore || accesses.length === 0) {
			return undefined;
		}
		const allocationLocation = fn.blocks
			.flatMap((block) =>
				block.instructions.map((instruction, index) => ({
					block,
					instruction,
					index,
				})),
			)
			.find(({ instruction }) => instruction === allocation);
		const inheritedLocation = fn.blocks
			.flatMap((block) =>
				block.instructions.map((instruction, index) => ({
					block,
					instruction,
					index,
				})),
			)
			.find(({ instruction }) => instruction === inheritedAccess);
		if (
			allocationLocation === undefined ||
			inheritedLocation === undefined ||
			allocationLocation.block !== inheritedLocation.block ||
			allocationLocation.index >= inheritedLocation.index
		) {
			return undefined;
		}
		for (const instruction of allocationLocation.block.instructions.slice(
			allocationLocation.index + 1,
			inheritedLocation.index,
		)) {
			const strictIdentity =
				instruction.opcode === "binary" &&
				(instruction.attributes.operator === "===" ||
					instruction.attributes.operator === "!==");
			const directOwnAccess = accesses.some(
				(access) => access.instruction === instruction,
			);
			const effects = coreOpcodeRegistry.require(instruction.opcode).effects;
			if (
				!strictIdentity &&
				!directOwnAccess &&
				(effects.mayGc || effects.maySuspend || effects.callsUserCode)
			) {
				return undefined;
			}
		}
		inheritedGuard = compilerGuardPlan(
			[analyses.context?.facts.protectors.get("primitive-methods")],
			[
				{
					kind: "fallback",
					id: `stack-object:${fn.functionIndex}:${allocation.id}`,
					cause: "escape",
				},
				{
					kind: "materialize",
					id: `stack-object-inherited:${fn.functionIndex}:${allocation.id}`,
					cause: "escape",
				},
			],
		);
		if (inheritedGuard === undefined) return undefined;
	}

	const claimedInstructions = [
		allocation.id,
		...accesses.map(({ instruction }) => instruction.id),
		...(inheritedAccess === undefined ? [] : [inheritedAccess.id]),
		...materializations.map(({ id }) => id),
	];
	if (new Set(claimedInstructions).size !== claimedInstructions.length) return undefined;
	const ordinaryBlocks = [
		...new Set(
			claimedInstructions.flatMap((instruction) => {
				const block = coreInstructionBlock(fn, instruction);
				return block === undefined ? [] : [block];
			}),
		),
	];
	if (ordinaryBlocks.length === 0) return undefined;
	const materializeObligations = materializations.map(({ id }) => ({
		kind: "materialize" as const,
		id: `stack-object-return:${fn.functionIndex}:${id}`,
		cause: "escape" as const,
	}));
	const materializes = inheritedAccess !== undefined || materializations.length > 0;
	const slotContents = keyStringIndices.map<CoreAggregateCellContent>(
		() => "uninitialized",
	);
	const representations = analyses.representations(fn);
	for (const [slot, initial] of allocation.inputs.entries()) {
		if (slot >= slotContents.length) break;
		slotContents[slot] = joinAggregateCellContent(
			slotContents[slot]!,
			aggregateCellContent(representations.get(initial)),
		);
	}
	for (const access of accesses) {
		if (access.instruction.opcode !== "storePropertyStatic") continue;
		const value = access.instruction.inputs[1];
		slotContents[access.slot] = joinAggregateCellContent(
			slotContents[access.slot]!,
			aggregateCellContent(value === undefined ? undefined : representations.get(value)),
		);
	}
	if (materializes) slotContents.fill("boxed");
	return {
		accesses,
		slotContents,
		region: {
			kind: "stack-object-plan",
			anchors: [allocation.id],
			claimedInstructions,
			ordinaryBlocks,
			exceptionalBlocks: [],
			data: coreAttributeObject(
				{
					license: {
						guard: inheritedGuard ?? {
							dependencies: [],
							obligations: [
								{
									kind: "fallback",
									id: `stack-object:${fn.functionIndex}:${allocation.id}`,
									cause: "escape",
								},
								...materializeObligations,
							],
						},
						genericTwin: "retained",
						materialization: materializes ? "on-demand" : "none",
					},
					representation: "activation-local-fixed-shape-objects",
					cost: {
						score: Math.max(1, keyStringIndices.length),
						metadataOperations: claimedInstructions.length,
					},
					sites: [
						{
							allocation: { $coreInstruction: allocation.id },
							slotCount: keyStringIndices.length,
							accesses: accesses.map(({ instruction, slot }) => ({
								instruction: { $coreInstruction: instruction.id },
								slot,
							})),
							...(inheritedAccess === undefined
								? {}
								: {
										inheritedAccess: {
											$coreInstruction: inheritedAccess.id,
										},
									}),
							materializations: materializations.map(({ id }) => ({
								instruction: { $coreInstruction: id },
								kind: "return",
							})),
						},
					],
				},
				"stack-object-plan",
			),
		},
	};
}

// A one-cell stack object exposes its scalar payload to the summary solver.
const refineStackObjectCellRepresentations: CoreFunctionPass = {
	name: "refine-stack-object-cell-representations",
	ablation: "escape",
	run(fn, analyses, program) {
		const refinements = new Map<CoreValueId, CoreRepresentation>();
		for (const block of fn.blocks) {
			for (const allocation of block.instructions) {
				if (allocation.opcode !== "createObjectShaped") continue;
				const selection = stackObjectRegion(fn, allocation, analyses, program);
				if (selection === undefined || selection.slotContents.length !== 1) continue;
				const content = selection.slotContents[0];
				if (content !== "i32" && content !== "f64" && content !== "boolean") {
					continue;
				}
				for (const access of selection.accesses) {
					if (access.instruction.opcode !== "loadPropertyStatic") continue;
					const output = access.instruction.outputs[0];
					if (output !== undefined) refinements.set(output, content);
				}
			}
		}
		if (refinements.size === 0) return fn;
		let changed = false;
		const values = fn.values.map((value) => {
			const representation = refinements.get(value.id);
			if (representation === undefined || representation === value.representation) {
				return value;
			}
			if (
				value.representation !== "boxed" &&
				!(value.representation === "f64" && representation === "i32")
			) {
				return value;
			}
			changed = true;
			return { ...value, representation };
		});
		return changed ? { ...fn, values, mutationEpoch: fn.mutationEpoch + 1 } : fn;
	},
};

const selectStackObjectRegions: CoreFunctionPass = {
	name: "select-stack-object-regions",
	ablation: "escape",
	run(fn, analyses, program) {
		const existingAllocations = new Set(
			fn.regions
				.filter(({ kind }) => kind === "stack-object-plan")
				.flatMap(({ anchors }) => anchors),
		);
		const regions = [...fn.regions];
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					instruction.opcode !== "createObjectShaped" ||
					existingAllocations.has(instruction.id)
				) {
					continue;
				}
				const selection = stackObjectRegion(fn, instruction, analyses, program);
				if (selection !== undefined) regions.push(selection.region);
			}
		}
		return regions.length === fn.regions.length
			? fn
			: { ...fn, regions, mutationEpoch: fn.mutationEpoch + 1 };
	},
};

const MAX_FRESH_DENSE_INDEXED_RESERVE = 65_536;
const FRESH_DENSE_NUMERIC_OPERATORS = new Set([
	"+",
	"-",
	"*",
	"/",
	"%",
	"**",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
]);

function coreBlockParameters(
	fn: CoreFunction,
): ReadonlyMap<CoreValueId, { readonly block: CoreBlockId; readonly index: number }> {
	const result = new Map<
		CoreValueId,
		{ readonly block: CoreBlockId; readonly index: number }
	>();
	for (const block of fn.blocks) {
		for (const [index, parameter] of block.parameters.entries()) {
			result.set(parameter.value, { block: block.id, index });
		}
	}
	return result;
}

function exactIntegerValue(
	value: CoreValueId,
	definitions: ReadonlyMap<CoreValueId, CoreInstruction>,
): number | undefined {
	const seen = new Set<CoreValueId>();
	let current = value;
	while (!seen.has(current)) {
		seen.add(current);
		const definition = definitions.get(current);
		if (definition === undefined) return undefined;
		if (definition.opcode === "move" && definition.inputs.length === 1) {
			current = definition.inputs[0]!;
			continue;
		}
		if (definition.opcode !== "createNumber") return undefined;
		const number = definition.attributes.value;
		return typeof number === "number" && Number.isSafeInteger(number)
			? number
			: undefined;
	}
	return undefined;
}

/**
 * Prove a canonical exact fresh-Array indexed-fill loop and move only its
 * geometric storage allocation to the allocation site. The original stores,
 * checks, polls, and fallback behavior remain intact.
 */
const annotateFreshDenseIndexedReserves: CoreFunctionPass = {
	name: "annotate-fresh-dense-indexed-reserves",
	run(fn, analyses) {
		if (fn.isGenerator || fn.isAsync) return fn;
		const cfg = analyses.controlFlow(fn);
		const canonicalValues = coreCanonicalValueRoots(fn, cfg);
		const definitions = analyses.definitions(fn);
		const exactInteger = (value: CoreValueId): number | undefined =>
			exactIntegerValue(canonicalValues.get(value) ?? value, definitions);
		const parameters = coreBlockParameters(fn);
		const locations = new Map<
			CoreInstructionId,
			{ readonly block: CoreBlockId; readonly index: number }
		>();
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				locations.set(instruction.id, { block: block.id, index });
			}
		}

		const reserveLengths = new Map<CoreInstructionId, number>();
		for (const block of fn.blocks) {
			for (const allocation of block.instructions) {
				if (
					allocation.opcode !== "createArray" ||
					allocation.outputs.length !== 1 ||
					allocation.attributes.length !== 0 ||
					allocation.attributes.freshDenseReserveLength !== undefined
				) {
					continue;
				}
				const allocationValue = allocation.outputs[0]!;
				const allocationLocation = locations.get(allocation.id)!;
				const aliasMemo = new Map<CoreValueId, boolean>();
				const aliasVisiting = new Set<CoreValueId>();
				const isAllocationAlias = (value: CoreValueId): boolean => {
					if (value === allocationValue) return true;
					const memo = aliasMemo.get(value);
					if (memo !== undefined) return memo;
					if (aliasVisiting.has(value)) return true;
					aliasVisiting.add(value);
					const definition = definitions.get(value);
					const parameter = parameters.get(value);
					let result = false;
					if (definition?.opcode === "move" && definition.inputs.length === 1) {
						result = isAllocationAlias(definition.inputs[0]!);
					} else if (parameter !== undefined) {
						const incoming = cfg.predecessors[parameter.block]!.filter(
							(edge) => edge.kind === "ordinary",
						);
						result =
							incoming.length > 0 &&
							incoming.every((edge) => {
								const argument = edge.arguments[parameter.index];
								return argument !== undefined && isAllocationAlias(argument);
							});
					}
					aliasVisiting.delete(value);
					aliasMemo.set(value, result);
					return result;
				};

				for (const loop of cfg.loops) {
					if (
						!loop.canonical ||
						loop.blocks.size !== 3 ||
						loop.latches.size !== 1 ||
						loop.blocks.has(block.id) ||
						!cfg.dominates(block.id, loop.header)
					) {
						continue;
					}
					const header = fn.blocks[loop.header]!;
					const backedgeBlock = [...loop.latches][0]!;
					const backedge = cfg.predecessors[loop.header]!.find(
						(edge) => edge.kind === "ordinary" && edge.from === backedgeBlock,
					);
					const entryEdges = cfg.predecessors[loop.header]!.filter(
						(edge) => edge.kind === "ordinary" && edge.from !== backedgeBlock,
					);
					if (backedge === undefined || entryEdges.length !== 1) continue;
					const entryEdge = entryEdges[0]!;
					if (
						entryEdge.from !== block.id &&
						(loop.preheader !== entryEdge.from ||
							!cfg.dominates(block.id, entryEdge.from))
					) {
						continue;
					}
					if (header.terminator.kind !== "branch") continue;
					const comparison = definitions.get(header.terminator.condition);
					if (
						comparison?.opcode !== "binary" ||
						comparison.attributes.operator !== "<" ||
						comparison.inputs.length !== 2
					) {
						continue;
					}
					const counter = comparison.inputs[0]!;
					const counterParameterIndex = header.parameters.findIndex(
						(parameter) => parameter.value === counter,
					);
					const bound = exactInteger(comparison.inputs[1]!);
					if (
						counterParameterIndex < 0 ||
						bound === undefined ||
						bound <= 0 ||
						bound > MAX_FRESH_DENSE_INDEXED_RESERVE ||
						exactInteger(entryEdge.arguments[counterParameterIndex]!) !== 0
					) {
						continue;
					}
					const bodyEdge = header.terminator.consequent;
					const exitEdge = header.terminator.alternate;
					// CFG cleanup may make the exit the next loop's header, whose backedge is
					// another predecessor; dominance still proves every later array use follows fill.
					if (!loop.blocks.has(bodyEdge.block) || loop.blocks.has(exitEdge.block)) {
						continue;
					}

					const counterFamily = new Set<CoreValueId>([counter]);
					let familyChanged = true;
					while (familyChanged) {
						familyChanged = false;
						for (const candidate of fn.blocks) {
							const incoming = cfg.predecessors[candidate.id]!.filter(
								(edge) => edge.kind === "ordinary",
							);
							for (const [index, parameter] of candidate.parameters.entries()) {
								if (
									!counterFamily.has(parameter.value) &&
									incoming.length > 0 &&
									incoming.every((edge) => {
										const argument = edge.arguments[index];
										return argument !== undefined && counterFamily.has(argument);
									})
								) {
									counterFamily.add(parameter.value);
									familyChanged = true;
								}
							}
						}
					}
					for (const [index, argument] of bodyEdge.arguments.entries()) {
						if (argument !== counter) continue;
						const parameter = fn.blocks[bodyEdge.block]!.parameters[index];
						if (parameter !== undefined) counterFamily.add(parameter.value);
					}

					const increment = definitions.get(backedge.arguments[counterParameterIndex]!);
					if (
						increment?.opcode !== "unary" ||
						increment.attributes.operator !== "increment" ||
						increment.inputs.length !== 1
					) {
						continue;
					}
					const numericSource = definitions.get(increment.inputs[0]!);
					const incrementInput =
						numericSource?.opcode === "unary" &&
						numericSource.attributes.operator === "tonumeric" &&
						numericSource.inputs.length === 1
							? numericSource.inputs[0]!
							: increment.inputs[0]!;
					if (!counterFamily.has(incrementInput)) continue;

					const stores = fn.blocks
						.filter((candidate) => loop.blocks.has(candidate.id))
						.flatMap((candidate) => candidate.instructions)
						.filter(
							(instruction) =>
								instruction.opcode === "storeProperty" &&
								instruction.inputs.length === 3 &&
								isAllocationAlias(instruction.inputs[0]!),
						);
					if (stores.length !== 1) continue;
					const store = stores[0]!;
					if (!counterFamily.has(store.inputs[1]!)) continue;

					const numericMemo = new Map<CoreValueId, boolean>();
					const proveNumeric = (value: CoreValueId): boolean => {
						if (counterFamily.has(value)) return true;
						const memo = numericMemo.get(value);
						if (memo !== undefined) return memo;
						numericMemo.set(value, false);
						const definition = definitions.get(value);
						if (definition === undefined) return false;
						let proven = false;
						if (definition.opcode === "createNumber") {
							proven = true;
						} else if (definition.opcode === "move" && definition.inputs.length === 1) {
							proven = proveNumeric(definition.inputs[0]!);
						} else if (
							definition.opcode === "unary" &&
							typeof definition.attributes.operator === "string" &&
							["+", "-", "~", "tonumeric"].includes(definition.attributes.operator) &&
							definition.inputs.length === 1
						) {
							proven = proveNumeric(definition.inputs[0]!);
						} else if (
							definition.opcode === "binary" &&
							typeof definition.attributes.operator === "string" &&
							FRESH_DENSE_NUMERIC_OPERATORS.has(definition.attributes.operator) &&
							definition.inputs.length === 2
						) {
							proven =
								proveNumeric(definition.inputs[0]!) &&
								proveNumeric(definition.inputs[1]!);
						}
						numericMemo.set(value, proven);
						return proven;
					};
					if (!proveNumeric(store.inputs[2]!)) continue;

					let safe = true;
					for (const candidate of fn.blocks) {
						for (const instruction of candidate.instructions) {
							for (const [position, input] of instruction.inputs.entries()) {
								if (!isAllocationAlias(input)) continue;
								if (
									(instruction.opcode === "move" && position === 0) ||
									(instruction.opcode === "throwIfTdz" && position === 0) ||
									(instruction === store && position === 0) ||
									cfg.dominates(exitEdge.block, candidate.id)
								) {
									continue;
								}
								safe = false;
							}
						}
					}
					if (!safe) continue;
					const allocationBlock = fn.blocks[allocationLocation.block]!;
					if (
						allocationBlock.instructions
							.slice(allocationLocation.index + 1)
							.some(
								(instruction) =>
									instruction.opcode !== "createNumber" && instruction.opcode !== "move",
							)
					) {
						continue;
					}
					reserveLengths.set(allocation.id, bound);
					break;
				}
			}
		}
		if (reserveLengths.size === 0) return fn;
		return {
			...fn,
			blocks: fn.blocks.map((block) => ({
				...block,
				instructions: block.instructions.map((instruction) => {
					const length = reserveLengths.get(instruction.id);
					return length === undefined
						? instruction
						: {
								...instruction,
								attributes: {
									...instruction.attributes,
									freshDenseReserveLength: length,
								},
							};
				}),
			})),
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

const NATIVE_NUMERIC_FUSION_OPERATORS = new Set([
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
const NATIVE_NUMERIC_FUSION_FINISH_OPERATORS = new Set([
	...NATIVE_NUMERIC_FUSION_OPERATORS,
	"<",
	"<=",
	">",
	">=",
	"==",
	"!=",
	"===",
	"!==",
]);

const INDEXED_LENGTH_LOOP_OPERATORS = new Set([
	"<",
	"<=",
	">",
	">=",
	"==",
	"!=",
	"===",
	"!==",
]);

const selectIndexedLengthLoopRegions: CoreFunctionPass = {
	name: "select-indexed-length-loop-regions",
	run(fn, analyses, program) {
		if (fn.isGenerator || fn.isAsync) return fn;
		const hasCandidate = fn.blocks.some(({ instructions }) =>
			instructions.some((load, index) => {
				const comparison = instructions[index + 1];
				return (
					load.opcode === "loadPropertyStatic" &&
					typeof load.attributes.stringIndex === "number" &&
					decodeString(program, load.attributes.stringIndex) === "length" &&
					comparison?.opcode === "binary" &&
					typeof comparison.attributes.operator === "string" &&
					INDEXED_LENGTH_LOOP_OPERATORS.has(comparison.attributes.operator) &&
					comparison.inputs.includes(load.outputs[0]!)
				);
			}),
		);
		if (!hasCandidate) return fn;
		const cfg = analyses.controlFlow(fn);
		const occupied = new Set(
			fn.regions.flatMap(({ claimedInstructions }) => claimedInstructions),
		);
		const uses = new Map<
			CoreValueId,
			Array<{ readonly instruction: CoreInstruction; readonly position: number }>
		>();
		const nonInstructionUses = new Set<CoreValueId>();
		const representations = new Map(
			fn.values.map(({ id, representation }) => [id, representation]),
		);
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				for (const [position, input] of instruction.inputs.entries()) {
					const entries = uses.get(input) ?? [];
					entries.push({ instruction, position });
					uses.set(input, entries);
				}
			}
			if (block.handler !== undefined) {
				for (const value of block.handler.arguments) nonInstructionUses.add(value);
			}
			for (const edge of coreTerminatorEdges(block.terminator)) {
				for (const value of edge.arguments) nonInstructionUses.add(value);
			}
			switch (block.terminator.kind) {
				case "branch":
				case "guard":
					nonInstructionUses.add(block.terminator.condition);
					break;
				case "switch":
					nonInstructionUses.add(block.terminator.discriminant);
					break;
				case "return":
				case "throw":
					nonInstructionUses.add(block.terminator.value);
					break;
				case "jump":
				case "unreachable":
					break;
			}
		}

		const sites: Array<{
			readonly load: CoreInstruction;
			readonly comparison: CoreInstruction;
			readonly lengthPosition: 1 | 2;
			readonly elements: ReadonlyArray<{
				readonly instruction: CoreInstruction;
				readonly kind: "load" | "store";
				readonly block: CoreBlockId;
			}>;
			readonly block: CoreBlockId;
		}> = [];
		for (const block of fn.blocks) {
			const loop = cfg.loops
				.filter((candidate) => candidate.blocks.has(block.id))
				.toSorted((left, right) => left.blocks.size - right.blocks.size)[0];
			if (loop === undefined) continue;
			for (let index = 0; index + 1 < block.instructions.length; index++) {
				const load = block.instructions[index]!;
				const comparison = block.instructions[index + 1]!;
				const lengthPosition =
					comparison.inputs[0] === load.outputs[0]
						? 1
						: comparison.inputs[1] === load.outputs[0]
							? 2
							: undefined;
				const otherPosition = lengthPosition === 1 ? 1 : 0;
				if (
					load.opcode !== "loadPropertyStatic" ||
					load.inputs.length !== 1 ||
					load.outputs.length !== 1 ||
					load.attributes[CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE] === true ||
					load.attributes.primitiveStringLength === true ||
					typeof load.attributes.stringIndex !== "number" ||
					decodeString(program, load.attributes.stringIndex) !== "length" ||
					comparison.opcode !== "binary" ||
					typeof comparison.attributes.operator !== "string" ||
					!INDEXED_LENGTH_LOOP_OPERATORS.has(comparison.attributes.operator) ||
					comparison.inputs.length !== 2 ||
					comparison.outputs.length !== 1 ||
					lengthPosition === undefined ||
					(representations.get(comparison.inputs[otherPosition]!) !== "i32" &&
						representations.get(comparison.inputs[otherPosition]!) !== "f64") ||
					occupied.has(load.id) ||
					occupied.has(comparison.id)
				) {
					continue;
				}
				const output = load.outputs[0]!;
				const outputUses = uses.get(output) ?? [];
				if (
					nonInstructionUses.has(output) ||
					outputUses.length !== 1 ||
					outputUses[0]!.instruction !== comparison ||
					outputUses[0]!.position !== lengthPosition - 1
				) {
					continue;
				}
				const receiver = load.inputs[0]!;
				const induction = comparison.inputs[otherPosition]!;
				const elements: Array<{
					readonly instruction: CoreInstruction;
					readonly kind: "load" | "store";
					readonly block: CoreBlockId;
				}> = [];
				for (const candidateBlock of fn.blocks) {
					if (
						!loop.blocks.has(candidateBlock.id) ||
						!cfg.dominates(block.id, candidateBlock.id)
					) {
						continue;
					}
					for (const instruction of candidateBlock.instructions) {
						const kind =
							instruction.opcode === "loadProperty"
								? "load"
								: instruction.opcode === "storeProperty"
									? "store"
									: undefined;
						if (
							kind === undefined ||
							instruction.inputs[0] !== receiver ||
							instruction.inputs[1] !== induction ||
							occupied.has(instruction.id) ||
							(candidateBlock.id === block.id && instruction.id <= comparison.id)
						) {
							continue;
						}
						elements.push({ instruction, kind, block: candidateBlock.id });
						if (elements.length >= 8) break;
					}
					if (elements.length >= 8) break;
				}
				sites.push({ load, comparison, lengthPosition, elements, block: block.id });
				occupied.add(load.id);
				occupied.add(comparison.id);
				for (const element of elements) occupied.add(element.instruction.id);
				if (sites.length >= 32) break;
			}
			if (sites.length >= 32) break;
		}
		const first = sites[0];
		if (first === undefined) return fn;
		const claimedInstructions = sites.flatMap(({ load, comparison, elements }) => [
			load.id,
			comparison.id,
			...elements.map(({ instruction }) => instruction.id),
		]);
		const elementCount = sites.reduce((total, site) => total + site.elements.length, 0);
		return {
			...fn,
			regions: [
				...fn.regions,
				{
					kind: "indexed-length-loop",
					anchors: [first.load.id, first.comparison.id],
					claimedInstructions,
					ordinaryBlocks: [
						...new Set(
							sites.flatMap(({ block, elements }) => [
								block,
								...elements.map((element) => element.block),
							]),
						),
					],
					exceptionalBlocks: [],
					data: coreAttributeObject(
						{
							license: {
								guard: "structural",
								genericTwin: "retained",
								materialization: "none",
							},
							representation: "live-indexed-length-loops",
							cost: {
								score: sites.length * 4 + elementCount * 3,
								metadataOperations: claimedInstructions.length,
							},
							runtimeGuard: "array-or-numeric-typed-array",
							sites: sites.map(({ load, comparison, lengthPosition, elements }) => ({
								load: { $coreInstruction: load.id },
								comparison: { $coreInstruction: comparison.id },
								lengthPosition,
								elements: elements.map(({ instruction, kind }) => ({
									instruction: { $coreInstruction: instruction.id },
									kind,
								})),
							})),
						},
						"indexed-length-loop",
					),
				},
			],
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

const selectNumericFusionRegions: CoreFunctionPass = {
	name: "select-numeric-fusion-regions",
	run(fn) {
		if (fn.isGenerator || fn.isAsync) return fn;
		const claimed = new Set(fn.regions.flatMap((region) => region.claimedInstructions));
		const uses = new Map<
			CoreValueId,
			Array<{
				readonly instruction: CoreInstruction;
				readonly position: number;
				readonly block: CoreBlockId;
				readonly index: number;
			}>
		>();
		const nonInstructionUses = new Set<CoreValueId>();
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				for (const [position, input] of instruction.inputs.entries()) {
					const entries = uses.get(input) ?? [];
					entries.push({ instruction, position, block: block.id, index });
					uses.set(input, entries);
				}
			}
			if (block.handler !== undefined) {
				for (const value of block.handler.arguments) nonInstructionUses.add(value);
			}
			for (const edge of coreTerminatorEdges(block.terminator)) {
				for (const value of edge.arguments) nonInstructionUses.add(value);
			}
			switch (block.terminator.kind) {
				case "branch":
				case "guard":
					nonInstructionUses.add(block.terminator.condition);
					break;
				case "switch":
					nonInstructionUses.add(block.terminator.discriminant);
					break;
				case "return":
				case "throw":
					nonInstructionUses.add(block.terminator.value);
					break;
				case "jump":
				case "unreachable":
					break;
			}
		}

		const participating = new Set<CoreInstructionId>();
		const pairs: Array<{
			readonly first: CoreInstruction;
			readonly finish: CoreInstruction;
			readonly firstUsePosition: 1 | 2;
			readonly block: CoreBlockId;
		}> = [];
		for (const block of fn.blocks) {
			for (const [firstIndex, first] of block.instructions.entries()) {
				if (
					first.opcode !== "binary" ||
					typeof first.attributes.operator !== "string" ||
					!NATIVE_NUMERIC_FUSION_OPERATORS.has(first.attributes.operator) ||
					first.outputs.length !== 1 ||
					participating.has(first.id) ||
					claimed.has(first.id)
				) {
					continue;
				}
				const output = first.outputs[0]!;
				const outputUses = uses.get(output);
				if (outputUses?.length !== 1 || nonInstructionUses.has(output)) continue;
				const use = outputUses[0]!;
				const finish = use.instruction;
				if (
					finish.opcode !== "binary" ||
					(use.position !== 0 && use.position !== 1) ||
					typeof finish.attributes.operator !== "string" ||
					!NATIVE_NUMERIC_FUSION_FINISH_OPERATORS.has(finish.attributes.operator) ||
					use.block !== block.id ||
					use.index <= firstIndex ||
					participating.has(finish.id) ||
					claimed.has(finish.id)
				) {
					continue;
				}
				pairs.push({
					first,
					finish,
					firstUsePosition: use.position === 0 ? 1 : 2,
					block: block.id,
				});
				participating.add(first.id);
				participating.add(finish.id);
				if (pairs.length >= 32) break;
			}
			if (pairs.length >= 32) break;
		}
		const firstPair = pairs[0];
		if (firstPair === undefined) return fn;
		const claimedInstructions = pairs.flatMap(({ first, finish }) => [
			first.id,
			finish.id,
		]);
		const region: CoreFunction["regions"][number] = {
			kind: "numeric-fusion",
			anchors: [firstPair.first.id, firstPair.finish.id],
			claimedInstructions,
			ordinaryBlocks: [...new Set(pairs.map(({ block }) => block))],
			exceptionalBlocks: [],
			data: coreAttributeObject(
				{
					license: {
						guard: "structural",
						genericTwin: "retained",
						materialization: "none",
					},
					representation: "binary-pairs-f64",
					composition: "overlay",
					cost: {
						score: pairs.length,
						metadataOperations: claimedInstructions.length,
					},
					runtimeGuard: "number-operands",
					pairs: pairs.map(({ first, finish, firstUsePosition }) => ({
						first: { $coreInstruction: first.id },
						finish: { $coreInstruction: finish.id },
						firstUsePosition,
					})),
				},
				"numeric-fusion",
			),
		};
		return {
			...fn,
			regions: [...fn.regions, region],
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

interface CoreKnownBuiltinProof {
	readonly proof: {
		readonly dependencies: ReadonlyArray<unknown>;
		readonly obligations: ReadonlyArray<unknown>;
	};
	readonly sourceSite?: string;
}

function unknownArray(value: unknown): ReadonlyArray<unknown> | undefined {
	return Array.isArray(value) ? (value as ReadonlyArray<unknown>) : undefined;
}

/**
 * Core stores proofs as opaque attribute values, so implication has to reify them
 * first. An unrecognized world fact or epoch family reifies as itself and simply
 * implies nothing, which is the conservative answer.
 */
function coreFactDependency(value: unknown): FactDependency | undefined {
	const object = attributeObject(value);
	switch (object?.kind) {
		case "world":
			return typeof object.fact === "string"
				? { kind: "world", fact: object.fact as WorldFactId }
				: undefined;
		case "epoch":
			return typeof object.family === "string"
				? { kind: "epoch", family: object.family as SemanticEpochFamily }
				: undefined;
		case "guard":
			return typeof object.id === "string" ? { kind: "guard", id: object.id } : undefined;
		case "summary":
			return typeof object.id === "string"
				? { kind: "summary", id: object.id }
				: undefined;
		default:
			return undefined;
	}
}

function coreFactObligation(value: unknown): FactObligation | undefined {
	const object = attributeObject(value);
	if (typeof object?.id !== "string" || typeof object.cause !== "string")
		return undefined;
	const cause = object.cause as FactObligationCause;
	if (object.kind === "materialize") {
		return { kind: "materialize", id: object.id, cause };
	}
	if (object.kind !== "fallback") return undefined;
	if (object.dischargedBy === undefined) {
		return { kind: "fallback", id: object.id, cause };
	}
	const witness = coreFactDependency(object.dischargedBy);
	return witness === undefined
		? undefined
		: { kind: "fallback", id: object.id, cause, dischargedBy: witness };
}

/**
 * Canonicalize a Core-side requirement pair. Anything that does not reify into
 * the shared vocabulary falls back to a stable dedupe that never discharges,
 * so an unrecognized attribute shape can only cost precision, never soundness.
 */
function normalizeCoreRequirements(
	dependencies: ReadonlyArray<unknown>,
	obligations: ReadonlyArray<unknown>,
): CoreKnownBuiltinProof["proof"] {
	const reifiedDependencies = dependencies
		.map(coreFactDependency)
		.filter((dependency) => dependency !== undefined);
	const reifiedObligations = obligations
		.map(coreFactObligation)
		.filter((obligation) => obligation !== undefined);
	if (
		reifiedDependencies.length === dependencies.length &&
		reifiedObligations.length === obligations.length
	) {
		return normalizeFactRequirements({
			dependencies: reifiedDependencies,
			obligations: reifiedObligations,
		});
	}
	const uniqueDependencies = new Map<string, unknown>();
	const uniqueObligations = new Map<string, unknown>();
	for (const dependency of dependencies) {
		uniqueDependencies.set(stableAttributeValue(dependency), dependency);
	}
	for (const obligation of obligations) {
		uniqueObligations.set(stableAttributeValue(obligation), obligation);
	}
	return {
		dependencies: [...uniqueDependencies.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([, dependency]) => dependency),
		obligations: [...uniqueObligations.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([, obligation]) => obligation),
	};
}

/**
 * Admit a call to a specialized lowering. Admission validates known identity,
 * registry-matching semantics, and a non-empty dependency set — never the
 * presence of a fallback obligation, which is a residual duty and not a token
 * saying the annotation was checked. A site whose authority obligation a locked
 * world has discharged is still a fully proven site.
 */
function coreKnownBuiltinProof(
	instruction: CoreInstruction,
	operation: string,
	options: {
		readonly lowering?: string;
		readonly result?: string;
	} = {},
): CoreKnownBuiltinProof | undefined {
	const descriptor = BUILTIN_OPERATION_BY_ID.get(operation);
	if (descriptor === undefined) return undefined;
	const call = attributeObject(instruction.attributes.knownBuiltinCall);
	if (call?.operation !== operation) return undefined;
	const identity = attributeObject(call.identity);
	const semantics = attributeObject(call.semantics);
	const semanticValue = attributeObject(semantics?.value);
	const identityProof = attributeObject(identity?.proof);
	const semanticsProof = attributeObject(semantics?.proof);
	const identityDependencies = unknownArray(identityProof?.dependencies);
	const identityObligations = unknownArray(identityProof?.obligations);
	const semanticsDependencies = unknownArray(semanticsProof?.dependencies);
	const semanticsObligations = unknownArray(semanticsProof?.obligations);
	const effects = unknownArray(semanticValue?.effects);
	const lowerings = unknownArray(semanticValue?.lowerings);
	if (
		identity?.kind !== "known" ||
		identity.value !== operation ||
		semantics?.kind !== "known" ||
		identityDependencies === undefined ||
		identityObligations === undefined ||
		semanticsDependencies === undefined ||
		semanticsObligations === undefined ||
		identityDependencies.length === 0 ||
		semanticsDependencies.length === 0 ||
		effects === undefined ||
		effects.length !== descriptor.effects.length ||
		effects.some((effect, index) => effect !== descriptor.effects[index]) ||
		semanticValue?.result !== descriptor.result ||
		lowerings === undefined ||
		lowerings.length !== descriptor.lowerings.length ||
		lowerings.some((lowering, index) => lowering !== descriptor.lowerings[index]) ||
		(options.lowering !== undefined && !lowerings.includes(options.lowering)) ||
		(options.result !== undefined && semanticValue?.result !== options.result)
	) {
		return undefined;
	}
	return {
		proof: normalizeCoreRequirements(
			[...identityDependencies, ...semanticsDependencies],
			[...identityObligations, ...semanticsObligations],
		),
		...(typeof call.sourceSite === "string" ? { sourceSite: call.sourceSite } : {}),
	};
}

function coreProofIsWorldInvariant(proof: CoreKnownBuiltinProof["proof"]): boolean {
	return (
		proof.dependencies.length > 0 &&
		proof.dependencies.every(
			(dependency) => attributeObject(dependency)?.kind === "world",
		)
	);
}

/** True when any terminator, edge, or handler argument observes `value`. */
function coreValueUsedByControlFlow(
	fn: CoreFunction,
	root: (value: CoreValueId) => CoreValueId,
	value: CoreValueId,
): boolean {
	const target = root(value);
	const observes = (candidate: CoreValueId): boolean => root(candidate) === target;
	for (const block of fn.blocks) {
		if (block.handler?.arguments.some(observes) === true) return true;
		for (const edge of coreTerminatorEdges(block.terminator)) {
			if (edge.arguments.some(observes)) return true;
		}
		switch (block.terminator.kind) {
			case "branch":
			case "guard":
				if (observes(block.terminator.condition)) return true;
				break;
			case "switch":
				if (observes(block.terminator.discriminant)) return true;
				break;
			case "return":
			case "throw":
				if (observes(block.terminator.value)) return true;
				break;
			case "jump":
			case "unreachable":
				break;
		}
	}
	return false;
}

/**
 * Decide where a region's ordinary property producer runs. `call-fallback` needs
 * three facts, all established here: `locked` says a world-invariant guard pins
 * the method table, so the lookup is a pure read that neither throws nor runs user
 * code; the producer's only consumer is the call's callee operand, so no fast path
 * can observe a skipped load; and both live in one block, so a deferred load keeps
 * the call's handler scope and execution frequency. Distance between the two is
 * irrelevant, and no later stage may re-derive the answer from emitted layout.
 */
function corePropertyPlacement(
	fn: CoreFunction,
	property: CoreInstruction | undefined,
	call: CoreInstruction,
	locations: ReadonlyMap<
		CoreInstructionId,
		{ readonly block: CoreBlock; readonly index: number }
	>,
	uses: ReadonlyMap<
		CoreValueId,
		ReadonlyArray<{
			readonly instruction: CoreInstruction;
			readonly position: number;
		}>
	>,
	root: (value: CoreValueId) => CoreValueId,
	locked: boolean,
): CorePropertyPlacement {
	if (property === undefined || !locked || property.outputs.length !== 1)
		return "in-place";
	const producer = locations.get(property.id);
	const consumer = locations.get(call.id);
	if (
		producer === undefined ||
		consumer === undefined ||
		producer.block.id !== consumer.block.id
	) {
		return "in-place";
	}
	const callee = property.outputs[0]!;
	const consumers = uses.get(root(callee)) ?? [];
	return consumers.length === 1 &&
		consumers[0]!.instruction === call &&
		consumers[0]!.position === 0 &&
		!coreValueUsedByControlFlow(fn, root, callee)
		? "call-fallback"
		: "in-place";
}

/**
 * A speculative region always keeps its ordinary twin: the region replaces a
 * whole instruction group with a virtual representation that a local guard,
 * an escape, or a materialization can still send back to generic code. Stating
 * that duty here, instead of borrowing whichever identity fallback the region's
 * builtin happened to carry, is what lets an identity obligation be discharged
 * without silently retiring the twin.
 */
function regionGenericTwin(kind: string, site: string | number): FactObligation {
	return {
		kind: "fallback",
		id: `region-twin:${kind}:${site}`,
		cause: "materialization",
	};
}

function mergeCoreBuiltinProofs(
	proofs: ReadonlyArray<CoreKnownBuiltinProof["proof"]>,
): CoreKnownBuiltinProof["proof"] {
	return normalizeCoreRequirements(
		proofs.flatMap((proof) => [...proof.dependencies]),
		proofs.flatMap((proof) => [...proof.obligations]),
	);
}

/**
 * Certify the canonical `i < text.length` loop relation for String#charCodeAt.
 * The backend still retains the ordinary Get/Call twin and uses this fact only
 * after its primitive-string, builtin-identity, and numeric-representation guards.
 */
const annotateBoundedStringCharCodeAtPositions: CoreFunctionPass = {
	name: "annotate-bounded-string-char-code-at-positions",
	run(fn, analyses, program) {
		if (
			fn.blocks.length < 3 ||
			!fn.blocks.some((block) =>
				block.instructions.some(
					(instruction) =>
						instruction.opcode === "call" &&
						attributeObject(instruction.attributes.knownBuiltinCall)?.operation ===
							"String.prototype.charCodeAt",
				),
			)
		) {
			return fn;
		}
		const cfg = analyses.controlFlow(fn);
		const canonical = analyses.canonicalValues(fn);
		const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
		const definitions = analyses.definitions(fn);
		const locations = new Map<
			CoreInstructionId,
			{ readonly block: CoreBlock; readonly index: number }
		>();
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				locations.set(instruction.id, { block, index });
			}
		}
		const boundedCalls = new Set<CoreInstructionId>();
		const primitiveLengths = new Set<CoreInstructionId>();
		for (const induction of analyses.loopInductions(fn).inductions) {
			const { comparison, loop } = induction;
			if (
				comparison?.operator !== "<" ||
				induction.step !== 1 ||
				!Object.is(numericConstant(induction.initial, definitions, root), 0)
			) {
				continue;
			}
			const header = fn.blocks[loop.header]!;
			const branch = header.terminator;
			if (header.handler !== undefined || branch.kind !== "branch") continue;
			const bodyIncoming = cfg.predecessors[comparison.body]!.filter(
				({ kind }) => kind === "ordinary",
			);
			if (bodyIncoming.length !== 1 || bodyIncoming[0]!.from !== header.id) continue;
			const comparisonInstruction = definitions.get(root(branch.condition));
			if (comparisonInstruction?.id !== comparison.instruction) continue;
			const length = definitions.get(root(comparison.bound));
			const lengthLocation = length === undefined ? undefined : locations.get(length.id);
			const comparisonLocation = locations.get(comparison.instruction);
			if (
				length?.opcode !== "loadPropertyStatic" ||
				length.inputs.length !== 1 ||
				length.outputs.length !== 1 ||
				typeof length.attributes.stringIndex !== "number" ||
				decodeString(program, length.attributes.stringIndex) !== "length" ||
				lengthLocation === undefined ||
				comparisonLocation === undefined ||
				(lengthLocation.block.id === comparisonLocation.block.id
					? lengthLocation.index >= comparisonLocation.index
					: !cfg.instructionDominatesBlock(lengthLocation.block.id, header.id))
			) {
				continue;
			}
			const updateLocation = locations.get(induction.updateInstruction);
			if (updateLocation === undefined) continue;
			const receiver = root(length.inputs[0]!);
			for (const blockId of loop.blocks) {
				const block = fn.blocks[blockId]!;
				if (block.handler !== undefined) continue;
				for (const call of block.instructions) {
					if (
						call.opcode !== "call" ||
						call.inputs.length !== 3 ||
						root(call.inputs[1]!) !== receiver ||
						root(call.inputs[2]!) !== root(induction.value) ||
						coreKnownBuiltinProof(call, "String.prototype.charCodeAt", {
							lowering: "guarded-primitive-string",
							result: "number",
						}) === undefined ||
						!cfg.dominates(comparison.body, block.id)
					) {
						continue;
					}
					const callLocation = locations.get(call.id)!;
					if (
						callLocation.block.id === updateLocation.block.id &&
						callLocation.index >= updateLocation.index
					) {
						continue;
					}
					boundedCalls.add(call.id);
					primitiveLengths.add(length.id);
				}
			}
		}
		if (boundedCalls.size === 0) return fn;
		return {
			...fn,
			blocks: fn.blocks.map((block) => ({
				...block,
				instructions: block.instructions.map((instruction) =>
					boundedCalls.has(instruction.id)
						? {
								...instruction,
								attributes: {
									...instruction.attributes,
									directStringCharCodeAtPosition: "inBounds",
								},
							}
						: primitiveLengths.has(instruction.id)
							? {
									...instruction,
									attributes: {
										...instruction.attributes,
										primitiveStringLength: true,
									},
								}
							: instruction,
				),
			})),
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

/** Select closed capture projections from an exact `RegExp.prototype.exec`. */
const selectRegExpExecProjectionRegions: CoreFunctionPass = {
	name: "select-regexp-exec-projection-regions",
	run(fn, analyses, program) {
		if (fn.regions.filter(({ kind }) => kind === "regexp-exec-projection").length >= 8) {
			return fn;
		}
		const projectedStringMethodIdentity = compilerFactIsWorldInvariant(
			analyses.context?.facts.protectors.get("watched-methods"),
		)
			? "authority-invariant"
			: "runtime-guarded";
		const cfg = analyses.controlFlow(fn);
		const canonical = analyses.canonicalValues(fn);
		const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
		const definitions = analyses.definitions(fn);
		const locations = new Map<
			CoreInstructionId,
			{ readonly block: CoreBlock; readonly index: number }
		>();
		const uses = new Map<
			CoreValueId,
			Array<{
				readonly instruction: CoreInstruction;
				readonly position: number;
			}>
		>();
		const escapingValues = new Set<CoreValueId>();
		const markEscape = (value: CoreValueId) => escapingValues.add(root(value));
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				locations.set(instruction.id, { block, index });
				for (const [position, input] of instruction.inputs.entries()) {
					const key = root(input);
					const entries = uses.get(key) ?? [];
					entries.push({ instruction, position });
					uses.set(key, entries);
				}
			}
			if (block.handler !== undefined) {
				for (const value of block.handler.arguments) markEscape(value);
			}
			for (const edge of coreTerminatorEdges(block.terminator)) {
				const target = fn.blocks[edge.block]!;
				for (const [index, argument] of edge.arguments.entries()) {
					const parameter = target.parameters[index];
					if (parameter === undefined || root(parameter.value) !== root(argument)) {
						markEscape(argument);
					}
				}
			}
			switch (block.terminator.kind) {
				case "branch":
				case "guard":
					markEscape(block.terminator.condition);
					break;
				case "switch":
					markEscape(block.terminator.discriminant);
					break;
				case "return":
				case "throw":
					markEscape(block.terminator.value);
					break;
				case "jump":
				case "unreachable":
					break;
			}
		}
		const instructionDominates = (
			producer: CoreInstruction,
			consumer: CoreInstruction,
		): boolean => {
			const producerLocation = locations.get(producer.id);
			const consumerLocation = locations.get(consumer.id);
			if (producerLocation === undefined || consumerLocation === undefined) return false;
			return producerLocation.block.id === consumerLocation.block.id
				? producerLocation.index < consumerLocation.index
				: cfg.dominates(producerLocation.block.id, consumerLocation.block.id);
		};
		const staticProperty = (
			instruction: CoreInstruction | undefined,
			name: string,
		): instruction is CoreInstruction =>
			instruction?.opcode === "loadPropertyStatic" &&
			typeof instruction.attributes.stringIndex === "number" &&
			decodeString(program, instruction.attributes.stringIndex) === name;
		const occupied = new Set(
			fn.regions
				.filter(({ kind }) => kind !== "numeric-fusion")
				.flatMap(({ claimedInstructions }) => claimedInstructions),
		);
		const regions = [...fn.regions];
		for (const block of fn.blocks) {
			for (const call of block.instructions) {
				if (
					call.opcode !== "call" ||
					call.inputs.length !== 3 ||
					call.outputs.length !== 1
				) {
					continue;
				}
				const builtin = coreKnownBuiltinProof(call, "RegExp.prototype.exec", {
					lowering: "capture-projection",
					result: "regexp-match-or-null",
				});
				if (builtin === undefined) continue;
				const property = definitions.get(root(call.inputs[0]!));
				if (
					!staticProperty(property, "exec") ||
					property.inputs.length !== 1 ||
					property.outputs.length !== 1 ||
					root(property.inputs[0]!) !== root(call.inputs[1]!) ||
					!instructionDominates(property, call)
				) {
					continue;
				}
				const propertyUses = uses.get(root(property.outputs[0]!));
				if (
					propertyUses?.length !== 1 ||
					propertyUses[0]?.instruction !== call ||
					propertyUses[0].position !== 0
				) {
					continue;
				}
				const result = root(call.outputs[0]!);
				if (escapingValues.has(result)) continue;
				const resultValues = fn.values
					.map(({ id }) => id)
					.filter((value) => root(value) === result);
				const nullChecks: Array<{
					readonly comparison: CoreInstruction;
					readonly nullValue: CoreInstruction;
				}> = [];
				const loads: Array<{
					readonly instruction: CoreInstruction;
					readonly key: CoreInstruction;
					readonly captureIndex: number;
					consumer?:
						| { readonly kind: "length"; readonly property: CoreInstruction }
						| {
								readonly kind: "charCodeAtZero";
								readonly methodIdentity: typeof projectedStringMethodIdentity;
								readonly property: CoreInstruction;
								readonly call: CoreInstruction;
								readonly zero?: CoreInstruction;
						  }
						| {
								readonly kind: "number";
								readonly intrinsic: CoreInstruction;
								readonly call: CoreInstruction;
						  }
						| {
								readonly kind: "asciiCaseLength";
								readonly methodIdentity: typeof projectedStringMethodIdentity;
								readonly upperProperty: CoreInstruction;
								readonly upperCall: CoreInstruction;
								readonly lowerProperty: CoreInstruction;
								readonly lowerCall: CoreInstruction;
								readonly resultMoves: ReadonlyArray<CoreInstruction>;
								readonly lengthProperty: CoreInstruction;
						  };
				}> = [];
				const captureIndices = new Set<number>();
				let safe = true;
				for (const use of uses.get(result) ?? []) {
					const consumer = use.instruction;
					if (
						consumer.opcode === "move" &&
						use.position === 0 &&
						consumer.outputs.length === 1 &&
						root(consumer.outputs[0]!) === result
					) {
						continue;
					}
					if (
						consumer.opcode === "binary" &&
						(consumer.attributes.operator === "===" ||
							consumer.attributes.operator === "!==")
					) {
						const other = consumer.inputs[use.position === 0 ? 1 : 0];
						const nullValue =
							other === undefined ? undefined : definitions.get(root(other));
						if (
							nullValue?.opcode === "createNull" &&
							instructionDominates(nullValue, consumer)
						) {
							nullChecks.push({ comparison: consumer, nullValue });
							continue;
						}
					}
					if (
						consumer.opcode === "loadProperty" &&
						use.position === 0 &&
						consumer.inputs.length === 2 &&
						consumer.outputs.length === 1 &&
						instructionDominates(call, consumer)
					) {
						const key = definitions.get(root(consumer.inputs[1]!));
						const captureIndex = key?.attributes.value;
						if (
							key?.opcode === "createNumber" &&
							typeof captureIndex === "number" &&
							Number.isInteger(captureIndex) &&
							captureIndex > 0 &&
							captureIndex <= 0xffff &&
							!captureIndices.has(captureIndex) &&
							instructionDominates(key, consumer)
						) {
							loads.push({ instruction: consumer, key, captureIndex });
							captureIndices.add(captureIndex);
							continue;
						}
					}
					safe = false;
					break;
				}
				if (!safe || loads.length === 0 || loads.length > 8) continue;

				for (const load of loads) {
					const capture = root(load.instruction.outputs[0]!);
					const captureUses = uses.get(capture) ?? [];
					if (captureUses.length === 1) {
						const consumer = captureUses[0]!.instruction;
						if (
							captureUses[0]!.position === 0 &&
							staticProperty(consumer, "length") &&
							consumer.inputs.length === 1
						) {
							load.consumer = { kind: "length", property: consumer };
							continue;
						}
						if (
							consumer.opcode === "call" &&
							captureUses[0]!.position === 2 &&
							consumer.inputs.length === 3
						) {
							const intrinsic = definitions.get(root(consumer.inputs[0]!));
							if (
								intrinsic?.opcode === "loadIntrinsic" &&
								intrinsic.attributes.intrinsic === "Number" &&
								instructionDominates(intrinsic, consumer)
							) {
								load.consumer = { kind: "number", intrinsic, call: consumer };
								continue;
							}
						}
					}
					if (captureUses.length !== 2) continue;
					const upperPropertyUse = captureUses.find(
						({ instruction, position }) =>
							position === 0 && staticProperty(instruction, "toUpperCase"),
					);
					const upperCallUse = captureUses.find(
						({ instruction, position }) =>
							instruction.opcode === "call" && position === 1,
					);
					const upperProperty = upperPropertyUse?.instruction;
					const upperCall = upperCallUse?.instruction;
					if (
						upperProperty !== undefined &&
						upperCall?.opcode === "call" &&
						upperCall.inputs.length === 2 &&
						root(upperCall.inputs[0]!) === root(upperProperty.outputs[0]!) &&
						(uses.get(root(upperProperty.outputs[0]!))?.length ?? 0) === 1
					) {
						const upperResult = root(upperCall.outputs[0]!);
						const upperUses = uses.get(upperResult) ?? [];
						const lowerPropertyUse = upperUses.find(
							({ instruction, position }) =>
								position === 0 && staticProperty(instruction, "toLowerCase"),
						);
						const lowerCallUse = upperUses.find(
							({ instruction, position }) =>
								instruction.opcode === "call" && position === 1,
						);
						const lowerProperty = lowerPropertyUse?.instruction;
						const lowerCall = lowerCallUse?.instruction;
						if (
							upperUses.length === 2 &&
							lowerProperty !== undefined &&
							lowerCall?.opcode === "call" &&
							lowerCall.inputs.length === 2 &&
							root(lowerCall.inputs[0]!) === root(lowerProperty.outputs[0]!) &&
							(uses.get(root(lowerProperty.outputs[0]!))?.length ?? 0) === 1
						) {
							const lowerUses = uses.get(root(lowerCall.outputs[0]!)) ?? [];
							const lengthProperty = lowerUses[0]?.instruction;
							if (
								lowerUses.length === 1 &&
								lowerUses[0]?.position === 0 &&
								staticProperty(lengthProperty, "length")
							) {
								load.consumer = {
									kind: "asciiCaseLength",
									methodIdentity: projectedStringMethodIdentity,
									upperProperty,
									upperCall,
									lowerProperty,
									lowerCall,
									resultMoves: [],
									lengthProperty,
								};
								continue;
							}
						}
					}
					const propertyUse = captureUses.find(
						({ instruction, position }) =>
							position === 0 && staticProperty(instruction, "charCodeAt"),
					);
					const callUse = captureUses.find(
						({ instruction, position }) =>
							instruction.opcode === "call" && position === 1,
					);
					const charProperty = propertyUse?.instruction;
					const charCall = callUse?.instruction;
					if (
						charProperty === undefined ||
						charCall?.opcode !== "call" ||
						charCall.inputs.length !== 3 ||
						root(charCall.inputs[0]!) !== root(charProperty.outputs[0]!) ||
						(uses.get(root(charProperty.outputs[0]!))?.length ?? 0) !== 1
					) {
						continue;
					}
					const zero = definitions.get(root(charCall.inputs[2]!));
					if (zero?.opcode === "createNumber" && Object.is(zero.attributes.value, 0)) {
						load.consumer = {
							kind: "charCodeAtZero",
							methodIdentity: projectedStringMethodIdentity,
							property: charProperty,
							call: charCall,
							zero,
						};
					}
				}

				let lockedLiteral:
					| {
							readonly constructorIntrinsic: CoreInstruction;
							readonly construct: CoreInstruction;
					  }
					| undefined;
				const construct = definitions.get(root(call.inputs[1]!));
				if (
					coreProofIsWorldInvariant(builtin.proof) &&
					construct?.opcode === "construct" &&
					construct.outputs.length === 1
				) {
					const receiverUses = uses.get(root(construct.outputs[0]!)) ?? [];
					const constructorIntrinsic = definitions.get(root(construct.inputs[0]!));
					if (
						receiverUses.length === 2 &&
						receiverUses.every(
							({ instruction }) => instruction === property || instruction === call,
						) &&
						constructorIntrinsic?.opcode === "loadIntrinsic" &&
						constructorIntrinsic.attributes.intrinsic === "RegExp" &&
						instructionDominates(constructorIntrinsic, construct) &&
						instructionDominates(construct, call)
					) {
						lockedLiteral = { constructorIntrinsic, construct };
					}
				}

				const claimed = new Set<CoreInstruction>([property, call]);
				for (const { comparison, nullValue } of nullChecks) {
					claimed.add(comparison);
					claimed.add(nullValue);
				}
				for (const load of loads) {
					claimed.add(load.key);
					claimed.add(load.instruction);
					const consumer = load.consumer;
					if (consumer?.kind === "length") claimed.add(consumer.property);
					else if (consumer?.kind === "number") {
						claimed.add(consumer.intrinsic);
						claimed.add(consumer.call);
					} else if (consumer?.kind === "charCodeAtZero") {
						claimed.add(consumer.property);
						claimed.add(consumer.call);
						if (consumer.zero !== undefined) claimed.add(consumer.zero);
					} else if (consumer?.kind === "asciiCaseLength") {
						claimed.add(consumer.upperProperty);
						claimed.add(consumer.upperCall);
						claimed.add(consumer.lowerProperty);
						claimed.add(consumer.lowerCall);
						for (const move of consumer.resultMoves) claimed.add(move);
						claimed.add(consumer.lengthProperty);
					}
				}
				if (lockedLiteral !== undefined) {
					claimed.add(lockedLiteral.constructorIntrinsic);
					claimed.add(lockedLiteral.construct);
				}
				const claimedInstructions = [...claimed].map(({ id }) => id);
				const ordinaryBlocks = [
					...new Set([...claimed].map(({ id }) => locations.get(id)!.block.id)),
				];
				if (
					claimedInstructions.length > 96 ||
					claimedInstructions.some((id) => occupied.has(id)) ||
					[...claimed].some(({ id }) => locations.get(id)?.block.handler !== undefined)
				) {
					continue;
				}
				const obligations = [
					...builtin.proof.obligations,
					{
						kind: "fallback",
						id: `regexp-exec-projection-twin:${builtin.sourceSite ?? fn.functionIndex}`,
						cause: "materialization",
					},
					{
						kind: "materialize",
						id: `regexp-exec-projection:${builtin.sourceSite ?? fn.functionIndex}`,
						cause: "materialization",
					},
				];
				regions.push({
					kind: "regexp-exec-projection",
					anchors: [call.id, loads[0]!.instruction.id],
					claimedInstructions,
					ordinaryBlocks,
					exceptionalBlocks: [],
					data: coreAttributeObject(
						{
							license: {
								guard: {
									dependencies: builtin.proof.dependencies,
									obligations,
								},
								genericTwin: "retained",
								materialization: "whole-region",
							},
							representation: "regexp-capture-spans",
							cost: {
								score: loads.length * 12 + nullChecks.length * 2,
								metadataOperations: claimedInstructions.length,
							},
							property: { $coreInstruction: property.id },
							// A locked fresh literal is the only receiver whose `exec` lookup a
							// declining fast path may skip.
							propertyPlacement: corePropertyPlacement(
								fn,
								property,
								call,
								locations,
								uses,
								root,
								lockedLiteral !== undefined,
							),
							resultRegisters: resultValues.map((value) => ({
								$coreValue: value,
							})),
							nullChecks: nullChecks.map(({ comparison, nullValue }) => ({
								comparison: { $coreInstruction: comparison.id },
								nullValue: { $coreInstruction: nullValue.id },
							})),
							...(lockedLiteral === undefined
								? {}
								: {
										lockedLiteral: {
											constructorIntrinsic: {
												$coreInstruction: lockedLiteral.constructorIntrinsic.id,
											},
											construct: {
												$coreInstruction: lockedLiteral.construct.id,
											},
										},
									}),
							lastIndexEffect: "retained-call-twin",
							loads: loads.map((load) => ({
								instruction: { $coreInstruction: load.instruction.id },
								key: { $coreInstruction: load.key.id },
								captureIndex: load.captureIndex,
								...(load.consumer === undefined
									? {}
									: {
											consumer:
												load.consumer.kind === "length"
													? {
															kind: "length",
															property: {
																$coreInstruction: load.consumer.property.id,
															},
														}
													: load.consumer.kind === "number"
														? {
																kind: "number",
																intrinsic: {
																	$coreInstruction: load.consumer.intrinsic.id,
																},
																call: {
																	$coreInstruction: load.consumer.call.id,
																},
															}
														: load.consumer.kind === "charCodeAtZero"
															? {
																	kind: "charCodeAtZero",
																	methodIdentity: load.consumer.methodIdentity,
																	property: {
																		$coreInstruction: load.consumer.property.id,
																	},
																	call: {
																		$coreInstruction: load.consumer.call.id,
																	},
																	...(load.consumer.zero === undefined
																		? {}
																		: {
																				zero: {
																					$coreInstruction: load.consumer.zero.id,
																				},
																			}),
																}
															: {
																	kind: "asciiCaseLength",
																	methodIdentity: load.consumer.methodIdentity,
																	upperProperty: {
																		$coreInstruction: load.consumer.upperProperty.id,
																	},
																	upperCall: {
																		$coreInstruction: load.consumer.upperCall.id,
																	},
																	lowerProperty: {
																		$coreInstruction: load.consumer.lowerProperty.id,
																	},
																	lowerCall: {
																		$coreInstruction: load.consumer.lowerCall.id,
																	},
																	resultMoves: load.consumer.resultMoves.map(
																		({ id }) => ({
																			$coreInstruction: id,
																		}),
																	),
																	lengthProperty: {
																		$coreInstruction: load.consumer.lengthProperty.id,
																	},
																},
										}),
							})),
						},
						"regexp-exec-projection",
					),
				});
				for (const id of claimedInstructions) occupied.add(id);
				if (regions.filter(({ kind }) => kind === "regexp-exec-projection").length >= 8) {
					break;
				}
			}
		}
		return regions.length === fn.regions.length
			? fn
			: { ...fn, regions, mutationEpoch: fn.mutationEpoch + 1 };
	},
};

/** Select closed constant captures from one exact RegExp iterator step. */
const selectRegExpIteratorProjectionRegions: CoreFunctionPass = {
	name: "select-regexp-iterator-projection-regions",
	run(fn, analyses, _program) {
		const protector = analyses.context?.facts.protectors.get("watched-methods");
		const guard = compilerGuardPlan(
			[protector],
			[
				{
					kind: "fallback",
					id: `regexp-iterator-projection:${fn.functionIndex}`,
					cause: "materialization",
				},
				{
					kind: "materialize",
					id: `regexp-iterator-projection:${fn.functionIndex}`,
					cause: "materialization",
				},
			],
		);
		if (
			guard === undefined ||
			fn.regions.filter(({ kind }) => kind === "regexp-iterator-projection").length >= 8
		) {
			return fn;
		}
		const cfg = analyses.controlFlow(fn);
		const canonical = analyses.canonicalValues(fn);
		const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
		const definitions = analyses.definitions(fn);
		const locations = new Map<
			CoreInstructionId,
			{ readonly block: CoreBlock; readonly index: number }
		>();
		const uses = new Map<
			CoreValueId,
			Array<{
				readonly instruction: CoreInstruction;
				readonly position: number;
			}>
		>();
		const terminatorUses = new Set<CoreValueId>();
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				locations.set(instruction.id, { block, index });
				for (const [position, input] of instruction.inputs.entries()) {
					const key = root(input);
					const entries = uses.get(key) ?? [];
					entries.push({ instruction, position });
					uses.set(key, entries);
				}
			}
			locations.set(block.terminator.id, {
				block,
				index: block.instructions.length,
			});
			switch (block.terminator.kind) {
				case "branch":
				case "guard":
					terminatorUses.add(root(block.terminator.condition));
					break;
				case "switch":
					terminatorUses.add(root(block.terminator.discriminant));
					break;
				case "return":
				case "throw":
					terminatorUses.add(root(block.terminator.value));
					break;
				case "jump":
				case "unreachable":
					break;
			}
		}
		const instructionDominates = (
			producer: CoreInstruction,
			consumer: CoreInstruction,
		): boolean => {
			const producerLocation = locations.get(producer.id);
			const consumerLocation = locations.get(consumer.id);
			if (producerLocation === undefined || consumerLocation === undefined) return false;
			return producerLocation.block.id === consumerLocation.block.id
				? producerLocation.index < consumerLocation.index
				: cfg.dominates(producerLocation.block.id, consumerLocation.block.id);
		};
		const occupied = new Set(
			fn.regions
				.filter(({ kind }) => kind !== "numeric-fusion")
				.flatMap(({ claimedInstructions }) => claimedInstructions),
		);
		const regions = [...fn.regions];
		for (const block of fn.blocks) {
			const step = block.instructions.at(-1);
			const doneBranch = block.terminator;
			if (
				step?.opcode !== "iteratorStep" ||
				step.inputs.length !== 2 ||
				step.outputs.length !== 2 ||
				doneBranch.kind !== "branch" ||
				root(doneBranch.condition) !== root(step.outputs[1]!) ||
				doneBranch.consequent.block === block.id
			) {
				continue;
			}
			const result = root(step.outputs[0]!);
			if (terminatorUses.has(result)) continue;
			const resultValues = fn.values
				.map(({ id }) => id)
				.filter((value) => root(value) === result);
			const loads: Array<{
				readonly instruction: CoreInstruction;
				readonly key: CoreInstruction;
				readonly captureIndex: number;
				readonly numberIntrinsic: CoreInstruction;
				readonly numberCall: CoreInstruction;
			}> = [];
			const captureIndices = new Set<number>();
			let safe = true;
			for (const use of uses.get(result) ?? []) {
				const capture = use.instruction;
				if (
					capture.opcode === "move" &&
					use.position === 0 &&
					capture.outputs.length === 1 &&
					root(capture.outputs[0]!) === result
				) {
					continue;
				}
				if (
					capture.opcode !== "loadProperty" ||
					use.position !== 0 ||
					capture.inputs.length !== 2 ||
					capture.outputs.length !== 1 ||
					!instructionDominates(step, capture)
				) {
					safe = false;
					break;
				}
				const key = definitions.get(root(capture.inputs[1]!));
				const captureIndex = key?.attributes.value;
				const captureUses = uses.get(root(capture.outputs[0]!)) ?? [];
				const numberUse = captureUses[0];
				const numberCall = numberUse?.instruction;
				const numberIntrinsic =
					numberCall?.opcode === "call"
						? definitions.get(root(numberCall.inputs[0]!))
						: undefined;
				if (
					key?.opcode !== "createNumber" ||
					typeof captureIndex !== "number" ||
					!Number.isInteger(captureIndex) ||
					captureIndex <= 0 ||
					captureIndex > 0xffff ||
					captureIndices.has(captureIndex) ||
					captureUses.length !== 1 ||
					numberUse?.position !== 2 ||
					numberCall?.opcode !== "call" ||
					numberCall.inputs.length !== 3 ||
					root(numberCall.inputs[2]!) !== root(capture.outputs[0]!) ||
					numberIntrinsic?.opcode !== "loadIntrinsic" ||
					numberIntrinsic.attributes.intrinsic !== "Number" ||
					!instructionDominates(key, capture) ||
					!instructionDominates(numberIntrinsic, numberCall)
				) {
					safe = false;
					break;
				}
				captureIndices.add(captureIndex);
				loads.push({
					instruction: capture,
					key,
					captureIndex,
					numberIntrinsic,
					numberCall,
				});
			}
			if (!safe || loads.length === 0 || loads.length > 8) continue;
			const claimed = new Set<CoreInstruction>([step]);
			for (const load of loads) {
				claimed.add(load.key);
				claimed.add(load.instruction);
				claimed.add(load.numberIntrinsic);
				claimed.add(load.numberCall);
			}
			const claimedInstructions = [...claimed].map(({ id }) => id);
			claimedInstructions.splice(1, 0, doneBranch.id);
			const ordinaryBlocks = [
				...new Set(claimedInstructions.map((id) => locations.get(id)!.block.id)),
			];
			const exceptionalBlocks = [
				...new Set(
					claimedInstructions.flatMap((id) => {
						const handler = locations.get(id)?.block.handler;
						return handler === undefined ? [] : [handler.block];
					}),
				),
			];
			if (
				claimedInstructions.some((id) => occupied.has(id)) ||
				exceptionalBlocks.some((handler) => ordinaryBlocks.includes(handler))
			) {
				continue;
			}
			regions.push({
				kind: "regexp-iterator-projection",
				anchors: [step.id, doneBranch.id, loads[0]!.instruction.id],
				claimedInstructions,
				ordinaryBlocks,
				exceptionalBlocks,
				data: coreAttributeObject(
					{
						license: {
							guard,
							genericTwin: "retained",
							materialization: "on-demand",
						},
						representation: "regexp-iterator-capture-spans",
						cost: {
							score: loads.length * 16,
							metadataOperations: claimedInstructions.length,
						},
						doneBranch: { $coreInstruction: doneBranch.id },
						exitBlock: { $coreBlock: doneBranch.consequent.block },
						resultRegisters: resultValues.map((value) => ({
							$coreValue: value,
						})),
						statefulEffect: "iterator-last-index-retained-step",
						runtimeGuard: "exact-brand-next-realm-regexp",
						loads: loads.map((load) => ({
							instruction: { $coreInstruction: load.instruction.id },
							key: { $coreInstruction: load.key.id },
							captureIndex: load.captureIndex,
							numberIntrinsic: { $coreInstruction: load.numberIntrinsic.id },
							numberCall: { $coreInstruction: load.numberCall.id },
						})),
					},
					"regexp-iterator-projection",
				),
			});
			for (const id of claimedInstructions) occupied.add(id);
			if (
				regions.filter(({ kind }) => kind === "regexp-iterator-projection").length >= 8
			) {
				break;
			}
		}
		return regions.length === fn.regions.length
			? fn
			: { ...fn, regions, mutationEpoch: fn.mutationEpoch + 1 };
	},
};

/** Select one-shot indexed consumers of an exact `String.prototype.split`. */
const selectStringSplitCursorRegions: CoreFunctionPass = {
	name: "select-string-split-cursor-regions",
	run(fn, analyses, program) {
		if (fn.regions.filter(({ kind }) => kind === "string-split-cursor").length >= 8) {
			return fn;
		}
		const cfg = analyses.controlFlow(fn);
		const canonical = analyses.canonicalValues(fn);
		const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
		const definitions = analyses.definitions(fn);
		const locations = new Map<
			CoreInstructionId,
			{ readonly block: CoreBlock; readonly index: number }
		>();
		const uses = new Map<
			CoreValueId,
			Array<{
				readonly instruction: CoreInstruction;
				readonly position: number;
			}>
		>();
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				locations.set(instruction.id, { block, index });
				for (const [position, input] of instruction.inputs.entries()) {
					const entries = uses.get(root(input)) ?? [];
					entries.push({ instruction, position });
					uses.set(root(input), entries);
				}
			}
			locations.set(block.terminator.id, {
				block,
				index: block.instructions.length,
			});
		}
		const instructionDominates = (
			producer: CoreInstruction,
			consumer: CoreInstruction,
		): boolean => {
			const producerLocation = locations.get(producer.id);
			const consumerLocation = locations.get(consumer.id);
			if (producerLocation === undefined || consumerLocation === undefined) return false;
			return producerLocation.block.id === consumerLocation.block.id
				? producerLocation.index < consumerLocation.index
				: cfg.dominates(producerLocation.block.id, consumerLocation.block.id);
		};
		const exactUses = (
			value: CoreValueId,
			expected: ReadonlyArray<{
				readonly instruction: CoreInstruction;
				readonly position: number;
			}>,
		): boolean => {
			const actual = uses.get(root(value)) ?? [];
			return (
				actual.length === expected.length &&
				expected.every(({ instruction, position }) =>
					actual.some(
						(use) => use.instruction === instruction && use.position === position,
					),
				)
			);
		};
		const canReachWithout = (
			from: CoreBlockId,
			to: CoreBlockId,
			blocked: CoreBlockId,
		): boolean => {
			if (from === blocked) return false;
			const seen = new Set<CoreBlockId>([blocked]);
			const pending = [from];
			while (pending.length > 0) {
				const block = pending.pop()!;
				if (block === to) return true;
				if (seen.has(block)) continue;
				seen.add(block);
				for (const edge of cfg.successors[block]!) {
					if (edge.kind === "ordinary" && !seen.has(edge.to)) pending.push(edge.to);
				}
			}
			return false;
		};
		const staticProperty = (
			instruction: CoreInstruction | undefined,
			name: string,
		): instruction is CoreInstruction =>
			instruction?.opcode === "loadPropertyStatic" &&
			typeof instruction.attributes.stringIndex === "number" &&
			decodeString(program, instruction.attributes.stringIndex) === name;
		const occupied = new Set(
			fn.regions
				.filter(({ kind }) => kind !== "numeric-fusion")
				.flatMap(({ claimedInstructions }) => claimedInstructions),
		);
		const handlerTargets = new Set(
			fn.blocks.flatMap(({ handler }) => (handler === undefined ? [] : [handler.block])),
		);
		const regions = [...fn.regions];
		for (const loop of cfg.loops) {
			if (!loop.canonical || loop.latches.size !== 1) continue;
			const backedge = [...loop.latches][0]!;
			const header = fn.blocks[loop.header]!;
			const backedgeBlock = fn.blocks[backedge]!;
			const branch = header.terminator;
			if (
				branch.kind !== "branch" ||
				backedgeBlock.terminator.kind !== "jump" ||
				backedgeBlock.terminator.edge.block !== header.id ||
				!loop.blocks.has(header.id) ||
				!loop.blocks.has(backedgeBlock.id)
			) {
				continue;
			}
			const bodyBlock = fn.blocks[branch.consequent.block]!;
			const compactBody = bodyBlock.id === backedgeBlock.id && loop.blocks.size === 2;
			const explicitLatch =
				bodyBlock.id !== header.id &&
				bodyBlock.id !== backedgeBlock.id &&
				loop.blocks.size === 3 &&
				loop.blocks.has(bodyBlock.id) &&
				bodyBlock.terminator.kind === "jump" &&
				bodyBlock.terminator.edge.block === backedgeBlock.id;
			if (!compactBody && !explicitLatch) continue;
			const containedLoops = cfg.loops.filter(
				(candidate) =>
					loop.blocks.has(candidate.header) &&
					[...candidate.blocks].every((block) => loop.blocks.has(block)),
			);
			const headerPredecessors = cfg.predecessors[header.id]!.filter(
				({ kind }) => kind === "ordinary",
			);
			const insidePredecessors = headerPredecessors.filter(({ from }) =>
				loop.blocks.has(from),
			);
			const outsidePredecessors = headerPredecessors.filter(
				({ from }) => !loop.blocks.has(from),
			);
			if (
				containedLoops.length !== 1 ||
				insidePredecessors.length !== 1 ||
				insidePredecessors[0]!.from !== backedgeBlock.id ||
				outsidePredecessors.length !== 1
			) {
				continue;
			}
			let exactLoopControl = true;
			for (const blockId of loop.blocks) {
				for (const edge of cfg.predecessors[blockId]!) {
					if (
						edge.kind !== "ordinary" ||
						(!loop.blocks.has(edge.from) && blockId !== header.id)
					) {
						exactLoopControl = false;
					}
				}
				for (const edge of cfg.successors[blockId]!) {
					if (
						edge.kind !== "ordinary" ||
						(!loop.blocks.has(edge.to) &&
							(blockId !== header.id || edge.to !== branch.alternate.block))
					) {
						exactLoopControl = false;
					}
				}
			}
			if (!exactLoopControl) continue;

			const compare = definitions.get(root(branch.condition));
			if (
				compare?.opcode !== "binary" ||
				compare.attributes.operator !== "<" ||
				compare.inputs.length !== 2 ||
				compare.outputs.length !== 1 ||
				header.instructions.at(-1) !== compare
			) {
				continue;
			}
			const index = compare.inputs[0]!;
			const length = definitions.get(root(compare.inputs[1]!));
			if (
				!staticProperty(length, "length") ||
				length.inputs.length !== 1 ||
				length.outputs.length !== 1 ||
				header.instructions.at(-2) !== length
			) {
				continue;
			}
			const splitResult = root(length.inputs[0]!);
			const splitCall = definitions.get(splitResult);
			if (
				(splitCall?.opcode !== "call" && splitCall?.opcode !== "callBuiltin") ||
				splitCall.outputs.length !== 1
			) {
				continue;
			}
			const dynamicSplit = splitCall.opcode === "call";
			if (splitCall.inputs.length !== (dynamicSplit ? 3 : 2)) continue;
			const splitProof = coreKnownBuiltinProof(splitCall, "String.prototype.split", {
				lowering: "closed-string-split",
				result: "array-of-strings",
			});
			if (splitProof === undefined) continue;
			const splitProperty = dynamicSplit
				? definitions.get(root(splitCall.inputs[0]!))
				: undefined;
			const receiver = splitCall.inputs[dynamicSplit ? 1 : 0]!;
			if (
				(dynamicSplit &&
					(!staticProperty(splitProperty, "split") ||
						splitProperty.inputs.length !== 1 ||
						splitProperty.outputs.length !== 1 ||
						root(splitProperty.inputs[0]!) !== root(receiver) ||
						!instructionDominates(splitProperty, splitCall) ||
						!exactUses(splitProperty.outputs[0]!, [
							{ instruction: splitCall, position: 0 },
						]))) ||
				!cfg.dominates(locations.get(splitCall.id)!.block.id, header.id)
			) {
				continue;
			}

			const element = bodyBlock.instructions[0];
			const trimProperty = bodyBlock.instructions[1];
			const trimCall = bodyBlock.instructions[2];
			if (
				element?.opcode !== "loadProperty" ||
				element.inputs.length !== 2 ||
				element.outputs.length !== 1 ||
				root(element.inputs[0]!) !== splitResult ||
				root(element.inputs[1]!) !== root(index) ||
				!staticProperty(trimProperty, "trim") ||
				trimProperty.inputs.length !== 1 ||
				trimProperty.outputs.length !== 1 ||
				root(trimProperty.inputs[0]!) !== root(element.outputs[0]!) ||
				trimCall?.opcode !== "call" ||
				trimCall.inputs.length !== 2 ||
				trimCall.outputs.length !== 1 ||
				root(trimCall.inputs[0]!) !== root(trimProperty.outputs[0]!) ||
				root(trimCall.inputs[1]!) !== root(element.outputs[0]!)
			) {
				continue;
			}
			const trimProof = coreKnownBuiltinProof(trimCall, "String.prototype.trim", {
				lowering: "split-cursor-span",
				result: "string",
			});
			if (trimProof === undefined) continue;

			const indexParameter = header.parameters.findIndex(
				(parameter) => root(parameter.value) === root(index),
			);
			if (indexParameter < 0) continue;
			const initialIndex = outsidePredecessors[0]!.arguments[indexParameter];
			const nextIndex = insidePredecessors[0]!.arguments[indexParameter];
			if (initialIndex === undefined || nextIndex === undefined) continue;
			const zero = definitions.get(root(initialIndex));
			const increment = definitions.get(root(nextIndex));
			if (
				zero?.opcode !== "createNumber" ||
				!Object.is(zero.attributes.value, 0) ||
				loop.blocks.has(locations.get(zero.id)!.block.id) ||
				!cfg.dominates(locations.get(zero.id)!.block.id, header.id) ||
				increment?.opcode !== "unary" ||
				increment.attributes.operator !== "increment" ||
				increment.inputs.length !== 1 ||
				increment.outputs.length !== 1 ||
				backedgeBlock.instructions.at(-1) !== increment
			) {
				continue;
			}
			const incrementInput = definitions.get(root(increment.inputs[0]!));
			const indexAdvanceInput =
				incrementInput?.opcode === "unary" &&
				incrementInput.attributes.operator === "tonumeric" &&
				incrementInput.inputs.length === 1
					? incrementInput.inputs[0]
					: increment.inputs[0];
			if (root(indexAdvanceInput!) !== root(index)) continue;

			const primitiveStringLengths: Array<CoreInstruction> = [];
			let trimResultSafe = true;
			for (const use of uses.get(root(trimCall.outputs[0]!)) ?? []) {
				if (
					use.position === 0 &&
					staticProperty(use.instruction, "length") &&
					instructionDominates(trimCall, use.instruction)
				) {
					primitiveStringLengths.push(use.instruction);
				} else {
					trimResultSafe = false;
				}
			}
			if (
				!trimResultSafe ||
				primitiveStringLengths.length > 64 ||
				!exactUses(splitCall.outputs[0]!, [
					{ instruction: length, position: 0 },
					{ instruction: element, position: 0 },
				]) ||
				!exactUses(index, [
					{ instruction: compare, position: 0 },
					{ instruction: element, position: 1 },
					{ instruction: incrementInput ?? increment, position: 0 },
				]) ||
				!exactUses(element.outputs[0]!, [
					{ instruction: trimProperty, position: 0 },
					{ instruction: trimCall, position: 1 },
				]) ||
				!exactUses(trimProperty.outputs[0]!, [{ instruction: trimCall, position: 0 }])
			) {
				continue;
			}

			const callBlock = locations.get(splitCall.id)!.block.id;
			if (canReachWithout(branch.alternate.block, header.id, callBlock)) continue;
			const ordinaryBlocks = [
				...new Set([
					...(splitProperty === undefined
						? []
						: [locations.get(splitProperty.id)!.block.id]),
					callBlock,
					...loop.blocks,
				]),
			];
			if (
				ordinaryBlocks.some(
					(blockId) =>
						fn.blocks[blockId]!.handler !== undefined || handlerTargets.has(blockId),
				)
			) {
				continue;
			}
			const proof = mergeCoreBuiltinProofs([splitProof.proof, trimProof.proof]);
			const materialization = {
				kind: "materialize",
				id: `string-split-cursor:${splitProof.sourceSite ?? fn.functionIndex}`,
				cause: "materialization",
			};
			const obligations = [
				...proof.obligations,
				regionGenericTwin(
					"string-split-cursor",
					splitProof.sourceSite ?? fn.functionIndex,
				),
				materialization,
			];
			const claimed = [
				...(splitProperty === undefined ? [] : [splitProperty]),
				splitCall,
				length,
				compare,
				branch,
				element,
				trimProperty,
				trimCall,
				...primitiveStringLengths,
				increment,
				backedgeBlock.terminator,
			];
			if (
				new Set(claimed.map(({ id }) => id)).size !== claimed.length ||
				claimed.some(({ id }) => occupied.has(id))
			) {
				continue;
			}
			const claimedInstructions = claimed.map(({ id }) => id);
			const resultValues = fn.values
				.map(({ id }) => id)
				.filter((value) => root(value) === splitResult);
			regions.push({
				kind: "string-split-cursor",
				anchors: [splitCall.id, branch.id, length.id, backedgeBlock.terminator.id],
				claimedInstructions,
				ordinaryBlocks,
				exceptionalBlocks: [],
				data: coreAttributeObject(
					{
						license: {
							guard: { dependencies: proof.dependencies, obligations },
							genericTwin: "retained",
							materialization: "on-demand",
						},
						representation: "split-cursor-spans",
						cost: {
							score: 4 + primitiveStringLengths.length,
							metadataOperations: claimedInstructions.length,
						},
						...(splitProperty === undefined
							? {}
							: { property: { $coreInstruction: splitProperty.id } }),
						// The split call's own identity proof, not the merged trim proof, is
						// what pins the `split` lookup a declining fast path may skip.
						propertyPlacement: corePropertyPlacement(
							fn,
							splitProperty,
							splitCall,
							locations,
							uses,
							root,
							coreProofIsWorldInvariant(splitProof.proof),
						),
						splitIdentity: coreProofIsWorldInvariant(splitProof.proof)
							? "authority-invariant"
							: "runtime-guarded",
						trimIdentity: coreProofIsWorldInvariant(trimProof.proof)
							? "authority-invariant"
							: "runtime-guarded",
						compare: { $coreInstruction: compare.id },
						element: { $coreInstruction: element.id },
						trimProperty: { $coreInstruction: trimProperty.id },
						trimCall: { $coreInstruction: trimCall.id },
						increment: { $coreInstruction: increment.id },
						resultRegisters: resultValues.map((value) => ({
							$coreValue: value,
						})),
						primitiveStringLengths: primitiveStringLengths.map(({ id }) => ({
							$coreInstruction: id,
						})),
						exitBlock: { $coreBlock: branch.alternate.block },
					},
					"string-split-cursor",
				),
			});
			for (const { id } of claimed) occupied.add(id);
			if (regions.filter(({ kind }) => kind === "string-split-cursor").length >= 8) {
				break;
			}
		}
		return regions.length === fn.regions.length
			? fn
			: { ...fn, regions, mutationEpoch: fn.mutationEpoch + 1 };
	},
};

/** Select a non-escaping exact `String.prototype.split` projection. */
const selectStringSplitProjectionRegions: CoreFunctionPass = {
	name: "select-string-split-projection-regions",
	run(fn, analyses, program) {
		if (fn.regions.filter(({ kind }) => kind === "string-split-projection").length >= 8) {
			return fn;
		}
		const cfg = analyses.controlFlow(fn);
		const canonical = analyses.canonicalValues(fn);
		const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
		const definitions = analyses.definitions(fn);
		const locations = new Map<
			CoreInstructionId,
			{ readonly block: CoreBlock; readonly index: number }
		>();
		const uses = new Map<
			CoreValueId,
			Array<{
				readonly instruction: CoreInstruction;
				readonly position: number;
			}>
		>();
		const nonInstructionUses = new Set<CoreValueId>();
		const handlerTargets = new Set(
			fn.blocks.flatMap(({ handler }) => (handler === undefined ? [] : [handler.block])),
		);
		const addNonInstructionUse = (value: CoreValueId) => {
			nonInstructionUses.add(root(value));
		};
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				locations.set(instruction.id, { block, index });
				for (const [position, input] of instruction.inputs.entries()) {
					const key = root(input);
					const entries = uses.get(key) ?? [];
					entries.push({ instruction, position });
					uses.set(key, entries);
				}
			}
			if (block.handler !== undefined) {
				for (const value of block.handler.arguments) addNonInstructionUse(value);
			}
			for (const edge of coreTerminatorEdges(block.terminator)) {
				for (const value of edge.arguments) addNonInstructionUse(value);
			}
			switch (block.terminator.kind) {
				case "branch":
				case "guard":
					addNonInstructionUse(block.terminator.condition);
					break;
				case "switch":
					addNonInstructionUse(block.terminator.discriminant);
					break;
				case "return":
				case "throw":
					addNonInstructionUse(block.terminator.value);
					break;
				case "jump":
				case "unreachable":
					break;
			}
		}
		const instructionDominates = (
			producer: CoreInstruction,
			consumer: CoreInstruction,
		): boolean => {
			const producerLocation = locations.get(producer.id);
			const consumerLocation = locations.get(consumer.id);
			if (producerLocation === undefined || consumerLocation === undefined) return false;
			return producerLocation.block.id === consumerLocation.block.id
				? producerLocation.index < consumerLocation.index
				: cfg.dominates(producerLocation.block.id, consumerLocation.block.id);
		};
		const occupied = new Set(
			fn.regions
				.filter(({ kind }) => kind !== "numeric-fusion")
				.flatMap(({ claimedInstructions }) => claimedInstructions),
		);
		const regions = [...fn.regions];
		for (const block of fn.blocks) {
			for (const call of block.instructions) {
				const dynamic = call.opcode === "call";
				if (
					(!dynamic && call.opcode !== "callBuiltin") ||
					call.inputs.length !== (dynamic ? 3 : 2) ||
					call.outputs.length !== 1
				) {
					continue;
				}
				const builtin = coreKnownBuiltinProof(call, "String.prototype.split", {
					lowering: "projected-string-split",
					result: "array-of-strings",
				});
				if (builtin === undefined) continue;
				const property = dynamic ? definitions.get(root(call.inputs[0]!)) : undefined;
				const receiver = call.inputs[dynamic ? 1 : 0]!;
				const separator = definitions.get(root(call.inputs[dynamic ? 2 : 1]!));
				const separatorStringIndex = separator?.attributes.stringIndex;
				if (
					(dynamic &&
						(property?.opcode !== "loadPropertyStatic" ||
							property.inputs.length !== 1 ||
							property.outputs.length !== 1 ||
							root(property.inputs[0]!) !== root(receiver) ||
							typeof property.attributes.stringIndex !== "number" ||
							decodeString(program, property.attributes.stringIndex) !== "split" ||
							!instructionDominates(property, call))) ||
					separator?.opcode !== "createString" ||
					typeof separatorStringIndex !== "number" ||
					(decodeString(program, separatorStringIndex)?.length ?? 0) === 0 ||
					!instructionDominates(separator, call)
				) {
					continue;
				}
				if (property !== undefined) {
					const propertyUses = uses.get(root(property.outputs[0]!));
					if (
						propertyUses?.length !== 1 ||
						propertyUses[0]?.instruction !== call ||
						propertyUses[0].position !== 0
					) {
						continue;
					}
				}

				const result = root(call.outputs[0]!);
				if (nonInstructionUses.has(result)) continue;
				const loads: Array<{
					readonly instruction: CoreInstruction;
					readonly kind: "element" | "length";
					readonly index?: number;
					readonly key?: CoreInstruction;
				}> = [];
				const projectedIndices = new Set<number>();
				let lengthSeen = false;
				let safe = true;
				for (const use of uses.get(result) ?? []) {
					const consumer = use.instruction;
					if (
						consumer.opcode === "move" &&
						use.position === 0 &&
						consumer.outputs.length === 1 &&
						root(consumer.outputs[0]!) === result
					) {
						continue;
					}
					if (
						consumer.opcode === "loadPropertyStatic" &&
						use.position === 0 &&
						consumer.outputs.length === 1 &&
						typeof consumer.attributes.stringIndex === "number" &&
						decodeString(program, consumer.attributes.stringIndex) === "length" &&
						!lengthSeen &&
						instructionDominates(call, consumer)
					) {
						loads.push({ instruction: consumer, kind: "length" });
						lengthSeen = true;
						continue;
					}
					if (
						consumer.opcode === "loadProperty" &&
						use.position === 0 &&
						consumer.inputs.length === 2 &&
						consumer.outputs.length === 1 &&
						instructionDominates(call, consumer)
					) {
						const key = definitions.get(root(consumer.inputs[1]!));
						const index = key?.attributes.value;
						if (
							key?.opcode === "createNumber" &&
							typeof index === "number" &&
							Number.isInteger(index) &&
							index >= 0 &&
							index <= 0xffff &&
							!projectedIndices.has(index) &&
							instructionDominates(key, consumer)
						) {
							loads.push({ instruction: consumer, kind: "element", index, key });
							projectedIndices.add(index);
							continue;
						}
					}
					safe = false;
					break;
				}
				if (!safe || projectedIndices.size === 0 || projectedIndices.size > 8) continue;
				const order = (instruction: CoreInstruction): number => {
					const location = locations.get(instruction.id)!;
					return location.block.id * 0x1_0000 + location.index;
				};
				loads.sort((left, right) => order(left.instruction) - order(right.instruction));
				const claimed = [
					...(property === undefined ? [] : [property]),
					separator,
					call,
					...loads.flatMap(({ instruction, key }) =>
						key === undefined ? [instruction] : [key, instruction],
					),
				];
				const ordinaryBlocks = [
					...new Set(claimed.map(({ id }) => locations.get(id)!.block.id)),
				];
				if (
					new Set(claimed.map(({ id }) => id)).size !== claimed.length ||
					claimed.some(({ id }) => occupied.has(id)) ||
					claimed.some(({ id }) => locations.get(id)?.block.handler !== undefined) ||
					ordinaryBlocks.some((id) => handlerTargets.has(id))
				) {
					continue;
				}
				const obligations = [
					...builtin.proof.obligations,
					regionGenericTwin(
						"string-split-projection",
						builtin.sourceSite ?? fn.functionIndex,
					),
					{
						kind: "materialize",
						id: `string-split-projection:${builtin.sourceSite ?? fn.functionIndex}`,
						cause: "materialization",
					},
				];
				const claimedInstructions = claimed.map(({ id }) => id);
				const resultValues = fn.values
					.map(({ id }) => id)
					.filter((value) => root(value) === result);
				regions.push({
					kind: "string-split-projection",
					anchors: [call.id, loads[0]!.instruction.id],
					claimedInstructions,
					ordinaryBlocks,
					exceptionalBlocks: [],
					data: coreAttributeObject(
						{
							license: {
								guard: {
									dependencies: builtin.proof.dependencies,
									obligations,
								},
								genericTwin: "retained",
								materialization: "whole-region",
							},
							representation: "projected-elements",
							cost: {
								score: projectedIndices.size * 8 + loads.length,
								metadataOperations: claimedInstructions.length,
							},
							...(property === undefined
								? {}
								: { property: { $coreInstruction: property.id } }),
							propertyPlacement: corePropertyPlacement(
								fn,
								property,
								call,
								locations,
								uses,
								root,
								coreProofIsWorldInvariant(builtin.proof),
							),
							splitIdentity: coreProofIsWorldInvariant(builtin.proof)
								? "authority-invariant"
								: "runtime-guarded",
							separator: { $coreInstruction: separator.id },
							separatorStringIndex,
							resultRegisters: resultValues.map((value) => ({
								$coreValue: value,
							})),
							loads: loads.map((load) => ({
								instruction: { $coreInstruction: load.instruction.id },
								kind: load.kind,
								...(load.index === undefined ? {} : { index: load.index }),
								...(load.key === undefined
									? {}
									: { key: { $coreInstruction: load.key.id } }),
							})),
						},
						"string-split-projection",
					),
				});
				for (const { id } of claimed) occupied.add(id);
				if (
					regions.filter(({ kind }) => kind === "string-split-projection").length >= 8
				) {
					break;
				}
			}
		}
		return regions.length === fn.regions.length
			? fn
			: { ...fn, regions, mutationEpoch: fn.mutationEpoch + 1 };
	},
};

/** Select exact `String.prototype.slice` -> `%Number%` span conversion. */
const selectStringSliceNumberRegions: CoreFunctionPass = {
	name: "select-string-slice-number-regions",
	run(fn, analyses, program) {
		if (fn.regions.filter(({ kind }) => kind === "string-slice-number").length >= 8) {
			return fn;
		}
		const definitions = analyses.definitions(fn);
		const canonical = analyses.canonicalValues(fn);
		const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
		const uses = new Map<
			CoreValueId,
			Array<{
				readonly instruction: CoreInstruction;
				readonly position: number;
			}>
		>();
		const locations = new Map<
			CoreInstructionId,
			{ readonly block: CoreBlock; readonly index: number }
		>();
		const blocksByInstruction = new Map<CoreInstructionId, CoreBlock>();
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				blocksByInstruction.set(instruction.id, block);
				locations.set(instruction.id, { block, index });
				for (const [position, input] of instruction.inputs.entries()) {
					const key = root(input);
					const entries = uses.get(key) ?? [];
					entries.push({ instruction, position });
					uses.set(key, entries);
				}
			}
		}
		const occupied = new Set(
			fn.regions
				.filter(({ kind }) => kind !== "numeric-fusion")
				.flatMap(({ claimedInstructions }) => claimedInstructions),
		);
		const regions = [...fn.regions];
		for (const block of fn.blocks) {
			for (const sliceCall of block.instructions) {
				if (
					sliceCall.opcode !== "call" ||
					sliceCall.inputs.length !== 3 ||
					sliceCall.outputs.length !== 1
				) {
					continue;
				}
				const builtin = coreKnownBuiltinProof(sliceCall, "String.prototype.slice", {
					lowering: "number-consumer-fusion",
					result: "string",
				});
				if (builtin === undefined) continue;
				const property = definitions.get(root(sliceCall.inputs[0]!));
				if (
					property?.opcode !== "loadPropertyStatic" ||
					property.inputs.length !== 1 ||
					root(property.inputs[0]!) !== root(sliceCall.inputs[1]!) ||
					typeof property.attributes.stringIndex !== "number" ||
					decodeString(program, property.attributes.stringIndex) !== "slice" ||
					property.outputs.length !== 1
				) {
					continue;
				}
				const propertyUses = uses.get(root(property.outputs[0]!));
				const sliceUses = uses.get(root(sliceCall.outputs[0]!));
				if (
					propertyUses?.length !== 1 ||
					propertyUses[0]?.instruction !== sliceCall ||
					propertyUses[0].position !== 0 ||
					sliceUses?.length !== 1 ||
					sliceUses[0]?.position !== 2
				) {
					continue;
				}
				const numberCall = sliceUses[0].instruction;
				if (
					numberCall.opcode !== "call" ||
					numberCall.inputs.length !== 3 ||
					root(numberCall.inputs[2]!) !== root(sliceCall.outputs[0]!)
				) {
					continue;
				}
				const numberIntrinsic = definitions.get(root(numberCall.inputs[0]!));
				if (
					numberIntrinsic?.opcode !== "loadIntrinsic" ||
					numberIntrinsic.attributes.intrinsic !== "Number"
				) {
					continue;
				}
				const start = definitions.get(root(sliceCall.inputs[2]!));
				if (
					start === undefined ||
					(start.opcode !== "createNumber" && start.opcode !== "createF64")
				) {
					continue;
				}
				const sliceStart = start.attributes.value;
				if (typeof sliceStart !== "number" || !Number.isFinite(sliceStart)) continue;

				const claimed = [property, sliceCall, start, numberIntrinsic, numberCall];
				if (
					new Set(claimed.map(({ id }) => id)).size !== claimed.length ||
					claimed.some(({ id }) => occupied.has(id))
				) {
					continue;
				}
				const ordinaryBlocks = [
					...new Set(claimed.map(({ id }) => blocksByInstruction.get(id)!.id)),
				];
				const exceptionalBlocks = [
					...new Set(
						claimed.flatMap(({ id }) => {
							const handler = blocksByInstruction.get(id)?.handler;
							return handler === undefined ? [] : [handler.block];
						}),
					),
				];
				if (exceptionalBlocks.some((handler) => ordinaryBlocks.includes(handler))) {
					continue;
				}
				const claimedInstructions = claimed.map(({ id }) => id);
				regions.push({
					kind: "string-slice-number",
					anchors: [sliceCall.id, numberCall.id],
					claimedInstructions,
					ordinaryBlocks,
					exceptionalBlocks,
					data: coreAttributeObject(
						{
							license: {
								guard: {
									dependencies: builtin.proof.dependencies,
									obligations: [
										...builtin.proof.obligations,
										regionGenericTwin(
											"string-slice-number",
											builtin.sourceSite ?? fn.functionIndex,
										),
									],
								},
								genericTwin: "retained",
								materialization: "none",
							},
							representation: "primitive-string-span-number",
							cost: {
								score: 16,
								metadataOperations: claimedInstructions.length,
							},
							property: { $coreInstruction: property.id },
							propertyPlacement: corePropertyPlacement(
								fn,
								property,
								sliceCall,
								locations,
								uses,
								root,
								coreProofIsWorldInvariant(builtin.proof),
							),
							builtinIdentities: coreProofIsWorldInvariant(builtin.proof)
								? "authority-invariant"
								: "runtime-guarded",
							sliceStartInstruction: { $coreInstruction: start.id },
							numberIntrinsic: { $coreInstruction: numberIntrinsic.id },
							numberCall: { $coreInstruction: numberCall.id },
							sliceStart,
						},
						"string-slice-number",
					),
				});
				for (const { id } of claimed) occupied.add(id);
				if (regions.filter(({ kind }) => kind === "string-slice-number").length >= 8) {
					break;
				}
			}
		}
		return regions.length === fn.regions.length
			? fn
			: { ...fn, regions, mutationEpoch: fn.mutationEpoch + 1 };
	},
};

const selectStringCharCodeAtChainRegions: CoreFunctionPass = {
	name: "select-string-char-code-at-chain-regions",
	run(fn, analyses, program) {
		if (
			fn.regions.filter(({ kind }) => kind === "string-char-code-at-chain").length >= 8
		) {
			return fn;
		}
		const definitions = analyses.definitions(fn);
		const canonical = analyses.canonicalValues(fn);
		const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
		const uses = new Map<
			CoreValueId,
			Array<{ readonly instruction: CoreInstruction; readonly position: number }>
		>();
		const locations = new Map<
			CoreInstructionId,
			{ readonly block: CoreBlock; readonly index: number }
		>();
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				locations.set(instruction.id, { block, index });
				for (const [position, input] of instruction.inputs.entries()) {
					const entries = uses.get(root(input)) ?? [];
					entries.push({ instruction, position });
					uses.set(root(input), entries);
				}
			}
		}
		const occupied = new Set(
			fn.regions
				.filter(({ kind }) => kind !== "numeric-fusion")
				.flatMap(({ claimedInstructions }) => claimedInstructions),
		);
		const regions = [...fn.regions];
		for (const block of fn.blocks) {
			for (const call of block.instructions) {
				if (
					call.opcode !== "call" ||
					call.outputs.length !== 1 ||
					(call.inputs.length !== 2 && call.inputs.length !== 3)
				) {
					continue;
				}
				const builtin = coreKnownBuiltinProof(call, "String.prototype.charCodeAt", {
					lowering: "guarded-primitive-string",
					result: "number",
				});
				if (builtin === undefined) continue;
				const property = definitions.get(root(call.inputs[0]!));
				const propertyLocation =
					property === undefined ? undefined : locations.get(property.id);
				const callLocation = locations.get(call.id);
				if (
					property?.opcode !== "loadPropertyStatic" ||
					property.inputs.length !== 1 ||
					property.outputs.length !== 1 ||
					root(property.inputs[0]!) !== root(call.inputs[1]!) ||
					typeof property.attributes.stringIndex !== "number" ||
					decodeString(program, property.attributes.stringIndex) !== "charCodeAt" ||
					uses.get(root(property.outputs[0]!))?.length !== 1 ||
					uses.get(root(property.outputs[0]!))?.[0]?.instruction !== call ||
					uses.get(root(property.outputs[0]!))?.[0]?.position !== 0 ||
					propertyLocation === undefined ||
					callLocation === undefined ||
					propertyLocation.block !== callLocation.block ||
					propertyLocation.index >= callLocation.index ||
					occupied.has(property.id) ||
					occupied.has(call.id)
				) {
					continue;
				}
				const claimedInstructions = [property.id, call.id];
				const handler = block.handler;
				regions.push({
					kind: "string-char-code-at-chain",
					anchors: claimedInstructions,
					claimedInstructions,
					ordinaryBlocks: [block.id],
					exceptionalBlocks: handler === undefined ? [] : [handler.block],
					data: coreAttributeObject(
						{
							license: {
								guard: {
									dependencies: builtin.proof.dependencies,
									obligations: [
										...builtin.proof.obligations,
										regionGenericTwin(
											"string-char-code-at-chain",
											builtin.sourceSite ?? fn.functionIndex,
										),
									],
								},
								genericTwin: "retained",
								materialization: "none",
							},
							representation: "primitive-string-code-unit",
							cost: { score: 12, metadataOperations: 2 },
							property: { $coreInstruction: property.id },
							call: { $coreInstruction: call.id },
							methodIdentity: coreProofIsWorldInvariant(builtin.proof)
								? "authority-invariant"
								: "runtime-guarded",
							runtimeGuard: "primitive-string-number-position",
							evaluationOrder: "capture-property-before-arguments",
						},
						"string-char-code-at-chain",
					),
				});
				occupied.add(property.id);
				occupied.add(call.id);
				if (
					regions.filter(({ kind }) => kind === "string-char-code-at-chain").length >= 8
				) {
					break;
				}
			}
		}
		return regions.length === fn.regions.length
			? fn
			: { ...fn, regions, mutationEpoch: fn.mutationEpoch + 1 };
	},
};

const COLLECTION_CALL_CHAIN_OPERATIONS = new Set([
	"Map.prototype.get",
	"Map.prototype.set",
	"Map.prototype.has",
	"Map.prototype.delete",
	"Set.prototype.add",
	"Set.prototype.has",
	"Set.prototype.delete",
]);

const selectBuiltinCollectionCallChainRegions: CoreFunctionPass = {
	name: "select-builtin-collection-call-chain-regions",
	run(fn, analyses, program) {
		const definitions = analyses.definitions(fn);
		const canonical = analyses.canonicalValues(fn);
		const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
		const uses = new Map<CoreValueId, Array<CoreInstruction>>();
		const locations = new Map<
			CoreInstructionId,
			{ readonly block: CoreBlock; readonly index: number }
		>();
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				locations.set(instruction.id, { block, index });
				for (const input of instruction.inputs) {
					const entries = uses.get(root(input)) ?? [];
					entries.push(instruction);
					uses.set(root(input), entries);
				}
			}
		}
		const occupied = new Set(
			fn.regions
				.filter(({ kind }) => kind !== "numeric-fusion")
				.flatMap(({ claimedInstructions }) => claimedInstructions),
		);
		const regions = [...fn.regions];
		for (const block of fn.blocks) {
			for (const call of block.instructions) {
				if (
					call.opcode !== "call" ||
					call.outputs.length !== 1 ||
					call.inputs.length < 2
				) {
					continue;
				}
				const operation = attributeObject(call.attributes.knownBuiltinCall)?.operation;
				if (
					typeof operation !== "string" ||
					!COLLECTION_CALL_CHAIN_OPERATIONS.has(operation)
				) {
					continue;
				}
				const builtin = coreKnownBuiltinProof(call, operation, {
					lowering: "guarded-native-collection",
				});
				if (builtin === undefined) continue;
				const property = definitions.get(root(call.inputs[0]!));
				const propertyLocation =
					property === undefined ? undefined : locations.get(property.id);
				const callLocation = locations.get(call.id);
				if (
					property?.opcode !== "loadPropertyStatic" ||
					property.inputs.length !== 1 ||
					property.outputs.length !== 1 ||
					root(property.inputs[0]!) !== root(call.inputs[1]!) ||
					typeof property.attributes.stringIndex !== "number" ||
					decodeString(program, property.attributes.stringIndex) !==
						operation.split(".").at(-1) ||
					uses.get(root(property.outputs[0]!))?.length !== 1 ||
					uses.get(root(property.outputs[0]!))?.[0] !== call ||
					propertyLocation === undefined ||
					callLocation === undefined ||
					propertyLocation.block !== callLocation.block ||
					propertyLocation.index >= callLocation.index ||
					occupied.has(property.id) ||
					occupied.has(call.id)
				) {
					continue;
				}
				const claimedInstructions = [property.id, call.id];
				regions.push({
					kind: "builtin-collection-call-chain",
					anchors: claimedInstructions,
					claimedInstructions,
					ordinaryBlocks: [block.id],
					exceptionalBlocks: block.handler === undefined ? [] : [block.handler.block],
					data: coreAttributeObject(
						{
							license: {
								guard: {
									dependencies: builtin.proof.dependencies,
									obligations: [
										...builtin.proof.obligations,
										regionGenericTwin(
											"builtin-collection-call-chain",
											builtin.sourceSite ?? fn.functionIndex,
										),
									],
								},
								genericTwin: "retained",
								materialization: "none",
							},
							representation: "captured-collection-method",
							cost: { score: 14, metadataOperations: 2 },
							property: { $coreInstruction: property.id },
							call: { $coreInstruction: call.id },
							operation,
							runtimeGuard: "exact-collection-method",
							evaluationOrder: "capture-property-before-arguments",
						},
						"builtin-collection-call-chain",
					),
				});
				occupied.add(property.id);
				occupied.add(call.id);
				if (
					regions.filter(({ kind }) => kind === "builtin-collection-call-chain").length >=
					8
				) {
					break;
				}
			}
		}
		return regions.length === fn.regions.length
			? fn
			: { ...fn, regions, mutationEpoch: fn.mutationEpoch + 1 };
	},
};

type CoreIteratorCursorKind =
	| "array-values-iterator-cursor"
	| "string-iterator-cursor"
	| "typed-array-iterator-cursor"
	| "map-iterator-cursor"
	| "set-iterator-cursor";

const CORE_ITERATOR_CURSOR_PROTOCOL = {
	"array-values-iterator-cursor": {
		representation: "array-values-authoritative-cursor",
		protocol: "array-values",
	},
	"string-iterator-cursor": {
		representation: "string-authoritative-cursor",
		protocol: "string",
	},
	"typed-array-iterator-cursor": {
		representation: "typed-array-authoritative-cursor",
		protocol: "typed-array-values",
	},
	"map-iterator-cursor": {
		representation: "map-authoritative-cursor",
		protocol: "map",
	},
	"set-iterator-cursor": {
		representation: "set-authoritative-cursor",
		protocol: "set",
	},
} as const satisfies Record<CoreIteratorCursorKind, Readonly<Record<string, string>>>;

const selectIteratorCursorRegions: CoreFunctionPass = {
	name: "select-iterator-cursor-regions",
	run(fn, analyses) {
		if (fn.isGenerator || fn.isAsync) return fn;
		const canonical = analyses.canonicalValues(fn);
		const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
		const definitions = analyses.definitions(fn);
		const representations = analyses.representations(fn);
		const locations = new Map<CoreInstructionId, CoreBlock>();
		const stepsByInput = new Map<CoreValueId, Array<CoreInstruction>>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				locations.set(instruction.id, block);
				if (instruction.opcode !== "iteratorStep") continue;
				const iterator = instruction.inputs[0];
				if (iterator === undefined) continue;
				const steps = stepsByInput.get(root(iterator)) ?? [];
				steps.push(instruction);
				stepsByInput.set(root(iterator), steps);
			}
		}
		const occupied = new Set(
			fn.regions
				.filter(({ kind }) => kind !== "numeric-fusion")
				.flatMap(({ claimedInstructions }) => claimedInstructions),
		);
		const regions = [...fn.regions];
		for (const block of fn.blocks) {
			for (const initialize of block.instructions) {
				if (
					initialize.opcode !== "getIterator" ||
					initialize.inputs.length !== 1 ||
					initialize.outputs.length !== 2 ||
					occupied.has(initialize.id)
				) {
					continue;
				}
				const iterator = root(initialize.outputs[0]!);
				const next = root(initialize.outputs[1]!);
				const steps = (stepsByInput.get(iterator) ?? []).filter(
					(step) => root(step.inputs[1]!) === next && !occupied.has(step.id),
				);
				if (steps.length === 0 || steps.length > 32) continue;
				const source = root(initialize.inputs[0]!);
				const sourceDefinition = definitions.get(source);
				const exactTypedArray = sourceDefinition?.attributes.exactTypedArrayKind;
				const exactCollection = sourceDefinition?.attributes.exactCollectionReceiver;
				const constructor =
					sourceDefinition?.opcode === "construct"
						? definitions.get(root(sourceDefinition.inputs[0]!))
						: undefined;
				const intrinsic =
					constructor?.opcode === "loadIntrinsic"
						? constructor.attributes.intrinsic
						: undefined;
				const typedArrayIntrinsic =
					typeof intrinsic === "string" &&
					[
						"Int8Array",
						"Uint8Array",
						"Uint8ClampedArray",
						"Int16Array",
						"Uint16Array",
						"Int32Array",
						"Uint32Array",
						"Float32Array",
						"Float64Array",
						"BigInt64Array",
						"BigUint64Array",
					].includes(intrinsic);
				const kind: CoreIteratorCursorKind =
					representations.get(source) === "string"
						? "string-iterator-cursor"
						: typeof exactTypedArray === "string" || typedArrayIntrinsic
							? "typed-array-iterator-cursor"
							: exactCollection === "Map" || intrinsic === "Map"
								? "map-iterator-cursor"
								: exactCollection === "Set" || intrinsic === "Set"
									? "set-iterator-cursor"
									: "array-values-iterator-cursor";
				const strategy = CORE_ITERATOR_CURSOR_PROTOCOL[kind];
				const claimedInstructions = [initialize.id, ...steps.map(({ id }) => id)];
				const ordinaryBlocks = [
					...new Set(claimedInstructions.map((id) => locations.get(id)!.id)),
				];
				const exceptionalBlocks = [
					...new Set(
						claimedInstructions.flatMap((id) => {
							const handler = locations.get(id)?.handler;
							return handler === undefined ? [] : [handler.block];
						}),
					),
				];
				regions.push({
					kind,
					anchors: [initialize.id, steps[0]!.id],
					claimedInstructions,
					ordinaryBlocks,
					exceptionalBlocks,
					data: coreAttributeObject(
						{
							license: {
								guard: "structural",
								genericTwin: "retained",
								materialization: "none",
							},
							representation: strategy.representation,
							cost: {
								score: steps.length * 8,
								metadataOperations: claimedInstructions.length,
							},
							initialize: { $coreInstruction: initialize.id },
							steps: steps.map((step) => ({ $coreInstruction: step.id })),
							protocol: strategy.protocol,
							runtimeGuard: "exact-iterator-brand-next-target",
							stateSynchronization: "authoritative-language-object",
							suspension: "forbidden",
						},
						kind,
					),
				});
				for (const instruction of claimedInstructions) occupied.add(instruction);
			}
		}
		return regions.length === fn.regions.length
			? fn
			: { ...fn, regions, mutationEpoch: fn.mutationEpoch + 1 };
	},
};

const selectIteratorResultVirtualizationRegions: CoreFunctionPass = {
	name: "select-iterator-result-virtualization-regions",
	run(fn) {
		const alreadyClaimed = new Set(
			fn.regions
				.filter(({ kind }) => kind === "iterator-result-virtualization")
				.flatMap(({ claimedInstructions }) => claimedInstructions),
		);
		const locations = new Map<CoreInstructionId, CoreBlock>();
		const steps: Array<CoreInstruction> = [];
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				locations.set(instruction.id, block);
				if (
					instruction.opcode === "iteratorStep" &&
					!alreadyClaimed.has(instruction.id)
				) {
					steps.push(instruction);
				}
			}
		}
		if (steps.length === 0) return fn;
		const regions = [...fn.regions];
		for (let offset = 0; offset < steps.length; offset += 64) {
			const shard = steps.slice(offset, offset + 64);
			const claimedInstructions = shard.map(({ id }) => id);
			const ordinaryBlocks = [...new Set(shard.map(({ id }) => locations.get(id)!.id))];
			const exceptionalBlocks = [
				...new Set(
					shard.flatMap(({ id }) => {
						const handler = locations.get(id)?.handler;
						return handler === undefined ? [] : [handler.block];
					}),
				),
			];
			const site = shard[0]!.id;
			regions.push({
				kind: "iterator-result-virtualization",
				anchors: [site],
				claimedInstructions,
				ordinaryBlocks,
				exceptionalBlocks,
				data: coreAttributeObject(
					{
						license: {
							guard: {
								dependencies: [],
								obligations: [
									regionGenericTwin("iterator-result-virtualization", site),
									{
										kind: "materialize",
										id: `iterator-result-virtualization:${fn.functionIndex}:${site}`,
										cause: "materialization",
									},
								],
							},
							genericTwin: "retained",
							materialization: "on-demand",
						},
						representation: "virtual-iterator-result",
						composition: "overlay",
						cost: {
							score: shard.length * 6,
							metadataOperations: shard.length,
						},
						steps: shard.map(({ id }) => ({ $coreInstruction: id })),
						runtimeGuard: "exact-builtin-iterator-next",
						correspondence: "done-value-observation",
						fallback: "materialize-result-then-observe",
					},
					"iterator-result-virtualization",
				),
			});
		}
		return { ...fn, regions, mutationEpoch: fn.mutationEpoch + 1 };
	},
};

function origin(
	value: CoreValueId,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreValueId {
	return environment.get(value) ?? value;
}

function enterEdge(
	fn: CoreFunction,
	edge: CoreEdge,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
): {
	readonly block: CoreBlock;
	readonly environment: ReadonlyMap<CoreValueId, CoreValueId>;
} {
	const block = fn.blocks[edge.block];
	if (block === undefined) throw new Error(`Unknown Core edge target ${edge.block}`);
	const next = new Map<CoreValueId, CoreValueId>();
	for (const [index, parameter] of block.parameters.entries()) {
		next.set(parameter.value, origin(edge.arguments[index]!, environment));
	}
	return { block, environment: next };
}

function exactNumberTest(
	block: CoreBlock,
	condition: CoreValueId,
	subject: CoreValueId,
	value: number,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
	instructions: ReadonlyArray<CoreInstruction>,
): boolean {
	if (instructions.length !== 2) return false;
	const [constant, compare] = instructions;
	return (
		constant?.opcode === "createNumber" &&
		instructionAttribute(constant, "value") === value &&
		constant.outputs.length === 1 &&
		compare?.opcode === "binary" &&
		instructionAttribute(compare, "operator") === "===" &&
		compare.outputs.length === 1 &&
		compare.outputs[0] === condition &&
		compare.inputs.length === 2 &&
		origin(compare.inputs[0]!, environment) === subject &&
		compare.inputs[1] === constant.outputs[0] &&
		block.terminator.kind === "branch"
	);
}

function edgeTerminatesWith(
	fn: CoreFunction,
	edge: CoreEdge,
	kind: "return" | "throw",
	value: CoreValueId,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
): boolean {
	const target = enterEdge(fn, edge, environment);
	return (
		target.block.instructions.length === 0 &&
		target.block.terminator.kind === kind &&
		origin(target.block.terminator.value, target.environment) === value
	);
}

function edgeReturnsUndefined(
	fn: CoreFunction,
	edge: CoreEdge,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
): boolean {
	let state = enterEdge(fn, edge, environment);
	const visited = new Set<CoreBlockId>();
	while (
		state.block.instructions.length === 0 &&
		state.block.terminator.kind === "jump"
	) {
		if (visited.has(state.block.id)) return false;
		visited.add(state.block.id);
		state = enterEdge(fn, state.block.terminator.edge, state.environment);
	}
	const [created] = state.block.instructions;
	return (
		state.block.instructions.length === 1 &&
		created?.opcode === "createUndefined" &&
		created.outputs.length === 1 &&
		state.block.terminator.kind === "return" &&
		state.block.terminator.value === created.outputs[0]
	);
}

/**
 * Prove the canonical synchronous-generator tail protocol in explicit CFG form.
 * The proof is intentionally exact: any cleanup, handler, additional use, or
 * observable continuation makes the yield resumable.
 */
const annotateTerminalYieldSites: CoreFunctionPass = {
	name: "annotate-terminal-yield-sites",
	run(fn) {
		if (
			!fn.isGenerator ||
			fn.isAsync ||
			fn.blocks.some(
				(block) =>
					block.handler !== undefined ||
					block.parameters.some(({ role }) => role === "exception"),
			)
		) {
			return fn;
		}
		const terminal = new Set<number>();
		for (const block of fn.blocks) {
			if (block.terminator.kind !== "branch") continue;
			for (const [index, instruction] of block.instructions.entries()) {
				if (
					instruction.opcode !== "yield" ||
					instruction.outputs.length !== 2 ||
					instruction.inputs.length !== 1
				) {
					continue;
				}
				const [yieldedValue, resumeMode] = instruction.outputs;
				const rootEnvironment = new Map<CoreValueId, CoreValueId>();
				if (
					!exactNumberTest(
						block,
						block.terminator.condition,
						resumeMode!,
						1,
						rootEnvironment,
						block.instructions.slice(index + 1),
					) ||
					!edgeTerminatesWith(
						fn,
						block.terminator.consequent,
						"throw",
						yieldedValue!,
						rootEnvironment,
					)
				) {
					continue;
				}
				const resumed = enterEdge(fn, block.terminator.alternate, rootEnvironment);
				if (resumed.block.terminator.kind !== "branch") continue;
				if (
					!exactNumberTest(
						resumed.block,
						resumed.block.terminator.condition,
						resumeMode!,
						2,
						resumed.environment,
						resumed.block.instructions,
					) ||
					!edgeTerminatesWith(
						fn,
						resumed.block.terminator.consequent,
						"return",
						yieldedValue!,
						resumed.environment,
					) ||
					!edgeReturnsUndefined(
						fn,
						resumed.block.terminator.alternate,
						resumed.environment,
					)
				) {
					continue;
				}
				if (instructionAttribute(instruction, "terminal") !== true) {
					terminal.add(instruction.id);
				}
			}
		}
		if (terminal.size === 0) return fn;
		return {
			...fn,
			blocks: fn.blocks.map((block) => ({
				...block,
				instructions: block.instructions.map((instruction) => {
					if (!terminal.has(instruction.id)) return instruction;
					return {
						...instruction,
						attributes: { ...instruction.attributes, terminal: true },
					};
				}),
			})),
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

function exactStringConstantIndex(
	program: CoreProgram,
	value: string,
): number | undefined {
	const index = program.stringConstants.findIndex(
		(units) =>
			units.length === value.length &&
			units.every((unit, offset) => unit === value.charCodeAt(offset)),
	);
	return index < 0 ? undefined : index;
}

/**
 * Preserve object identity as an SSA fact instead of rediscovering it in every
 * escape optimization. A fresh ordinary object has stable `typeof` and identity
 * semantics even when its allocation must remain observable for OOM behavior.
 */
const foldExactObjectObservations: CoreFunctionPass = {
	name: "fold-exact-object-observations",
	ablation: "constant-folding",
	run(fn, analyses, program) {
		const origins = new Map<CoreValueId, CoreInstructionId>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					(instruction.opcode === "createObject" ||
						instruction.opcode === "createObjectShaped") &&
					instruction.outputs.length === 1
				) {
					origins.set(instruction.outputs[0]!, instruction.id);
				}
			}
		}
		if (origins.size === 0) return fn;
		const cfg = analyses.controlFlow(fn);
		let propagated = true;
		while (propagated) {
			propagated = false;
			for (const block of fn.blocks) {
				for (const instruction of block.instructions) {
					if (
						instruction.opcode !== "move" ||
						instruction.inputs.length !== 1 ||
						instruction.outputs.length !== 1
					) {
						continue;
					}
					const allocation = origins.get(instruction.inputs[0]!);
					if (allocation !== undefined && !origins.has(instruction.outputs[0]!)) {
						origins.set(instruction.outputs[0]!, allocation);
						propagated = true;
					}
				}
				const incoming = cfg.predecessors[block.id]!;
				if (incoming.length === 0 || incoming.some(({ kind }) => kind !== "ordinary")) {
					continue;
				}
				for (const [index, parameter] of block.parameters.entries()) {
					if (origins.has(parameter.value)) continue;
					const first = origins.get(incoming[0]!.arguments[index]!);
					if (
						first !== undefined &&
						incoming.every((edge) => origins.get(edge.arguments[index]!) === first)
					) {
						origins.set(parameter.value, first);
						propagated = true;
					}
				}
			}
		}

		const objectStringIndex = exactStringConstantIndex(program, "object");
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					if (
						instruction.opcode === "typeofCompare" &&
						instruction.inputs.length === 1 &&
						origins.has(instruction.inputs[0]!)
					) {
						const expected = instructionAttribute(instruction, "expected");
						const negated = instructionAttribute(instruction, "negated") === true;
						changed = true;
						return withoutEffectRefinement({
							...instruction,
							opcode: "createBoolean",
							inputs: [],
							attributes: { value: (expected === "object") !== negated },
						});
					}
					if (
						objectStringIndex !== undefined &&
						instruction.opcode === "unary" &&
						instructionAttribute(instruction, "operator") === "typeof" &&
						instruction.inputs.length === 1 &&
						origins.has(instruction.inputs[0]!)
					) {
						changed = true;
						return withoutEffectRefinement({
							...instruction,
							opcode: "createString",
							inputs: [],
							attributes: { stringIndex: objectStringIndex },
						});
					}
					if (instruction.opcode !== "binary" || instruction.inputs.length !== 2) {
						return instruction;
					}
					const operator = instructionAttribute(instruction, "operator");
					if (
						operator !== "===" &&
						operator !== "!==" &&
						operator !== "==" &&
						operator !== "!="
					) {
						return instruction;
					}
					const left = origins.get(instruction.inputs[0]!);
					const right = origins.get(instruction.inputs[1]!);
					if (left === undefined || right === undefined) return instruction;
					const equal = left === right;
					changed = true;
					return withoutEffectRefinement({
						...instruction,
						opcode: "createBoolean",
						inputs: [],
						attributes: {
							value: operator === "!==" || operator === "!=" ? !equal : equal,
						},
					});
				}),
			}),
		);
		return changed ? { ...fn, blocks, mutationEpoch: fn.mutationEpoch + 1 } : fn;
	},
};

const MAY_PRODUCE_EMPTY_OPCODES = new Set([
	"createEmpty",
	"loadCaptured",
	"loadGlobal",
	"loadLocal",
	// Ordinary JavaScript properties cannot expose Empty, but compiler-owned
	// hidden cells can. In particular, a derived constructor stores Empty in its
	// shared lexical-this cell until super() binds the receiver.
	"loadProperty",
	"loadPropertyStatic",
	"loadPropertyStaticShapeCase",
]);

function coreMaybeEmptyValues(
	fn: CoreFunction,
	cfg: CoreControlFlow,
	definitelyInitializedLoads: ReadonlySet<CoreInstructionId> = new Set(),
): Uint8Array {
	const valueCount = (fn.values.at(-1)?.id ?? -1) + 1;
	const maybeEmpty = new Uint8Array(valueCount);
	const dependencies = new Array<Array<CoreValueId> | undefined>(valueCount);
	const pending: Array<CoreValueId> = [];
	const markMaybeEmpty = (value: CoreValueId): void => {
		if (maybeEmpty[value] !== 0) return;
		maybeEmpty[value] = 1;
		pending.push(value);
	};
	const addDependency = (source: CoreValueId, destination: CoreValueId): void => {
		const targets = dependencies[source] ?? (dependencies[source] = []);
		targets.push(destination);
	};
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				(MAY_PRODUCE_EMPTY_OPCODES.has(instruction.opcode) &&
					!definitelyInitializedLoads.has(instruction.id)) ||
				(instruction.opcode === "loadThis" && fn.metadata.isDerivedConstructor)
			) {
				for (const output of instruction.outputs) markMaybeEmpty(output);
			}
			if (instruction.opcode === "move" || instruction.opcode === "setThis") {
				for (const input of instruction.inputs) {
					for (const output of instruction.outputs) addDependency(input, output);
				}
			}
		}
		const incoming = cfg.predecessors[block.id]!;
		for (const [index, parameter] of block.parameters.entries()) {
			if (parameter.role === "exception") continue;
			for (const edge of incoming) {
				const argumentIndex =
					edge.kind === "exceptional" && block.parameters[0]?.role === "exception"
						? index - 1
						: index;
				const argument = argumentIndex < 0 ? undefined : edge.arguments[argumentIndex];
				if (argument === undefined) markMaybeEmpty(parameter.value);
				else addDependency(argument, parameter.value);
			}
		}
	}
	while (pending.length > 0) {
		const source = pending.pop()!;
		for (const destination of dependencies[source] ?? []) {
			markMaybeEmpty(destination);
		}
	}
	return maybeEmpty;
}

function closedWorldInitializedBindingLoads(
	fn: CoreFunction,
	analyses: CoreAnalysisManager,
	baselineMaybeEmpty: Uint8Array,
): ReadonlySet<CoreInstructionId> {
	if (analyses.context?.facts.closure.sourceClosure.kind !== "known") return new Set();

	const accessesByInstruction = new Map<
		CoreInstructionId,
		ReadonlyArray<CoreMemoryAccess>
	>();
	const cellIndices = new Map<string, number>();
	const bindingCellKey = (access: CoreMemoryAccess): string | undefined => {
		const location = access.location;
		return location.kind === "global-slot"
			? `global\0${location.slot}`
			: location.kind === "local-slot"
				? `local\0${location.slot}`
				: undefined;
	};
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			const accesses = coreMemoryAccesses(instruction);
			accessesByInstruction.set(instruction.id, accesses);
			for (const access of accesses) {
				if (access.mode !== "read" || access.result === undefined) continue;
				const key = bindingCellKey(access);
				if (key !== undefined && !cellIndices.has(key)) {
					cellIndices.set(key, cellIndices.size);
				}
			}
		}
	}
	if (cellIndices.size === 0) return new Set();

	const reads = new Map<CoreInstructionId, Array<number>>();
	const writes = new Map<
		CoreInstructionId,
		Array<{ readonly cell: number; readonly value?: CoreValueId }>
	>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			for (const access of accessesByInstruction.get(instruction.id) ?? []) {
				const key = bindingCellKey(access);
				const cell = key === undefined ? undefined : cellIndices.get(key);
				if (cell === undefined) continue;
				if (access.mode === "read" && access.result !== undefined) {
					const cells = reads.get(instruction.id) ?? [];
					cells.push(cell);
					reads.set(instruction.id, cells);
				} else if (access.mode === "write") {
					const cells = writes.get(instruction.id) ?? [];
					cells.push({
						cell,
						...(access.value === undefined ? {} : { value: access.value }),
					});
					writes.set(instruction.id, cells);
				}
			}
		}
	}

	const wordCount = Math.ceil(cellIndices.size / 32);
	const entries = fn.blocks.map(() => new Uint32Array(wordCount));
	const exits = fn.blocks.map(() => new Uint32Array(wordCount));
	const lastWordMask =
		cellIndices.size % 32 === 0
			? 0xffffffff
			: 0xffffffff >>> (32 - (cellIndices.size % 32));
	const fillTop = (state: Uint32Array): void => {
		state.fill(0xffffffff);
		state[wordCount - 1] = lastWordMask;
	};
	const cfg = analyses.controlFlow(fn);
	for (const block of fn.blocks) {
		if (!cfg.reachable.has(block.id) || block.id === fn.entry) continue;
		fillTop(entries[block.id]!);
		fillTop(exits[block.id]!);
	}
	const hasCell = (state: Uint32Array, cell: number): boolean =>
		(state[cell >>> 5]! & (1 << (cell & 31))) !== 0;
	const updateCell = (state: Uint32Array, cell: number, initialized: boolean): void => {
		const word = cell >>> 5;
		const mask = 1 << (cell & 31);
		if (initialized) state[word] = state[word]! | mask;
		else state[word] = state[word]! & ~mask;
	};
	const applyWrites = (state: Uint32Array, instruction: CoreInstruction): void => {
		for (const write of writes.get(instruction.id) ?? []) {
			updateCell(
				state,
				write.cell,
				write.value !== undefined && baselineMaybeEmpty[write.value] === 0,
			);
		}
	};
	const replaceIfDifferent = (target: Uint32Array, source: Uint32Array): boolean => {
		let changed = false;
		for (let word = 0; word < wordCount; word++) {
			if (target[word] === source[word]) continue;
			target[word] = source[word]!;
			changed = true;
		}
		return changed;
	};
	const nextEntry = new Uint32Array(wordCount);
	const nextExit = new Uint32Array(wordCount);
	// Source-closed calls may replace a binding's JavaScript value, but only an
	// explicit Core write can manufacture Empty and restore its uninitialized state.
	let changed = true;
	while (changed) {
		changed = false;
		for (const blockId of cfg.reversePostorder) {
			const block = fn.blocks[blockId]!;
			if (blockId === fn.entry) {
				nextEntry.fill(0);
			} else {
				fillTop(nextEntry);
				let predecessorCount = 0;
				for (const edge of cfg.predecessors[blockId]!) {
					if (!cfg.reachable.has(edge.from)) continue;
					predecessorCount++;
					const source =
						edge.kind === "exceptional" ? entries[edge.from]! : exits[edge.from]!;
					for (let word = 0; word < wordCount; word++) {
						nextEntry[word] = nextEntry[word]! & source[word]!;
					}
				}
				if (predecessorCount === 0) nextEntry.fill(0);
			}
			changed = replaceIfDifferent(entries[blockId]!, nextEntry) || changed;
			nextExit.set(nextEntry);
			for (const instruction of block.instructions) applyWrites(nextExit, instruction);
			changed = replaceIfDifferent(exits[blockId]!, nextExit) || changed;
		}
	}

	const initializedLoads = new Set<CoreInstructionId>();
	const state = new Uint32Array(wordCount);
	for (const blockId of cfg.reversePostorder) {
		state.set(entries[blockId]!);
		for (const instruction of fn.blocks[blockId]!.instructions) {
			const readCells = reads.get(instruction.id);
			if (readCells !== undefined && readCells.every((cell) => hasCell(state, cell))) {
				initializedLoads.add(instruction.id);
			}
			applyWrites(state, instruction);
		}
	}
	return initializedLoads;
}

/**
 * Empty is an internal TDZ sentinel, not a JavaScript value. Core SSA makes its
 * provenance explicit, so remove a check only when no incoming definition can
 * carry that sentinel. Cyclic phis start non-empty and become maybe-empty only
 * when a real Empty-producing source reaches the cycle.
 */
const eliminateRedundantTdzChecks: CoreFunctionPass = {
	name: "eliminate-redundant-tdz-checks",
	changesControlFlow: true,
	run(fn, analyses) {
		if (
			!fn.blocks.some((block) =>
				block.instructions.some(({ opcode }) => opcode === "throwIfTdz"),
			)
		) {
			return fn;
		}
		const cfg = analyses.controlFlow(fn);
		const baselineMaybeEmpty = coreMaybeEmptyValues(fn, cfg);
		const definitelyInitializedLoads = closedWorldInitializedBindingLoads(
			fn,
			analyses,
			baselineMaybeEmpty,
		);
		const maybeEmpty =
			definitelyInitializedLoads.size === 0
				? baselineMaybeEmpty
				: coreMaybeEmptyValues(fn, cfg, definitelyInitializedLoads);

		let removed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.filter((instruction) => {
					if (
						instruction.opcode === "throwIfTdz" &&
						instruction.inputs.length === 1 &&
						maybeEmpty[instruction.inputs[0]!] === 0
					) {
						removed = true;
						return false;
					}
					return true;
				}),
			}),
		);
		if (!removed) return fn;
		// A TDZ check can be the last throwing instruction covered by a handler.
		// Removing it also removes Core's exceptional edge, so immediately restore
		// the verifier invariant that every retained block is reachable.
		return removeUnreachableCoreBlocks({
			...fn,
			blocks,
			mutationEpoch: fn.mutationEpoch + 1,
		});
	},
};

const TYPEOF_RESULTS = new Set([
	"undefined",
	"object",
	"boolean",
	"number",
	"string",
	"symbol",
	"bigint",
	"function",
]);

/** Collapse the allocating `typeof` string corridor into Core's exact predicate. */
const foldTypeofComparisons: CoreFunctionPass = {
	name: "fold-typeof-comparisons",
	ablation: "constant-folding",
	run(fn, _analyses, program) {
		const definitions = new Map<CoreValueId, CoreInstruction>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				for (const output of instruction.outputs) definitions.set(output, instruction);
			}
		}
		const stringValue = (instruction: CoreInstruction): string | undefined => {
			if (instruction.opcode !== "createString") return undefined;
			const index = instructionAttribute(instruction, "stringIndex");
			if (typeof index !== "number") return undefined;
			const units = program.stringConstants[index];
			return units === undefined ? undefined : String.fromCharCode(...units);
		};
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					if (instruction.opcode !== "binary" || instruction.inputs.length !== 2) {
						return instruction;
					}
					const operator = instructionAttribute(instruction, "operator");
					if (
						operator !== "===" &&
						operator !== "!==" &&
						operator !== "==" &&
						operator !== "!="
					) {
						return instruction;
					}
					const left = definitions.get(instruction.inputs[0]!);
					const right = definitions.get(instruction.inputs[1]!);
					const unary =
						left?.opcode === "unary" &&
						instructionAttribute(left, "operator") === "typeof"
							? left
							: right?.opcode === "unary" &&
								  instructionAttribute(right, "operator") === "typeof"
								? right
								: undefined;
					const constant = unary === left ? right : unary === right ? left : undefined;
					const expected = constant === undefined ? undefined : stringValue(constant);
					if (
						unary === undefined ||
						unary.inputs.length !== 1 ||
						expected === undefined ||
						!TYPEOF_RESULTS.has(expected)
					) {
						return instruction;
					}
					changed = true;
					return withoutEffectRefinement({
						...instruction,
						opcode: "typeofCompare",
						inputs: [unary.inputs[0]!],
						attributes: {
							expected,
							negated: operator === "!==" || operator === "!=",
						},
					});
				}),
			}),
		);
		return changed ? { ...fn, blocks, mutationEpoch: fn.mutationEpoch + 1 } : fn;
	},
};

function exactTypeofResult(mask: CompilerValueKindMask): string | undefined {
	switch (mask) {
		case COMPILER_VALUE_KIND_UNDEFINED:
			return "undefined";
		case COMPILER_VALUE_KIND_NULL:
			return "object";
		case COMPILER_VALUE_KIND_BOOLEAN:
			return "boolean";
		case COMPILER_VALUE_KIND_NUMBER:
			return "number";
		case COMPILER_VALUE_KIND_STRING:
			return "string";
		case COMPILER_VALUE_KIND_SYMBOL:
			return "symbol";
		case COMPILER_VALUE_KIND_BIGINT:
			return "bigint";
		default:
			return undefined;
	}
}

function exactTypeofComparison(
	mask: CompilerValueKindMask,
	expected: unknown,
): boolean | undefined {
	const exact = exactTypeofResult(mask);
	if (exact !== undefined) return exact === expected;
	const primitive =
		expected === "undefined"
			? COMPILER_VALUE_KIND_UNDEFINED
			: expected === "boolean"
				? COMPILER_VALUE_KIND_BOOLEAN
				: expected === "number"
					? COMPILER_VALUE_KIND_NUMBER
					: expected === "string"
						? COMPILER_VALUE_KIND_STRING
						: expected === "symbol"
							? COMPILER_VALUE_KIND_SYMBOL
							: expected === "bigint"
								? COMPILER_VALUE_KIND_BIGINT
								: undefined;
	if (primitive !== undefined) return (mask & primitive) === 0 ? false : undefined;
	if (expected === "object") {
		return (mask & (COMPILER_VALUE_KIND_NULL | COMPILER_VALUE_KIND_OBJECT)) === 0
			? false
			: undefined;
	}
	return expected === "function" && (mask & COMPILER_VALUE_KIND_OBJECT) === 0
		? false
		: undefined;
}

function exactKindTruthiness(mask: CompilerValueKindMask): boolean | undefined {
	const alwaysFalsy = COMPILER_VALUE_KIND_UNDEFINED | COMPILER_VALUE_KIND_NULL;
	if ((mask & ~alwaysFalsy) === 0) return false;
	if ((mask & ~COMPILER_VALUE_KIND_SYMBOL) === 0) return true;
	return undefined;
}

/** Consume closed whole-program value kinds while Core can still simplify users. */
const foldWholeProgramValueKinds: CoreFunctionPass = {
	name: "fold-whole-program-value-kinds",
	ablation: "fact-driven",
	dependsOnProgram: true,
	preservesValueKinds: true,
	run(fn, analyses, program) {
		const valueKinds = analyses.valueKinds(program);
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					if (instruction.inputs.length === 1 && instruction.outputs.length === 1) {
						const input = instruction.inputs[0]!;
						const mask = valueKinds.kindMask(fn.functionIndex, input);
						if (instruction.opcode === "typeofCompare") {
							const expected = instructionAttribute(instruction, "expected");
							const matches = exactTypeofComparison(mask, expected);
							if (matches !== undefined) {
								changed = true;
								return withoutEffectRefinement({
									...instruction,
									opcode: "createBoolean",
									inputs: [],
									attributes: {
										value:
											instructionAttribute(instruction, "negated") === true
												? !matches
												: matches,
									},
								});
							}
						}
						if (
							instruction.opcode === "unary" &&
							instructionAttribute(instruction, "operator") === "typeof"
						) {
							const result = exactTypeofResult(mask);
							const stringIndex =
								result === undefined
									? undefined
									: exactStringConstantIndex(program, result);
							if (stringIndex !== undefined) {
								changed = true;
								return withoutEffectRefinement({
									...instruction,
									opcode: "createString",
									inputs: [],
									attributes: { stringIndex },
								});
							}
						}
						if (
							instruction.opcode === "unary" &&
							instructionAttribute(instruction, "operator") === "!"
						) {
							const truthy = exactKindTruthiness(mask);
							if (truthy !== undefined) {
								changed = true;
								return withoutEffectRefinement({
									...instruction,
									opcode: "createBoolean",
									inputs: [],
									attributes: { value: !truthy },
								});
							}
						}
					}
					if (
						instruction.opcode === "binary" &&
						instruction.inputs.length === 2 &&
						instruction.outputs.length === 1
					) {
						const operator = instructionAttribute(instruction, "operator");
						if (operator === "===" || operator === "!==") {
							const left = valueKinds.kindMask(fn.functionIndex, instruction.inputs[0]!);
							const right = valueKinds.kindMask(fn.functionIndex, instruction.inputs[1]!);
							if ((left & right) === 0) {
								changed = true;
								return withoutEffectRefinement({
									...instruction,
									opcode: "createBoolean",
									inputs: [],
									attributes: { value: operator === "!==" },
								});
							}
						}
					}
					return instruction;
				}),
			}),
		);
		return changed ? { ...fn, blocks, mutationEpoch: fn.mutationEpoch + 1 } : fn;
	},
};

const refinePrimitiveOperatorEffects: CoreFunctionPass = {
	name: "refine-primitive-operator-effects",
	ablation: "fact-driven",
	dependsOnProgram: true,
	preservesValueKinds: true,
	run(fn, analyses, program) {
		const valueKinds = analyses.valueKinds(program);
		const existingFacts = new Map(fn.facts.map((fact) => [fact.id, fact] as const));
		const retained = new Set<CoreFactId>();
		const added: Array<CoreFact> = [];
		let nextFact = nextFactId(fn);
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					const current = instruction.effectRefinement;
					const ownsCurrent =
						current !== undefined &&
						existingFacts.get(current.proof)?.kind ===
							CORE_PRIMITIVE_OPERATOR_EFFECT_FACT;
					if (current !== undefined && !ownsCurrent) return instruction;
					if (instruction.opcode !== "unary" && instruction.opcode !== "binary") {
						if (!ownsCurrent) return instruction;
						changed = true;
						return withoutEffectRefinement(instruction);
					}
					const masks = instruction.inputs.map((input) =>
						valueKinds.kindMask(fn.functionIndex, input),
					);
					const refined = corePrimitiveOperatorEffectRefinement(instruction, masks);
					if (refined === undefined) {
						if (!ownsCurrent) return instruction;
						changed = true;
						return withoutEffectRefinement(instruction);
					}
					const operator = instructionAttribute(instruction, "operator");
					const digest = `primitive-operator:${String(operator)}:${masks.join(",")}`;
					if (ownsCurrent) {
						const fact = existingFacts.get(current.proof)!;
						if (
							fact.validity.kind === "summary" &&
							fact.validity.digest === digest &&
							effectSummariesEqual(current.effects, refined)
						) {
							retained.add(fact.id);
							return instruction;
						}
					}
					const proof = coreFactId(nextFact++);
					added.push({
						id: proof,
						kind: CORE_PRIMITIVE_OPERATOR_EFFECT_FACT,
						value: { operator: String(operator), masks: [...masks] },
						claims: [{ kind: "effect", instruction: instruction.id, effects: refined }],
						validity: { kind: "summary", digest },
						obligations: [],
						origin: "core-value-kind-analysis",
					});
					changed = true;
					return { ...instruction, effectRefinement: { effects: refined, proof } };
				}),
			}),
		);
		if (!changed) return fn;
		return {
			...fn,
			blocks,
			facts: [
				...fn.facts.filter(
					(fact) =>
						fact.kind !== CORE_PRIMITIVE_OPERATOR_EFFECT_FACT || retained.has(fact.id),
				),
				...added,
			],
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

const refineExactShapeOwnSlotEffects: CoreFunctionPass = {
	name: "refine-exact-shape-own-slot-effects",
	ablation: "fact-driven",
	preservesValueKinds: true,
	run(fn) {
		const existingFacts = new Map(fn.facts.map((fact) => [fact.id, fact] as const));
		const retained = new Set<CoreFactId>();
		const added: Array<CoreFact> = [];
		let nextFact = nextFactId(fn);
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					const current = instruction.effectRefinement;
					const ownsCurrent =
						current !== undefined &&
						existingFacts.get(current.proof)?.kind ===
							CORE_EXACT_SHAPE_OWN_SLOT_EFFECT_FACT;
					if (current !== undefined && !ownsCurrent) return instruction;
					const refined = coreExactShapeOwnSlotEffects(instruction);
					const value = instruction.attributes[CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE];
					const digest = coreExactShapeOwnSlotDigest(value);
					if (refined === undefined || digest === undefined) {
						if (!ownsCurrent) return instruction;
						changed = true;
						return withoutEffectRefinement(instruction);
					}
					if (ownsCurrent) {
						const fact = existingFacts.get(current.proof)!;
						if (
							fact.validity.kind === "summary" &&
							fact.validity.digest === digest &&
							effectSummariesEqual(current.effects, refined)
						) {
							retained.add(fact.id);
							return instruction;
						}
					}
					const proof = coreFactId(nextFact++);
					added.push({
						id: proof,
						kind: CORE_EXACT_SHAPE_OWN_SLOT_EFFECT_FACT,
						value,
						claims: [{ kind: "effect", instruction: instruction.id, effects: refined }],
						validity: { kind: "summary", digest },
						obligations: [],
						origin: "core-shape-provenance",
					});
					changed = true;
					return { ...instruction, effectRefinement: { effects: refined, proof } };
				}),
			}),
		);
		if (!changed) return fn;
		return {
			...fn,
			blocks,
			facts: [
				...fn.facts.filter(
					(fact) =>
						fact.kind !== CORE_EXACT_SHAPE_OWN_SLOT_EFFECT_FACT || retained.has(fact.id),
				),
				...added,
			],
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

const refineExactCollectionBuiltinEffects: CoreFunctionPass = {
	name: "refine-exact-collection-builtin-effects",
	ablation: "fact-driven",
	preservesValueKinds: true,
	run(fn) {
		const existingFacts = new Map(fn.facts.map((fact) => [fact.id, fact] as const));
		const retained = new Set<CoreFactId>();
		const added: Array<CoreFact> = [];
		let nextFact = nextFactId(fn);
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					const current = instruction.effectRefinement;
					const ownsCurrent =
						current !== undefined &&
						existingFacts.get(current.proof)?.kind ===
							CORE_EXACT_COLLECTION_BUILTIN_EFFECT_FACT;
					if (current !== undefined && !ownsCurrent) return instruction;
					const refined = coreExactCollectionBuiltinEffects(instruction);
					const operation = instruction.attributes.operation;
					if (refined === undefined || typeof operation !== "string") {
						if (!ownsCurrent) return instruction;
						changed = true;
						return withoutEffectRefinement(instruction);
					}
					const digest = `exact-collection-builtin:${operation}`;
					if (ownsCurrent) {
						const fact = existingFacts.get(current.proof)!;
						if (
							fact.validity.kind === "summary" &&
							fact.validity.digest === digest &&
							effectSummariesEqual(current.effects, refined)
						) {
							retained.add(fact.id);
							return instruction;
						}
					}
					const proof = coreFactId(nextFact++);
					added.push({
						id: proof,
						kind: CORE_EXACT_COLLECTION_BUILTIN_EFFECT_FACT,
						value: operation,
						claims: [{ kind: "effect", instruction: instruction.id, effects: refined }],
						validity: { kind: "summary", digest },
						obligations: [],
						origin: "core-value-classes",
					});
					changed = true;
					return { ...instruction, effectRefinement: { effects: refined, proof } };
				}),
			}),
		);
		if (!changed) return fn;
		return {
			...fn,
			blocks,
			facts: [
				...fn.facts.filter(
					(fact) =>
						fact.kind !== CORE_EXACT_COLLECTION_BUILTIN_EFFECT_FACT ||
						retained.has(fact.id),
				),
				...added,
			],
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

const CORE_NULLISH_VALUE_KINDS = COMPILER_VALUE_KIND_NULL | COMPILER_VALUE_KIND_UNDEFINED;
const CORE_PROPERTY_KEY_VALUE_KINDS =
	COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_SYMBOL;

const eliminateRedundantPrimitiveCoercions: CoreFunctionPass = {
	name: "eliminate-redundant-primitive-coercions",
	ablation: "fact-driven",
	dependsOnProgram: true,
	run(fn, analyses, program) {
		const valueKinds = analyses.valueKinds(program);
		const { instructions: protectedInstructions, inputs: protectedInputs } =
			analyses.regionProtection(fn);
		const replacements = new Map<CoreValueId, CoreValueId>();
		const removedInstructions = new Set<number>();
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					if (
						instruction.effectRefinement !== undefined ||
						protectedInstructions.has(instruction.id) ||
						instruction.outputs.some((output) => protectedInputs.has(output))
					) {
						return instruction;
					}
					if (instruction.opcode === "requireCoercible") {
						const input = instruction.inputs[0];
						const mask =
							input === undefined ? 0 : valueKinds.kindMask(fn.functionIndex, input);
						if (mask === 0 || (mask & CORE_NULLISH_VALUE_KINDS) !== 0) {
							return instruction;
						}
						removedInstructions.add(instruction.id);
						changed = true;
						return instruction;
					}
					if (
						instruction.opcode !== "toPropertyKey" ||
						instruction.inputs.length !== 2 ||
						instruction.outputs.length !== 1
					) {
						return instruction;
					}
					const [base, key] = instruction.inputs;
					const keyMask = valueKinds.kindMask(fn.functionIndex, key!);
					if (!compilerValueKindMaskIsSubset(keyMask, CORE_PROPERTY_KEY_VALUE_KINDS)) {
						return instruction;
					}
					replacements.set(instruction.outputs[0]!, key!);
					changed = true;
					const baseMask = valueKinds.kindMask(fn.functionIndex, base!);
					if (baseMask !== 0 && (baseMask & CORE_NULLISH_VALUE_KINDS) === 0) {
						removedInstructions.add(instruction.id);
						return instruction;
					}
					return {
						id: instruction.id,
						opcode: "requireCoercible",
						inputs: [base!],
						outputs: [],
						attributes: {},
					};
				}),
			}),
		);
		return changed ? rewriteFunction(fn, blocks, replacements, removedInstructions) : fn;
	},
};

/** Fold an exact string SSA value into the property operation's attributes. */
const foldStaticPropertyKeys: CoreFunctionPass = {
	name: "fold-static-property-keys",
	ablation: "static-properties",
	run(fn, analyses) {
		const canonical = analyses.canonicalValues(fn);
		const strings = new Map<CoreValueId, number>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const stringIndex = instructionAttribute(instruction, "stringIndex");
				if (
					instruction.opcode === "createString" &&
					instruction.outputs.length === 1 &&
					typeof stringIndex === "number"
				) {
					strings.set(instruction.outputs[0]!, stringIndex);
				}
			}
		}
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					if (
						(instruction.opcode !== "loadProperty" &&
							instruction.opcode !== "storeProperty") ||
						instruction.inputs.length < 2
					) {
						return instruction;
					}
					const key = instruction.inputs[1]!;
					const stringIndex = strings.get(canonical.get(key) ?? key);
					if (stringIndex === undefined) return instruction;
					changed = true;
					return withoutEffectRefinement({
						...instruction,
						opcode:
							instruction.opcode === "loadProperty"
								? "loadPropertyStatic"
								: "storePropertyStatic",
						inputs: instruction.inputs.filter((_, index) => index !== 1),
						attributes: { ...instruction.attributes, stringIndex },
					});
				}),
			}),
		);
		return changed ? { ...fn, blocks, mutationEpoch: fn.mutationEpoch + 1 } : fn;
	},
};

export interface CoreOptimizationResult {
	readonly program: CoreProgram;
	readonly context?: CoreCompilationContext;
	readonly changed: boolean;
	readonly targetAnalyses?: {
		readonly summaries: CoreProgramSummaries;
	};
}

interface CoreFunctionPass {
	readonly name: string;
	readonly ablation?: OptimizationAblation;
	/** The result may change when another function changes. */
	readonly dependsOnProgram?: boolean;
	/** Every output retains the same semantic kind as the input snapshot. */
	readonly preservesValueKinds?: boolean;
	/** Block identity is part of a region certificate until CFG regions migrate. */
	readonly changesControlFlow?: boolean;
	run(
		fn: CoreFunction,
		analyses: CoreAnalysisManager,
		program: CoreProgram,
	): CoreFunction;
}

interface CoreRegionProtection {
	readonly instructions: ReadonlySet<CoreInstructionId>;
	readonly inputs: ReadonlySet<CoreValueId>;
}

function instructionAttribute(instruction: CoreInstruction, name: string): unknown {
	return instruction.attributes[name];
}

/** Per-function analysis cache keyed by the immutable function snapshot. */
/**
 * Exact heap locations are only as trustworthy as the escape proof behind them.
 * A slot is named exactly when the base must-aliases one contained allocation and
 * the key is one of its own writable data slots; a contained allocation's shape
 * can no longer change, so that slot is a plain cell for the rest of its life.
 */
function memoryProvenance(
	analyses: CoreAnalysisManager,
	fn: CoreFunction,
): CoreProvenance {
	const ordinary = analyses.provenance(fn);
	const candidates = fn.blocks.flatMap(({ instructions }) =>
		instructions.flatMap((instruction) => {
			if (instruction.opcode !== "call") return [];
			const claim = coreCallSummaryClaimFromAttribute(
				instruction.attributes[CORE_CALL_SUMMARY_ATTRIBUTE],
			);
			if (
				claim === undefined ||
				claim.digest !== coreCallValueSummaryDigest(claim) ||
				claim.targets.length !== 1 ||
				claim.relativeOwnSlotEffects.length === 0
			) {
				return [];
			}
			return [{ instruction, claim }];
		}),
	);
	let active = candidates;
	let provenance = ordinary;
	while (active.length > 0) {
		const assumptions = new Map<CoreInstructionId, Set<number>>();
		for (const { instruction, claim } of active) {
			assumptions.set(
				instruction.id,
				new Set(
					claim.relativeOwnSlotEffects.map((effect) =>
						effect.base.kind === "receiver" ? 1 : effect.base.index + 2,
					),
				),
			);
		}
		const conditional = ordinary.withAssumedNonEscapingOperands(assumptions);
		const retained = active.filter(({ instruction, claim }) =>
			claim.relativeOwnSlotEffects.every((effect) => {
				const operand = effect.base.kind === "receiver" ? 1 : effect.base.index + 2;
				const base = instruction.inputs[operand];
				if (base === undefined) return false;
				const resolved = conditional.ownCell(
					base,
					{ kind: "string-constant", index: effect.key },
					effect.mode,
				);
				return resolved?.cell.kind === "object-slot";
			}),
		);
		if (retained.length === active.length) {
			provenance = conditional;
			break;
		}
		active = retained;
	}
	return provenance;
}

function memoryResolution(
	analyses: CoreAnalysisManager,
	fn: CoreFunction,
	provenance = memoryProvenance(analyses, fn),
): CoreMemoryResolution {
	return {
		ownCell: (base, key, mode) => {
			const resolved = provenance.ownCell(base, key, mode);
			return resolved === undefined
				? undefined
				: { allocation: resolved.layout.instruction, cell: resolved.cell };
		},
	};
}

export class CoreAnalysisManager {
	readonly context: CoreCompilationContext | undefined;
	readonly #stringConstants: ReadonlyArray<ReadonlyArray<number>>;
	readonly #controlFlow = new WeakMap<CoreFunction, CoreControlFlow>();
	readonly #definitions = new WeakMap<
		CoreFunction,
		ReadonlyMap<CoreValueId, CoreInstruction>
	>();
	readonly #representations = new WeakMap<
		CoreFunction,
		ReadonlyMap<CoreValueId, CoreRepresentation>
	>();
	readonly #regionProtection = new WeakMap<CoreFunction, CoreRegionProtection>();
	readonly #canonicalValues = new WeakMap<
		CoreFunction,
		ReadonlyMap<CoreValueId, CoreValueId>
	>();
	readonly #memory = new WeakMap<CoreFunction, CoreMemoryVersions>();
	readonly #provenance = new WeakMap<CoreFunction, CoreProvenance>();
	readonly #loopInductions = new WeakMap<CoreFunction, CoreLoopInductionAnalysis>();
	readonly #regionValidity = new WeakMap<CoreFunction, CoreRegionValidityModel>();
	/**
	 * Program-level analyses cannot key on the program or its function array: the
	 * driver rebuilds both for every pass, so a `WeakMap` would never hit. The
	 * cache first recognizes the exact per-pass program object in O(1), then
	 * compares function identities once when the driver constructs the next pass's
	 * program. That retains an analysis across unchanged passes without turning N
	 * function callbacks into N whole-array scans.
	 */
	#summaries:
		| {
				readonly program: CoreProgram;
				readonly context: CoreCompilationContext | undefined;
				readonly functions: ReadonlyArray<CoreFunction>;
				readonly analysis: CoreProgramSummaries;
		  }
		| undefined;
	#valueKinds:
		| {
				readonly program: CoreProgram;
				readonly context: CoreCompilationContext | undefined;
				readonly functions: ReadonlyArray<CoreFunction>;
				readonly analysis: CoreValueKindAnalysis;
		  }
		| undefined;

	constructor(
		stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
		context?: CoreCompilationContext,
	) {
		this.#stringConstants = stringConstants;
		this.context = context;
	}

	controlFlow(fn: CoreFunction): CoreControlFlow {
		let analysis = this.#controlFlow.get(fn);
		if (analysis === undefined) {
			analysis = buildCoreControlFlow(fn, coreOpcodeRegistry);
			this.#controlFlow.set(fn, analysis);
		}
		return analysis;
	}

	definitions(fn: CoreFunction): ReadonlyMap<CoreValueId, CoreInstruction> {
		let definitions = this.#definitions.get(fn);
		if (definitions === undefined) {
			definitions = functionDefinitions(fn);
			this.#definitions.set(fn, definitions);
		}
		return definitions;
	}

	representations(fn: CoreFunction): ReadonlyMap<CoreValueId, CoreRepresentation> {
		let representations = this.#representations.get(fn);
		if (representations === undefined) {
			representations = new Map(
				fn.values.map(({ id, representation }) => [id, representation] as const),
			);
			this.#representations.set(fn, representations);
		}
		return representations;
	}

	regionProtection(fn: CoreFunction): CoreRegionProtection {
		let protection = this.#regionProtection.get(fn);
		if (protection === undefined) {
			protection = regionProtectedValues(fn);
			this.#regionProtection.set(fn, protection);
		}
		return protection;
	}

	/**
	 * Carry a CFG across an immutable instruction-only rewrite. Terminator and
	 * handler identity retain every ordinary/exceptional edge and its arguments;
	 * parameter value/role identity retains the destination side of those edges.
	 */
	inheritControlFlow(before: CoreFunction, after: CoreFunction): void {
		const analysis = this.#controlFlow.get(before);
		if (analysis === undefined || before.blocks.length !== after.blocks.length) return;
		for (let index = 0; index < before.blocks.length; index++) {
			const left = before.blocks[index]!;
			const right = after.blocks[index]!;
			if (
				left.id !== right.id ||
				left.terminator !== right.terminator ||
				left.handler !== right.handler ||
				left.parameters.length !== right.parameters.length ||
				left.parameters.some(
					(parameter, parameterIndex) =>
						parameter.value !== right.parameters[parameterIndex]?.value ||
						parameter.role !== right.parameters[parameterIndex]?.role,
				)
			) {
				return;
			}
		}
		this.#controlFlow.set(after, analysis);
	}

	/** Shared epoch-transparency bits every region-selection pass reuses. */
	regionValidity(fn: CoreFunction): CoreRegionValidityModel {
		let analysis = this.#regionValidity.get(fn);
		if (analysis === undefined) {
			analysis = coreRegionValidityModel(fn, coreOpcodeRegistry);
			this.#regionValidity.set(fn, analysis);
		}
		return analysis;
	}

	canonicalValues(fn: CoreFunction): ReadonlyMap<CoreValueId, CoreValueId> {
		let analysis = this.#canonicalValues.get(fn);
		if (analysis === undefined) {
			analysis = coreCanonicalValueRoots(fn, this.controlFlow(fn));
			this.#canonicalValues.set(fn, analysis);
		}
		return analysis;
	}

	inheritCanonicalValues(before: CoreFunction, after: CoreFunction): void {
		const analysis = this.#canonicalValues.get(before);
		if (
			analysis === undefined ||
			before.entry !== after.entry ||
			before.bodyEntry !== after.bodyEntry ||
			before.values.length !== after.values.length ||
			before.blocks.length !== after.blocks.length
		) {
			return;
		}
		for (let index = 0; index < before.values.length; index++) {
			if (before.values[index]!.id !== after.values[index]!.id) return;
		}
		for (let index = 0; index < before.blocks.length; index++) {
			const left = before.blocks[index]!;
			const right = after.blocks[index]!;
			if (
				left.id !== right.id ||
				left.terminator !== right.terminator ||
				left.handler !== right.handler ||
				left.parameters.length !== right.parameters.length ||
				left.parameters.some(
					(parameter, parameterIndex) =>
						parameter.value !== right.parameters[parameterIndex]!.value ||
						parameter.role !== right.parameters[parameterIndex]!.role,
				)
			) {
				return;
			}
			let leftIndex = 0;
			let rightIndex = 0;
			for (;;) {
				while (
					leftIndex < left.instructions.length &&
					left.instructions[leftIndex]!.opcode !== "move"
				) {
					leftIndex++;
				}
				while (
					rightIndex < right.instructions.length &&
					right.instructions[rightIndex]!.opcode !== "move"
				) {
					rightIndex++;
				}
				const leftMove = left.instructions[leftIndex];
				const rightMove = right.instructions[rightIndex];
				if (leftMove === undefined || rightMove === undefined) {
					if (leftMove !== rightMove) return;
					break;
				}
				if (
					leftMove.inputs[0] !== rightMove.inputs[0] ||
					leftMove.outputs[0] !== rightMove.outputs[0]
				) {
					return;
				}
				leftIndex++;
				rightIndex++;
			}
		}
		this.#canonicalValues.set(after, analysis);
	}

	provenance(fn: CoreFunction): CoreProvenance {
		let analysis = this.#provenance.get(fn);
		if (analysis === undefined) {
			analysis = coreProvenance(fn, this.controlFlow(fn), this.#stringConstants, {
				canonicalRoots: this.canonicalValues(fn),
			});
			this.#provenance.set(fn, analysis);
		}
		return analysis;
	}

	/**
	 * Carry summaries across an advisory target hint rewrite. The scalar selector
	 * changes only backend-owned attributes: function/value identity, control flow,
	 * effects, representations, callee flow, and every call-site id stay identical.
	 */
	inheritSummaries(before: CoreProgram, after: CoreProgram): void {
		const cached = this.#summaries;
		if (cached?.program !== before || cached.context !== this.context) return;
		this.#summaries = {
			...cached,
			program: after,
			functions: after.functions,
		};
	}

	memory(fn: CoreFunction): CoreMemoryVersions {
		let analysis = this.#memory.get(fn);
		if (analysis === undefined) {
			analysis = coreMemoryVersions(fn, this.controlFlow(fn), memoryResolution(this, fn));
			this.#memory.set(fn, analysis);
		}
		return analysis;
	}

	summaries(program: CoreProgram): CoreProgramSummaries {
		const cached = this.#summaries;
		if (cached?.program === program && cached.context === this.context) {
			return cached.analysis;
		}
		if (
			cached !== undefined &&
			cached.context === this.context &&
			cached.functions.length === program.functions.length &&
			cached.functions.every((fn, index) => fn === program.functions[index])
		) {
			this.#summaries = { ...cached, program };
			return cached.analysis;
		}
		const analysis = analyzeCoreProgramSummaries(
			program,
			coreOpcodeRegistry,
			this.context,
		);
		this.#summaries = {
			program,
			context: this.context,
			functions: program.functions,
			analysis,
		};
		return analysis;
	}

	valueKinds(program: CoreProgram): CoreValueKindAnalysis {
		const cached = this.#valueKinds;
		if (cached?.program === program && cached.context === this.context) {
			return cached.analysis;
		}
		if (
			cached !== undefined &&
			cached.context === this.context &&
			cached.functions.length === program.functions.length &&
			cached.functions.every((fn, index) => fn === program.functions[index])
		) {
			this.#valueKinds = { ...cached, program };
			return cached.analysis;
		}
		const analysis = analyzeCoreValueKinds(
			program,
			this.context,
			this.summaries(program),
		);
		this.#valueKinds = {
			program,
			context: this.context,
			functions: program.functions,
			analysis,
		};
		return analysis;
	}

	inheritValueKinds(before: CoreProgram, after: CoreProgram): void {
		const cached = this.#valueKinds;
		if (cached?.program !== before || cached.context !== this.context) return;
		this.#valueKinds = { ...cached, program: after, functions: after.functions };
	}

	loopInductions(fn: CoreFunction): CoreLoopInductionAnalysis {
		let analysis = this.#loopInductions.get(fn);
		if (analysis === undefined) {
			analysis = analyzeCoreLoopInductions(
				fn,
				this.controlFlow(fn),
				this.canonicalValues(fn),
			);
			this.#loopInductions.set(fn, analysis);
		}
		return analysis;
	}
}

function resolveValue(
	value: CoreValueId,
	replacements: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreValueId {
	let current = value;
	let remaining = replacements.size;
	for (;;) {
		const next = replacements.get(current);
		if (next === undefined) return current;
		if (remaining === 0) {
			throw new Error(`Cyclic Core value replacement at ${current}`);
		}
		remaining -= 1;
		current = next;
	}
}

function rewriteEdge(
	edge: CoreEdge,
	replacements: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreEdge {
	return {
		...edge,
		arguments: edge.arguments.map((value) => resolveValue(value, replacements)),
	};
}

function remapTerminatorEdges(
	terminator: CoreTerminator,
	remap: (edge: CoreEdge) => CoreEdge,
): CoreTerminator {
	switch (terminator.kind) {
		case "jump":
			return { ...terminator, edge: remap(terminator.edge) };
		case "branch":
			return {
				...terminator,
				consequent: remap(terminator.consequent),
				alternate: remap(terminator.alternate),
			};
		case "guard":
			return {
				...terminator,
				success: remap(terminator.success),
				fallback: remap(terminator.fallback),
			};
		case "switch":
			return {
				...terminator,
				cases: terminator.cases.map((entry) => ({
					...entry,
					edge: remap(entry.edge),
				})),
				default: remap(terminator.default),
			};
		case "return":
		case "throw":
		case "unreachable":
			return terminator;
	}
}

function rewriteTerminator(
	terminator: CoreTerminator,
	replacements: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreTerminator {
	switch (terminator.kind) {
		case "jump":
			return {
				...terminator,
				edge: rewriteEdge(terminator.edge, replacements),
			};
		case "branch":
			return {
				...terminator,
				condition: resolveValue(terminator.condition, replacements),
				consequent: rewriteEdge(terminator.consequent, replacements),
				alternate: rewriteEdge(terminator.alternate, replacements),
			};
		case "guard":
			return {
				...terminator,
				condition: resolveValue(terminator.condition, replacements),
				success: rewriteEdge(terminator.success, replacements),
				fallback: rewriteEdge(terminator.fallback, replacements),
			};
		case "switch":
			return {
				...terminator,
				discriminant: resolveValue(terminator.discriminant, replacements),
				cases: terminator.cases.map((entry) => ({
					...entry,
					edge: rewriteEdge(entry.edge, replacements),
				})),
				default: rewriteEdge(terminator.default, replacements),
			};
		case "return":
		case "throw":
			return {
				...terminator,
				value: resolveValue(terminator.value, replacements),
			};
		case "unreachable":
			return terminator;
	}
}

function rewriteFactClaimSubjects(
	facts: ReadonlyArray<CoreFact>,
	replacements: ReadonlyMap<CoreValueId, CoreValueId>,
): ReadonlyArray<CoreFact> {
	if (replacements.size === 0) return facts;
	return facts.map((fact) => {
		let changed = false;
		const claims = fact.claims.map((claim): CoreFactClaim => {
			if (claim.kind === "effect") return claim;
			const subject = resolveValue(claim.subject, replacements);
			if (subject === claim.subject) return claim;
			changed = true;
			return { ...claim, subject };
		});
		return changed ? { ...fact, claims } : fact;
	});
}

function rewriteFunction(
	fn: CoreFunction,
	blocks: ReadonlyArray<CoreBlock>,
	replacements: ReadonlyMap<CoreValueId, CoreValueId>,
	removedInstructions: ReadonlySet<number>,
): CoreFunction {
	const removedValues = new Set(replacements.keys());
	return {
		...fn,
		blocks: blocks.map((block) => ({
			...block,
			instructions: block.instructions
				.filter(({ id }) => !removedInstructions.has(id))
				.map((instruction) => ({
					...instruction,
					inputs: instruction.inputs.map((value) => resolveValue(value, replacements)),
				})),
			terminator: rewriteTerminator(block.terminator, replacements),
			...(block.handler === undefined
				? {}
				: {
						handler: {
							...block.handler,
							arguments: block.handler.arguments.map((value) =>
								resolveValue(value, replacements),
							),
						},
					}),
		})),
		values: fn.values.filter(({ id }) => !removedValues.has(id)),
		facts: rewriteFactClaimSubjects(fn.facts, replacements),
		mutationEpoch: fn.mutationEpoch + 1,
	};
}

function sameEdge(left: CoreEdge, right: CoreEdge): boolean {
	return (
		left.block === right.block &&
		left.arguments.length === right.arguments.length &&
		left.arguments.every((argument, index) => argument === right.arguments[index])
	);
}

/**
 * Remove selected ordinary block parameters and the matching argument on every
 * incoming edge. Handler arguments omit the implicit exception parameter, so
 * their index space is adjusted explicitly rather than treated like an ordinary
 * edge. Remaining parameter definitions are re-indexed in the same transaction.
 */
function removeBlockParameters(
	fn: CoreFunction,
	removedIndices: ReadonlyMap<CoreBlockId, ReadonlySet<number>>,
	replacements: ReadonlyMap<CoreValueId, CoreValueId> = new Map(),
	retainedDefinitions: ReadonlyMap<
		CoreValueId,
		{
			readonly instruction: CoreInstructionId;
			readonly representation: CoreFunction["values"][number]["representation"];
		}
	> = new Map(),
): CoreFunction {
	const removedValues = new Set<CoreValueId>();
	for (const [blockId, indices] of removedIndices) {
		for (const index of indices) {
			const parameter = fn.blocks[blockId]?.parameters[index];
			if (parameter !== undefined) removedValues.add(parameter.value);
		}
	}
	const rewriteIncomingEdge = (edge: CoreEdge): CoreEdge => {
		const removed = removedIndices.get(edge.block);
		return {
			...edge,
			arguments: edge.arguments
				.map((value) => resolveValue(value, replacements))
				.filter((_, index) => removed?.has(index) !== true),
		};
	};
	const blocks = fn.blocks.map((block): CoreBlock => {
		const removed = removedIndices.get(block.id);
		const parameters = block.parameters.filter(
			(_, index) => removed?.has(index) !== true,
		);
		let handler = block.handler;
		if (handler !== undefined) {
			const target = fn.blocks[handler.block]!;
			const targetRemoved = removedIndices.get(handler.block);
			const exceptionOffset = target.parameters[0]?.role === "exception" ? 1 : 0;
			handler = {
				...handler,
				arguments: handler.arguments
					.map((value) => resolveValue(value, replacements))
					.filter((_, index) => targetRemoved?.has(index + exceptionOffset) !== true),
			};
		}
		return {
			...block,
			parameters,
			instructions: block.instructions.map((instruction) => ({
				...instruction,
				inputs: instruction.inputs.map((value) => resolveValue(value, replacements)),
			})),
			terminator: remapTerminatorEdges(
				rewriteTerminator(block.terminator, replacements),
				rewriteIncomingEdge,
			),
			...(handler === undefined ? { handler: undefined } : { handler }),
		};
	});
	return {
		...fn,
		blocks,
		facts: rewriteFactClaimSubjects(fn.facts, replacements),
		values: fn.values
			.filter(({ id }) => !removedValues.has(id) || retainedDefinitions.has(id))
			.map((value) => {
				const retained = retainedDefinitions.get(value.id);
				if (retained !== undefined) {
					return {
						...value,
						representation: retained.representation,
						definition: {
							kind: "instruction" as const,
							instruction: retained.instruction,
							index: 0,
						},
					};
				}
				if (value.definition.kind !== "block-parameter") return value;
				const parameters = blocks[value.definition.block]!.parameters;
				const index = parameters.findIndex(({ value: id }) => id === value.id);
				return index === value.definition.index
					? value
					: {
							...value,
							definition: { ...value.definition, index },
						};
			}),
		mutationEpoch: fn.mutationEpoch + 1,
	};
}

function stableAttributeValue(value: unknown): string {
	if (value === undefined) return "u";
	if (value === null) return "n";
	if (typeof value === "boolean") return value ? "b1" : "b0";
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "dNaN";
		if (Object.is(value, -0)) return "d-0";
		if (value === Number.POSITIVE_INFINITY) return "d+Inf";
		if (value === Number.NEGATIVE_INFINITY) return "d-Inf";
		return `d${value}`;
	}
	if (typeof value === "string") return `s${JSON.stringify(value)}`;
	if (Array.isArray(value)) {
		const arrayValue: ReadonlyArray<unknown> = value;
		return `[${arrayValue.map(stableAttributeValue).join(",")}]`;
	}
	if (typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableAttributeValue(entry)}`)
			.join(",")}}`;
	}
	throw new Error(`Unsupported Core attribute key value ${typeof value}`);
}

function stableAttributes(instruction: CoreInstruction): string {
	return stableAttributeValue(instruction.attributes);
}

function constantImmediate(instruction: CoreInstruction): CoreImmediate | undefined {
	switch (instruction.opcode) {
		case "createUndefined":
			return { kind: "undefined" };
		case "createNull":
			return { kind: "null" };
		case "createBoolean":
			return typeof instructionAttribute(instruction, "value") === "boolean"
				? {
						kind: "boolean",
						value: instructionAttribute(instruction, "value") as boolean,
					}
				: undefined;
		case "createNumber":
		case "createF64":
			return typeof instructionAttribute(instruction, "value") === "number"
				? {
						kind: "number",
						value: instructionAttribute(instruction, "value") as number,
					}
				: undefined;
		case "createString":
			return typeof instructionAttribute(instruction, "stringIndex") === "number"
				? {
						kind: "string",
						index: instructionAttribute(instruction, "stringIndex") as number,
					}
				: undefined;
		default:
			return undefined;
	}
}

function primitiveNumber(
	value: CoreImmediate,
	program?: CoreProgram,
): number | undefined {
	switch (value.kind) {
		case "undefined":
			return Number.NaN;
		case "null":
			return 0;
		case "boolean":
			return value.value ? 1 : 0;
		case "number":
			return value.value;
		case "string": {
			const decoded =
				program === undefined ? undefined : decodeString(program, value.index);
			return decoded === undefined ? undefined : Number(decoded);
		}
	}
}

function foldUnaryPrimitive(
	operator: unknown,
	operand: CoreImmediate,
	program?: CoreProgram,
): CoreImmediate | undefined {
	switch (operator) {
		case "!": {
			const truthy = immediateTruthiness(operand, program);
			return truthy === undefined ? undefined : { kind: "boolean", value: !truthy };
		}
		case "+":
		case "-":
		case "~": {
			const numeric = primitiveNumber(operand, program);
			if (numeric === undefined) return undefined;
			return {
				kind: "number",
				value: operator === "+" ? numeric : operator === "-" ? -numeric : ~numeric,
			};
		}
		default:
			return undefined;
	}
}

function foldNumericBinary(
	operator: unknown,
	left: number,
	right: number,
): CoreImmediate | undefined {
	switch (operator) {
		case "+":
			return { kind: "number", value: left + right };
		case "-":
			return { kind: "number", value: left - right };
		case "*":
			return { kind: "number", value: left * right };
		case "/":
			return { kind: "number", value: left / right };
		case "%":
			return { kind: "number", value: left % right };
		case "&":
			return { kind: "number", value: left & right };
		case "|":
			return { kind: "number", value: left | right };
		case "^":
			return { kind: "number", value: left ^ right };
		case "<<":
			return { kind: "number", value: left << right };
		case ">>":
			return { kind: "number", value: left >> right };
		case ">>>":
			return { kind: "number", value: left >>> right };
		case "<":
			return { kind: "boolean", value: left < right };
		case "<=":
			return { kind: "boolean", value: left <= right };
		case ">":
			return { kind: "boolean", value: left > right };
		case ">=":
			return { kind: "boolean", value: left >= right };
		case "==":
		case "===":
			return { kind: "boolean", value: left === right };
		case "!=":
		case "!==":
			return { kind: "boolean", value: left !== right };
		default:
			// Exponentiation remains runtime-evaluated so host/self-host compilers
			// cannot disagree on serialized transcendental f64 bits.
			return undefined;
	}
}

function foldPrimitiveBinary(
	operator: unknown,
	left: CoreImmediate,
	right: CoreImmediate,
	program?: CoreProgram,
): CoreImmediate | undefined {
	if (left.kind === "number" && right.kind === "number") {
		return foldNumericBinary(operator, left.value, right.value);
	}
	if (
		operator !== "===" &&
		operator !== "!==" &&
		operator !== "==" &&
		operator !== "!="
	) {
		return undefined;
	}
	const strictEqual = (
		leftValue: CoreImmediate,
		rightValue: CoreImmediate,
	): boolean | undefined => {
		if (leftValue.kind !== rightValue.kind) return false;
		if (leftValue.kind !== "string") return immediateStrictEquals(leftValue, rightValue);
		if (program === undefined) {
			return leftValue.index ===
				(rightValue as Extract<CoreImmediate, { kind: "string" }>).index
				? true
				: undefined;
		}
		const leftString = decodeString(program, leftValue.index);
		const rightString = decodeString(
			program,
			(rightValue as Extract<CoreImmediate, { kind: "string" }>).index,
		);
		return leftString === undefined || rightString === undefined
			? undefined
			: leftString === rightString;
	};
	const looselyEqual = (
		leftValue: CoreImmediate,
		rightValue: CoreImmediate,
	): boolean | undefined => {
		if (leftValue.kind === rightValue.kind) return strictEqual(leftValue, rightValue);
		if (
			(leftValue.kind === "null" && rightValue.kind === "undefined") ||
			(leftValue.kind === "undefined" && rightValue.kind === "null")
		) {
			return true;
		}
		if (
			leftValue.kind === "null" ||
			leftValue.kind === "undefined" ||
			rightValue.kind === "null" ||
			rightValue.kind === "undefined"
		) {
			return false;
		}
		if (leftValue.kind === "boolean") {
			return looselyEqual({ kind: "number", value: leftValue.value ? 1 : 0 }, rightValue);
		}
		if (rightValue.kind === "boolean") {
			return looselyEqual(leftValue, {
				kind: "number",
				value: rightValue.value ? 1 : 0,
			});
		}
		if (
			(leftValue.kind === "number" && rightValue.kind === "string") ||
			(leftValue.kind === "string" && rightValue.kind === "number")
		) {
			const leftNumber = primitiveNumber(leftValue, program);
			const rightNumber = primitiveNumber(rightValue, program);
			return leftNumber === undefined || rightNumber === undefined
				? undefined
				: leftNumber === rightNumber;
		}
		return false;
	};
	const equal =
		operator === "==" || operator === "!="
			? looselyEqual(left, right)
			: strictEqual(left, right);
	if (equal === undefined) return undefined;
	return {
		kind: "boolean",
		value: operator === "!==" || operator === "!=" ? !equal : equal,
	};
}

function foldedInstruction(
	instruction: CoreInstruction,
	value: CoreImmediate,
):
	| {
			readonly instruction: CoreInstruction;
			readonly representation: "boxed" | "f64" | "boolean";
	  }
	| undefined {
	const common = {
		...withoutEffectRefinement(instruction),
		inputs: [],
	};
	switch (value.kind) {
		case "undefined":
			return {
				instruction: { ...common, opcode: "createUndefined", attributes: {} },
				representation: "boxed",
			};
		case "null":
			return {
				instruction: { ...common, opcode: "createNull", attributes: {} },
				representation: "boxed",
			};
		case "boolean":
			return {
				instruction: {
					...common,
					opcode: "createBoolean",
					attributes: { value: value.value },
				},
				representation: "boolean",
			};
		case "number":
			return {
				instruction: {
					...common,
					opcode: "createF64",
					attributes: { value: value.value },
				},
				representation: "f64",
			};
		case "string":
			return undefined;
	}
}

type ConstantLattice =
	| { readonly kind: "unknown" }
	| { readonly kind: "constant"; readonly value: CoreImmediate }
	| { readonly kind: "overdefined" };

const UNKNOWN_CONSTANT: ConstantLattice = { kind: "unknown" };
const OVERDEFINED_CONSTANT: ConstantLattice = { kind: "overdefined" };

function sameImmediate(left: CoreImmediate, right: CoreImmediate): boolean {
	if (left.kind !== right.kind) return false;
	switch (left.kind) {
		case "undefined":
		case "null":
			return true;
		case "boolean":
			return left.value === (right as Extract<CoreImmediate, { kind: "boolean" }>).value;
		case "number":
			return Object.is(
				left.value,
				(right as Extract<CoreImmediate, { kind: "number" }>).value,
			);
		case "string":
			return left.index === (right as Extract<CoreImmediate, { kind: "string" }>).index;
	}
}

function mergeConstantLattice(
	current: ConstantLattice,
	incoming: ConstantLattice,
): ConstantLattice {
	if (current.kind === "overdefined" || incoming.kind === "unknown") return current;
	if (incoming.kind === "overdefined") return OVERDEFINED_CONSTANT;
	if (current.kind === "unknown") return incoming;
	return sameImmediate(current.value, incoming.value) ? current : OVERDEFINED_CONSTANT;
}

function evaluateConstantInstruction(
	instruction: CoreInstruction,
	states: ReadonlyArray<ConstantLattice | undefined>,
	program?: CoreProgram,
): ConstantLattice {
	if (instruction.outputs.length !== 1) return OVERDEFINED_CONSTANT;
	const immediate = constantImmediate(instruction);
	if (immediate !== undefined) return { kind: "constant", value: immediate };
	if (instruction.opcode === "move" && instruction.inputs.length === 1) {
		return states[instruction.inputs[0]!] ?? UNKNOWN_CONSTANT;
	}
	if (instruction.opcode === "unary" && instruction.inputs.length === 1) {
		const operand = states[instruction.inputs[0]!] ?? UNKNOWN_CONSTANT;
		if (operand.kind !== "constant") return operand;
		const value = foldUnaryPrimitive(
			instructionAttribute(instruction, "operator"),
			operand.value,
			program,
		);
		return value === undefined ? OVERDEFINED_CONSTANT : { kind: "constant", value };
	}
	if (instruction.opcode === "binary" && instruction.inputs.length === 2) {
		const left = states[instruction.inputs[0]!] ?? UNKNOWN_CONSTANT;
		const right = states[instruction.inputs[1]!] ?? UNKNOWN_CONSTANT;
		if (left.kind === "overdefined" || right.kind === "overdefined") {
			return OVERDEFINED_CONSTANT;
		}
		if (left.kind !== "constant" || right.kind !== "constant") {
			return UNKNOWN_CONSTANT;
		}
		const value = foldPrimitiveBinary(
			instructionAttribute(instruction, "operator"),
			left.value,
			right.value,
			program,
		);
		return value === undefined ? OVERDEFINED_CONSTANT : { kind: "constant", value };
	}
	return OVERDEFINED_CONSTANT;
}

function constantInstruction(
	id: CoreInstructionId,
	output: CoreValueId,
	value: CoreImmediate,
):
	| {
			readonly instruction: CoreInstruction;
			readonly representation: CoreFunction["values"][number]["representation"];
	  }
	| undefined {
	const prototype: CoreInstruction = {
		id,
		opcode: "createUndefined",
		inputs: [],
		outputs: [output],
		attributes: {},
	};
	if (value.kind === "string") {
		return {
			instruction: {
				...prototype,
				opcode: "createString",
				attributes: { stringIndex: value.index },
			},
			representation: "boxed",
		};
	}
	return foldedInstruction(prototype, value);
}

/** SCCP needs no worklist for an acyclic chain with no constant block argument. */
function foldLinearPrimitiveConstants(
	fn: CoreFunction,
	protectedInstructions: ReadonlySet<CoreInstructionId>,
	program: CoreProgram,
): CoreFunction | undefined {
	if (fn.regions.length > 0) return undefined;
	const predecessorCounts = new Uint32Array(fn.blocks.length);
	for (const block of fn.blocks) {
		if (block.handler !== undefined) return undefined;
		switch (block.terminator.kind) {
			case "jump": {
				const target = block.terminator.edge.block;
				predecessorCounts[target] = (predecessorCounts[target] ?? 0) + 1;
				break;
			}
			case "return":
			case "throw":
			case "unreachable":
				break;
			case "branch":
			case "guard":
			case "switch":
				return undefined;
		}
	}
	if (predecessorCounts[fn.entry] !== 0) return undefined;
	for (const block of fn.blocks) {
		if (block.id !== fn.entry && predecessorCounts[block.id] !== 1) return undefined;
	}
	const order: Array<CoreBlockId> = [];
	const visited = new Set<CoreBlockId>();
	let next: CoreBlockId | undefined = fn.entry;
	while (next !== undefined && !visited.has(next)) {
		const current: CoreBlockId = next;
		visited.add(current);
		order.push(current);
		const terminator: CoreTerminator = fn.blocks[current]!.terminator;
		next = terminator.kind === "jump" ? terminator.edge.block : undefined;
	}
	if (order.length !== fn.blocks.length || next !== undefined) return undefined;

	const states = new Array<ConstantLattice | undefined>((fn.values.at(-1)?.id ?? -1) + 1);
	for (const parameter of fn.blocks[fn.entry]!.parameters) {
		states[parameter.value] = OVERDEFINED_CONSTANT;
	}
	const representations = new Map<
		CoreValueId,
		CoreFunction["values"][number]["representation"]
	>();
	let changed = false;
	const blocks = [...fn.blocks];
	for (const blockId of order) {
		const block = fn.blocks[blockId]!;
		const instructions = block.instructions.map((instruction): CoreInstruction => {
			const state = evaluateConstantInstruction(instruction, states, program);
			for (const output of instruction.outputs) states[output] = state;
			if (
				protectedInstructions.has(instruction.id) ||
				instruction.outputs.length !== 1 ||
				(instruction.opcode !== "unary" && instruction.opcode !== "binary") ||
				state.kind !== "constant"
			) {
				return instruction;
			}
			const replacement = foldedInstruction(instruction, state.value);
			if (replacement === undefined) return instruction;
			changed = true;
			representations.set(instruction.outputs[0]!, replacement.representation);
			return replacement.instruction;
		});
		blocks[blockId] = { ...block, instructions };
		if (block.terminator.kind !== "jump") continue;
		const target = fn.blocks[block.terminator.edge.block]!;
		for (const [index, argument] of block.terminator.edge.arguments.entries()) {
			const parameter = target.parameters[index];
			if (parameter === undefined) continue;
			const state = states[argument] ?? UNKNOWN_CONSTANT;
			// Generic SCCP materializes constant phis. Keep that path authoritative.
			if (state.kind === "constant") return undefined;
			states[parameter.value] = state;
		}
	}
	if (!changed) return fn;
	return {
		...fn,
		blocks,
		values: fn.values.map((value) => {
			const representation = representations.get(value.id);
			return representation === undefined ? value : { ...value, representation };
		}),
		mutationEpoch: fn.mutationEpoch + 1,
	};
}

/** Sparse conditional constant propagation over executable ordinary and exceptional edges. */
const sparseConditionalConstantPropagation: CoreFunctionPass = {
	name: "sparse-conditional-constant-propagation",
	ablation: "constant-folding",
	run(fn, analyses, program) {
		const protectedInstructions = new Set(
			fn.regions.flatMap(({ claimedInstructions }) => claimedInstructions),
		);
		const linear = foldLinearPrimitiveConstants(fn, protectedInstructions, program);
		if (linear !== undefined) return linear;
		const cfg = analyses.controlFlow(fn);
		const valueCount = (fn.values.at(-1)?.id ?? -1) + 1;
		const instructionCount = nextInstructionId(fn);
		const states = new Array<ConstantLattice>(valueCount).fill(UNKNOWN_CONSTANT);
		const executableBlocks = new Uint8Array(fn.blocks.length);
		executableBlocks[fn.entry] = 1;
		const executableEdges = new Set<CoreEdge>();
		const executableExceptionalSources = new Uint8Array(fn.blocks.length);
		for (const parameter of fn.blocks[fn.entry]!.parameters) {
			states[parameter.value] = OVERDEFINED_CONSTANT;
		}

		type OrdinaryParameterBinding = {
			readonly edge: CoreEdge;
			readonly parameter: CoreValueId;
		};
		type ExceptionalParameterBinding = {
			readonly source: CoreBlockId;
			readonly parameter: CoreValueId;
		};
		const instructionUsers = new Array<Array<CoreInstruction> | undefined>(valueCount);
		const instructionBlocks = new Uint32Array(instructionCount);
		const terminatorUsers = new Array<Array<CoreBlockId> | undefined>(valueCount);
		const ordinaryParameterBindings = new Array<
			Array<OrdinaryParameterBinding> | undefined
		>(valueCount);
		const exceptionalParameterBindings = new Array<
			Array<ExceptionalParameterBinding> | undefined
		>(valueCount);
		const addInstructionUser = (
			value: CoreValueId,
			instruction: CoreInstruction,
		): void => {
			const users = instructionUsers[value] ?? (instructionUsers[value] = []);
			users.push(instruction);
		};
		const addTerminatorUser = (value: CoreValueId, block: CoreBlockId): void => {
			const users = terminatorUsers[value] ?? (terminatorUsers[value] = []);
			users.push(block);
		};
		const addOrdinaryBinding = (
			value: CoreValueId,
			binding: OrdinaryParameterBinding,
		): void => {
			const bindings =
				ordinaryParameterBindings[value] ?? (ordinaryParameterBindings[value] = []);
			bindings.push(binding);
		};
		const addExceptionalBinding = (
			value: CoreValueId,
			binding: ExceptionalParameterBinding,
		): void => {
			const bindings =
				exceptionalParameterBindings[value] ?? (exceptionalParameterBindings[value] = []);
			bindings.push(binding);
		};
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				instructionBlocks[instruction.id] = block.id;
				for (const input of instruction.inputs) {
					addInstructionUser(input, instruction);
				}
			}
			for (const edge of coreTerminatorEdges(block.terminator)) {
				const target = fn.blocks[edge.block]!;
				for (const [index, argument] of edge.arguments.entries()) {
					const parameter = target.parameters[index];
					if (parameter !== undefined) {
						addOrdinaryBinding(argument, { edge, parameter: parameter.value });
					}
				}
			}
			switch (block.terminator.kind) {
				case "branch":
				case "guard":
					addTerminatorUser(block.terminator.condition, block.id);
					break;
				case "switch":
					addTerminatorUser(block.terminator.discriminant, block.id);
					break;
				case "jump":
				case "return":
				case "throw":
				case "unreachable":
					break;
			}
			const exceptional = cfg.successors[block.id]!.find(
				({ kind }) => kind === "exceptional",
			);
			if (exceptional !== undefined) {
				const target = fn.blocks[exceptional.to]!;
				const offset = target.parameters[0]?.role === "exception" ? 1 : 0;
				for (const [index, argument] of exceptional.arguments.entries()) {
					const parameter = target.parameters[index + offset];
					if (parameter !== undefined) {
						addExceptionalBinding(argument, {
							source: block.id,
							parameter: parameter.value,
						});
					}
				}
			}
		}

		const pendingBlocks: Array<CoreBlockId> = [fn.entry];
		const pendingValues: Array<CoreValueId> = [];
		const pendingInstructions: Array<CoreInstruction> = [];
		const pendingTerminators: Array<CoreBlockId> = [];
		const scheduledInstructions = new Uint8Array(instructionCount);
		const scheduledTerminators = new Uint8Array(fn.blocks.length);
		const enqueueInstruction = (instruction: CoreInstruction): void => {
			if (
				executableBlocks[instructionBlocks[instruction.id]!] === 0 ||
				scheduledInstructions[instruction.id] !== 0
			) {
				return;
			}
			scheduledInstructions[instruction.id] = 1;
			pendingInstructions.push(instruction);
		};
		const enqueueTerminator = (block: CoreBlockId): void => {
			if (executableBlocks[block] === 0 || scheduledTerminators[block] !== 0) return;
			scheduledTerminators[block] = 1;
			pendingTerminators.push(block);
		};
		const mergeValue = (value: CoreValueId, state: ConstantLattice): boolean => {
			const current = states[value] ?? UNKNOWN_CONSTANT;
			const merged = mergeConstantLattice(current, state);
			if (merged === current) return false;
			states[value] = merged;
			pendingValues.push(value);
			return true;
		};
		const markOrdinary = (edge: CoreEdge): boolean => {
			if (executableEdges.has(edge)) return false;
			executableEdges.add(edge);
			if (executableBlocks[edge.block] === 0) {
				executableBlocks[edge.block] = 1;
				pendingBlocks.push(edge.block);
			}
			const target = fn.blocks[edge.block]!;
			for (const [index, argument] of edge.arguments.entries()) {
				const parameter = target.parameters[index];
				if (parameter !== undefined) {
					mergeValue(parameter.value, states[argument] ?? UNKNOWN_CONSTANT);
				}
			}
			return true;
		};
		const markExceptional = (
			from: CoreBlockId,
			to: CoreBlockId,
			arguments_: ReadonlyArray<CoreValueId>,
		): boolean => {
			if (executableExceptionalSources[from] !== 0) return false;
			executableExceptionalSources[from] = 1;
			if (executableBlocks[to] === 0) {
				executableBlocks[to] = 1;
				pendingBlocks.push(to);
			}
			const target = fn.blocks[to]!;
			const offset = target.parameters[0]?.role === "exception" ? 1 : 0;
			if (offset === 1) mergeValue(target.parameters[0]!.value, OVERDEFINED_CONSTANT);
			for (const [index, argument] of arguments_.entries()) {
				const parameter = target.parameters[index + offset];
				if (parameter !== undefined) {
					mergeValue(parameter.value, states[argument] ?? UNKNOWN_CONSTANT);
				}
			}
			return true;
		};
		const visitInstruction = (instruction: CoreInstruction): void => {
			const state = evaluateConstantInstruction(instruction, states, program);
			for (const output of instruction.outputs) mergeValue(output, state);
		};
		const visitTerminator = (blockId: CoreBlockId): void => {
			const block = fn.blocks[blockId]!;
			const terminator = block.terminator;
			switch (terminator.kind) {
				case "jump":
					markOrdinary(terminator.edge);
					break;
				case "branch": {
					const condition = states[terminator.condition] ?? UNKNOWN_CONSTANT;
					if (condition.kind === "constant") {
						const truthy = immediateTruthiness(condition.value, program);
						if (truthy === undefined) {
							markOrdinary(terminator.consequent);
							markOrdinary(terminator.alternate);
						} else {
							markOrdinary(truthy ? terminator.consequent : terminator.alternate);
						}
					} else if (condition.kind === "overdefined") {
						markOrdinary(terminator.consequent);
						markOrdinary(terminator.alternate);
					}
					break;
				}
				case "guard":
					// A guard establishes more than the truthiness of its condition.
					markOrdinary(terminator.success);
					markOrdinary(terminator.fallback);
					break;
				case "switch": {
					const discriminant = states[terminator.discriminant] ?? UNKNOWN_CONSTANT;
					if (discriminant.kind === "constant") {
						const matched = terminator.cases.find(({ value }) =>
							immediateStrictEquals(discriminant.value, value),
						);
						markOrdinary(matched?.edge ?? terminator.default);
					} else if (discriminant.kind === "overdefined") {
						for (const { edge } of terminator.cases) markOrdinary(edge);
						markOrdinary(terminator.default);
					}
					break;
				}
				case "return":
				case "throw":
				case "unreachable":
					break;
			}
		};

		// Wegman-Zadeck style dual worklists: CFG edges become executable once,
		// and each monotone SSA lattice change visits only its explicit users.
		// Expected work is O(blocks + CFG edges + instructions + SSA uses).
		while (
			pendingBlocks.length > 0 ||
			pendingValues.length > 0 ||
			pendingInstructions.length > 0 ||
			pendingTerminators.length > 0
		) {
			while (pendingBlocks.length > 0) {
				const blockId = pendingBlocks.pop()!;
				const block = fn.blocks[blockId]!;
				for (const instruction of block.instructions) visitInstruction(instruction);
				visitTerminator(blockId);
				for (const edge of cfg.successors[block.id]!) {
					if (edge.kind === "exceptional") {
						markExceptional(block.id, edge.to, edge.arguments);
					}
				}
			}
			while (pendingValues.length > 0) {
				const value = pendingValues.pop()!;
				const state = states[value]!;
				for (const user of instructionUsers[value] ?? []) {
					enqueueInstruction(user);
				}
				for (const block of terminatorUsers[value] ?? []) enqueueTerminator(block);
				for (const binding of ordinaryParameterBindings[value] ?? []) {
					if (executableEdges.has(binding.edge)) mergeValue(binding.parameter, state);
				}
				for (const binding of exceptionalParameterBindings[value] ?? []) {
					if (executableExceptionalSources[binding.source] !== 0) {
						mergeValue(binding.parameter, state);
					}
				}
			}
			while (pendingInstructions.length > 0) {
				const instruction = pendingInstructions.pop()!;
				scheduledInstructions[instruction.id] = 0;
				visitInstruction(instruction);
			}
			while (pendingTerminators.length > 0) {
				const block = pendingTerminators.pop()!;
				scheduledTerminators[block] = 0;
				visitTerminator(block);
			}
		}

		const representations = new Map<
			CoreValueId,
			CoreFunction["values"][number]["representation"]
		>();
		let changed = false;
		const blocks = fn.blocks.map((block): CoreBlock => {
			const instructions = block.instructions.map((instruction) => {
				if (
					protectedInstructions.has(instruction.id) ||
					instruction.outputs.length !== 1 ||
					(instruction.opcode !== "unary" && instruction.opcode !== "binary")
				) {
					return instruction;
				}
				const state = states[instruction.outputs[0]!];
				if (state?.kind !== "constant") return instruction;
				const replacement = foldedInstruction(instruction, state.value);
				if (replacement === undefined) return instruction;
				changed = true;
				representations.set(instruction.outputs[0]!, replacement.representation);
				return replacement.instruction;
			});
			const terminator = block.terminator;
			let selected: CoreEdge | undefined;
			if (fn.regions.length === 0 && terminator.kind === "branch") {
				const condition = states[terminator.condition];
				const truthy =
					condition?.kind === "constant"
						? immediateTruthiness(condition.value, program)
						: undefined;
				if (truthy !== undefined) {
					selected = truthy ? terminator.consequent : terminator.alternate;
				}
			} else if (fn.regions.length === 0 && terminator.kind === "switch") {
				const discriminant = states[terminator.discriminant];
				if (discriminant?.kind === "constant") {
					selected =
						terminator.cases.find(({ value }) =>
							immediateStrictEquals(discriminant.value, value),
						)?.edge ?? terminator.default;
				}
			}
			if (selected === undefined) return { ...block, instructions };
			changed = true;
			return {
				...block,
				instructions,
				terminator: {
					kind: "jump",
					id: terminator.id,
					edge: selected,
					...(terminator.sourcePosition === undefined
						? {}
						: { sourcePosition: terminator.sourcePosition }),
				},
			};
		});
		let result: CoreFunction = changed
			? {
					...fn,
					blocks,
					values: fn.values.map((value) => {
						const representation = representations.get(value.id);
						return representation === undefined ? value : { ...value, representation };
					}),
					mutationEpoch: fn.mutationEpoch + 1,
				}
			: fn;
		if (changed && fn.regions.length === 0) result = removeUnreachableCoreBlocks(result);
		if (changed) result = pruneVacuousHandlers(result);
		if (fn.regions.length > 0) return result;

		const removedIndices = new Map<CoreBlockId, Set<number>>();
		const retainedDefinitions = new Map<
			CoreValueId,
			{
				readonly instruction: CoreInstructionId;
				readonly representation: CoreFunction["values"][number]["representation"];
			}
		>();
		let instructionNumber = nextInstructionId(result);
		const materializedBlocks = result.blocks.map((block): CoreBlock => {
			if (block.id === result.entry) return block;
			const constants: Array<CoreInstruction> = [];
			for (const [index, parameter] of block.parameters.entries()) {
				if (parameter.role === "exception") continue;
				const state = states[parameter.value];
				if (state?.kind !== "constant") continue;
				const replacement = constantInstruction(
					coreInstructionId(instructionNumber++),
					parameter.value,
					state.value,
				);
				if (replacement === undefined) continue;
				constants.push(replacement.instruction);
				let indices = removedIndices.get(block.id);
				if (indices === undefined) removedIndices.set(block.id, (indices = new Set()));
				indices.add(index);
				retainedDefinitions.set(parameter.value, {
					instruction: replacement.instruction.id,
					representation: replacement.representation,
				});
			}
			return constants.length === 0
				? block
				: { ...block, instructions: [...constants, ...block.instructions] };
		});
		if (removedIndices.size > 0) {
			result = removeBlockParameters(
				{ ...result, blocks: materializedBlocks },
				removedIndices,
				new Map(),
				retainedDefinitions,
			);
		}
		return result;
	},
};

function immediateTruthiness(
	value: CoreImmediate,
	program?: CoreProgram,
): boolean | undefined {
	switch (value.kind) {
		case "undefined":
		case "null":
			return false;
		case "boolean":
			return value.value;
		case "number":
			return value.value !== 0 && !Number.isNaN(value.value);
		case "string": {
			if (program === undefined) return undefined;
			const units = program.stringConstants[value.index];
			return units === undefined ? undefined : units.length > 0;
		}
	}
}

function immediateStrictEquals(left: CoreImmediate, right: CoreImmediate): boolean {
	if (left.kind !== right.kind) return false;
	switch (left.kind) {
		case "undefined":
		case "null":
			return true;
		case "boolean":
			return left.value === (right as Extract<CoreImmediate, { kind: "boolean" }>).value;
		case "number":
			return left.value === (right as Extract<CoreImmediate, { kind: "number" }>).value;
		case "string":
			return left.index === (right as Extract<CoreImmediate, { kind: "string" }>).index;
	}
}

function immediateForValue(
	value: CoreValueId,
	definitions: ReadonlyMap<CoreValueId, CoreInstruction>,
): CoreImmediate | undefined {
	const instruction = definitions.get(value);
	return instruction === undefined ? undefined : constantImmediate(instruction);
}

/** Re-solve the narrow representation facts exposed by SCCP and copy cleanup. */
const refineValueRepresentations: CoreFunctionPass = {
	name: "refine-value-representations",
	run(fn, analyses, program) {
		const representations = new Map(
			fn.values.map(({ id, representation }) => [id, representation] as const),
		);
		const possibleArrayLengthLoads = fn.blocks.flatMap((block) =>
			block.instructions.filter(
				(instruction) =>
					instruction.opcode === "loadPropertyStatic" &&
					instruction.inputs.length === 1 &&
					typeof instruction.attributes.stringIndex === "number" &&
					decodeString(program, instruction.attributes.stringIndex) === "length",
			),
		);
		const freshArrayLengthLoads = new Set<CoreInstructionId>();
		if (possibleArrayLengthLoads.length > 0) {
			const provenance = analyses.provenance(fn);
			for (const instruction of possibleArrayLengthLoads) {
				if (provenance.allocationOf(instruction.inputs[0]!)?.kind === "indexed") {
					freshArrayLengthLoads.add(instruction.id);
				}
			}
		}
		const ordinaryIncoming = fn.blocks.map(() => new Array<CoreEdge>());
		const handlerTargets = new Set<CoreBlockId>();
		for (const source of fn.blocks) {
			for (const edge of coreTerminatorEdges(source.terminator)) {
				ordinaryIncoming[edge.block]!.push(edge);
			}
			if (source.handler !== undefined) handlerTargets.add(source.handler.block);
		}
		const hasCandidate = fn.blocks.some((block) => {
			if (
				block.id !== fn.entry &&
				!block.parameters.some(({ role }) => role === "exception") &&
				block.parameters.some(({ value }, index) => {
					if (representations.get(value) !== "boxed") return false;
					if (handlerTargets.has(block.id)) return true;
					const candidates = new Set(
						ordinaryIncoming[block.id]!.map(({ arguments: arguments_ }) =>
							representations.get(arguments_[index]!),
						),
					);
					if (candidates.size !== 1) return false;
					const candidate = [...candidates][0];
					return candidate === "i32" || candidate === "f64" || candidate === "boolean";
				})
			) {
				return true;
			}
			return block.instructions.some((instruction) => {
				const operator = instructionAttribute(instruction, "operator");
				return instruction.outputs.some((output, index) => {
					if (index === 0 && freshArrayLengthLoads.has(instruction.id)) {
						return (
							representations.get(output) === "boxed" ||
							instruction.attributes[CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE] !== true
						);
					}
					if (representations.get(output) !== "boxed") return false;
					if (
						instruction.opcode === "createF64" ||
						instruction.opcode === "createNumber" ||
						instruction.opcode === "mathUnaryNumber" ||
						instruction.opcode === "mathBinaryNumber"
					) {
						return true;
					}
					if (
						index === 0 &&
						(instruction.opcode === "createBoolean" ||
							instruction.opcode === "guardFunctionIndex" ||
							instruction.opcode === "hasPrivate" ||
							instruction.opcode === "isEmpty" ||
							instruction.opcode === "typeofCompare" ||
							(instruction.opcode === "binary" &&
								COMPARISON_REPRESENTATION_OPERATORS.has(String(operator))) ||
							(instruction.opcode === "unary" && operator === "!"))
					) {
						return true;
					}
					if (index !== 0 || instruction.inputs.length === 0) return false;
					if (instruction.opcode === "move" && instruction.inputs.length === 1) {
						const input = representations.get(instruction.inputs[0]!);
						return input === "i32" || input === "f64" || input === "boolean";
					}
					return (
						((instruction.opcode === "binary" &&
							NUMERIC_BINARY_REPRESENTATION_OPERATORS.has(String(operator))) ||
							(instruction.opcode === "unary" &&
								["-", "+", "~", "tonumeric", "increment", "decrement"].includes(
									String(operator),
								))) &&
						instruction.inputs.every((input) =>
							["i32", "f64"].includes(representations.get(input) ?? ""),
						)
					);
				});
			});
		});
		if (!hasCandidate) return fn;
		const cfg = analyses.controlFlow(fn);
		let changed = possibleArrayLengthLoads.some(
			(instruction) =>
				freshArrayLengthLoads.has(instruction.id) &&
				instruction.attributes[CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE] !== true,
		);
		let progress = true;
		const narrow = (
			value: CoreValueId,
			representation: "i32" | "f64" | "boolean" | undefined,
		): void => {
			if (representation !== undefined && representations.get(value) === "boxed") {
				representations.set(value, representation);
				progress = true;
				changed = true;
			}
		};
		while (progress) {
			progress = false;
			for (const block of fn.blocks) {
				if (
					block.id !== fn.entry &&
					!block.parameters.some(({ role }) => role === "exception")
				) {
					const incoming = cfg.predecessors[block.id]!.filter(
						({ kind }) => kind === "ordinary",
					);
					if (incoming.length === cfg.predecessors[block.id]!.length) {
						for (const [index, parameter] of block.parameters.entries()) {
							const candidates = new Set(
								incoming.map(({ arguments: arguments_ }) =>
									representations.get(arguments_[index]!),
								),
							);
							if (candidates.size === 1) {
								const candidate = [...candidates][0];
								narrow(
									parameter.value,
									candidate === "i32" || candidate === "f64" || candidate === "boolean"
										? candidate
										: undefined,
								);
							}
						}
					}
				}
				for (const instruction of block.instructions) {
					for (const [index, output] of instruction.outputs.entries()) {
						let candidate: "i32" | "f64" | "boolean" | undefined;
						const operator = instructionAttribute(instruction, "operator");
						if (
							instruction.opcode === "createF64" ||
							instruction.opcode === "createNumber" ||
							instruction.opcode === "mathUnaryNumber" ||
							instruction.opcode === "mathBinaryNumber" ||
							(index === 0 && freshArrayLengthLoads.has(instruction.id))
						) {
							candidate = "f64";
						} else if (
							index === 0 &&
							(instruction.opcode === "createBoolean" ||
								instruction.opcode === "guardFunctionIndex" ||
								instruction.opcode === "hasPrivate" ||
								instruction.opcode === "isEmpty" ||
								instruction.opcode === "typeofCompare" ||
								(instruction.opcode === "binary" &&
									COMPARISON_REPRESENTATION_OPERATORS.has(String(operator))) ||
								(instruction.opcode === "unary" && operator === "!"))
						) {
							candidate = "boolean";
						} else if (
							index === 0 &&
							instruction.opcode === "move" &&
							instruction.inputs.length === 1
						) {
							const input = representations.get(instruction.inputs[0]!);
							candidate =
								input === "i32" || input === "f64" || input === "boolean"
									? input
									: undefined;
						} else if (
							index === 0 &&
							((instruction.opcode === "binary" &&
								NUMERIC_BINARY_REPRESENTATION_OPERATORS.has(String(operator))) ||
								(instruction.opcode === "unary" &&
									["-", "+", "~", "tonumeric", "increment", "decrement"].includes(
										String(operator),
									))) &&
							instruction.inputs.length > 0 &&
							instruction.inputs.every((input) =>
								["i32", "f64"].includes(representations.get(input) ?? ""),
							)
						) {
							candidate =
								instruction.opcode === "unary" && operator === "~"
									? "i32"
									: instruction.opcode === "binary" &&
										  INT32_BINARY_REPRESENTATION_OPERATORS.has(String(operator))
										? "i32"
										: "f64";
						}
						narrow(output, candidate);
					}
				}
			}
		}
		if (!changed) return fn;
		return {
			...fn,
			blocks: fn.blocks.map((block) => ({
				...block,
				instructions: block.instructions.map((instruction) =>
					freshArrayLengthLoads.has(instruction.id) &&
					instruction.attributes[CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE] !== true
						? {
								...instruction,
								attributes: {
									...instruction.attributes,
									[CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE]: true,
								},
							}
						: instruction,
				),
				parameters: block.parameters.map((parameter) => ({
					...parameter,
					representation: representations.get(parameter.value)!,
				})),
			})),
			values: fn.values.map((value) => ({
				...value,
				representation: representations.get(value.id)!,
			})),
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

/**
 * Representation-proven algebraic identities only. Boxed operations retain
 * their original coercion order, and f64 rewrites explicitly account for NaN
 * and signed zero rather than importing integer-ring identities into JavaScript.
 */
const simplifyAlgebraicValues: CoreFunctionPass = {
	name: "simplify-algebraic-values",
	ablation: "constant-folding",
	run(fn, analyses) {
		const representations = analyses.representations(fn);
		if (
			!fn.blocks.some((block) =>
				block.instructions.some(
					(instruction) =>
						(instruction.opcode === "binary" ||
							instruction.opcode === "mathUnaryNumber" ||
							instruction.opcode === "mathBinaryNumber") &&
						instruction.outputs.some((output) => representations.get(output) !== "boxed"),
				),
			)
		) {
			return fn;
		}
		const definitions = new Map<CoreValueId, CoreInstruction>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				for (const output of instruction.outputs) definitions.set(output, instruction);
			}
		}
		const protectedInstructions = new Set(
			fn.regions.flatMap(({ claimedInstructions }) => claimedInstructions),
		);
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					if (
						protectedInstructions.has(instruction.id) ||
						instruction.outputs.length !== 1
					) {
						return instruction;
					}
					const output = instruction.outputs[0]!;
					const outputRepresentation = representations.get(output);
					const move = (value: CoreValueId): CoreInstruction | undefined => {
						if (representations.get(value) !== outputRepresentation) return undefined;
						return {
							...instruction,
							opcode: "move",
							inputs: [value],
							attributes: {},
						};
					};
					const constant = (value: CoreImmediate): CoreInstruction | undefined => {
						const replacement = foldedInstruction(instruction, value);
						return replacement !== undefined &&
							replacement.representation === outputRepresentation
							? replacement.instruction
							: undefined;
					};
					let replacement: CoreInstruction | undefined;
					if (
						instruction.opcode === "mathBinaryNumber" &&
						instruction.inputs.length === 2
					) {
						const operation = instructionAttribute(instruction, "operation");
						if (
							(operation === "Math.min" || operation === "Math.max") &&
							instruction.inputs[0] === instruction.inputs[1]
						) {
							replacement = move(instruction.inputs[0]!);
						}
					} else if (
						instruction.opcode === "mathUnaryNumber" &&
						instruction.inputs.length === 1
					) {
						const operation = instructionAttribute(instruction, "operation");
						const producer = definitions.get(instruction.inputs[0]!);
						if (
							typeof operation === "string" &&
							IDEMPOTENT_MATH_UNARY_OPERATIONS.has(operation) &&
							producer?.opcode === "mathUnaryNumber" &&
							instructionAttribute(producer, "operation") === operation
						) {
							replacement = move(instruction.inputs[0]!);
						}
					} else if (instruction.opcode === "binary" && instruction.inputs.length === 2) {
						let [left, right] = instruction.inputs;
						const leftRepresentation = representations.get(left!);
						const rightRepresentation = representations.get(right!);
						const operator = instructionAttribute(instruction, "operator");
						const leftConstant = immediateForValue(left!, definitions);
						const rightConstant = immediateForValue(right!, definitions);
						if (
							leftRepresentation === "boolean" &&
							rightRepresentation === "boolean" &&
							outputRepresentation === "boolean" &&
							["==", "!=", "===", "!=="].includes(String(operator))
						) {
							const boolean =
								leftConstant?.kind === "boolean"
									? { value: leftConstant.value, variable: right! }
									: rightConstant?.kind === "boolean"
										? { value: rightConstant.value, variable: left! }
										: undefined;
							if (boolean !== undefined) {
								const equal = operator === "==" || operator === "===";
								const identity = equal === boolean.value;
								replacement = identity
									? move(boolean.variable)
									: {
											...instruction,
											opcode: "unary",
											inputs: [boolean.variable],
											attributes: { operator: "!" },
										};
							}
						} else if (leftRepresentation === "f64" && rightRepresentation === "f64") {
							if (
								outputRepresentation === "f64" &&
								operator === "+" &&
								leftConstant?.kind === "number" &&
								Object.is(leftConstant.value, -0)
							) {
								replacement = move(right!);
							} else if (
								outputRepresentation === "f64" &&
								operator === "+" &&
								rightConstant?.kind === "number" &&
								Object.is(rightConstant.value, -0)
							) {
								replacement = move(left!);
							} else if (
								outputRepresentation === "f64" &&
								operator === "-" &&
								rightConstant?.kind === "number" &&
								Object.is(rightConstant.value, 0)
							) {
								replacement = move(left!);
							} else if (
								outputRepresentation === "f64" &&
								(operator === "*" || operator === "/") &&
								rightConstant?.kind === "number" &&
								rightConstant.value === 1
							) {
								replacement = move(left!);
							} else if (
								outputRepresentation === "f64" &&
								operator === "*" &&
								leftConstant?.kind === "number" &&
								leftConstant.value === 1
							) {
								replacement = move(right!);
							} else if (
								outputRepresentation === "f64" &&
								operator === "&" &&
								((leftConstant?.kind === "number" && leftConstant.value === 0) ||
									(rightConstant?.kind === "number" && rightConstant.value === 0))
							) {
								replacement = constant({ kind: "number", value: 0 });
							} else if (
								outputRepresentation === "f64" &&
								operator === "^" &&
								left === right
							) {
								replacement = constant({ kind: "number", value: 0 });
							} else if (
								outputRepresentation === "boolean" &&
								(operator === "<" || operator === ">") &&
								left === right
							) {
								replacement = constant({ kind: "boolean", value: false });
							} else if (
								outputRepresentation === "boolean" &&
								leftConstant !== undefined &&
								rightConstant === undefined &&
								["<", "<=", ">", ">="].includes(String(operator))
							) {
								const reversed = new Map([
									["<", ">"],
									["<=", ">="],
									[">", "<"],
									[">=", "<="],
								]).get(String(operator));
								if (reversed !== undefined) {
									[left, right] = [right, left];
									replacement = {
										...instruction,
										inputs: [left!, right!],
										attributes: {
											...instruction.attributes,
											operator: reversed,
										},
									};
								}
							}
						}
					}
					if (replacement === undefined) return instruction;
					changed = true;
					return withoutEffectRefinement(replacement);
				}),
			}),
		);
		return changed
			? pruneVacuousHandlers({
					...fn,
					blocks,
					mutationEpoch: fn.mutationEpoch + 1,
				})
			: fn;
	},
};

/**
 * The verifier re-proves an effect refinement from scratch when its proof has one
 * of these kinds: `verifyOwnDataCellRefinements` re-derives containment, and the
 * program-level checks re-derive call summaries and primitive operand kinds. They
 * work by proof kind, so moving a refinement onto or off one of them would
 * silently change which independent check runs. Proofs of these kinds are never
 * rewired.
 */
const CORE_REPROVED_FACT_KINDS: ReadonlySet<string> = new Set([
	CORE_CONTAINED_AGGREGATE_OWN_SLOT_FACT,
	CORE_OWN_DATA_CELL_FACT,
	CORE_CALL_EFFECT_SUMMARY_FACT,
	CORE_PRIMITIVE_OPERATOR_EFFECT_FACT,
	CORE_EXACT_SHAPE_OWN_SLOT_EFFECT_FACT,
	CORE_EXACT_COLLECTION_BUILTIN_EFFECT_FACT,
]);

function coreFactValidityRank(fact: CoreFact): number {
	switch (fact.validity.kind) {
		case "world":
			return 0;
		case "summary":
			return 1;
		case "guard":
			return 2;
		case "epoch":
			return 3;
		case "asserted":
			return 4;
	}
}

/**
 * Total order over interchangeable replacements: a strictly stronger fact first,
 * then the cheapest authority, then the fewest obligations, then the lowest id so
 * the choice never depends on visit order.
 */
function preferCoreFactReplacement(candidate: CoreFact, incumbent: CoreFact): boolean {
	const stronger = coreFactImplies(candidate, incumbent);
	const weaker = coreFactImplies(incumbent, candidate);
	if (stronger !== weaker) return stronger;
	const validity = coreFactValidityRank(candidate) - coreFactValidityRank(incumbent);
	if (validity !== 0) return validity < 0;
	const obligations = candidate.obligations.length - incumbent.obligations.length;
	return obligations !== 0 ? obligations < 0 : candidate.id < incumbent.id;
}

interface CoreFactSubsumption {
	/** Canonicalized facts, in the function's fact order. */
	readonly facts: ReadonlyArray<CoreFact>;
	readonly canonicalized: boolean;
	fact(id: CoreFactId): CoreFact | undefined;
	/** Instructions naming the fact as their effect-refinement proof. */
	refinementUses(id: CoreFactId): number;
	/** Facts this guard instruction establishes or keeps alive. */
	guardFacts(guard: CoreInstructionId): number;
	/**
	 * The preferred available fact that establishes everything `weak` states at
	 * the given point, or undefined when no other fact does.
	 */
	replacementFor(
		weak: CoreFact,
		block: CoreBlockId,
		point: number,
		excluded?: ReadonlySet<CoreFactId>,
	): CoreFact | undefined;
}

/**
 * Index the function's facts for implication queries.
 *
 * Availability is deliberately strict. A guard establishes its fact on the
 * success *edge*, so the proof is only usable where that edge dominates the
 * consumer; success-block dominance would also hold on a path that bypassed the
 * guard entirely. A claim about a value additionally needs that value to be
 * defined at the consumer, because a claim carries no program point of its own.
 *
 * Cost is one pass over blocks, instructions, and claims to build the indexes.
 * A lookup scans the smallest family one of `weak`'s claims belongs to — facts
 * that share a subject value or a claimed instruction — so it is bounded by that
 * family rather than by the function's fact count.
 */
function coreFactSubsumption(
	fn: CoreFunction,
	cfg: CoreControlFlow,
	canonicalValues: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreFactSubsumption {
	let canonicalized = false;
	const facts = fn.facts.map((fact) => {
		let subjectsChanged = false;
		const claims = fact.claims.map((claim): CoreFactClaim => {
			if (claim.kind === "effect") return claim;
			const subject = canonicalValues.get(claim.subject) ?? claim.subject;
			if (subject === claim.subject) return claim;
			subjectsChanged = true;
			return { ...claim, subject };
		});
		const normalized = normalizeCoreFact(subjectsChanged ? { ...fact, claims } : fact);
		if (normalized !== fact) canonicalized = true;
		return normalized;
	});
	const byId = new Map(facts.map((fact) => [fact.id, fact] as const));
	const familyKeys = new Map<CoreFactId, ReadonlyArray<string>>();
	const byFamily = new Map<string, Array<CoreFact>>();
	const factGuards = new Map<CoreFactId, ReadonlyArray<CoreInstructionId>>();
	const guardFactCounts = new Map<CoreInstructionId, number>();
	for (const fact of facts) {
		const keys = coreFactFamilyKeys(fact);
		familyKeys.set(fact.id, keys);
		for (const key of keys) {
			const family = byFamily.get(key);
			if (family === undefined) byFamily.set(key, [fact]);
			else family.push(fact);
		}
		const guards = new Set<CoreInstructionId>();
		if (fact.validity.kind === "guard") guards.add(fact.validity.instruction);
		for (const obligation of fact.obligations) {
			if (obligation.kind === "guard") guards.add(obligation.instruction);
		}
		factGuards.set(fact.id, [...guards]);
		for (const guard of guards) {
			guardFactCounts.set(guard, (guardFactCounts.get(guard) ?? 0) + 1);
		}
	}

	const guardEdges = new Map<
		CoreInstructionId,
		{ readonly block: CoreBlockId; readonly success: CoreBlockId }
	>();
	const definitions = new Map<
		CoreValueId,
		{ readonly block: CoreBlockId; readonly point: number }
	>();
	const refinementUses = new Map<CoreFactId, number>();
	for (const block of fn.blocks) {
		for (const parameter of block.parameters) {
			definitions.set(parameter.value, { block: block.id, point: -1 });
		}
		for (const [point, instruction] of block.instructions.entries()) {
			for (const output of instruction.outputs) {
				definitions.set(output, { block: block.id, point });
			}
			const proof = instruction.effectRefinement?.proof;
			if (proof !== undefined) {
				refinementUses.set(proof, (refinementUses.get(proof) ?? 0) + 1);
			}
		}
		if (block.terminator.kind === "guard") {
			guardEdges.set(block.terminator.id, {
				block: block.id,
				success: block.terminator.success.block,
			});
		}
	}

	const subjectAvailable = (
		subject: CoreValueId,
		block: CoreBlockId,
		point: number,
	): boolean => {
		const definition = definitions.get(subject);
		if (definition === undefined) return false;
		if (definition.block === block) return definition.point < point;
		return definition.point < 0
			? cfg.dominates(definition.block, block)
			: cfg.instructionDominatesBlock(definition.block, block);
	};

	const available = (fact: CoreFact, block: CoreBlockId, point: number): boolean => {
		const guards = factGuards.get(fact.id) ?? [];
		if (guards.length === 0) {
			// Nothing in the graph re-establishes an epoch or asserted fact, so only a
			// world or summary premise holds without a guard to point at.
			if (fact.validity.kind !== "world" && fact.validity.kind !== "summary") {
				return false;
			}
		}
		for (const guard of guards) {
			const edge = guardEdges.get(guard);
			if (edge === undefined || !cfg.dominatesEdge(edge.block, edge.success, block)) {
				return false;
			}
		}
		return fact.claims.every(
			(claim) => claim.kind === "effect" || subjectAvailable(claim.subject, block, point),
		);
	};

	return {
		facts,
		canonicalized,
		fact: (id) => byId.get(id),
		refinementUses: (id) => refinementUses.get(id) ?? 0,
		guardFacts: (guard) => guardFactCounts.get(guard) ?? 0,
		replacementFor: (weak, block, point, excluded) => {
			let smallest: ReadonlyArray<CoreFact> | undefined;
			for (const key of familyKeys.get(weak.id) ?? []) {
				const family = byFamily.get(key) ?? [];
				if (smallest === undefined || family.length < smallest.length) smallest = family;
			}
			let best: CoreFact | undefined;
			for (const candidate of smallest ?? []) {
				if (
					candidate.id === weak.id ||
					excluded?.has(candidate.id) === true ||
					!coreFactImplies(candidate, weak) ||
					!available(candidate, block, point)
				) {
					continue;
				}
				if (best === undefined || preferCoreFactReplacement(candidate, best)) {
					best = candidate;
				}
			}
			return best;
		},
	};
}

/**
 * Canonicalize fact claims and move each effect refinement onto a strictly better
 * proof already available where it is consumed. Nothing here changes control flow,
 * so it also runs on functions that already carry region certificates.
 */
const subsumeCoreFactProofs: CoreFunctionPass = {
	name: "subsume-core-fact-proofs",
	run(fn, analyses) {
		if (fn.facts.length === 0) return fn;
		const subsumption = coreFactSubsumption(
			fn,
			analyses.controlFlow(fn),
			analyses.canonicalValues(fn),
		);
		// A region certificate is proven against exact instructions, and the proof a
		// refinement names is part of one.
		const { instructions: claimed } = analyses.regionProtection(fn);
		let changed = false;
		const blocks = fn.blocks.map((block): CoreBlock => {
			let blockChanged = false;
			const instructions = block.instructions.map(
				(instruction, point): CoreInstruction => {
					const refinement = instruction.effectRefinement;
					if (refinement === undefined) return instruction;
					const weak = subsumption.fact(refinement.proof);
					if (
						weak === undefined ||
						claimed.has(instruction.id) ||
						CORE_REPROVED_FACT_KINDS.has(weak.kind)
					) {
						return instruction;
					}
					const replacement = subsumption.replacementFor(weak, block.id, point);
					// Only a strictly better proof is worth moving to. Two interchangeable
					// facts would otherwise trade the refinement back and forth for as many
					// rounds as the fixpoint allows.
					if (
						replacement === undefined ||
						CORE_REPROVED_FACT_KINDS.has(replacement.kind) ||
						!preferCoreFactReplacement(replacement, weak)
					) {
						return instruction;
					}
					blockChanged = true;
					return {
						...instruction,
						effectRefinement: { ...refinement, proof: replacement.id },
					};
				},
			);
			if (!blockChanged) return block;
			changed = true;
			return { ...block, instructions };
		});
		return changed || subsumption.canonicalized
			? {
					...fn,
					blocks,
					facts: subsumption.facts,
					mutationEpoch: fn.mutationEpoch + 1,
				}
			: fn;
	},
};

/**
 * Fold a guard whose fact is already established by another available proof.
 *
 * Decisions are taken in reverse postorder and are never justified by a fact this
 * run already removed, so the set of folds is deterministic and the justification
 * relation cannot cycle. Success-edge dominance already rules such a cycle out —
 * two guards cannot each run only after the other has succeeded — but the
 * exclusion keeps a future dominance bug from deleting both checks of a pair that
 * proves itself.
 */
const foldSubsumedCoreGuards: CoreFunctionPass = {
	name: "fold-subsumed-core-guards",
	changesControlFlow: true,
	run(fn, analyses) {
		// `removeUnreachableCoreBlocks` renumbers blocks and does not remap region
		// block lists. The driver already skips control-flow passes on region-bearing
		// functions; this keeps the coupling true if that ever changes.
		if (fn.facts.length < 2 || fn.regions.length > 0) return fn;
		const cfg = analyses.controlFlow(fn);
		const subsumption = coreFactSubsumption(fn, cfg, analyses.canonicalValues(fn));
		const removedFacts = new Set<CoreFactId>();
		const foldedGuards = new Set<CoreInstructionId>();
		for (const blockId of cfg.reversePostorder) {
			const block = fn.blocks[blockId];
			if (block?.terminator.kind !== "guard") continue;
			const terminator = block.terminator;
			const weak = subsumption.fact(terminator.fact);
			if (weak === undefined) continue;
			// A non-guard obligation is a promise to another layer that no dominating
			// proof discharges; only the guard itself becomes redundant.
			if (weak.obligations.some(({ kind }) => kind !== "guard")) continue;
			// The guard also establishes another fact, or a refinement still names
			// this one. Folding would strand a proof either way.
			if (subsumption.guardFacts(terminator.id) > 1) continue;
			if (subsumption.refinementUses(weak.id) > 0) continue;
			const replacement = subsumption.replacementFor(
				weak,
				blockId,
				block.instructions.length,
				removedFacts,
			);
			if (replacement === undefined) continue;
			removedFacts.add(weak.id);
			foldedGuards.add(terminator.id);
		}
		if (foldedGuards.size === 0) {
			return subsumption.canonicalized
				? {
						...fn,
						facts: subsumption.facts,
						mutationEpoch: fn.mutationEpoch + 1,
					}
				: fn;
		}
		const blocks = fn.blocks.map((block): CoreBlock => {
			const terminator = block.terminator;
			if (terminator.kind !== "guard" || !foldedGuards.has(terminator.id)) return block;
			return {
				...block,
				terminator: {
					kind: "jump",
					id: terminator.id,
					edge: terminator.success,
					...(terminator.sourcePosition === undefined
						? {}
						: { sourcePosition: terminator.sourcePosition }),
				},
			};
		});
		return removeUnreachableCoreBlocks({
			...fn,
			blocks,
			facts: subsumption.facts.filter((fact) => !removedFacts.has(fact.id)),
			mutationEpoch: fn.mutationEpoch + 1,
		});
	},
};

/** Resolve primitive branches and switches, then restore Core's dense reachable CFG. */
const simplifyControlFlow: CoreFunctionPass = {
	name: "simplify-control-flow",
	changesControlFlow: true,
	run(fn) {
		if (
			!fn.blocks.some(
				(block) =>
					block.handler !== undefined ||
					block.terminator.kind === "branch" ||
					block.terminator.kind === "switch" ||
					block.terminator.kind === "guard",
			)
		) {
			return fn;
		}
		const constants = new Map<CoreValueId, CoreImmediate>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.outputs.length !== 1) continue;
				const value = constantImmediate(instruction);
				if (value !== undefined) constants.set(instruction.outputs[0]!, value);
			}
		}
		let changed = false;
		const blocks = fn.blocks.map((block): CoreBlock => {
			const terminator = block.terminator;
			let handler = block.handler;
			if (
				handler !== undefined &&
				terminator.kind !== "throw" &&
				!block.instructions.some(
					(instruction) =>
						(
							instruction.effectRefinement?.effects ??
							coreOpcodeRegistry.require(instruction.opcode).effects
						).mayThrow,
				)
			) {
				handler = undefined;
				changed = true;
			}
			if (terminator.kind === "branch") {
				if (sameEdge(terminator.consequent, terminator.alternate)) {
					changed = true;
					return {
						...block,
						...(handler === undefined ? { handler: undefined } : { handler }),
						terminator: {
							kind: "jump",
							id: terminator.id,
							edge: terminator.consequent,
							...(terminator.sourcePosition === undefined
								? {}
								: { sourcePosition: terminator.sourcePosition }),
						},
					};
				}
				const condition = constants.get(terminator.condition);
				const truthy =
					condition === undefined ? undefined : immediateTruthiness(condition);
				if (truthy === undefined) return block;
				changed = true;
				return {
					...block,
					...(handler === undefined ? { handler: undefined } : { handler }),
					terminator: {
						kind: "jump",
						id: terminator.id,
						edge: truthy ? terminator.consequent : terminator.alternate,
						...(terminator.sourcePosition === undefined
							? {}
							: { sourcePosition: terminator.sourcePosition }),
					},
				};
			}
			if (terminator.kind === "switch") {
				if (terminator.cases.every(({ edge }) => sameEdge(edge, terminator.default))) {
					changed = true;
					return {
						...block,
						...(handler === undefined ? { handler: undefined } : { handler }),
						terminator: {
							kind: "jump",
							id: terminator.id,
							edge: terminator.default,
							...(terminator.sourcePosition === undefined
								? {}
								: { sourcePosition: terminator.sourcePosition }),
						},
					};
				}
				const discriminant = constants.get(terminator.discriminant);
				if (discriminant === undefined) return block;
				const matched = terminator.cases.find(({ value }) =>
					immediateStrictEquals(discriminant, value),
				);
				changed = true;
				return {
					...block,
					...(handler === undefined ? { handler: undefined } : { handler }),
					terminator: {
						kind: "jump",
						id: terminator.id,
						edge: matched?.edge ?? terminator.default,
						...(terminator.sourcePosition === undefined
							? {}
							: { sourcePosition: terminator.sourcePosition }),
					},
				};
			}
			if (
				terminator.kind === "guard" &&
				sameEdge(terminator.success, terminator.fallback)
			) {
				const factUsed = fn.blocks.some((candidate) =>
					candidate.instructions.some(
						({ effectRefinement }) => effectRefinement?.proof === terminator.fact,
					),
				);
				const guardRequiredByAnotherFact = fn.facts.some(
					(fact) =>
						fact.id !== terminator.fact &&
						((fact.validity.kind === "guard" &&
							fact.validity.instruction === terminator.id) ||
							fact.obligations.some(
								(obligation) =>
									obligation.kind === "guard" && obligation.instruction === terminator.id,
							)),
				);
				if (!factUsed && !guardRequiredByAnotherFact) {
					changed = true;
					return {
						...block,
						...(handler === undefined ? { handler: undefined } : { handler }),
						terminator: {
							kind: "jump",
							id: terminator.id,
							edge: terminator.success,
							...(terminator.sourcePosition === undefined
								? {}
								: { sourcePosition: terminator.sourcePosition }),
						},
					};
				}
			}
			return handler === block.handler
				? block
				: {
						...block,
						...(handler === undefined ? { handler: undefined } : { handler }),
					};
		});
		if (!changed) return fn;
		return removeUnreachableCoreBlocks({
			...fn,
			blocks,
			mutationEpoch: fn.mutationEpoch + 1,
		});
	},
};

/** Replace local-only unwind regions with equivalent explicit value edges. */
const lowerLocalThrowCatchFlows: CoreFunctionPass = {
	name: "lower-local-throw-catch-flows",
	changesControlFlow: true,
	run(fn, analyses) {
		const flows = analyzeCoreLocalExceptionFlows(fn, analyses.controlFlow(fn));
		if (flows.length === 0) return fn;
		const bySource = new Map(flows.map((flow) => [flow.source, flow]));
		const handlerBlocks = new Set(flows.map(({ handler }) => handler));
		return {
			...fn,
			blocks: fn.blocks.map((block): CoreBlock => {
				const parameters = handlerBlocks.has(block.id)
					? block.parameters.map((parameter, index) =>
							index === 0 ? { ...parameter, role: "value" as const } : parameter,
						)
					: block.parameters;
				const flow = bySource.get(block.id);
				if (flow !== undefined) {
					return {
						...block,
						parameters,
						handler: undefined,
						terminator: {
							kind: "jump",
							id: block.terminator.id,
							edge: {
								block: flow.handler,
								arguments: [flow.thrownValue, ...flow.handlerArguments],
							},
							...(block.terminator.sourcePosition === undefined
								? {}
								: { sourcePosition: block.terminator.sourcePosition }),
						},
					};
				}
				return parameters === block.parameters ? block : { ...block, parameters };
			}),
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

const IDENTITY_PRODUCING_OPCODES = new Set([
	"createArgumentsObject",
	"createArray",
	// A function has fresh identity and captures the current environment pointer.
	"createFunction",
	"createModuleNamespace",
	"createObject",
	"createObjectShaped",
	"createPrivateName",
	"createPrivateNames",
	"createRestArguments",
	"createTemplateObject",
	"instantiateLiteralTemplate",
]);

// Empty read domains are not themselves proof of immutability. Keep this list
// explicit so a newly added resource load is never commoned until its effect
// partition (or immutable producer semantics) has been reviewed.
const IMMUTABLE_VALUE_NUMBERING_OPCODES = new Set([
	"binary",
	"createBigint",
	"createBoolean",
	"createEmpty",
	"createF64",
	"createNull",
	"createNumber",
	"createString",
	"createUndefined",
	"guardFunctionIndex",
	"isEmpty",
	"loadIntrinsic",
	"loadNewTarget",
	"mathBinaryNumber",
	"mathUnaryNumber",
	"move",
	"typeofCompare",
	"unary",
]);

function instructionIsDiscardable(instruction: CoreInstruction): boolean {
	if (coreOpcodeRegistry.require(instruction.opcode).discardable) return true;
	if (instruction.effectRefinement === undefined) return false;
	const effects = coreInstructionEffects(instruction);
	return (
		effects.reads.length === 0 &&
		effects.writes.length === 0 &&
		!effects.mayThrow &&
		!effects.maySuspend &&
		!effects.mayGc &&
		!effects.callsUserCode
	);
}

function pruneVacuousHandlers(fn: CoreFunction): CoreFunction {
	let changed = false;
	const blocks = fn.blocks.map((block): CoreBlock => {
		if (
			block.handler === undefined ||
			block.terminator.kind === "throw" ||
			block.instructions.some(
				(instruction) => coreInstructionEffects(instruction).mayThrow,
			)
		) {
			return block;
		}
		changed = true;
		return { ...block, handler: undefined };
	});
	if (!changed) return fn;
	return removeUnreachableCoreBlocks({
		...fn,
		blocks,
		mutationEpoch: fn.mutationEpoch + 1,
	});
}

const pruneVacuousExceptionHandlers: CoreFunctionPass = {
	name: "prune-vacuous-exception-handlers",
	changesControlFlow: true,
	run: pruneVacuousHandlers,
};

function valueNumberingKey(
	instruction: CoreInstruction,
	memoryVersion: string,
): string | undefined {
	if (!isValueNumberingCandidate(instruction)) return undefined;
	return `${instruction.opcode}\0${instruction.inputs.join(",")}\0${stableAttributes(instruction)}\0${memoryVersion}`;
}

function isValueNumberingCandidate(instruction: CoreInstruction): boolean {
	if (instruction.attributes[CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE] !== undefined) {
		return false;
	}
	const effects = coreInstructionEffects(instruction);
	return !(
		instruction.outputs.length === 0 ||
		!instructionIsDiscardable(instruction) ||
		IDENTITY_PRODUCING_OPCODES.has(instruction.opcode) ||
		(effects.reads.length === 0 &&
			!IMMUTABLE_VALUE_NUMBERING_OPCODES.has(instruction.opcode)) ||
		effects.writes.length > 0 ||
		effects.callsUserCode ||
		effects.maySuspend
	);
}

function isEliminableMove(instruction: CoreInstruction): boolean {
	// The marked move is a checked boxed-to-scalar conversion, not an SSA alias.
	return (
		instruction.opcode === "move" &&
		instruction.inputs.length === 1 &&
		instruction.outputs.length === 1 &&
		instruction.attributes[CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE] === undefined
	);
}

/**
 * Instructions a region certificate pins, and the values they consume. A pass may
 * neither rewrite a pinned instruction nor replace one of its operands, because
 * the certificate is a proof about those exact identities.
 */
function regionProtectedValues(fn: CoreFunction): CoreRegionProtection {
	const instructions = new Set(
		fn.regions.flatMap(({ claimedInstructions }) => claimedInstructions),
	);
	const inputs = new Set<CoreValueId>();
	if (instructions.size === 0) return { instructions, inputs };
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!instructions.has(instruction.id)) continue;
			for (const input of instruction.inputs) inputs.add(input);
		}
		if (!instructions.has(block.terminator.id)) continue;
		const addEdge = (edge: CoreEdge) => {
			for (const argument of edge.arguments) inputs.add(argument);
		};
		switch (block.terminator.kind) {
			case "jump":
				addEdge(block.terminator.edge);
				break;
			case "branch":
				inputs.add(block.terminator.condition);
				addEdge(block.terminator.consequent);
				addEdge(block.terminator.alternate);
				break;
			case "guard":
				inputs.add(block.terminator.condition);
				addEdge(block.terminator.success);
				addEdge(block.terminator.fallback);
				break;
			case "switch":
				inputs.add(block.terminator.discriminant);
				for (const { edge } of block.terminator.cases) addEdge(edge);
				addEdge(block.terminator.default);
				break;
			case "return":
			case "throw":
				inputs.add(block.terminator.value);
				break;
			case "unreachable":
				break;
		}
	}
	return { instructions, inputs };
}

/** A duplicate GVN key requires two eligible instructions with the same opcode. */
function mayCopyOrValueNumber(fn: CoreFunction): boolean {
	const candidates = new Set<string>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (isEliminableMove(instruction)) {
				return true;
			}
			if (!isValueNumberingCandidate(instruction)) continue;
			if (candidates.has(instruction.opcode)) return true;
			candidates.add(instruction.opcode);
		}
	}
	return false;
}

interface LoopInvariantCandidate {
	readonly kind: "pure" | "load";
	/** Relative compile-time/code-generation price used by the structural budget. */
	readonly cost: number;
	/** Boxed primitive kept live across the loop after hoisting. */
	readonly addedRootSlots: number;
}

const LOOP_UNROOTED_REPRESENTATIONS = new Set(["f64", "i32", "boolean"]);

function isContainedArrayLengthRead(
	instruction: CoreInstruction,
	provenance: CoreProvenance,
): boolean {
	for (const access of coreMemoryAccesses(instruction)) {
		if (access.mode !== "read" || access.base === undefined || access.key === undefined) {
			continue;
		}
		const resolved = provenance.ownCell(access.base, access.key, "read");
		if (resolved?.layout.kind === "indexed" && resolved.cell.kind === "object-slot") {
			return true;
		}
	}
	return false;
}

function loopInvariantCandidate(
	instruction: CoreInstruction,
	provenance: CoreProvenance,
	resolution: CoreMemoryResolution,
	representations: ReadonlyMap<CoreValueId, string>,
): LoopInvariantCandidate | undefined {
	const arrayLength = isContainedArrayLengthRead(instruction, provenance);
	if (
		instruction.outputs.length === 0 ||
		IDENTITY_PRODUCING_OPCODES.has(instruction.opcode) ||
		(!instructionIsDiscardable(instruction) && !arrayLength)
	) {
		return undefined;
	}
	const effects = coreInstructionEffects(instruction);
	if (
		IMMUTABLE_VALUE_NUMBERING_OPCODES.has(instruction.opcode) &&
		effects.reads.length === 0 &&
		effects.writes.length === 0 &&
		!effects.mayThrow &&
		!effects.maySuspend &&
		!effects.mayGc &&
		!effects.callsUserCode
	) {
		const addedRootSlots = instruction.outputs.filter(
			(output) => !LOOP_UNROOTED_REPRESENTATIONS.has(representations.get(output) ?? ""),
		).length;
		return {
			kind: "pure",
			cost:
				instruction.opcode === "mathUnaryNumber" ||
				instruction.opcode === "mathBinaryNumber"
					? 4
					: 1,
			addedRootSlots,
		};
	}
	if (
		instruction.outputs.length !== 1 ||
		effects.reads.length === 0 ||
		effects.writes.length > 0 ||
		effects.mayThrow ||
		effects.maySuspend ||
		effects.callsUserCode
	) {
		return undefined;
	}
	const accesses = coreMemoryAccesses(instruction, resolution);
	if (
		accesses.length === 0 ||
		accesses.some(
			(access) => access.mode !== "read" || !coreMemoryLocationIsExact(access.location),
		)
	) {
		return undefined;
	}
	const outputRepresentation = representations.get(instruction.outputs[0]!);
	if (!LOOP_UNROOTED_REPRESENTATIONS.has(outputRepresentation ?? "") && !arrayLength) {
		return undefined;
	}
	// A generic property helper may contain a collection point. It is movable only
	// when provenance proves the result is the contained array's numeric length;
	// the caller additionally requires the original load to execute on loop entry.
	if (effects.mayGc && !arrayLength) return undefined;
	return {
		kind: "load",
		cost: 2,
		addedRootSlots: LOOP_UNROOTED_REPRESENTATIONS.has(outputRepresentation ?? "") ? 0 : 1,
	};
}

interface LoopWriteSummary {
	readonly exactPartitions: ReadonlySet<CoreMemoryPartition>;
	readonly exactDomains: ReadonlySet<CoreEffectDomain>;
	readonly impreciseDomains: ReadonlySet<CoreEffectDomain>;
	readonly universal: boolean;
}

/** Summarize every loop write once, keeping LICM linear in accesses plus reads. */
function summarizeLoopWrites(
	instructions: ReadonlyArray<CoreInstruction>,
	resolution: CoreMemoryResolution,
): LoopWriteSummary {
	const exactPartitions = new Set<CoreMemoryPartition>();
	const exactDomains = new Set<CoreEffectDomain>();
	const impreciseDomains = new Set<CoreEffectDomain>();
	let universal = false;
	for (const instruction of instructions) {
		const effects = coreInstructionEffects(instruction);
		universal ||= effects.callsUserCode || effects.maySuspend;
		const writes = coreMemoryAccesses(instruction, resolution).filter(
			(access) => access.mode === "write",
		);
		const covered = new Set<CoreEffectDomain>();
		for (const write of writes) {
			const domains =
				CORE_MEMORY_FAMILY_DOMAINS[coreMemoryLocationFamily(write.location)];
			for (const domain of domains) covered.add(domain);
			if (coreMemoryLocationIsExact(write.location)) {
				exactPartitions.add(coreMemoryPartition(write.location));
				for (const domain of domains) exactDomains.add(domain);
			} else {
				for (const domain of domains) impreciseDomains.add(domain);
			}
		}
		for (const domain of effects.writes) {
			if (!covered.has(domain)) impreciseDomains.add(domain);
		}
	}
	return { exactPartitions, exactDomains, impreciseDomains, universal };
}

/** Whether the loop summary can change the cell observed by one invariant read. */
function loopWritesInvalidateRead(
	read: CoreMemoryAccess,
	summary: LoopWriteSummary,
): boolean {
	const containedRead =
		coreMemoryLocationIsExact(read.location) &&
		(read.location.kind === "object-slot" || read.location.kind === "element");
	if (
		coreMemoryLocationIsExact(read.location) &&
		summary.exactPartitions.has(coreMemoryPartition(read.location))
	) {
		return true;
	}
	// An unattributed effect cannot reach a contained allocation whose reference
	// never escaped this activation. This is the same contract memory SSA uses.
	if (containedRead) return false;
	if (summary.universal) return true;
	const domains = CORE_MEMORY_FAMILY_DOMAINS[coreMemoryLocationFamily(read.location)];
	return domains.some(
		(domain) =>
			summary.impreciseDomains.has(domain) ||
			(!coreMemoryLocationIsExact(read.location) && summary.exactDomains.has(domain)),
	);
}

function nextFactId(fn: CoreFunction): number {
	return (fn.facts.at(-1)?.id ?? -1) + 1;
}

/**
 * Narrow a property access on a contained fresh aggregate to what it actually
 * does.
 *
 * A contained allocation's shape is fixed: every use of it names one of its own
 * writable data slots, so nothing can convert a slot to an accessor, install a
 * Proxy, delete a key, or replace the prototype. Reading or writing such a slot
 * therefore runs no user code, which is the property every later memory analysis
 * needs — an access that may call user code is a barrier for every partition.
 *
 * `callsUserCode`, the `host` domain it implies, and `mayThrow` are refined. The
 * own-slot proof excludes every JavaScript path that can call or throw: there is
 * no accessor, Proxy trap, prototype lookup, shape transition, or failed
 * writability check. `mayGc` stays as the opcode declared it because collection
 * points are a lowering/runtime property, not a JavaScript-semantic one.
 */
const refineOwnDataCellAccesses: CoreFunctionPass = {
	name: "refine-own-data-cell-accesses",
	changesControlFlow: true,
	run(fn, analyses) {
		const provenance = analyses.provenance(fn);
		if (provenance.layouts.length === 0) return fn;
		const resolution = memoryResolution(analyses, fn);
		const { instructions: protectedInstructions } = analyses.regionProtection(fn);
		const facts = [...fn.facts];
		let nextFact = nextFactId(fn);
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					if (
						instruction.opcode === "call" ||
						instruction.effectRefinement !== undefined ||
						protectedInstructions.has(instruction.id)
					) {
						return instruction;
					}
					const effects = coreInstructionEffects(instruction);
					if (!effects.callsUserCode) return instruction;
					const accesses = coreMemoryAccesses(instruction, resolution).filter((access) =>
						["object-slot", "element", "shape", "prototype"].includes(
							coreMemoryLocationFamily(access.location),
						),
					);
					let proven:
						| {
								readonly allocation: CoreInstructionId;
								readonly cell: CoreOwnCell;
						  }
						| undefined;
					let exactCells = 0;
					for (const access of accesses) {
						if (access.base === undefined || access.key === undefined) {
							return instruction;
						}
						const cell = provenance.ownCell(access.base, access.key, access.mode);
						if (cell === undefined) return instruction;
						const current = {
							allocation: cell.layout.instruction,
							cell: cell.cell,
						};
						if (
							proven !== undefined &&
							(proven.allocation !== current.allocation ||
								!coreOwnCellsEqual(proven.cell, current.cell))
						) {
							return instruction;
						}
						proven = current;
						if (coreMemoryLocationIsExact(access.location)) exactCells += 1;
					}
					if (proven === undefined || exactCells !== 1) return instruction;
					const refined = {
						reads: effects.reads.filter((domain) => domain !== "host"),
						writes: effects.writes.filter((domain) => domain !== "host"),
						mayThrow: false,
						maySuspend: effects.maySuspend,
						mayGc: effects.mayGc,
						callsUserCode: false,
					};
					const proof = coreFactId(nextFact++);
					facts.push({
						id: proof,
						kind: CORE_OWN_DATA_CELL_FACT,
						value: {
							allocation: proven.allocation,
							cell: proven.cell,
						},
						claims: [{ kind: "effect", instruction: instruction.id, effects: refined }],
						validity: {
							kind: "summary",
							digest: `contained-allocation:${proven.allocation}`,
						},
						obligations: [],
						origin: "core-allocation-provenance",
					});
					changed = true;
					return {
						...instruction,
						effectRefinement: { effects: refined, proof },
					};
				}),
			}),
		);
		return changed
			? pruneVacuousHandlers({
					...fn,
					blocks,
					facts,
					mutationEpoch: fn.mutationEpoch + 1,
				})
			: fn;
	},
};

/**
 * Narrow an ordinary call to what its callee provably does.
 *
 * The proof is the joined summary of a finite, closed target set: every function
 * the bounded target lattice says this site can reach, with the call's own frame
 * cost folded in. `deriveCoreCallEffectRefinement` decides which baseline
 * components that claim licenses dropping, per component, and refuses when the
 * summary is not strictly narrower than the opcode's baseline.
 *
 * Placed before the memory passes on purpose: the whole consumer surface is code
 * that already exists. `coreInstructionEffects` is the single funnel, so a call
 * that no longer claims to run user code stops being a universal barrier for
 * memory SSA, which is what lets forwarding, dead-store elimination, loop
 * invariance, and partial redundancy cross it without any of them learning about
 * summaries.
 *
 * The pass also revalidates its own earlier refinements, so a graph the optimizer
 * changed converges on refinements the current summaries still license instead of
 * carrying a claim to the verifier that has since gone stale.
 */
const refineDirectCallEffects: CoreFunctionPass = {
	name: "refine-direct-call-effects",
	ablation: "interprocedural",
	dependsOnProgram: true,
	run(fn, analyses, program) {
		const summaries = analyses.summaries(program);
		const facts = new Map(fn.facts.map((fact) => [fact.id, fact] as const));
		const { instructions: protectedInstructions } = analyses.regionProtection(fn);
		const retained = new Set<CoreFactId>();
		const added: Array<CoreFact> = [];
		let nextFact = nextFactId(fn);
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					const current = instruction.effectRefinement;
					const ownsCurrent =
						current !== undefined &&
						facts.get(current.proof)?.kind === CORE_CALL_EFFECT_SUMMARY_FACT;
					// A region certificate proves a property of this exact instruction, and
					// another producer's refinement is not this pass's to reconsider.
					if (protectedInstructions.has(instruction.id)) {
						if (ownsCurrent) retained.add(current.proof);
						return instruction;
					}
					const claim =
						instruction.opcode === "call"
							? summaries.callSite(fn.functionIndex, instruction.id)
							: undefined;
					let next = instruction;
					if (claim !== undefined) {
						const attribute = coreCallSummaryAttribute(claim);
						if (
							stableAttributeValue(
								instruction.attributes[CORE_CALL_SUMMARY_ATTRIBUTE],
							) !== stableAttributeValue(attribute)
						) {
							next = {
								...instruction,
								attributes: {
									...instruction.attributes,
									[CORE_CALL_SUMMARY_ATTRIBUTE]: attribute,
								},
							};
							changed = true;
						}
					} else if (CORE_CALL_SUMMARY_ATTRIBUTE in instruction.attributes) {
						next = withoutInstructionAttribute(instruction, CORE_CALL_SUMMARY_ATTRIBUTE);
						changed = true;
					}
					if (current !== undefined && !ownsCurrent) return next;
					const baseline = coreOpcodeRegistry.require(instruction.opcode).effects;
					const refined =
						claim === undefined
							? undefined
							: deriveCoreCallEffectRefinement(baseline, claim);
					if (refined === undefined || claim === undefined) {
						if (current === undefined) return next;
						changed = true;
						return withoutEffectRefinement(next);
					}
					const digest = coreCallSummaryDigest(claim);
					if (current !== undefined) {
						const fact = facts.get(current.proof)!;
						if (
							fact.validity.kind === "summary" &&
							fact.validity.digest === digest &&
							effectSummariesEqual(current.effects, refined)
						) {
							retained.add(current.proof);
							return next;
						}
					}
					const proof = coreFactId(nextFact++);
					added.push({
						id: proof,
						kind: CORE_CALL_EFFECT_SUMMARY_FACT,
						value: coreCallSummaryFactValue(claim),
						claims: [{ kind: "effect", instruction: instruction.id, effects: refined }],
						validity: { kind: "summary", digest },
						obligations: [],
						origin: "core-callee-summary",
					});
					changed = true;
					return { ...next, effectRefinement: { effects: refined, proof } };
				}),
			}),
		);
		if (!changed) return fn;
		return {
			...fn,
			blocks,
			facts: [
				...fn.facts.filter(
					(fact) => fact.kind !== CORE_CALL_EFFECT_SUMMARY_FACT || retained.has(fact.id),
				),
				...added,
			],
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

/**
 * Select a scalar storage class for a proven primitive script-call result.
 *
 * The JavaScript call ABI remains boxed: compiled callees return `MalValue`, and
 * native emission performs the checked-by-verifier conversion at the assignment
 * into this value. This pass intentionally runs once after the optimization
 * fixed point. No later value transform can propagate the narrowing and then be
 * left stale if a call target changes; region selection only records exact
 * instruction snapshots, and target lowering consumes the final representation.
 */
const refineDirectCallResultRepresentations: CoreFunctionPass = {
	name: "refine-direct-call-result-representations",
	ablation: "interprocedural",
	run(fn, analyses, program) {
		const summaries = analyses.summaries(program);
		const { instructions: protectedInstructions } = analyses.regionProtection(fn);
		const representations = new Map(
			fn.values.map(({ id, representation }) => [id, representation] as const),
		);
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					if (
						instruction.opcode !== "call" ||
						protectedInstructions.has(instruction.id)
					) {
						return instruction;
					}
					const output = instruction.outputs[0];
					if (output === undefined) return instruction;
					const claim = summaries.callSite(fn.functionIndex, instruction.id);
					const representation =
						claim === undefined ? "boxed" : coreCallResultRepresentation(claim);
					const ownsCurrent = CORE_CALL_SUMMARY_ATTRIBUTE in instruction.attributes;
					if (representation === "boxed") {
						if (!ownsCurrent) return instruction;
						representations.set(output, "boxed");
						changed = true;
						return withoutInstructionAttribute(instruction, CORE_CALL_SUMMARY_ATTRIBUTE);
					}
					if (claim === undefined) return instruction;
					const attribute = coreCallSummaryAttribute(claim);
					if (representations.get(output) !== representation) {
						representations.set(output, representation);
						changed = true;
					}
					if (
						stableAttributeValue(instruction.attributes[CORE_CALL_SUMMARY_ATTRIBUTE]) ===
						stableAttributeValue(attribute)
					) {
						return instruction;
					}
					changed = true;
					return {
						...instruction,
						attributes: {
							...instruction.attributes,
							[CORE_CALL_SUMMARY_ATTRIBUTE]: attribute,
						},
					};
				}),
			}),
		);
		if (!changed) return fn;
		return {
			...fn,
			blocks,
			values: fn.values.map((value) => ({
				...value,
				representation: representations.get(value.id)!,
			})),
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

function withoutInstructionAttribute(
	instruction: CoreInstruction,
	attribute: string,
): CoreInstruction {
	return {
		...instruction,
		attributes: Object.fromEntries(
			Object.entries(instruction.attributes).filter(([key]) => key !== attribute),
		),
	};
}

function withoutEffectRefinement(instruction: CoreInstruction): CoreInstruction {
	return {
		id: instruction.id,
		opcode: instruction.opcode,
		inputs: instruction.inputs,
		outputs: instruction.outputs,
		attributes: instruction.attributes,
		...(instruction.sourcePosition === undefined
			? {}
			: { sourcePosition: instruction.sourcePosition }),
	};
}

/**
 * Families whose cells can carry a value from one program point to another.
 *
 * A global slot, a captured slot, and the activation's `this` binding are
 * compiler-owned rather than JavaScript properties, so reading one has no
 * observable effect. An `object-slot` location only exists when the memory model
 * resolved it against the escape proof, which means the key is an own writable
 * data slot of a contained allocation — no accessor, Proxy trap, prototype walk,
 * or coercion is reachable through it.
 *
 * `local-slot` is excluded: the frontend turns locals into SSA, so its opcodes
 * only appear in hand-built graphs, and a direct eval can address a real frame
 * slot dynamically.
 */
const FORWARDABLE_MEMORY_LOCATION_KINDS: ReadonlySet<string> = new Set([
	"activation-this",
	"captured-slot",
	"element",
	"global-slot",
	"object-slot",
]);

interface ForwardableAccess {
	readonly partition: CoreMemoryPartition;
	readonly mode: "read" | "write";
	readonly value: CoreValueId;
	readonly containedObjectSlot: boolean;
}

function forwardableMemoryAccesses(
	instruction: CoreInstruction,
	resolution: CoreMemoryResolution | undefined,
): ReadonlyArray<ForwardableAccess> {
	const forwardable: Array<ForwardableAccess> = [];
	const effects = coreInstructionEffects(instruction);
	// Suspension and independent user code can change a slot after the declared
	// access. Static/dynamic property opcodes are the exception only when the
	// resolution below proves their access is the existing own data cell itself.
	const conditionallyExactProperty =
		instruction.opcode === "loadProperty" ||
		instruction.opcode === "loadPropertyStatic" ||
		instruction.opcode === "storeProperty" ||
		instruction.opcode === "storePropertyStatic";
	if ((effects.callsUserCode && !conditionallyExactProperty) || effects.maySuspend) {
		return forwardable;
	}
	for (const access of coreMemoryAccesses(instruction, resolution)) {
		if (!coreMemoryLocationIsExact(access.location)) continue;
		if (!FORWARDABLE_MEMORY_LOCATION_KINDS.has(access.location.kind)) {
			continue;
		}
		const value = access.mode === "read" ? access.result : access.value;
		if (value === undefined) continue;
		forwardable.push({
			partition: coreMemoryPartition(access.location),
			mode: access.mode,
			value,
			containedObjectSlot: access.location.kind === "object-slot",
		});
	}
	return forwardable;
}

/**
 * A slot read can only be redundant when the same slot is written, initialized by
 * its allocation, or read twice.
 */
function mayForwardMemoryAccesses(
	fn: CoreFunction,
	resolution: CoreMemoryResolution | undefined,
	provenance: CoreProvenance,
): boolean {
	const read = new Set<CoreMemoryPartition>();
	const written = new Set<CoreMemoryPartition>();
	for (const layout of provenance.layouts) {
		if (provenance.escape(layout.instruction) === "escaped") continue;
		if (layout.kind !== "named-slots") continue;
		for (const key of layout.keys) {
			written.add(
				coreMemoryPartition({
					kind: "object-slot",
					allocation: layout.instruction,
					key,
				}),
			);
		}
	}
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			for (const access of forwardableMemoryAccesses(instruction, resolution)) {
				if (access.mode === "write") {
					written.add(access.partition);
					continue;
				}
				if (read.has(access.partition)) return true;
				read.add(access.partition);
			}
		}
	}
	return [...written].some((partition) => read.has(partition));
}

function corePropertyLoadCount(fn: CoreFunction): number {
	return fn.blocks.reduce(
		(count, block) =>
			count +
			block.instructions.filter(
				({ opcode }) => opcode === "loadProperty" || opcode === "loadPropertyStatic",
			).length,
		0,
	);
}

/**
 * Materialize a value phi only when memory SSA's entry phi is exactly the read's
 * version and every direct ordinary predecessor has one edge-available SSA value.
 * Cyclic and exceptional joins stay in memory form because an edge argument cannot
 * represent their iteration- or prefix-dependent memory state.
 */
function forwardOneContainedObjectSlotJoinLoad(
	fn: CoreFunction,
	analyses: CoreAnalysisManager,
	provenance: CoreProvenance,
	resolution: CoreMemoryResolution | undefined,
	memory: CoreMemoryVersions,
): CoreFunction | undefined {
	const cfg = analyses.controlFlow(fn);
	const representations = analyses.representations(fn);
	const { instructions: protectedInstructions, inputs: protectedInputs } =
		analyses.regionProtection(fn);
	const cyclicBlocks = new Set<CoreBlockId>();
	for (const loop of cfg.loops) for (const block of loop.blocks) cyclicBlocks.add(block);
	for (const cycle of cfg.irreducibleCycles) {
		for (const block of cycle.blocks) cyclicBlocks.add(block);
	}
	interface VersionValue {
		readonly value: CoreValueId;
		readonly block: CoreBlockId;
	}
	const valuesByVersion = new Map<number, VersionValue>();
	for (const layout of provenance.layouts) {
		if (
			layout.kind !== "named-slots" ||
			provenance.escape(layout.instruction) !== "contained"
		) {
			continue;
		}
		const block = coreInstructionBlock(fn, layout.instruction);
		if (block === undefined || cyclicBlocks.has(block)) continue;
		for (const [index, key] of layout.keys.entries()) {
			const value = layout.initialValues[index];
			if (value === undefined) continue;
			const version = memory.initializationVersion(
				layout.instruction,
				coreMemoryPartition({
					kind: "object-slot",
					allocation: layout.instruction,
					key,
				}),
			);
			if (version !== undefined) valuesByVersion.set(version, { value, block });
		}
	}
	for (const block of fn.blocks) {
		if (cyclicBlocks.has(block.id)) continue;
		for (const instruction of block.instructions) {
			for (const access of forwardableMemoryAccesses(instruction, resolution)) {
				if (access.mode !== "write" || !access.containedObjectSlot) continue;
				const version = memory.writeVersion(instruction.id, access.partition);
				if (version !== undefined) {
					valuesByVersion.set(version, { value: access.value, block: block.id });
				}
			}
		}
	}
	if (valuesByVersion.size === 0) return undefined;

	for (const block of fn.blocks) {
		if (
			block.id === fn.entry ||
			block.id === fn.bodyEntry ||
			block.handler !== undefined ||
			block.parameters.some(({ role }) => role === "exception") ||
			cyclicBlocks.has(block.id)
		) {
			continue;
		}
		const incoming = cfg.predecessors[block.id]!;
		const predecessorIds = new Set(incoming.map(({ from }) => from));
		if (
			incoming.length < 2 ||
			predecessorIds.size !== incoming.length ||
			incoming.some(({ kind, from }) => {
				const predecessor = fn.blocks[from]!;
				return (
					kind !== "ordinary" ||
					cyclicBlocks.has(from) ||
					predecessor.handler !== undefined ||
					protectedInstructions.has(predecessor.terminator.id) ||
					predecessor.terminator.kind !== "jump" ||
					predecessor.terminator.edge.block !== block.id
				);
			})
		) {
			continue;
		}
		for (const candidate of block.instructions) {
			const accesses = forwardableMemoryAccesses(candidate, resolution);
			const access = accesses[0];
			const output = candidate.outputs[0];
			if (
				accesses.length !== 1 ||
				access?.mode !== "read" ||
				!access.containedObjectSlot ||
				output === undefined ||
				candidate.outputs.length !== 1 ||
				access.value !== output ||
				protectedInstructions.has(candidate.id) ||
				protectedInputs.has(output)
			) {
				continue;
			}
			const readVersion = memory.readVersion(candidate.id, access.partition);
			if (
				readVersion === undefined ||
				memory.entryVersion(block.id, access.partition) !== readVersion
			) {
				continue;
			}
			const valuesByPredecessor = new Map<CoreBlockId, CoreValueId>();
			let sourceRepresentation: CoreRepresentation | undefined;
			let valid = true;
			for (const edge of incoming) {
				const version = memory.exitVersion(edge.from, access.partition);
				const source = version === undefined ? undefined : valuesByVersion.get(version);
				const representation =
					source === undefined ? undefined : representations.get(source.value);
				if (
					source === undefined ||
					representation === undefined ||
					(source.block !== edge.from &&
						!cfg.instructionDominatesBlock(source.block, edge.from)) ||
					(sourceRepresentation !== undefined && sourceRepresentation !== representation)
				) {
					valid = false;
					break;
				}
				sourceRepresentation = representation;
				valuesByPredecessor.set(edge.from, source.value);
			}
			const destinationRepresentation = representations.get(output);
			const needsBoxing =
				destinationRepresentation === "boxed" &&
				(sourceRepresentation === "f64" ||
					sourceRepresentation === "i32" ||
					sourceRepresentation === "boolean");
			if (
				!valid ||
				sourceRepresentation === undefined ||
				destinationRepresentation === undefined ||
				(sourceRepresentation !== destinationRepresentation && !needsBoxing)
			) {
				continue;
			}

			const reuseOutput = sourceRepresentation === destinationRepresentation;
			const parameterValue = reuseOutput
				? output
				: coreValueId((fn.values.at(-1)?.id ?? -1) + 1);
			const parameterIndex = block.parameters.length;
			const blocks = fn.blocks.map((current): CoreBlock => {
				if (current.id === block.id) {
					return {
						...current,
						parameters: [
							...current.parameters,
							{
								value: parameterValue,
								representation: sourceRepresentation,
								role: "value",
							},
						],
						instructions: reuseOutput
							? current.instructions.filter(({ id }) => id !== candidate.id)
							: current.instructions.map((instruction) =>
									instruction.id === candidate.id
										? {
												...withoutEffectRefinement(instruction),
												opcode: "move",
												inputs: [parameterValue],
												attributes: {},
											}
										: instruction,
								),
					};
				}
				const argument = valuesByPredecessor.get(current.id);
				if (argument === undefined || current.terminator.kind !== "jump") {
					return current;
				}
				return {
					...current,
					terminator: {
						...current.terminator,
						edge: {
							...current.terminator.edge,
							arguments: [...current.terminator.edge.arguments, argument],
						},
					},
				};
			});
			let values = fn.values;
			if (reuseOutput) {
				values = fn.values.map((value) =>
					value.id === output
						? {
								...value,
								definition: {
									kind: "block-parameter" as const,
									block: block.id,
									index: parameterIndex,
								},
							}
						: value,
				);
			} else {
				values = fn.values.concat({
					id: parameterValue,
					representation: sourceRepresentation,
					definition: {
						kind: "block-parameter",
						block: block.id,
						index: parameterIndex,
					},
				});
			}
			return { ...fn, blocks, values, mutationEpoch: fn.mutationEpoch + 1 };
		}
	}
	return undefined;
}

/**
 * Forward a fresh shaped allocation's own slots before its first escaping use.
 *
 * Whole-function containment deliberately becomes false once an object is
 * published, even when all earlier accesses were still private. That is the
 * correct contract for memory SSA, but it leaves a useful local prefix on the
 * table: before the first instruction that receives the fresh reference, no
 * user code or alias can have changed its default writable data slots. Track
 * only one basic block, exact static present keys, moves, and existing-slot
 * stores. Any other use ends the prefix before it executes. The object itself is
 * retained when it later escapes; only semantically silent reads are forwarded.
 */
const forwardFreshAllocationPrefixLoads: CoreFunctionPass = {
	name: "forward-fresh-allocation-prefix-loads",
	changesControlFlow: true,
	run(fn, analyses, program) {
		const provenance = analyses.provenance(fn);
		const layouts = new Map(
			provenance.layouts
				.filter((layout) => layout.kind === "named-slots")
				.map((layout) => [layout.instruction, layout] as const),
		);
		if (layouts.size === 0) return fn;
		const canonical = analyses.canonicalValues(fn);
		const cellForString = coreOwnCellResolver(program.stringConstants);
		const representations = analyses.representations(fn);
		const replacements = new Map<CoreValueId, CoreValueId>();
		const removedInstructions = new Set<CoreInstructionId>();
		const replacementInstructions = new Map<CoreInstructionId, CoreInstruction>();
		interface PrefixState {
			readonly values: Map<number, CoreValueId>;
		}
		const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
		const resolved = (value: CoreValueId): CoreValueId =>
			resolveValue(value, replacements);
		for (const block of fn.blocks) {
			const active = new Map<CoreValueId, PrefixState>();
			for (const instruction of block.instructions) {
				const receiver = instruction.inputs[0];
				const receiverRoot = receiver === undefined ? undefined : root(receiver);
				const state = receiverRoot === undefined ? undefined : active.get(receiverRoot);
				const stringIndex =
					instruction.opcode === "loadPropertyStatic" ||
					instruction.opcode === "storePropertyStatic"
						? instruction.attributes.stringIndex
						: undefined;
				const cell =
					typeof stringIndex === "number" ? cellForString(stringIndex) : undefined;
				const trackedCellKey = cell?.kind === "object-slot" ? cell.key : undefined;
				const trackedSlot =
					state !== undefined && trackedCellKey !== undefined
						? state.values.get(trackedCellKey)
						: undefined;
				const trackedAccess =
					trackedSlot !== undefined &&
					((instruction.opcode === "loadPropertyStatic" &&
						instruction.inputs.length === 1 &&
						instruction.outputs.length === 1) ||
						(instruction.opcode === "storePropertyStatic" &&
							instruction.inputs.length === 2));

				// A move only creates another SSA spelling of the same private object.
				// A tracked own-slot access consumes the receiver without publishing it.
				// Every other use ends this allocation's private prefix before the use.
				for (const input of instruction.inputs) {
					const inputRoot = root(input);
					if (!active.has(inputRoot)) continue;
					const retained =
						(instruction.opcode === "move" && instruction.inputs.length === 1) ||
						(inputRoot === receiverRoot && trackedAccess);
					if (!retained) active.delete(inputRoot);
				}

				if (state !== undefined && active.has(receiverRoot!)) {
					if (instruction.opcode === "storePropertyStatic") {
						state.values.set(trackedCellKey!, resolved(instruction.inputs[1]!));
					} else if (instruction.opcode === "loadPropertyStatic") {
						const destination = instruction.outputs[0]!;
						const source = resolved(trackedSlot!);
						const sourceRepresentation = representations.get(source);
						const destinationRepresentation = representations.get(destination);
						if (sourceRepresentation === destinationRepresentation) {
							replacements.set(destination, source);
							removedInstructions.add(instruction.id);
						} else if (
							destinationRepresentation === "boxed" &&
							(sourceRepresentation === "f64" ||
								sourceRepresentation === "i32" ||
								sourceRepresentation === "boolean")
						) {
							const { effectRefinement: _refinement, ...withoutRefinement } = instruction;
							replacementInstructions.set(instruction.id, {
								...withoutRefinement,
								opcode: "move",
								inputs: [source],
								attributes: {},
							});
						}
					}
				}

				const layout = layouts.get(instruction.id);
				const output = instruction.outputs[0];
				if (layout === undefined || output === undefined) continue;
				const allocationRoot = root(output);
				if (
					active.has(allocationRoot) ||
					provenance.allocationOf(output)?.instruction !== instruction.id
				) {
					continue;
				}
				const values = new Map<number, CoreValueId>();
				let valid = true;
				for (const [index, keyStringIndex] of layout.keys.entries()) {
					const ownCell = cellForString(keyStringIndex);
					const initial = layout.initialValues[index];
					if (
						ownCell?.kind !== "object-slot" ||
						initial === undefined ||
						values.has(ownCell.key)
					) {
						valid = false;
						break;
					}
					values.set(ownCell.key, resolved(initial));
				}
				if (valid) active.set(allocationRoot, { values });
			}
		}
		if (removedInstructions.size === 0 && replacementInstructions.size === 0) return fn;
		const blocks = fn.blocks.map((block) => ({
			...block,
			instructions: block.instructions.map(
				(instruction) => replacementInstructions.get(instruction.id) ?? instruction,
			),
		}));
		return removeUnreachableCoreBlocks(
			rewriteFunction(fn, blocks, replacements, removedInstructions),
		);
	},
};

/**
 * Reuse the value already in a compiler slot instead of loading it again: forward
 * a store to a later load, and remove a load the same load already performed.
 *
 * Two obligations, discharged separately. Memory equality comes from the
 * analysis-only memory-SSA version of the slot's own partition, so a load is only
 * a hit when the exact same memory-SSA definition reaches both points; unknown
 * calls, suspension, scope-chain edits, derived-`this` rebinding, and every
 * backedge or exceptional entry that could reach a different definition give the
 * later point a different version. Value availability comes from walking the
 * dominator tree with a scoped map, so the value the pass substitutes always
 * dominates its new use. TDZ checks are untouched: forwarding replaces a value
 * and never removes a check, leaving `eliminate-redundant-tdz-checks` to decide
 * on its own Empty-provenance proof.
 *
 * Each block is entered once, so the walk terminates on cyclic and irreducible
 * control flow alike, in O(instructions) map operations.
 */
const forwardMemoryAccesses: CoreFunctionPass = {
	name: "forward-memory-accesses",
	changesControlFlow: true,
	run(input, analyses) {
		let fn = input;
		let propertyLoads = corePropertyLoadCount(fn);
		for (;;) {
			const joinProvenance = memoryProvenance(analyses, fn);
			const joinResolution = memoryResolution(analyses, fn, joinProvenance);
			if (!mayForwardMemoryAccesses(fn, joinResolution, joinProvenance)) break;
			const next = forwardOneContainedObjectSlotJoinLoad(
				fn,
				analyses,
				joinProvenance,
				joinResolution,
				analyses.memory(fn),
			);
			if (next === undefined) break;
			const nextPropertyLoads = corePropertyLoadCount(next);
			if (nextPropertyLoads >= propertyLoads) {
				throw new Error(
					"Contained object-slot join forwarding changed without removing a property load",
				);
			}
			fn = next;
			propertyLoads = nextPropertyLoads;
		}
		const provenance = memoryProvenance(analyses, fn);
		const resolution = memoryResolution(analyses, fn, provenance);
		if (!mayForwardMemoryAccesses(fn, resolution, provenance)) return fn;
		const cfg = analyses.controlFlow(fn);
		const memory = analyses.memory(fn);
		const initialValues = new Map(
			provenance.layouts
				.filter((layout) => layout.kind === "named-slots")
				.map((layout) => [layout.instruction, layout] as const),
		);
		const { instructions: protectedInstructions, inputs: protectedInputs } =
			analyses.regionProtection(fn);
		const representations = analyses.representations(fn);
		const children = fn.blocks.map(() => new Array<CoreBlockId>());
		for (const block of fn.blocks) {
			const parent = cfg.immediateDominators[block.id];
			if (parent !== undefined && parent !== null && parent !== block.id) {
				children[parent]!.push(block.id);
			}
		}
		const replacements = new Map<CoreValueId, CoreValueId>();
		const removedInstructions = new Set<CoreInstructionId>();
		const replacementInstructions = new Map<CoreInstructionId, CoreInstruction>();
		const visited = new Set<CoreBlockId>();
		interface AvailableValue {
			readonly value: CoreValueId;
			readonly block: CoreBlockId;
		}
		type Undo = {
			readonly key: string;
			readonly previous: AvailableValue | undefined;
		};
		type Frame =
			| { readonly kind: "enter"; readonly block: CoreBlockId }
			| { readonly kind: "exit"; readonly marker: number };
		const available = new Map<string, AvailableValue>();
		const undo: Array<Undo> = [];
		const record = (key: string, entry: AvailableValue): void => {
			undo.push({ key, previous: available.get(key) });
			available.set(key, entry);
		};
		const processTree = (root: CoreBlockId): void => {
			const stack: Array<Frame> = [{ kind: "enter", block: root }];
			while (stack.length > 0) {
				const frame = stack.pop()!;
				if (frame.kind === "exit") {
					while (undo.length > frame.marker) {
						const entry = undo.pop()!;
						if (entry.previous === undefined) available.delete(entry.key);
						else available.set(entry.key, entry.previous);
					}
					continue;
				}
				if (visited.has(frame.block)) continue;
				visited.add(frame.block);
				const marker = undo.length;
				const block = fn.blocks[frame.block]!;
				for (const instruction of block.instructions) {
					if (protectedInstructions.has(instruction.id)) continue;
					// A fresh literal's own slots start out holding its operands, so the
					// allocation is a definition every dominated read of those slots can
					// use, without the allocation being a write to anyone else's memory.
					const layout = initialValues.get(instruction.id);
					if (layout !== undefined) {
						for (const [index, key] of layout.keys.entries()) {
							const partition = coreMemoryPartition({
								kind: "object-slot",
								allocation: instruction.id,
								key,
							});
							const version = memory.initializationVersion(instruction.id, partition);
							const initial = layout.initialValues[index];
							if (version === undefined || initial === undefined) continue;
							record(`${partition}\0${version}`, {
								value: initial,
								block: frame.block,
							});
						}
					}
					const accesses = forwardableMemoryAccesses(instruction, resolution);
					if (accesses.length === 0) continue;
					// Replacing an instruction by one SSA value is only valid for a
					// single-read operation whose sole output is that read. A future
					// multi-location opcode may still participate in memory analysis, but
					// forwarding one of its accesses must not erase its other effects.
					if (
						accesses.some(({ mode }) => mode === "read") &&
						(accesses.length !== 1 ||
							accesses[0]!.mode !== "read" ||
							instruction.outputs.length !== 1 ||
							instruction.outputs[0] !== accesses[0]!.value)
					) {
						continue;
					}
					for (const access of accesses) {
						if (access.mode === "write") {
							// No reader tracks a partition nothing reads, so its store has no
							// version to record a forwarding candidate under.
							const written = memory.writeVersion(instruction.id, access.partition);
							if (written !== undefined) {
								record(`${access.partition}\0${written}`, {
									value: access.value,
									block: frame.block,
								});
							}
							continue;
						}
						const version = memory.readVersion(instruction.id, access.partition);
						if (version === undefined) continue;
						const key = `${access.partition}\0${version}`;
						const hit = available.get(key);
						if (
							hit !== undefined &&
							// An exceptional edge leaves a block before its instructions, so
							// ordinary dominance is not enough to make the recorded value
							// available here.
							(hit.block === frame.block ||
								cfg.instructionDominatesBlock(hit.block, frame.block)) &&
							!protectedInputs.has(access.value)
						) {
							const sourceRepresentation = representations.get(hit.value);
							const destinationRepresentation = representations.get(access.value);
							if (sourceRepresentation === destinationRepresentation) {
								replacements.set(access.value, hit.value);
								removedInstructions.add(instruction.id);
								continue;
							}
							// Target lowering defines `move` as a representation conversion when
							// an unboxed primitive flows into a boxed destination. Retain the
							// load's output in that case: consumers keep their declared class,
							// while the property operation and its effects disappear.
							if (
								destinationRepresentation === "boxed" &&
								(sourceRepresentation === "f64" ||
									sourceRepresentation === "i32" ||
									sourceRepresentation === "boolean")
							) {
								const { effectRefinement: _refinement, ...withoutRefinement } =
									instruction;
								replacementInstructions.set(instruction.id, {
									...withoutRefinement,
									opcode: "move",
									inputs: [hit.value],
									attributes: {},
								});
								record(key, { value: access.value, block: frame.block });
								continue;
							}
						}
						// The earlier definition may have the wrong representation or may be
						// unavailable on exceptional flow. This load is nevertheless the
						// current block's value for the version, so later dominated reads can
						// reuse it.
						record(key, { value: access.value, block: frame.block });
					}
				}
				stack.push({ kind: "exit", marker });
				for (const child of [...children[frame.block]!].reverse()) {
					stack.push({ kind: "enter", block: child });
				}
			}
		};
		processTree(fn.entry);
		for (const block of fn.blocks) {
			if (!visited.has(block.id)) processTree(block.id);
		}
		if (removedInstructions.size === 0 && replacementInstructions.size === 0) return fn;
		const blocks = fn.blocks.map((block) => ({
			...block,
			instructions: block.instructions.map(
				(instruction) => replacementInstructions.get(instruction.id) ?? instruction,
			),
		}));
		// A forwarded read can be the last throwing instruction covered by the
		// block's handler. Core represents exceptional flow on the block rather
		// than on an individual instruction, so restore the CFG invariant as part
		// of the same transformation.
		return pruneVacuousHandlers(
			rewriteFunction(fn, blocks, replacements, removedInstructions),
		);
	},
};

function coreControlObservesAnyValue(
	block: CoreBlock,
	values: ReadonlySet<CoreValueId>,
): boolean {
	switch (block.terminator.kind) {
		case "branch":
		case "guard":
			return values.has(block.terminator.condition);
		case "switch":
			return values.has(block.terminator.discriminant);
		case "return":
		case "throw":
			return values.has(block.terminator.value);
		case "jump":
		case "unreachable":
			return false;
	}
}

/**
 * Erase one contained shaped object as a transaction with its remaining writes.
 *
 * Forwarding has already replaced every readable own slot with its SSA value. A
 * boxed occupant can nevertheless be observed through WeakRef while user code or
 * collection runs. Direct operands are already rooted for an operation's whole
 * duration; every other virtual field receives a compile-only `rootUse` after the
 * collection point. Ordinary SSA liveness then carries the field into the exact
 * target root map, while runtime lowering emits no instruction for the marker.
 * Removing the allocation and stores only removes collection points, which can
 * delay collection but cannot expose an earlier one.
 *
 * Moves and all-ordinary block parameters are structural spellings of the same
 * contained identity. Differing incoming fields become explicit value parameters,
 * including loop-header phis for reducible loop-carried state, so their roots
 * remain ordinary SSA liveness.
 */
const scalarizeRootedContainedObjects: CoreFunctionPass = {
	name: "scalarize-rooted-contained-objects",
	ablation: "escape",
	run(fn, analyses, program) {
		const provenance = analyses.provenance(fn);
		const cfg = analyses.controlFlow(fn);
		const representations = analyses.representations(fn);
		const { instructions: protectedInstructions, inputs: protectedInputs } =
			analyses.regionProtection(fn);
		const locations = new Map<
			CoreInstructionId,
			{ readonly block: CoreBlock; readonly index: number }
		>();
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				locations.set(instruction.id, { block, index });
			}
		}
		const valuesById = new Map(fn.values.map((value) => [value.id, value] as const));

		for (const layout of provenance.layouts) {
			const aliases = new Set(
				fn.values
					.filter(
						({ id }) => provenance.allocationOf(id)?.instruction === layout.instruction,
					)
					.map(({ id }) => id),
			);
			if (
				layout.kind !== "named-slots" ||
				provenance.escape(layout.instruction) !== "contained" ||
				protectedInstructions.has(layout.instruction) ||
				[...aliases].some((value) => protectedInputs.has(value))
			) {
				continue;
			}
			const allocationLocation = locations.get(layout.instruction);
			if (
				allocationLocation === undefined ||
				allocationLocation.block.handler !== undefined
			) {
				continue;
			}
			const stores: Array<{
				readonly instruction: CoreInstruction;
				readonly block: CoreBlock;
				readonly index: number;
				readonly key: number;
				readonly value: CoreValueId;
			}> = [];
			const loads: Array<{
				readonly instruction: CoreInstruction;
				readonly block: CoreBlock;
				readonly index: number;
				readonly key: number;
				readonly value: CoreValueId;
			}> = [];
			const aliasMoves = new Set<CoreInstructionId>();
			let valid = true;
			for (const alias of aliases) {
				if (alias === layout.result) continue;
				const definition = valuesById.get(alias)?.definition;
				if (definition?.kind === "instruction") {
					const location = locations.get(definition.instruction);
					const instruction =
						location === undefined
							? undefined
							: location.block.instructions[location.index];
					if (
						instruction?.opcode !== "move" ||
						instruction.inputs.length !== 1 ||
						!aliases.has(instruction.inputs[0]!) ||
						instruction.outputs.length !== 1 ||
						instruction.outputs[0] !== alias ||
						protectedInstructions.has(instruction.id)
					) {
						valid = false;
						break;
					}
					aliasMoves.add(instruction.id);
					continue;
				}
				if (definition?.kind !== "block-parameter") {
					valid = false;
					break;
				}
				const block = fn.blocks[definition.block];
				const incoming = cfg.predecessors[definition.block]!;
				const parameter = block?.parameters[definition.index];
				if (
					block === undefined ||
					parameter === undefined ||
					parameter.role === "exception" ||
					incoming.length === 0 ||
					incoming.some((edge) => {
						const argumentIndex =
							edge.kind === "exceptional" ? definition.index - 1 : definition.index;
						return argumentIndex < 0 || !aliases.has(edge.arguments[argumentIndex]!);
					})
				) {
					valid = false;
					break;
				}
			}
			if (!valid) continue;
			for (const block of fn.blocks) {
				if (coreControlObservesAnyValue(block, aliases)) {
					valid = false;
					break;
				}
				for (const edge of coreTerminatorEdges(block.terminator)) {
					const parameters = fn.blocks[edge.block]?.parameters;
					if (
						parameters === undefined ||
						edge.arguments.some(
							(argument, index) =>
								aliases.has(argument) && !aliases.has(parameters[index]!.value),
						)
					) {
						valid = false;
						break;
					}
				}
				if (!valid) break;
				if (block.handler !== undefined) {
					const target = fn.blocks[block.handler.block];
					if (
						target === undefined ||
						block.handler.arguments.some(
							(argument, index) =>
								aliases.has(argument) &&
								!aliases.has(target.parameters[index + 1]!.value),
						)
					) {
						valid = false;
						break;
					}
				}
				for (const [index, instruction] of block.instructions.entries()) {
					for (const [position, input] of instruction.inputs.entries()) {
						if (!aliases.has(input)) continue;
						if (position === 0 && aliasMoves.has(instruction.id)) continue;
						const stringIndex = instruction.attributes.stringIndex;
						const stored = instruction.inputs[1];
						const loaded = instruction.outputs[0];
						const ownCell =
							(instruction.opcode === "loadPropertyStatic" ||
								instruction.opcode === "storePropertyStatic") &&
							position === 0 &&
							typeof stringIndex === "number"
								? provenance.ownCell(
										input,
										{ kind: "string-constant", index: stringIndex },
										instruction.opcode === "loadPropertyStatic" ? "read" : "write",
									)
								: undefined;
						if (
							ownCell?.layout.instruction !== layout.instruction ||
							ownCell.cell.kind !== "object-slot" ||
							(instruction.opcode === "storePropertyStatic"
								? stored === undefined
								: instruction.opcode !== "loadPropertyStatic" ||
									loaded === undefined ||
									instruction.outputs.length !== 1 ||
									protectedInputs.has(loaded)) ||
							(block === allocationLocation.block
								? index <= allocationLocation.index
								: !cfg.instructionDominatesBlock(
										allocationLocation.block.id,
										block.id,
									)) ||
							block.handler !== undefined ||
							protectedInstructions.has(instruction.id)
						) {
							valid = false;
							break;
						}
						if (instruction.opcode === "storePropertyStatic") {
							stores.push({
								instruction,
								block,
								index,
								key: ownCell.cell.key,
								value: stored!,
							});
						} else {
							loads.push({
								instruction,
								block,
								index,
								key: ownCell.cell.key,
								value: loaded!,
							});
						}
					}
					if (!valid) break;
				}
				if (!valid) break;
			}
			if (!valid || stores.length === 0) continue;
			const uniqueStores = new Map(
				stores.map((store) => [store.instruction.id, store] as const),
			);
			if (uniqueStores.size !== stores.length) continue;
			const uniqueLoads = new Map(
				loads.map((load) => [load.instruction.id, load] as const),
			);
			if (uniqueLoads.size !== loads.length) continue;
			const orderedStores = [...uniqueStores.values()];
			const orderedLoads = [...uniqueLoads.values()];
			const storesByBlock = new Map<
				CoreBlockId,
				Map<number, (typeof orderedStores)[number]>
			>();
			for (const store of orderedStores) {
				let storesInBlock = storesByBlock.get(store.block.id);
				if (storesInBlock === undefined) {
					storesInBlock = new Map();
					storesByBlock.set(store.block.id, storesInBlock);
				}
				storesInBlock.set(store.index, store);
			}
			const loadsByBlock = new Map<
				CoreBlockId,
				Map<number, (typeof orderedLoads)[number]>
			>();
			for (const load of orderedLoads) {
				let loadsInBlock = loadsByBlock.get(load.block.id);
				if (loadsInBlock === undefined) {
					loadsInBlock = new Map();
					loadsByBlock.set(load.block.id, loadsInBlock);
				}
				loadsInBlock.set(load.index, load);
			}
			const blocksCanReachAccess = new Set<CoreBlockId>(
				[...orderedStores, ...orderedLoads].map(({ block }) => block.id),
			);
			const worklist = [...blocksCanReachAccess];
			while (worklist.length > 0 && valid) {
				const block = worklist.pop()!;
				if (block === allocationLocation.block.id) continue;
				for (const edge of cfg.predecessors[block]!) {
					if (
						edge.from !== allocationLocation.block.id &&
						!cfg.instructionDominatesBlock(allocationLocation.block.id, edge.from)
					) {
						valid = false;
						break;
					}
					if (!blocksCanReachAccess.has(edge.from)) {
						blocksCanReachAccess.add(edge.from);
						worklist.push(edge.from);
					}
				}
			}
			const irreducibleBlocks = new Set<CoreBlockId>();
			for (const cycle of cfg.irreducibleCycles) {
				for (const block of cycle.blocks) irreducibleBlocks.add(block);
			}
			if (
				!valid ||
				cfg.loops.some(({ blocks }) => blocks.has(allocationLocation.block.id)) ||
				[...blocksCanReachAccess].some((block) => irreducibleBlocks.has(block))
			) {
				continue;
			}

			const rootValuesAfter = new Map<CoreInstructionId, ReadonlyArray<CoreValueId>>();
			const exitFields = new Map<CoreBlockId, ReadonlyMap<number, CoreValueId>>();
			interface VirtualFieldParameter {
				readonly value: CoreValueId;
				readonly representation: CoreRepresentation;
				readonly index: number;
				readonly key: number;
			}
			const virtualFieldParameters = new Map<CoreBlockId, Array<VirtualFieldParameter>>();
			const virtualFieldRepresentations = new Map<CoreValueId, CoreRepresentation>();
			const representationOf = (value: CoreValueId): CoreRepresentation | undefined =>
				virtualFieldRepresentations.get(value) ?? representations.get(value);
			const joinedRepresentation = (
				values: ReadonlyArray<CoreValueId>,
			): CoreRepresentation | undefined => {
				const first = representationOf(values[0]!);
				if (
					first === undefined ||
					values.some((value) => representationOf(value) === undefined)
				) {
					return undefined;
				}
				return values.every((value) => representationOf(value) === first)
					? first
					: "boxed";
			};
			const cannotBeHeldWeakly = (value: CoreValueId): boolean => {
				const representation = representationOf(value);
				return representation === "f64" ||
					representation === "i32" ||
					representation === "boolean"
					? true
					: provenance.cannotBeHeldWeakly(value);
			};
			let nextValue = (fn.values.at(-1)?.id ?? -1) + 1;
			for (const loop of cfg.loops) {
				if (!blocksCanReachAccess.has(loop.header)) continue;
				const block = fn.blocks[loop.header]!;
				const parameters: Array<VirtualFieldParameter> = [];
				for (const [keyIndex, key] of layout.keys.entries()) {
					const possibleValues = [
						layout.initialValues[keyIndex]!,
						...orderedStores
							.filter((store) => store.key === key && loop.blocks.has(store.block.id))
							.map(({ value }) => value),
					];
					const representation = joinedRepresentation(possibleValues);
					if (representation === undefined) {
						valid = false;
						break;
					}
					const value = coreValueId(nextValue++);
					parameters.push({
						value,
						representation,
						index: block.parameters.length + parameters.length,
						key,
					});
					virtualFieldRepresentations.set(value, representation);
				}
				if (!valid) break;
				virtualFieldParameters.set(loop.header, parameters);
			}
			const handlerTargets = new Set(
				fn.blocks.flatMap(({ handler }) =>
					handler !== undefined && blocksCanReachAccess.has(handler.block)
						? [handler.block]
						: [],
				),
			);
			for (const blockId of handlerTargets) {
				if (virtualFieldParameters.has(blockId)) {
					valid = false;
					break;
				}
				const block = fn.blocks[blockId]!;
				const parameters: Array<VirtualFieldParameter> = [];
				for (const [keyIndex, key] of layout.keys.entries()) {
					const possibleValues = [
						layout.initialValues[keyIndex]!,
						...orderedStores
							.filter((store) => store.key === key)
							.map(({ value }) => value),
					];
					const representation = joinedRepresentation(possibleValues);
					if (representation === undefined) {
						valid = false;
						break;
					}
					const value = coreValueId(nextValue++);
					parameters.push({
						value,
						representation,
						index: block.parameters.length + parameters.length,
						key,
					});
					virtualFieldRepresentations.set(value, representation);
				}
				if (!valid) break;
				virtualFieldParameters.set(blockId, parameters);
			}
			if (!valid) continue;
			const replacements = new Map<CoreValueId, CoreValueId>();
			const replacementInstructions = new Map<CoreInstructionId, CoreInstruction>();
			const removedAccessInstructions = new Set<CoreInstructionId>();
			const entryFields = new Map<CoreBlockId, ReadonlyMap<number, CoreValueId>>();
			for (const blockId of cfg.reversePostorder) {
				if (!blocksCanReachAccess.has(blockId)) continue;
				const block = fn.blocks[blockId]!;
				let currentFields: Map<number, CoreValueId>;
				let start = 0;
				if (block === allocationLocation.block) {
					currentFields = new Map(
						layout.keys.map((key, index) => [key, layout.initialValues[index]!] as const),
					);
					start = allocationLocation.index + 1;
				} else if (virtualFieldParameters.has(blockId)) {
					currentFields = new Map(
						virtualFieldParameters
							.get(blockId)!
							.map(({ key, value }) => [key, value] as const),
					);
				} else {
					const incoming = cfg.predecessors[blockId]!.filter(
						({ kind }) => kind === "ordinary",
					);
					const incomingFields = incoming.map((edge) => exitFields.get(edge.from));
					if (
						incomingFields.length === 0 ||
						incomingFields.some((candidate) => candidate === undefined)
					) {
						valid = false;
						break;
					}
					currentFields = new Map();
					for (const key of layout.keys) {
						const incomingValues = incomingFields.map((fields) => fields!.get(key));
						const firstValue = incomingValues[0];
						if (
							firstValue === undefined ||
							incomingValues.some((value) => value === undefined)
						) {
							valid = false;
							break;
						}
						if (incomingValues.every((value) => value === firstValue)) {
							currentFields.set(key, firstValue);
							continue;
						}
						const existing = block.parameters.find((parameter, index) =>
							incoming.every(
								(edge, incomingIndex) =>
									edge.arguments[index] === incomingValues[incomingIndex],
							),
						);
						if (existing !== undefined) {
							currentFields.set(key, existing.value);
							continue;
						}
						const representation = joinedRepresentation(
							incomingValues as ReadonlyArray<CoreValueId>,
						);
						if (representation === undefined) {
							valid = false;
							break;
						}
						const value = coreValueId(nextValue++);
						const parameters = virtualFieldParameters.get(blockId) ?? [];
						parameters.push({
							value,
							representation,
							index: block.parameters.length + parameters.length,
							key,
						});
						virtualFieldParameters.set(blockId, parameters);
						virtualFieldRepresentations.set(value, representation);
						currentFields.set(key, value);
					}
					if (!valid) break;
				}
				entryFields.set(blockId, new Map(currentFields));
				const storesInBlock =
					storesByBlock.get(blockId) ?? new Map<number, (typeof orderedStores)[number]>();
				const loadsInBlock =
					loadsByBlock.get(blockId) ?? new Map<number, (typeof orderedLoads)[number]>();
				const lastAccess = Math.max(-1, ...storesInBlock.keys(), ...loadsInBlock.keys());
				const liveIntoSuccessor = cfg.successors[blockId]!.some(
					({ kind, to }) => kind === "ordinary" && blocksCanReachAccess.has(to),
				);
				for (let index = start; index < block.instructions.length; index++) {
					const store = storesInBlock.get(index);
					if (store !== undefined) {
						currentFields.set(store.key, resolveValue(store.value, replacements));
						removedAccessInstructions.add(store.instruction.id);
						continue;
					}
					const load = loadsInBlock.get(index);
					if (load !== undefined) {
						const source = currentFields.get(load.key);
						const sourceRepresentation =
							source === undefined ? undefined : representationOf(source);
						const destinationRepresentation = representationOf(load.value);
						if (
							source === undefined ||
							sourceRepresentation === undefined ||
							destinationRepresentation === undefined
						) {
							valid = false;
							break;
						}
						if (sourceRepresentation === destinationRepresentation) {
							replacements.set(load.value, source);
							removedAccessInstructions.add(load.instruction.id);
						} else if (
							destinationRepresentation === "boxed" &&
							(sourceRepresentation === "f64" ||
								sourceRepresentation === "i32" ||
								sourceRepresentation === "boolean")
						) {
							replacementInstructions.set(load.instruction.id, {
								...withoutEffectRefinement(load.instruction),
								opcode: "move",
								inputs: [source],
								attributes: {},
							});
						} else {
							valid = false;
							break;
						}
						continue;
					}
					if (index >= lastAccess && !liveIntoSuccessor) continue;
					const instruction = block.instructions[index]!;
					const effects = coreInstructionEffects(instruction);
					if (!effects.mayGc && !effects.maySuspend) continue;
					const values = [
						...new Set(
							[...currentFields.values()].filter(
								(value) =>
									!cannotBeHeldWeakly(value) &&
									(effects.maySuspend || !instruction.inputs.includes(value)),
							),
						),
					];
					if (values.length > 0) rootValuesAfter.set(instruction.id, values);
				}
				if (!valid) break;
				exitFields.set(blockId, currentFields);
			}
			if (!valid) continue;

			const transformedInstructions = new Set<CoreInstructionId>([
				layout.instruction,
				...orderedStores.map(({ instruction }) => instruction.id),
				...orderedLoads.map(({ instruction }) => instruction.id),
			]);
			const removedInstructions = new Set<CoreInstructionId>([
				layout.instruction,
				...removedAccessInstructions,
			]);
			const affectedFacts = new Set(
				fn.facts
					.filter((fact) =>
						fact.claims.some((claim) =>
							claim.kind === "effect"
								? transformedInstructions.has(claim.instruction)
								: aliases.has(claim.subject),
						),
					)
					.map(({ id }) => id),
			);
			if (
				fn.facts.some(
					(fact) =>
						affectedFacts.has(fact.id) &&
						fact.obligations.some(({ kind }) => kind !== "guard"),
				) ||
				fn.blocks.some((block) =>
					block.instructions.some(
						(instruction) =>
							!transformedInstructions.has(instruction.id) &&
							instruction.effectRefinement !== undefined &&
							affectedFacts.has(instruction.effectRefinement.proof),
					),
				)
			) {
				continue;
			}
			let instructionId = nextInstructionId(fn);
			const placeholderInstructionId = coreInstructionId(instructionId++);
			const rootUsesAfter = new Map(
				[...rootValuesAfter].map(
					([after, inputs]) =>
						[
							after,
							{
								id: coreInstructionId(instructionId++),
								opcode: "rootUse",
								inputs,
								outputs: [],
								attributes: {},
							} satisfies CoreInstruction,
						] as const,
				),
			);
			const stripped: CoreFunction = {
				...fn,
				blocks: fn.blocks.map((block) => {
					const fieldParameters = virtualFieldParameters.get(block.id) ?? [];
					return {
						...block,
						parameters: [
							...block.parameters,
							...fieldParameters.map(({ value, representation }) => ({
								value,
								representation,
								role: "value" as const,
							})),
						],
						instructions: block.instructions.flatMap(
							(instruction): ReadonlyArray<CoreInstruction> => {
								if (instruction.id === layout.instruction) {
									return [
										{
											id: placeholderInstructionId,
											opcode: "createUndefined",
											inputs: [],
											outputs: [layout.result],
											attributes: {},
										} satisfies CoreInstruction,
									];
								}
								if (removedInstructions.has(instruction.id)) return [];
								const rootUse = rootUsesAfter.get(instruction.id);
								const retained =
									replacementInstructions.get(instruction.id) ?? instruction;
								const rewritten = {
									...retained,
									inputs: retained.inputs.map((value) =>
										resolveValue(value, replacements),
									),
								};
								return rootUse === undefined
									? [rewritten]
									: [
											rewritten,
											{
												...rootUse,
												inputs: rootUse.inputs.map((value) =>
													resolveValue(value, replacements),
												),
											},
										];
							},
						),
						terminator: remapTerminatorEdges(
							rewriteTerminator(block.terminator, replacements),
							(edge) => {
								const targetParameters = virtualFieldParameters.get(edge.block);
								if (targetParameters === undefined) return edge;
								return {
									...edge,
									arguments: [
										...edge.arguments,
										...targetParameters.map((parameter) => {
											const argument = exitFields.get(block.id)?.get(parameter.key);
											if (argument === undefined) {
												throw new Error(
													`Missing virtual field argument on b${block.id} -> b${edge.block}`,
												);
											}
											return resolveValue(argument, replacements);
										}),
									],
								};
							},
						),
						...(block.handler === undefined
							? {}
							: {
									handler: {
										...block.handler,
										arguments: [
											...block.handler.arguments.map((value) =>
												resolveValue(value, replacements),
											),
											...(virtualFieldParameters.get(block.handler.block) ?? []).map(
												(parameter) => {
													const argument = entryFields.get(block.id)?.get(parameter.key);
													if (argument === undefined) {
														throw new Error(
															`Missing virtual field handler argument on b${block.id} -> b${block.handler!.block}`,
														);
													}
													return resolveValue(argument, replacements);
												},
											),
										],
									},
								}),
					};
				}),
				values: fn.values
					.filter(({ id }) => !replacements.has(id))
					.map((value) =>
						value.id === layout.result
							? {
									...value,
									definition: {
										kind: "instruction" as const,
										instruction: placeholderInstructionId,
										index: 0,
									},
								}
							: value,
					)
					.concat(
						[...virtualFieldParameters.entries()].flatMap(([block, parameters]) =>
							parameters.map(({ value, representation, index }) => ({
								id: value,
								representation,
								definition: { kind: "block-parameter" as const, block, index },
							})),
						),
					),
				facts: rewriteFactClaimSubjects(fn.facts, replacements),
				mutationEpoch: fn.mutationEpoch + 1,
			};
			return deadInstructionElimination.run(stripped, analyses, program);
		}
		return fn;
	},
};

/**
 * Remove stores to a contained aggregate that nothing can read.
 *
 * A contained allocation's reference never leaves the activation, so the only
 * operations that can observe one of its slots are the accesses to it that this
 * function already contains. Two conservative shapes are removed:
 *
 *  - a slot no access anywhere reads, so every store to it is unobservable. This
 *    needs no control-flow reasoning at all, and it is what makes forwarding pay
 *    off: once the reads are gone, the stores that fed them are dead.
 *  - a store overwritten later in the same block with no read of that slot in
 *    between. The block must have no handler, since a handler is a reader inside
 *    this activation that the linear scan does not cover.
 *
 * ## Reachability is part of the semantics
 *
 * Dropping a store changes what the slot references, in both directions: the
 * dropped value is never reachable through the slot, and whatever the slot held
 * before stays reachable through it for longer. `WeakRef.prototype.deref` and
 * `FinalizationRegistry` callbacks make both directions observable, and they are
 * ordinary operations rather than a timing artefact, so "the collector might not
 * have run" is not a justification.
 *
 * The proof is therefore per partition, not per store: every value that can ever
 * occupy the slot — the literal's initial value for that key and the stored value
 * of every store to it — must be one `CanBeHeldWeakly` rejects. Then no `WeakRef`
 * can be pointed at it and no registry can be given it, so how long the slot
 * references it is not observable. A single unproven value retains the whole
 * partition.
 *
 * ## Why the baseline effects do not block it
 *
 * `storePropertyStatic` declares `mayThrow` and `mayGc` because in general a
 * property store can hit a setter, a Proxy trap, a frozen object, a prototype
 * setter, or a shape transition that allocates. The containment proof refutes
 * every one of those for this site: the key is an own writable data property of an
 * ordinary object that has existed since the literal was built, so the runtime
 * invariant this relies on is that such a store is exactly one slot write —
 * `object->slots[index] = value` plus a write barrier, with no lookup, no
 * transition, no allocation, and no user code. Removing the instruction therefore
 * removes a throw that cannot happen and a collection point that cannot allocate;
 * both are pure reductions, and dropping the safepoint only shrinks the root set.
 * The refinement pass has already removed the impossible `mayThrow`; surviving
 * stores retain `mayGc`, so root liveness remains conservative.
 */
const eliminateDeadStores: CoreFunctionPass = {
	name: "eliminate-dead-stores",
	changesControlFlow: true,
	run(fn, analyses) {
		const provenance = analyses.provenance(fn);
		const contained = provenance.layouts.filter(
			({ instruction }) => provenance.escape(instruction) === "contained",
		);
		if (contained.length === 0) return fn;
		const resolution = memoryResolution(analyses, fn);
		const { instructions: protectedInstructions } = analyses.regionProtection(fn);

		// Values that can occupy each partition, starting with what the literal put
		// there. A partition is only a candidate while every one of them is proven
		// unable to be a finalization target.
		const weaklyHoldable = new Set<CoreMemoryPartition>();
		const described = new Set<CoreMemoryPartition>();
		const establishingStores = new Set<CoreInstructionId>();
		const note = (
			partition: CoreMemoryPartition,
			value: CoreValueId | undefined,
		): void => {
			if (value === undefined || !provenance.cannotBeHeldWeakly(value)) {
				weaklyHoldable.add(partition);
			}
		};
		for (const layout of contained) {
			if (layout.kind === "named-slots") {
				for (const [index, key] of layout.keys.entries()) {
					const partition = coreMemoryPartition({
						kind: "object-slot",
						allocation: layout.instruction,
						key,
					});
					described.add(partition);
					note(partition, layout.initialValues[index]);
				}
				continue;
			}
			for (const element of layout.elements.values()) {
				const partition = coreMemoryPartition({
					kind: "element",
					allocation: layout.instruction,
					index: element.index,
				});
				described.add(partition);
				establishingStores.add(element.definition);
				note(partition, element.value);
			}
		}
		const readPartitions = new Set<CoreMemoryPartition>();
		const storesByPartition = new Map<CoreMemoryPartition, Array<CoreInstructionId>>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				for (const access of coreMemoryAccesses(instruction, resolution)) {
					if (
						access.location.kind !== "object-slot" &&
						access.location.kind !== "element"
					) {
						continue;
					}
					const partition = coreMemoryPartition(access.location);
					if (access.mode === "read") {
						readPartitions.add(partition);
						continue;
					}
					const stores = storesByPartition.get(partition) ?? [];
					stores.push(instruction.id);
					storesByPartition.set(partition, stores);
					note(partition, access.value);
				}
			}
		}
		if (storesByPartition.size === 0) return fn;
		// A partition this pass never described has no proven set of occupants, so it
		// is not removable either.
		const removable = (partition: CoreMemoryPartition): boolean =>
			described.has(partition) && !weaklyHoldable.has(partition);

		const dead = new Set<CoreInstructionId>();
		for (const [partition, stores] of storesByPartition) {
			if (readPartitions.has(partition) || !removable(partition)) continue;
			for (const store of stores) {
				if (!protectedInstructions.has(store)) dead.add(store);
			}
		}
		for (const block of fn.blocks) {
			if (block.handler !== undefined) continue;
			const pending = new Map<CoreMemoryPartition, CoreInstructionId>();
			for (const instruction of block.instructions) {
				for (const access of coreMemoryAccesses(instruction, resolution)) {
					if (
						access.location.kind !== "object-slot" &&
						access.location.kind !== "element"
					) {
						continue;
					}
					const partition = coreMemoryPartition(access.location);
					if (access.mode === "read") {
						pending.delete(partition);
						continue;
					}
					const previous = pending.get(partition);
					if (
						previous !== undefined &&
						!establishingStores.has(previous) &&
						removable(partition) &&
						!protectedInstructions.has(previous)
					) {
						dead.add(previous);
					}
					pending.set(partition, instruction.id);
				}
			}
		}
		if (dead.size === 0) return fn;
		return pruneVacuousHandlers({
			...fn,
			blocks: fn.blocks.map((block) => ({
				...block,
				instructions: block.instructions.filter(({ id }) => !dead.has(id)),
			})),
			mutationEpoch: fn.mutationEpoch + 1,
		});
	},
};

/**
 * Remove a contained aggregate after scalar forwarding erased its identity.
 *
 * Allocation opcodes are deliberately non-discardable: a fresh object normally
 * carries identity and keeps every value stored in it reachable. Provenance and
 * liveness discharge both obligations together: the allocation must be contained
 * and its SSA result must be dead after forwarding and store elimination. A dead
 * result is not a root at any later safepoint, so the allocation cannot keep its
 * occupants alive there; its inputs are still rooted at the allocation itself.
 * Removing that safepoint can delay collection, but cannot make an occupant die
 * sooner, including through WeakRef or FinalizationRegistry observation.
 *
 * Removing the allocation can expose dead moves and block arguments that still
 * name its result. Run the ordinary liveness cleanup in the same transaction so
 * no intermediate Core graph contains a dangling value.
 */
const eliminateDeadAllocations: CoreFunctionPass = {
	name: "eliminate-dead-allocations",
	run(fn, analyses, program) {
		const provenance = analyses.provenance(fn);
		if (provenance.layouts.length === 0) return fn;
		const liveness = coreLiveness(fn);
		const { instructions: protectedInstructions } = analyses.regionProtection(fn);
		const dead = new Set<CoreInstructionId>();
		const deadValues = new Set<CoreValueId>();
		for (const layout of provenance.layouts) {
			if (
				provenance.escape(layout.instruction) !== "contained" ||
				protectedInstructions.has(layout.instruction) ||
				liveness.values[layout.result] !== 0
			) {
				continue;
			}
			dead.add(layout.instruction);
			deadValues.add(layout.result);
		}
		if (dead.size === 0) return fn;
		const withoutAllocations: CoreFunction = {
			...fn,
			blocks: fn.blocks.map((block) => ({
				...block,
				instructions: block.instructions.filter(({ id }) => !dead.has(id)),
			})),
			values: fn.values.filter(({ id }) => !deadValues.has(id)),
			mutationEpoch: fn.mutationEpoch + 1,
		};
		return deadInstructionElimination.run(withoutAllocations, analyses, program);
	},
};

interface FreshAllocationSinkCandidate {
	readonly allocation: CoreInstruction;
	readonly sourceBlock: CoreBlockId;
	readonly sourceIndex: number;
	readonly use: CoreInstruction;
}

function sameCoreHandler(
	left: CoreBlock["handler"],
	right: CoreBlock["handler"],
): boolean {
	if (left === undefined || right === undefined) return left === right;
	return (
		left.block === right.block &&
		left.arguments.length === right.arguments.length &&
		left.arguments.every((argument, index) => argument === right.arguments[index])
	);
}

/**
 * Delay a fresh aggregate until the only instruction that can observe it.
 *
 * Scalar forwarding often erases every ordinary use of an object while leaving
 * one cold publication, such as storing the object in a retained record. Keeping
 * the allocation at its original merge point then allocates on hot paths that
 * never publish the identity. This pass moves the allocation to immediately
 * before that unique consuming instruction.
 *
 * The move is deliberately CFG- and exception-aware. Every initializer must be
 * available at the destination; the allocation and consumer retain the same
 * handler; and both blocks must belong to exactly the same reducible and
 * irreducible cycles. The cycle rule prevents moving a once-per-entry allocation
 * into a loop that can execute it repeatedly. Moving within the same block does
 * not reduce execution frequency, so it is left to register allocation and
 * precise liveness instead. Initializer SSA values remain live through the move,
 * so delaying the aggregate does not expose its occupants to earlier collection.
 */
const sinkFreshAllocations: CoreFunctionPass = {
	name: "sink-fresh-allocations",
	ablation: "escape",
	run(fn, analyses) {
		const cfg = analyses.controlFlow(fn);
		const { instructions: protectedInstructions, inputs: protectedInputs } =
			analyses.regionProtection(fn);
		const instructionLocations = new Map<
			CoreInstructionId,
			{
				readonly block: CoreBlockId;
				readonly index: number;
				readonly instruction: CoreInstruction;
			}
		>();
		const uses = new Map<
			CoreValueId,
			Array<{
				readonly kind: "instruction" | "control";
				readonly instruction?: CoreInstruction;
				readonly block: CoreBlockId;
			}>
		>();
		const noteUse = (
			value: CoreValueId,
			use: {
				readonly kind: "instruction" | "control";
				readonly instruction?: CoreInstruction;
				readonly block: CoreBlockId;
			},
		): void => {
			const current = uses.get(value);
			if (current === undefined) uses.set(value, [use]);
			else current.push(use);
		};
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				instructionLocations.set(instruction.id, {
					block: block.id,
					index,
					instruction,
				});
				for (const input of instruction.inputs) {
					noteUse(input, { kind: "instruction", instruction, block: block.id });
				}
			}
			for (const argument of block.handler?.arguments ?? []) {
				noteUse(argument, { kind: "control", block: block.id });
			}
			for (const edge of coreTerminatorEdges(block.terminator)) {
				for (const argument of edge.arguments) {
					noteUse(argument, { kind: "control", block: block.id });
				}
			}
			switch (block.terminator.kind) {
				case "branch":
				case "guard":
					noteUse(block.terminator.condition, {
						kind: "control",
						block: block.id,
					});
					break;
				case "switch":
					noteUse(block.terminator.discriminant, {
						kind: "control",
						block: block.id,
					});
					break;
				case "return":
				case "throw":
					noteUse(block.terminator.value, { kind: "control", block: block.id });
					break;
				case "jump":
				case "unreachable":
					break;
			}
		}

		const values = new Map(fn.values.map((value) => [value.id, value] as const));
		const factSubjects = new Set(
			fn.facts.flatMap((fact) =>
				fact.claims.flatMap((claim) => (claim.kind === "effect" ? [] : [claim.subject])),
			),
		);
		const factInstructions = new Set(
			fn.facts.flatMap((fact) =>
				fact.claims.flatMap((claim) =>
					claim.kind === "effect" ? [claim.instruction] : [],
				),
			),
		);
		const sameCycleContext = (left: CoreBlockId, right: CoreBlockId): boolean =>
			cfg.loops.every(({ blocks }) => blocks.has(left) === blocks.has(right)) &&
			cfg.irreducibleCycles.every(({ blocks }) => blocks.has(left) === blocks.has(right));
		const valueAvailableAt = (
			value: CoreValueId,
			block: CoreBlockId,
			point: number,
		): boolean => {
			const definition = values.get(value)?.definition;
			if (definition === undefined) return false;
			if (definition.kind === "block-parameter") {
				return definition.block === block || cfg.dominates(definition.block, block);
			}
			const location = instructionLocations.get(definition.instruction);
			if (location === undefined) return false;
			return location.block === block
				? location.index < point
				: cfg.instructionDominatesBlock(location.block, block);
		};

		const candidates: Array<FreshAllocationSinkCandidate> = [];
		for (const block of fn.blocks) {
			for (const [sourceIndex, allocation] of block.instructions.entries()) {
				const descriptor = coreOpcodeRegistry.require(allocation.opcode);
				const output = allocation.outputs[0];
				if (
					descriptor.allocation === undefined ||
					allocation.outputs.length !== 1 ||
					output === undefined ||
					allocation.effectRefinement !== undefined ||
					protectedInstructions.has(allocation.id) ||
					protectedInputs.has(output) ||
					factSubjects.has(output) ||
					factInstructions.has(allocation.id)
				) {
					continue;
				}
				const valueUses = uses.get(output) ?? [];
				const use = valueUses.length === 1 ? valueUses[0] : undefined;
				const consumer = use?.kind === "instruction" ? use.instruction : undefined;
				const consumerLocation =
					consumer === undefined ? undefined : instructionLocations.get(consumer.id);
				if (
					consumer === undefined ||
					consumerLocation === undefined ||
					consumerLocation.block === block.id ||
					protectedInstructions.has(consumer.id) ||
					!cfg.instructionDominatesBlock(block.id, consumerLocation.block) ||
					!sameCoreHandler(block.handler, fn.blocks[consumerLocation.block]!.handler) ||
					!sameCycleContext(block.id, consumerLocation.block) ||
					!allocation.inputs.every((input) =>
						valueAvailableAt(input, consumerLocation.block, consumerLocation.index),
					)
				) {
					continue;
				}
				candidates.push({
					allocation,
					sourceBlock: block.id,
					sourceIndex,
					use: consumer,
				});
			}
		}
		if (candidates.length === 0) return fn;

		// If one movable allocation consumes another, move the outer allocation in
		// this round and reconsider the inner one against its new destination in the
		// next fixpoint round. This keeps initializer-availability checks local and
		// avoids inventing a relocation dependency graph in the pass.
		const movableAllocations = new Set(candidates.map(({ allocation }) => allocation.id));
		const selected = candidates.filter(({ use }) => !movableAllocations.has(use.id));
		if (selected.length === 0) return fn;
		selected.sort(
			(left, right) =>
				left.sourceBlock - right.sourceBlock || left.sourceIndex - right.sourceIndex,
		);
		const moved = new Set(selected.map(({ allocation }) => allocation.id));
		const before = new Map<CoreInstructionId, Array<CoreInstruction>>();
		for (const { allocation, use } of selected) {
			const current = before.get(use.id);
			if (current === undefined) before.set(use.id, [allocation]);
			else current.push(allocation);
		}
		const blocks = fn.blocks.map((block): CoreBlock => {
			const instructions: Array<CoreInstruction> = [];
			for (const instruction of block.instructions) {
				if (moved.has(instruction.id)) continue;
				instructions.push(...(before.get(instruction.id) ?? []), instruction);
			}
			return instructions.length === block.instructions.length &&
				instructions.every(
					(instruction, index) => instruction === block.instructions[index],
				)
				? block
				: { ...block, instructions };
		});
		return pruneVacuousHandlers({
			...fn,
			blocks,
			mutationEpoch: fn.mutationEpoch + 1,
		});
	},
};

function loopHasExceptionalControl(
	fn: CoreFunction,
	cfg: CoreControlFlow,
	loop: CoreNaturalLoop,
): boolean {
	return [...loop.blocks].some(
		(block) =>
			fn.blocks[block]!.handler !== undefined ||
			cfg.predecessors[block]!.some(({ kind }) => kind === "exceptional"),
	);
}

/**
 * Split the ordinary edges that keep one reducible loop from canonical form.
 * Forwarding blocks mirror the destination's parameters, so the transform never
 * invents a value merge or changes an existing phi-like block argument.
 */
function canonicalizeNaturalLoop(
	fn: CoreFunction,
	cfg: CoreControlFlow,
	loop: CoreNaturalLoop,
): CoreFunction | undefined {
	if (
		loop.canonical ||
		loop.header === fn.entry ||
		loopHasExceptionalControl(fn, cfg, loop) ||
		cfg.irreducibleCycles.some(({ blocks }) =>
			[...loop.blocks].some((block) => blocks.has(block)),
		)
	) {
		return undefined;
	}
	const headerIncoming = cfg.predecessors[loop.header]!.filter(
		({ kind }) => kind === "ordinary",
	);
	const outside = headerIncoming.filter(({ from }) => !loop.blocks.has(from));
	if (outside.length === 0) return undefined;

	const retarget = new Map<string, CoreBlockId>();
	const blocks = [...fn.blocks];
	const values = [...fn.values];
	let nextInstruction = nextInstructionId(fn);
	let nextValue = (fn.values.at(-1)?.id ?? -1) + 1;
	const edgeKey = (from: CoreBlockId, to: CoreBlockId): string => `${from}\0${to}`;
	const appendForwarder = (target: CoreBlockId): CoreBlockId | undefined => {
		const destination = blocks[target];
		if (
			destination === undefined ||
			destination.parameters.some(({ role }) => role === "exception")
		) {
			return undefined;
		}
		const id = coreBlockId(blocks.length);
		const parameters = destination.parameters.map((parameter, index) => {
			const value = coreValueId(nextValue++);
			values.push({
				id: value,
				representation: parameter.representation,
				definition: { kind: "block-parameter", block: id, index },
			});
			return { ...parameter, value };
		});
		blocks.push({
			id,
			parameters,
			instructions: [],
			terminator: {
				kind: "jump",
				id: coreInstructionId(nextInstruction++),
				edge: {
					block: target,
					arguments: parameters.map(({ value }) => value),
				},
			},
		});
		return id;
	};

	if (loop.preheader === undefined) {
		const preheader = appendForwarder(loop.header);
		if (preheader === undefined) return undefined;
		for (const { from } of outside) retarget.set(edgeKey(from, loop.header), preheader);
	}
	const existingLatch = loop.latches.size === 1 ? [...loop.latches][0]! : undefined;
	const existingLatchTerminator =
		existingLatch === undefined ? undefined : fn.blocks[existingLatch]!.terminator;
	const canonicalLatch =
		existingLatch !== undefined &&
		existingLatchTerminator?.kind === "jump" &&
		existingLatchTerminator.edge.block === loop.header &&
		cfg.successors[existingLatch]!.length === 1;
	if (!canonicalLatch) {
		const latch = appendForwarder(loop.header);
		if (latch === undefined) return undefined;
		for (const from of loop.latches) retarget.set(edgeKey(from, loop.header), latch);
	}
	const sharedExitTargets = new Set(
		loop.exits.filter(({ dedicated }) => !dedicated).map(({ to }) => to),
	);
	for (const target of sharedExitTargets) {
		if (target === fn.entry) continue;
		const exit = appendForwarder(target);
		if (exit === undefined) continue;
		for (const { from, to } of loop.exits) {
			if (to === target) retarget.set(edgeKey(from, to), exit);
		}
	}
	if (retarget.size === 0) return undefined;
	for (const block of fn.blocks) {
		const terminator = remapTerminatorEdges(block.terminator, (edge) => {
			const target = retarget.get(edgeKey(block.id, edge.block));
			return target === undefined ? edge : { ...edge, block: target };
		});
		if (terminator !== block.terminator) blocks[block.id] = { ...block, terminator };
	}
	return {
		...fn,
		blocks,
		values,
		mutationEpoch: fn.mutationEpoch + 1,
	};
}

/**
 * Give every ordinary reducible loop one preheader, one latch, and dedicated
 * exits. Irreducible and exceptional cycles deliberately remain in their correct
 * unspecialized form. Rebuilding the linear-time CFG after each changed loop
 * keeps nested-loop membership exact instead of transforming against stale sets.
 */
const canonicalizeLoops: CoreFunctionPass = {
	name: "canonicalize-loops",
	changesControlFlow: true,
	run(fn, analyses) {
		let current = fn;
		let cfg = analyses.controlFlow(fn);
		const maximumTransforms = fn.blocks.length * 2 + 16;
		for (let iteration = 0; iteration < maximumTransforms; iteration += 1) {
			let transformed: CoreFunction | undefined;
			for (const loop of [...cfg.loops].sort(
				(left, right) => left.blocks.size - right.blocks.size,
			)) {
				transformed = canonicalizeNaturalLoop(current, cfg, loop);
				if (transformed !== undefined) break;
			}
			if (transformed === undefined) return current;
			current = transformed;
			cfg = buildCoreControlFlow(current, coreOpcodeRegistry);
		}
		return current;
	},
};

/**
 * Canonical loop boundary blocks are deliberately explicit optimization seams.
 * CFG cleanup must preserve them once formed, or cleanup and canonicalization
 * would recreate and remove the same forwarding blocks on alternating rounds.
 */
function canonicalLoopBoundaryBlocks(
	fn: CoreFunction,
	cfg: CoreControlFlow,
): ReadonlySet<CoreBlockId> {
	const protectedBlocks = new Set<CoreBlockId>();
	for (const loop of cfg.loops) {
		if (!loop.canonical || loop.preheader === undefined) continue;
		protectedBlocks.add(loop.preheader);
		for (const latch of loop.latches) protectedBlocks.add(latch);
		for (const exit of loop.exits) {
			if (!exit.dedicated) continue;
			const boundary = fn.blocks[exit.to];
			if (boundary === undefined) continue;
			const wouldExposeSharedExit = coreTerminatorEdges(boundary.terminator).some(
				({ block: successor }) =>
					cfg.predecessors[successor]!.some(
						(edge) =>
							edge.kind === "ordinary" &&
							edge.from !== boundary.id &&
							!loop.blocks.has(edge.from),
					),
			);
			if (wouldExposeSharedExit) protectedBlocks.add(exit.to);
		}
	}
	return protectedBlocks;
}

/**
 * Hoist speculatable SSA expressions from canonical reducible loops. The sparse
 * dependency worklist visits each candidate input once; cyclic phis and values
 * produced by effectful instructions remain variant.
 */
const loopInvariantCodeMotion: CoreFunctionPass = {
	name: "loop-invariant-code-motion",
	run(fn, analyses) {
		if (fn.blocks.length <= 1) return fn;
		const cfg = analyses.controlFlow(fn);
		if (cfg.loops.length === 0) return fn;
		const { instructions: protectedInstructions, inputs: protectedInputs } =
			analyses.regionProtection(fn);
		const definitionBlocks = new Map<CoreValueId, CoreBlockId>();
		const representations = analyses.representations(fn);
		const provenance = analyses.provenance(fn);
		const resolution = memoryResolution(analyses, fn);
		for (const block of fn.blocks) {
			for (const parameter of block.parameters)
				definitionBlocks.set(parameter.value, block.id);
			for (const instruction of block.instructions) {
				for (const output of instruction.outputs) definitionBlocks.set(output, block.id);
			}
		}

		let changed = false;
		const blocks = [...fn.blocks];
		const loops = [...cfg.loops].sort(
			(left, right) => left.blocks.size - right.blocks.size,
		);
		for (const loop of loops) {
			if (loop.preheader === undefined) continue;
			if (loopHasExceptionalControl(fn, cfg, loop)) continue;
			const preheader = blocks[loop.preheader]!;
			const loopInstructions = [...loop.blocks].flatMap(
				(block) => blocks[block]!.instructions,
			);
			const writes = summarizeLoopWrites(loopInstructions, resolution);

			const candidates: Array<CoreInstruction> = [];
			let selectedCost = 0;
			let selectedRootSlots = 0;
			for (const blockId of cfg.reversePostorder) {
				if (!loop.blocks.has(blockId)) continue;
				for (const instruction of blocks[blockId]!.instructions) {
					if (
						protectedInstructions.has(instruction.id) ||
						instruction.outputs.some((output) => protectedInputs.has(output))
					) {
						continue;
					}
					const candidate = loopInvariantCandidate(
						instruction,
						provenance,
						resolution,
						representations,
					);
					if (candidate === undefined) continue;
					const executesEveryIteration = [...loop.latches].every((latch) =>
						cfg.dominates(blockId, latch),
					);
					if (candidate.addedRootSlots > 0 && !executesEveryIteration) continue;
					if (candidate.kind === "load") {
						if (!executesEveryIteration) continue;
						const effects = coreInstructionEffects(instruction);
						if (
							(effects.mayGc || candidate.addedRootSlots > 0) &&
							blockId !== loop.header
						) {
							continue;
						}
						const reads = coreMemoryAccesses(instruction, resolution).filter(
							(access) => access.mode === "read",
						);
						if (reads.some((read) => loopWritesInvalidateRead(read, writes))) continue;
					} else if (candidate.cost > 1 && !executesEveryIteration) {
						continue;
					}
					// Hoisting never duplicates an instruction. The budget limits compile-time
					// work and, more importantly, prevents an unbounded increase in live roots.
					if (
						selectedCost + candidate.cost > 64 ||
						selectedRootSlots + candidate.addedRootSlots > 2
					) {
						continue;
					}
					selectedCost += candidate.cost;
					selectedRootSlots += candidate.addedRootSlots;
					candidates.push(instruction);
				}
			}
			if (candidates.length === 0) continue;
			const remaining = new Map<CoreInstructionId, Set<CoreValueId>>();
			const users = new Map<CoreValueId, Array<CoreInstruction>>();
			const ready: Array<CoreInstruction> = [];
			for (const instruction of candidates) {
				const dependencies = new Set(
					instruction.inputs.filter((input) => {
						const definitionBlock = definitionBlocks.get(input);
						return definitionBlock !== undefined && loop.blocks.has(definitionBlock);
					}),
				);
				remaining.set(instruction.id, dependencies);
				if (dependencies.size === 0) ready.push(instruction);
				for (const dependency of dependencies) {
					const dependentUsers = users.get(dependency) ?? [];
					dependentUsers.push(instruction);
					users.set(dependency, dependentUsers);
				}
			}

			const hoisted: Array<CoreInstruction> = [];
			const hoistedIds = new Set<CoreInstructionId>();
			for (let index = 0; index < ready.length; index++) {
				const instruction = ready[index]!;
				if (hoistedIds.has(instruction.id)) continue;
				hoistedIds.add(instruction.id);
				hoisted.push(instruction);
				for (const output of instruction.outputs) {
					definitionBlocks.set(output, preheader.id);
					for (const user of users.get(output) ?? []) {
						const dependencies = remaining.get(user.id)!;
						dependencies.delete(output);
						if (dependencies.size === 0) ready.push(user);
					}
				}
			}
			if (hoisted.length === 0) continue;
			for (const blockId of loop.blocks) {
				const block = blocks[blockId]!;
				blocks[blockId] = {
					...block,
					instructions: block.instructions.filter(({ id }) => !hoistedIds.has(id)),
				};
			}
			blocks[preheader.id] = {
				...blocks[preheader.id]!,
				instructions: [...blocks[preheader.id]!.instructions, ...hoisted],
			};
			changed = true;
		}
		return changed ? { ...fn, blocks, mutationEpoch: fn.mutationEpoch + 1 } : fn;
	},
};

function numericConstant(
	value: CoreValueId,
	definitions: ReadonlyMap<CoreValueId, CoreInstruction>,
	root: (value: CoreValueId) => CoreValueId,
): number | undefined {
	const definition = definitions.get(root(value));
	if (definition?.opcode !== "createNumber" && definition?.opcode !== "createF64") {
		return undefined;
	}
	const constant = definition.attributes.value;
	return typeof constant === "number" ? constant : undefined;
}

function compareF64(operator: string, left: number, right: number): boolean | undefined {
	switch (operator) {
		case "<":
			return left < right;
		case "<=":
			return left <= right;
		case ">":
			return left > right;
		case ">=":
			return left >= right;
		case "==":
		case "===":
			return left === right;
		case "!=":
		case "!==":
			return left !== right;
		default:
			return undefined;
	}
}

function reverseComparison(operator: string): string | undefined {
	switch (operator) {
		case "<":
			return ">";
		case "<=":
			return ">=";
		case ">":
			return "<";
		case ">=":
			return "<=";
		case "==":
		case "===":
		case "!=":
		case "!==":
			return operator;
		default:
			return undefined;
	}
}

function oppositeLoopComparison(left: string, right: CoreLoopComparison): boolean {
	return (
		(left === "<" && right === ">=") ||
		(left === "<=" && right === ">") ||
		(left === ">" && right === "<=") ||
		(left === ">=" && right === "<")
	);
}

function numericRangeComparisonTruth(
	instruction: CoreInstruction,
	block: CoreBlockId,
	analysis: CoreLoopInductionAnalysis,
	representations: ReadonlyMap<CoreValueId, string>,
): boolean | undefined {
	if (
		instruction.opcode !== "binary" ||
		instruction.inputs.length !== 2 ||
		instruction.outputs.length !== 1 ||
		instruction.inputs.some(
			(value) =>
				representations.get(value) !== "f64" && representations.get(value) !== "i32",
		) ||
		representations.get(instruction.outputs[0]!) !== "boolean"
	) {
		return undefined;
	}
	const operator = instruction.attributes.operator;
	if (typeof operator !== "string") return undefined;
	const left = analysis.range(instruction.inputs[0]!, block);
	const right = analysis.range(instruction.inputs[1]!, block);
	if (left === undefined || right === undefined) return undefined;
	switch (operator) {
		case "<":
			if (left.maximum < right.minimum) return true;
			if (left.minimum >= right.maximum) return false;
			return undefined;
		case "<=":
			if (left.maximum <= right.minimum) return true;
			if (left.minimum > right.maximum) return false;
			return undefined;
		case ">":
			if (left.minimum > right.maximum) return true;
			if (left.maximum <= right.minimum) return false;
			return undefined;
		case ">=":
			if (left.minimum >= right.maximum) return true;
			if (left.maximum < right.minimum) return false;
			return undefined;
		case "==":
		case "===":
			if (left.maximum < right.minimum || right.maximum < left.minimum) return false;
			if (
				left.minimum === left.maximum &&
				right.minimum === right.maximum &&
				left.minimum === right.minimum
			) {
				return true;
			}
			return undefined;
		case "!=":
		case "!==": {
			const equal = numericRangeComparisonTruth(
				{ ...instruction, attributes: { ...instruction.attributes, operator: "===" } },
				block,
				analysis,
				representations,
			);
			return equal === undefined ? undefined : !equal;
		}
		default:
			return undefined;
	}
}

/**
 * Fold a comparison only where the loop's successful control edge dominates it.
 * The endpoint test is valid because the supported numeric relations are monotone;
 * equality is folded only when the exact safe-integer interval excludes the key.
 */
function loopComparisonTruth(
	instruction: CoreInstruction,
	block: CoreBlockId,
	induction: CoreInductionVariable,
	cfg: CoreControlFlow,
	definitions: ReadonlyMap<CoreValueId, CoreInstruction>,
	representations: ReadonlyMap<CoreValueId, string>,
	root: (value: CoreValueId) => CoreValueId,
): boolean | undefined {
	if (
		instruction.opcode !== "binary" ||
		instruction.inputs.length !== 2 ||
		instruction.outputs.length !== 1 ||
		instruction.inputs.some(
			(value) =>
				representations.get(value) !== "f64" && representations.get(value) !== "i32",
		) ||
		representations.get(instruction.outputs[0]!) !== "boolean" ||
		induction.comparison === undefined ||
		!induction.loop.blocks.has(block) ||
		!cfg.dominates(induction.comparison.body, block)
	) {
		return undefined;
	}
	// Generic binary operations can rerun boxed coercions. The numeric/boolean gate is
	// what makes deleting this comparison effect-free, not merely a range fact.
	const operatorAttribute = instruction.attributes.operator;
	if (typeof operatorAttribute !== "string") return undefined;
	let operator = operatorAttribute;
	let other: CoreValueId;
	if (root(instruction.inputs[0]!) === root(induction.value)) {
		other = instruction.inputs[1]!;
	} else if (root(instruction.inputs[1]!) === root(induction.value)) {
		other = instruction.inputs[0]!;
		operator = reverseComparison(operator) ?? "";
	} else {
		return undefined;
	}
	if (root(other) === root(induction.comparison.bound)) {
		if (operator === induction.comparison.operator) return true;
		if (oppositeLoopComparison(operator, induction.comparison.operator)) return false;
	}
	const range = induction.range;
	const constant = numericConstant(other, definitions, root);
	if (range === undefined || constant === undefined) return undefined;
	if (["==", "===", "!=", "!=="].includes(operator)) {
		if (constant < range.minimum || constant > range.maximum) {
			return operator === "!=" || operator === "!==";
		}
		if (range.minimum !== range.maximum || constant !== range.minimum) return undefined;
	}
	const atMinimum = compareF64(operator, range.minimum, constant);
	const atMaximum = compareF64(operator, range.maximum, constant);
	return atMinimum !== undefined && atMinimum === atMaximum ? atMinimum : undefined;
}

function numericStrengthReductionValue(
	instruction: CoreInstruction,
	block: CoreBlockId,
	analysis: CoreLoopInductionAnalysis,
	representations: ReadonlyMap<CoreValueId, string>,
): CoreValueId | undefined {
	if (
		instruction.opcode !== "binary" ||
		instruction.attributes.operator !== "%" ||
		instruction.inputs.length !== 2 ||
		instruction.outputs.length !== 1 ||
		(representations.get(instruction.inputs[0]!) !== "f64" &&
			representations.get(instruction.inputs[0]!) !== "i32") ||
		(representations.get(instruction.inputs[1]!) !== "f64" &&
			representations.get(instruction.inputs[1]!) !== "i32") ||
		representations.get(instruction.outputs[0]!) !==
			representations.get(instruction.inputs[0]!)
	) {
		return undefined;
	}
	const range = analysis.range(instruction.inputs[0]!, block);
	const divisor = analysis.range(instruction.inputs[1]!, block);
	return range !== undefined &&
		divisor !== undefined &&
		divisor.minimum === divisor.maximum &&
		Number.isSafeInteger(divisor.minimum) &&
		divisor.minimum > range.maximum &&
		range.minimum >= 0
		? instruction.inputs[0]
		: undefined;
}

/**
 * Consume exact integer ranges in two representation-safe ways:
 *
 * - comparisons on the comparison-true side become constants when every value in
 *   the proven interval gives the same answer;
 * - a non-negative safe-integer remainder below its positive divisor becomes the
 *   induction value itself.
 *
 * Both rewrites strictly remove work and add neither edge computations nor roots.
 */
const optimizeLoopRanges: CoreFunctionPass = {
	name: "optimize-loop-ranges",
	ablation: "fact-driven",
	run(fn, analyses) {
		if (
			(fn.blocks.length < 3 &&
				!fn.values.some(({ representation }) => representation === "i32")) ||
			!fn.blocks.some((block) =>
				block.instructions.some(({ opcode }) => opcode === "binary"),
			)
		) {
			return fn;
		}
		const analysis = analyses.loopInductions(fn);
		if (!analysis.hasNumericRanges) return fn;
		const cfg = analyses.controlFlow(fn);
		const canonical = analyses.canonicalValues(fn);
		const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
		const definitions = analyses.definitions(fn);
		const representations = analyses.representations(fn);
		const { instructions: protectedInstructions, inputs: protectedInputs } =
			analyses.regionProtection(fn);
		const inductionsByBlock = new Map<CoreBlockId, Array<CoreInductionVariable>>();
		for (const induction of analysis.inductions) {
			for (const block of induction.loop.blocks) {
				const inductions = inductionsByBlock.get(block) ?? [];
				inductions.push(induction);
				inductionsByBlock.set(block, inductions);
			}
		}
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					if (
						protectedInstructions.has(instruction.id) ||
						instruction.outputs.some((output) => protectedInputs.has(output))
					) {
						return instruction;
					}
					if (
						instruction.opcode !== "binary" ||
						instruction.inputs.length !== 2 ||
						instruction.outputs.length !== 1 ||
						instruction.inputs.some(
							(value) =>
								representations.get(value) !== "f64" &&
								representations.get(value) !== "i32",
						)
					) {
						return instruction;
					}
					for (const induction of inductionsByBlock.get(block.id) ?? []) {
						const truth = loopComparisonTruth(
							instruction,
							block.id,
							induction,
							cfg,
							definitions,
							representations,
							root,
						);
						if (truth !== undefined) {
							changed = true;
							return {
								id: instruction.id,
								opcode: "createBoolean",
								inputs: [],
								outputs: instruction.outputs,
								attributes: { value: truth },
								...(instruction.sourcePosition === undefined
									? {}
									: { sourcePosition: instruction.sourcePosition }),
							};
						}
					}
					const truth = numericRangeComparisonTruth(
						instruction,
						block.id,
						analysis,
						representations,
					);
					if (truth !== undefined) {
						changed = true;
						return {
							id: instruction.id,
							opcode: "createBoolean",
							inputs: [],
							outputs: instruction.outputs,
							attributes: { value: truth },
							...(instruction.sourcePosition === undefined
								? {}
								: { sourcePosition: instruction.sourcePosition }),
						};
					}
					const reduced = numericStrengthReductionValue(
						instruction,
						block.id,
						analysis,
						representations,
					);
					if (reduced !== undefined) {
						changed = true;
						return {
							id: instruction.id,
							opcode: "move",
							inputs: [reduced],
							outputs: instruction.outputs,
							attributes: {},
							...(instruction.sourcePosition === undefined
								? {}
								: { sourcePosition: instruction.sourcePosition }),
						};
					}
					return instruction;
				}),
			}),
		);
		return changed ? { ...fn, blocks, mutationEpoch: fn.mutationEpoch + 1 } : fn;
	},
};

/** Use the local form when every candidate shares one block and reads no memory. */
function localCopyAndValueNumber(
	fn: CoreFunction,
	representations: ReadonlyMap<CoreValueId, CoreRepresentation>,
): CoreFunction | undefined {
	if (fn.regions.length > 0) return undefined;
	const candidateBlocks = fn.blocks.filter((block) =>
		block.instructions.some(
			(instruction) =>
				isEliminableMove(instruction) || isValueNumberingCandidate(instruction),
		),
	);
	if (candidateBlocks.length !== 1) return undefined;
	const candidateBlock = candidateBlocks[0]!;
	if (
		candidateBlock.instructions.some(
			(instruction) =>
				isValueNumberingCandidate(instruction) &&
				coreInstructionEffects(instruction).reads.length > 0,
		)
	) {
		return undefined;
	}
	const replacements = new Map<CoreValueId, CoreValueId>();
	const removedInstructions = new Set<CoreInstructionId>();
	const available = new Map<string, ReadonlyArray<CoreValueId>>();
	const instructions: Array<CoreInstruction> = [];
	for (const original of candidateBlock.instructions) {
		const instruction: CoreInstruction = {
			...original,
			inputs: original.inputs.map((value) => resolveValue(value, replacements)),
		};
		if (isEliminableMove(instruction)) {
			replacements.set(instruction.outputs[0]!, instruction.inputs[0]!);
			removedInstructions.add(instruction.id);
			continue;
		}
		const key = valueNumberingKey(instruction, "");
		if (key !== undefined) {
			const previous = available.get(key);
			if (
				previous !== undefined &&
				previous.length === instruction.outputs.length &&
				instruction.outputs.every(
					(output, index) =>
						representations.get(output) === representations.get(previous[index]!),
				)
			) {
				for (const [index, output] of instruction.outputs.entries()) {
					replacements.set(output, previous[index]!);
				}
				removedInstructions.add(instruction.id);
				continue;
			}
			available.set(key, instruction.outputs);
		}
		instructions.push(instruction);
	}
	if (removedInstructions.size === 0) return fn;
	const blocks = fn.blocks.map((block) =>
		block.id === candidateBlock.id ? { ...block, instructions } : block,
	);
	return pruneVacuousHandlers(
		rewriteFunction(fn, blocks, replacements, removedInstructions),
	);
}

const copyAndValueNumber: CoreFunctionPass = {
	name: "copy-and-value-number",
	ablation: "constant-folding",
	run(fn, analyses) {
		if (!mayCopyOrValueNumber(fn)) return fn;
		const local = localCopyAndValueNumber(fn, analyses.representations(fn));
		if (local !== undefined) return local;
		const cfg = analyses.controlFlow(fn);
		const needsMemoryVersions = fn.blocks.some((block) =>
			block.instructions.some(
				(instruction) =>
					isValueNumberingCandidate(instruction) &&
					coreInstructionEffects(instruction).reads.length > 0,
			),
		);
		const memoryVersions = needsMemoryVersions ? analyses.memory(fn) : undefined;
		const replacements = new Map<CoreValueId, CoreValueId>();
		const removedInstructions = new Set<number>();
		const { instructions: protectedInstructions, inputs: protectedInputs } =
			analyses.regionProtection(fn);
		const representations = analyses.representations(fn);
		const blocks = [...fn.blocks];
		const children = fn.blocks.map(() => new Array<CoreBlockId>());
		for (const block of fn.blocks) {
			const parent = cfg.immediateDominators[block.id];
			if (parent !== undefined && parent !== null && parent !== block.id) {
				children[parent]!.push(block.id);
			}
		}
		const visited = new Set<CoreBlockId>();
		interface AvailableValue {
			readonly outputs: ReadonlyArray<CoreValueId>;
			readonly block: CoreBlockId;
		}
		type Available = Map<string, AvailableValue>;
		type Undo = {
			readonly available: Available;
			readonly key: string;
			readonly previous: AvailableValue | undefined;
			readonly existed: boolean;
		};
		type Frame =
			| {
					readonly kind: "enter";
					readonly block: CoreBlockId;
					readonly available: Available;
			  }
			| { readonly kind: "exit"; readonly marker: number };
		const processTree = (root: CoreBlockId): void => {
			const undo: Array<Undo> = [];
			const stack: Array<Frame> = [{ kind: "enter", block: root, available: new Map() }];
			while (stack.length > 0) {
				const frame = stack.pop()!;
				if (frame.kind === "exit") {
					while (undo.length > frame.marker) {
						const entry = undo.pop()!;
						if (entry.existed) entry.available.set(entry.key, entry.previous!);
						else entry.available.delete(entry.key);
					}
					continue;
				}
				if (visited.has(frame.block)) continue;
				visited.add(frame.block);
				const marker = undo.length;
				const block = fn.blocks[frame.block]!;
				const instructions: Array<CoreInstruction> = [];
				for (const original of block.instructions) {
					if (protectedInstructions.has(original.id)) {
						instructions.push(original);
						continue;
					}
					const instruction: CoreInstruction = {
						...original,
						inputs: original.inputs.map((value) => resolveValue(value, replacements)),
					};
					if (
						isEliminableMove(instruction) &&
						!protectedInputs.has(instruction.outputs[0]!)
					) {
						replacements.set(instruction.outputs[0]!, instruction.inputs[0]!);
						removedInstructions.add(instruction.id);
						continue;
					}
					const key = valueNumberingKey(
						instruction,
						memoryVersions?.readKey(instruction.id) ?? "",
					);
					if (key !== undefined) {
						const previous = frame.available.get(key);
						if (
							previous !== undefined &&
							(previous.block === frame.block ||
								cfg.instructionDominatesBlock(previous.block, frame.block)) &&
							previous.outputs.length === instruction.outputs.length &&
							instruction.outputs.every(
								(output, index) =>
									representations.get(output) ===
									representations.get(previous.outputs[index]!),
							) &&
							instruction.outputs.every((output) => !protectedInputs.has(output))
						) {
							for (const [index, output] of instruction.outputs.entries()) {
								replacements.set(output, previous.outputs[index]!);
							}
							removedInstructions.add(instruction.id);
							continue;
						}
						undo.push({
							available: frame.available,
							key,
							previous,
							existed: frame.available.has(key),
						});
						frame.available.set(key, {
							outputs: instruction.outputs,
							block: frame.block,
						});
					}
					instructions.push(instruction);
				}
				blocks[frame.block] = { ...block, instructions };
				stack.push({ kind: "exit", marker });
				for (const child of [...children[frame.block]!].reverse()) {
					stack.push({
						kind: "enter",
						block: child,
						available: cfg.predecessors[child]!.some(({ kind }) => kind === "exceptional")
							? new Map<string, AvailableValue>()
							: frame.available,
					});
				}
			}
		};
		processTree(fn.entry);
		for (const block of fn.blocks) {
			if (!visited.has(block.id)) processTree(block.id);
		}
		if (removedInstructions.size === 0) return fn;
		return pruneVacuousHandlers(
			rewriteFunction(fn, blocks, replacements, removedInstructions),
		);
	},
};

interface CoreLiveness {
	readonly instructions: ReadonlySet<CoreInstructionId>;
	readonly values: Uint8Array;
	readonly hasNonEntryParameters: boolean;
}

/** Backward SSA liveness shared by profitability decisions and final DCE. */
function coreLiveness(fn: CoreFunction): CoreLiveness {
	const valueCount = (fn.values.at(-1)?.id ?? -1) + 1;
	const definitions = new Array<CoreInstruction | undefined>(valueCount);
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			for (const output of instruction.outputs) definitions[output] = instruction;
		}
	}
	const parameterSources = new Array<Array<CoreValueId> | undefined>(valueCount);
	const hasNonEntryParameters = fn.blocks.some(
		(block) =>
			block.id !== fn.entry && block.parameters.some(({ role }) => role !== "exception"),
	);
	if (hasNonEntryParameters) {
		const addParameterSource = (
			block: CoreBlockId,
			index: number,
			source: CoreValueId,
		): void => {
			const parameter = fn.blocks[block]?.parameters[index];
			if (parameter === undefined) return;
			const sources = parameterSources[parameter.value];
			if (sources === undefined) parameterSources[parameter.value] = [source];
			else sources.push(source);
		};
		for (const block of fn.blocks) {
			for (const edge of coreTerminatorEdges(block.terminator)) {
				for (const [index, argument] of edge.arguments.entries()) {
					addParameterSource(edge.block, index, argument);
				}
			}
			if (block.handler === undefined) continue;
			const handler = fn.blocks[block.handler.block]!;
			const exceptionOffset = handler.parameters[0]?.role === "exception" ? 1 : 0;
			for (const [index, argument] of block.handler.arguments.entries()) {
				addParameterSource(block.handler.block, index + exceptionOffset, argument);
			}
		}
	}
	const instructions = new Set<CoreInstructionId>();
	const values = new Uint8Array(valueCount);
	const pending = new Int32Array(valueCount);
	let pendingSize = 0;
	const markValue = (value: CoreValueId): void => {
		if (values[value] !== 0) return;
		values[value] = 1;
		pending[pendingSize++] = value;
	};
	const markInstruction = (instruction: CoreInstruction): void => {
		if (instructions.has(instruction.id)) return;
		instructions.add(instruction.id);
		for (const input of instruction.inputs) markValue(input);
	};
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			const discardable =
				instructionIsDiscardable(instruction) ||
				(instruction.opcode === "unary" &&
					instructionAttribute(instruction, "operator") === "typeof");
			if (!discardable) markInstruction(instruction);
		}
		switch (block.terminator.kind) {
			case "jump":
				break;
			case "branch":
			case "guard":
				markValue(block.terminator.condition);
				break;
			case "switch":
				markValue(block.terminator.discriminant);
				break;
			case "return":
			case "throw":
				markValue(block.terminator.value);
				break;
			case "unreachable":
				break;
		}
	}
	for (const parameter of fn.blocks[fn.entry]!.parameters) markValue(parameter.value);
	if (fn.bodyEntry !== undefined && fn.bodyEntry !== fn.entry) {
		for (const parameter of fn.blocks[fn.bodyEntry]!.parameters) {
			markValue(parameter.value);
		}
	}
	while (pendingSize > 0) {
		const value = pending[--pendingSize]! as CoreValueId;
		const producer = definitions[value];
		if (producer !== undefined) markInstruction(producer);
		for (const source of parameterSources[value] ?? []) markValue(source);
	}
	return { instructions, values, hasNonEntryParameters };
}

interface PreAvailableExpression {
	readonly block: CoreBlockId;
	readonly instruction: CoreInstruction;
	readonly output: CoreValueId;
}

function isPreExpressionOpcode(instruction: CoreInstruction): boolean {
	return (
		instruction.opcode === "mathUnaryNumber" || instruction.opcode === "mathBinaryNumber"
	);
}

function preExpressionCost(fn: CoreFunction, instruction: CoreInstruction): number {
	return coreGeneratedCodeCostForInstructions(fn, [{ instruction }], {
		duplicatedInstructions: 1,
	}).compileScore;
}

/**
 * Costed SSA PRE for jump-only merge edges. GVN has already removed fully
 * redundant expressions; this pass handles the partial case where an expensive,
 * unrooted, effect-free value is live on some incoming paths. One missing edge
 * keeps the expression count neutral; zero missing edges removes an expression.
 * The cost score pays for merge copies before moving work to the missing edge.
 */
function eliminateOnePartialRedundancy(
	fn: CoreFunction,
	analyses: CoreAnalysisManager,
): CoreFunction | undefined {
	if (fn.blocks.length < 3) return undefined;
	const cfg = analyses.controlFlow(fn);
	const loopHeaders = new Set(cfg.loops.map(({ header }) => header));
	const representations = analyses.representations(fn);
	const definitionBlocks = new Map<CoreValueId, CoreBlockId>();
	for (const current of fn.blocks) {
		for (const parameter of current.parameters) {
			definitionBlocks.set(parameter.value, current.id);
		}
		for (const instruction of current.instructions) {
			for (const output of instruction.outputs) {
				definitionBlocks.set(output, current.id);
			}
		}
	}
	const { instructions: protectedInstructions, inputs: protectedInputs } =
		analyses.regionProtection(fn);
	let liveBeforeDce: ReadonlySet<CoreInstructionId> | undefined;
	const availableByKey = new Map<string, Array<PreAvailableExpression>>();
	for (const block of fn.blocks) {
		if (block.handler !== undefined) continue;
		for (const instruction of block.instructions) {
			if (
				!isPreExpressionOpcode(instruction) ||
				protectedInstructions.has(instruction.id) ||
				instruction.outputs.length !== 1 ||
				!LOOP_UNROOTED_REPRESENTATIONS.has(
					representations.get(instruction.outputs[0]!) ?? "",
				)
			) {
				continue;
			}
			const effects = coreInstructionEffects(instruction);
			if (
				effects.reads.length > 0 ||
				effects.writes.length > 0 ||
				effects.mayThrow ||
				effects.mayGc ||
				effects.maySuspend ||
				effects.callsUserCode
			) {
				continue;
			}
			const key = valueNumberingKey(instruction, "");
			if (key === undefined) continue;
			const entries = availableByKey.get(key) ?? [];
			entries.push({
				block: block.id,
				instruction,
				output: instruction.outputs[0]!,
			});
			availableByKey.set(key, entries);
		}
	}

	for (const block of fn.blocks) {
		if (
			block.id === fn.entry ||
			block.id === fn.bodyEntry ||
			block.handler !== undefined ||
			block.parameters.some(({ role }) => role === "exception") ||
			loopHeaders.has(block.id)
		) {
			continue;
		}
		const incoming = cfg.predecessors[block.id]!;
		if (
			incoming.length < 2 ||
			incoming.some(({ kind }) => kind !== "ordinary") ||
			incoming.some(({ from }) => {
				const predecessor = fn.blocks[from]!;
				return (
					predecessor.handler !== undefined ||
					protectedInstructions.has(predecessor.terminator.id) ||
					predecessor.terminator.kind !== "jump" ||
					predecessor.terminator.edge.block !== block.id
				);
			})
		) {
			continue;
		}
		const parameterIndices = new Map(
			block.parameters.map(({ value }, index) => [value, index] as const),
		);
		let followsSuspension = false;
		for (const candidate of block.instructions) {
			const candidateFollowsSuspension = followsSuspension;
			followsSuspension ||= coreInstructionEffects(candidate).maySuspend;
			const output = candidate.outputs[0];
			if (
				output === undefined ||
				!isPreExpressionOpcode(candidate) ||
				candidateFollowsSuspension ||
				candidate.outputs.length !== 1 ||
				protectedInstructions.has(candidate.id) ||
				protectedInputs.has(output) ||
				!LOOP_UNROOTED_REPRESENTATIONS.has(representations.get(output) ?? "")
			) {
				continue;
			}
			if (
				candidate.inputs.some((input) => {
					if (parameterIndices.has(input)) return false;
					const definitionBlock = definitionBlocks.get(input);
					return (
						definitionBlock === undefined ||
						definitionBlock === block.id ||
						!cfg.instructionDominatesBlock(definitionBlock, block.id)
					);
				})
			) {
				continue;
			}
			const effects = coreInstructionEffects(candidate);
			if (
				effects.reads.length > 0 ||
				effects.writes.length > 0 ||
				effects.mayThrow ||
				effects.mayGc ||
				effects.maySuspend ||
				effects.callsUserCode ||
				valueNumberingKey(candidate, "") === undefined
			) {
				continue;
			}
			const valuesByPredecessor = new Map<CoreBlockId, CoreValueId>();
			let missing:
				| {
						readonly block: CoreBlockId;
						readonly inputs: ReadonlyArray<CoreValueId>;
				  }
				| undefined;
			let valid = true;
			for (const edge of incoming) {
				if (edge.kind !== "ordinary") {
					valid = false;
					break;
				}
				const translated = candidate.inputs.map((input) => {
					const parameter = parameterIndices.get(input);
					return parameter === undefined ? input : edge.arguments[parameter]!;
				});
				if (translated.some((value) => value === undefined)) {
					valid = false;
					break;
				}
				const key = valueNumberingKey({ ...candidate, inputs: translated }, "")!;
				const structurallyAvailable = (availableByKey.get(key) ?? []).filter(
					(entry) =>
						entry.instruction.id !== candidate.id &&
						representations.get(entry.output) === representations.get(output) &&
						(entry.block === edge.from ||
							cfg.instructionDominatesBlock(entry.block, edge.from)),
				);
				if (structurallyAvailable.length > 0 && liveBeforeDce === undefined) {
					liveBeforeDce = coreLiveness(fn).instructions;
				}
				if (liveBeforeDce !== undefined && !liveBeforeDce.has(candidate.id)) {
					valid = false;
					break;
				}
				const available = structurallyAvailable.find((entry) =>
					liveBeforeDce!.has(entry.instruction.id),
				);
				if (available !== undefined) {
					valuesByPredecessor.set(edge.from, available.output);
				} else if (missing === undefined) {
					missing = { block: edge.from, inputs: translated };
				} else {
					valid = false;
					break;
				}
			}
			if (
				!valid ||
				valuesByPredecessor.size === 0 ||
				(missing !== undefined &&
					preExpressionCost(fn, candidate) * valuesByPredecessor.size <= incoming.length)
			) {
				continue;
			}

			const instructionId =
				missing === undefined ? undefined : coreInstructionId(nextInstructionId(fn));
			const valueId =
				missing === undefined ? undefined : coreValueId((fn.values.at(-1)?.id ?? -1) + 1);
			const clone: CoreInstruction | undefined =
				missing === undefined
					? undefined
					: {
							...candidate,
							id: instructionId!,
							inputs: missing.inputs,
							outputs: [valueId!],
						};
			if (missing !== undefined) valuesByPredecessor.set(missing.block, valueId!);
			const parameterIndex = block.parameters.length;
			const blocks = fn.blocks.map((current): CoreBlock => {
				if (current.id === block.id) {
					return {
						...current,
						parameters: [
							...current.parameters,
							{
								value: output,
								representation: representations.get(output)!,
								role: "value",
							},
						],
						instructions: current.instructions.filter(({ id }) => id !== candidate.id),
					};
				}
				if (!valuesByPredecessor.has(current.id)) return current;
				if (current.terminator.kind !== "jump") return current;
				return {
					...current,
					instructions:
						clone !== undefined && current.id === missing?.block
							? [...current.instructions, clone]
							: current.instructions,
					terminator: {
						...current.terminator,
						edge: {
							...current.terminator.edge,
							arguments: [
								...current.terminator.edge.arguments,
								valuesByPredecessor.get(current.id)!,
							],
						},
					},
				};
			});
			let values = fn.values.map((value) =>
				value.id === output
					? {
							...value,
							definition: {
								kind: "block-parameter" as const,
								block: block.id,
								index: parameterIndex,
							},
						}
					: value,
			);
			if (instructionId !== undefined && valueId !== undefined) {
				values = values.concat({
					id: valueId,
					representation: representations.get(output)!,
					definition: {
						kind: "instruction",
						instruction: instructionId,
						index: 0,
					},
				});
			}
			return { ...fn, blocks, values, mutationEpoch: fn.mutationEpoch + 1 };
		}
	}
	return undefined;
}

const partialRedundancyElimination: CoreFunctionPass = {
	name: "partial-redundancy-elimination",
	changesControlFlow: true,
	run(fn, analyses) {
		let expressionCount = 0;
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (isPreExpressionOpcode(instruction)) expressionCount++;
				if (expressionCount >= 2) break;
			}
			if (expressionCount >= 2) break;
		}
		if (expressionCount < 2) return fn;
		let current = fn;
		const instructionCount = fn.blocks.reduce(
			(count, block) => count + block.instructions.length,
			0,
		);
		const maximumTransforms = Math.max(1, instructionCount * fn.blocks.length);
		for (let transform = 0; transform < maximumTransforms; transform += 1) {
			const next = eliminateOnePartialRedundancy(current, analyses);
			if (next === undefined) return current;
			current = next;
		}
		return current;
	},
};

function collectUses(fn: CoreFunction): Uint8Array {
	const uses = new Uint8Array((fn.values.at(-1)?.id ?? -1) + 1);
	const addEdge = (edge: CoreEdge) => {
		for (const value of edge.arguments) uses[value] = 1;
	};
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			for (const input of instruction.inputs) uses[input] = 1;
		}
		if (block.handler !== undefined) {
			for (const value of block.handler.arguments) uses[value] = 1;
		}
		switch (block.terminator.kind) {
			case "jump":
				addEdge(block.terminator.edge);
				break;
			case "branch":
				uses[block.terminator.condition] = 1;
				addEdge(block.terminator.consequent);
				addEdge(block.terminator.alternate);
				break;
			case "guard":
				uses[block.terminator.condition] = 1;
				addEdge(block.terminator.success);
				addEdge(block.terminator.fallback);
				break;
			case "switch":
				uses[block.terminator.discriminant] = 1;
				for (const { edge } of block.terminator.cases) addEdge(edge);
				addEdge(block.terminator.default);
				break;
			case "return":
			case "throw":
				uses[block.terminator.value] = 1;
				break;
			case "unreachable":
				break;
		}
	}
	return uses;
}

/**
 * Collapse ordinary phi-like parameters whose reachable inputs have one
 * canonical producer, and delete parameters that no instruction or control
 * operation consumes. Exception parameters remain owned by the unwinder.
 */
const eliminateTrivialBlockArguments: CoreFunctionPass = {
	name: "eliminate-trivial-block-arguments",
	changesControlFlow: true,
	run(fn, analyses) {
		if (
			!fn.blocks.some(
				(block) =>
					block.id !== fn.entry &&
					block.id !== fn.bodyEntry &&
					block.parameters.length > 0 &&
					!block.parameters.some(({ role }) => role === "exception"),
			)
		) {
			return fn;
		}
		const cfg = analyses.controlFlow(fn);
		const uses = collectUses(fn);
		let canonical: ReadonlyMap<CoreValueId, CoreValueId> | undefined;
		let representations:
			| Array<CoreFunction["values"][number]["representation"] | undefined>
			| undefined;
		const removedIndices = new Map<CoreBlockId, Set<number>>();
		const replacements = new Map<CoreValueId, CoreValueId>();
		for (const block of fn.blocks) {
			if (
				block.id === fn.entry ||
				block.id === fn.bodyEntry ||
				block.parameters.some(({ role }) => role === "exception")
			) {
				continue;
			}
			const incoming = cfg.predecessors[block.id]!.filter(({ from }) =>
				cfg.reachable.has(from),
			);
			if (incoming.length === 0 || incoming.some(({ kind }) => kind !== "ordinary")) {
				continue;
			}
			for (const [index, parameter] of block.parameters.entries()) {
				if (uses[parameter.value] === 0) {
					let indices = removedIndices.get(block.id);
					if (indices === undefined) removedIndices.set(block.id, (indices = new Set()));
					indices.add(index);
					continue;
				}
				canonical ??= analyses.canonicalValues(fn);
				if (representations === undefined) {
					representations = new Array(uses.length);
					for (const value of fn.values) {
						representations[value.id] = value.representation;
					}
				}
				const root = canonical.get(parameter.value) ?? parameter.value;
				if (
					root === parameter.value ||
					representations[root] !== parameter.representation
				) {
					continue;
				}
				let indices = removedIndices.get(block.id);
				if (indices === undefined) removedIndices.set(block.id, (indices = new Set()));
				indices.add(index);
				replacements.set(parameter.value, root);
			}
		}
		return removedIndices.size === 0
			? fn
			: removeBlockParameters(fn, removedIndices, replacements);
	},
};

const deadInstructionElimination: CoreFunctionPass = {
	name: "dead-instruction-elimination",
	run(fn) {
		const {
			instructions: liveInstructions,
			values: liveValues,
			hasNonEntryParameters,
		} = coreLiveness(fn);
		const removedInstructions = new Set<number>();
		const removedValues = new Set<CoreValueId>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (!liveInstructions.has(instruction.id)) {
					removedInstructions.add(instruction.id);
					for (const output of instruction.outputs) removedValues.add(output);
				}
			}
		}
		const liveGuardInstructionIds = new Set<number>();
		for (const block of fn.blocks) {
			if (block.terminator.kind === "guard") {
				liveGuardInstructionIds.add(block.terminator.id);
			}
		}
		const liveFacts = new Set(
			fn.blocks.flatMap((block) => [
				...(block.terminator.kind === "guard" ? [block.terminator.fact] : []),
				...block.instructions.flatMap(({ id, effectRefinement }) =>
					removedInstructions.has(id) || effectRefinement === undefined
						? []
						: [effectRefinement.proof],
				),
			]),
		);
		const facts = fn.facts.filter((fact) => {
			if (
				fact.validity.kind === "guard" &&
				!liveGuardInstructionIds.has(fact.validity.instruction)
			) {
				return false;
			}
			if (
				fact.obligations.some(
					(obligation) =>
						obligation.kind === "guard" &&
						!liveGuardInstructionIds.has(obligation.instruction),
				)
			) {
				return false;
			}
			return (
				liveFacts.has(fact.id) || fact.obligations.some(({ kind }) => kind !== "guard")
			);
		});
		const removedIndices = new Map<CoreBlockId, Set<number>>();
		if (fn.regions.length === 0 && hasNonEntryParameters) {
			for (const block of fn.blocks) {
				if (block.id === fn.entry || block.id === fn.bodyEntry) continue;
				for (const [index, parameter] of block.parameters.entries()) {
					if (parameter.role === "exception" || liveValues[parameter.value] !== 0)
						continue;
					const indices = removedIndices.get(block.id) ?? new Set<number>();
					indices.add(index);
					removedIndices.set(block.id, indices);
				}
			}
		}
		if (
			removedInstructions.size === 0 &&
			facts.length === fn.facts.length &&
			removedIndices.size === 0
		) {
			return fn;
		}
		let result: CoreFunction = {
			...fn,
			blocks: fn.blocks.map((block) => ({
				...block,
				instructions: block.instructions.filter(({ id }) => !removedInstructions.has(id)),
			})),
			values: fn.values.filter(({ id }) => !removedValues.has(id)),
			facts,
			mutationEpoch: fn.mutationEpoch + 1,
		};
		if (removedIndices.size > 0) result = removeBlockParameters(result, removedIndices);
		return pruneVacuousHandlers(result);
	},
};

/**
 * Retarget edges through empty jumps and through empty branch/switch blocks when
 * the incoming edge makes their choice constant. Core owns this threading so no
 * later stage has to rediscover it from emitted block layout.
 *
 * A forwarded argument is either one of the block's parameters, substituted with
 * the incoming edge's argument, or a value that dominates the empty block. Since
 * retargeting deletes parameter definitions, candidates are rejected when one of
 * those parameters is also used by a dominated instruction outside the terminator.
 */
const foldEmptyForwardingBlocks: CoreFunctionPass = {
	name: "fold-empty-forwarding-blocks",
	changesControlFlow: true,
	run(fn, analyses, program) {
		if (fn.blocks.length <= 1) return fn;
		const protectedLoopBoundaries = canonicalLoopBoundaryBlocks(
			fn,
			analyses.controlFlow(fn),
		);
		const useSites = new Map<CoreValueId, Set<string>>();
		const addUse = (value: CoreValueId, site: string): void => {
			const sites = useSites.get(value) ?? new Set<string>();
			sites.add(site);
			useSites.set(value, sites);
		};
		for (const block of fn.blocks) {
			const bodySite = `body:${block.id}`;
			const terminatorSite = `terminator:${block.id}`;
			for (const instruction of block.instructions) {
				for (const input of instruction.inputs) addUse(input, bodySite);
			}
			for (const argument of block.handler?.arguments ?? []) addUse(argument, bodySite);
			for (const edge of coreTerminatorEdges(block.terminator)) {
				for (const argument of edge.arguments) addUse(argument, terminatorSite);
			}
			switch (block.terminator.kind) {
				case "branch":
				case "guard":
					addUse(block.terminator.condition, terminatorSite);
					break;
				case "switch":
					addUse(block.terminator.discriminant, terminatorSite);
					break;
				case "return":
				case "throw":
					addUse(block.terminator.value, terminatorSite);
					break;
				case "jump":
				case "unreachable":
					break;
			}
		}
		const emptyControlBlocks = new Map<CoreBlockId, CoreBlock>();
		for (const block of fn.blocks) {
			const ownTerminator = `terminator:${block.id}`;
			if (
				block.id === fn.entry ||
				block.id === fn.bodyEntry ||
				protectedLoopBoundaries.has(block.id) ||
				block.instructions.length > 0 ||
				block.handler !== undefined ||
				// An exception parameter is bound by the unwinder, not by an edge.
				block.parameters.some(({ role }) => role === "exception") ||
				// Retargeting deletes this block. A parameter used by a dominated
				// instruction would otherwise survive without its defining phi.
				block.parameters.some((parameter) =>
					[...(useSites.get(parameter.value) ?? [])].some(
						(site) => site !== ownTerminator,
					),
				) ||
				(block.terminator.kind !== "jump" &&
					block.terminator.kind !== "branch" &&
					block.terminator.kind !== "switch") ||
				(block.terminator.kind === "jump" && block.terminator.edge.block === block.id)
			) {
				continue;
			}
			emptyControlBlocks.set(block.id, block);
		}
		if (emptyControlBlocks.size === 0) return fn;
		const definitions = new Map<CoreValueId, CoreInstruction>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				for (const output of instruction.outputs) definitions.set(output, instruction);
			}
		}
		// A chain that closes into a cycle has no non-forwarding target, so the walk
		// gives the current edge back unchanged and the pass reaches its fixpoint.
		// Branches and switches are threaded only when this particular incoming edge
		// supplies a primitive constant for their discriminant; other predecessors can
		// continue to enter the original block.
		const forwardEdge = (edge: CoreEdge): CoreEdge => {
			const seen = new Set<CoreBlockId>();
			let current = edge;
			for (;;) {
				const block = emptyControlBlocks.get(current.block);
				if (block === undefined || seen.has(current.block)) return current;
				seen.add(current.block);
				const substitutions = new Map<CoreValueId, CoreValueId>(
					block.parameters.map((parameter, index) => [
						parameter.value,
						current.arguments[index]!,
					]),
				);
				let outgoing: CoreEdge;
				switch (block.terminator.kind) {
					case "jump":
						outgoing = block.terminator.edge;
						break;
					case "branch": {
						const condition =
							substitutions.get(block.terminator.condition) ?? block.terminator.condition;
						const immediate = immediateForValue(condition, definitions);
						const truthy =
							immediate === undefined
								? undefined
								: immediateTruthiness(immediate, program);
						if (truthy === undefined) return current;
						outgoing = truthy ? block.terminator.consequent : block.terminator.alternate;
						break;
					}
					case "switch": {
						const discriminant =
							substitutions.get(block.terminator.discriminant) ??
							block.terminator.discriminant;
						const immediate = immediateForValue(discriminant, definitions);
						if (immediate === undefined) return current;
						outgoing =
							block.terminator.cases.find(({ value }) =>
								immediateStrictEquals(immediate, value),
							)?.edge ?? block.terminator.default;
						break;
					}
					case "guard":
					case "return":
					case "throw":
					case "unreachable":
						return current;
				}
				current = {
					block: outgoing.block,
					arguments: outgoing.arguments.map(
						(argument) => substitutions.get(argument) ?? argument,
					),
				};
			}
		};
		const sameEdge = (left: CoreEdge, right: CoreEdge): boolean =>
			left.block === right.block &&
			left.arguments.length === right.arguments.length &&
			left.arguments.every((argument, index) => argument === right.arguments[index]);
		let changed = false;
		const blocks = fn.blocks.map((block): CoreBlock => {
			let blockChanged = false;
			const terminator = remapTerminatorEdges(block.terminator, (edge) => {
				const forwarded = forwardEdge(edge);
				if (sameEdge(edge, forwarded)) return edge;
				blockChanged = true;
				return forwarded;
			});
			if (!blockChanged) return block;
			changed = true;
			return { ...block, terminator };
		});
		if (!changed) return fn;
		return removeUnreachableCoreBlocks({
			...fn,
			blocks,
			mutationEpoch: fn.mutationEpoch + 1,
		});
	},
};

/** Merge every dominance-safe linear chain in one O(blocks + edges + instructions) pass. */
const combineLinearBlocks: CoreFunctionPass = {
	name: "combine-linear-blocks",
	changesControlFlow: true,
	run(fn, analyses) {
		const cfg = analyses.controlFlow(fn);
		const protectedLoopBoundaries = canonicalLoopBoundaryBlocks(fn, cfg);
		const mergeSuccessors = new Map<CoreBlockId, CoreBlockId>();
		const mergeTargets = new Set<CoreBlockId>();
		for (const predecessor of fn.blocks) {
			if (predecessor.handler !== undefined || predecessor.terminator.kind !== "jump") {
				continue;
			}
			const targetId = predecessor.terminator.edge.block;
			if (
				targetId === predecessor.id ||
				targetId === fn.entry ||
				targetId === fn.bodyEntry ||
				protectedLoopBoundaries.has(targetId)
			) {
				continue;
			}
			const target = fn.blocks[targetId];
			if (target === undefined || target.handler !== undefined) continue;
			const incoming = cfg.predecessors[targetId]!;
			if (
				incoming.length !== 1 ||
				incoming[0]!.kind !== "ordinary" ||
				incoming[0]!.from !== predecessor.id
			) {
				continue;
			}
			mergeSuccessors.set(predecessor.id, targetId);
			mergeTargets.add(targetId);
		}
		if (mergeTargets.size === 0) return fn;

		const replacements = new Map<CoreValueId, CoreValueId>();
		const blocks = [...fn.blocks];
		for (const root of fn.blocks) {
			if (mergeTargets.has(root.id)) continue;
			let merged = root;
			let tail = root.id;
			for (;;) {
				const targetId = mergeSuccessors.get(tail);
				if (targetId === undefined) break;
				const predecessor = fn.blocks[tail]!;
				if (predecessor.terminator.kind !== "jump") {
					throw new Error(`Core linear merge predecessor b${tail} is not a jump`);
				}
				const target = fn.blocks[targetId]!;
				for (const [index, parameter] of target.parameters.entries()) {
					replacements.set(
						parameter.value,
						resolveValue(predecessor.terminator.edge.arguments[index]!, replacements),
					);
				}
				merged = {
					...merged,
					instructions: [
						...merged.instructions,
						...target.instructions.map((instruction) => ({
							...instruction,
							inputs: instruction.inputs.map((value) =>
								resolveValue(value, replacements),
							),
						})),
					],
					terminator: rewriteTerminator(target.terminator, replacements),
				};
				tail = targetId;
			}
			blocks[root.id] = merged;
		}

		// A removed target parameter can be used by blocks dominated by the whole
		// chain. Rewrite every such use once before dense normalization deletes the
		// old blocks and their parameter definitions.
		return removeUnreachableCoreBlocks(
			rewriteFunction(fn, blocks, replacements, new Set()),
		);
	},
};

const CORE_LOCAL_PASSES: ReadonlyArray<CoreFunctionPass> = [
	annotateTerminalYieldSites,
	annotateKnownBuiltinCalls,
	foldTypeofComparisons,
	foldExactObjectObservations,
	eliminateRedundantTdzChecks,
	eliminateTrivialBlockArguments,
	sparseConditionalConstantPropagation,
	refineValueRepresentations,
	refineStackObjectCellRepresentations,
	simplifyAlgebraicValues,
	subsumeCoreFactProofs,
	foldSubsumedCoreGuards,
	simplifyControlFlow,
	lowerLocalThrowCatchFlows,
	foldEmptyForwardingBlocks,
	combineLinearBlocks,
	canonicalizeLoops,
	foldStaticPropertyKeys,
	refineOwnDataCellAccesses,
	forwardFreshAllocationPrefixLoads,
	forwardMemoryAccesses,
	scalarizeRootedContainedObjects,
	eliminateDeadStores,
	eliminateDeadAllocations,
	sinkFreshAllocations,
	loopInvariantCodeMotion,
	optimizeLoopRanges,
	copyAndValueNumber,
	partialRedundancyElimination,
	deadInstructionElimination,
];

const CORE_PROGRAM_PASSES: ReadonlyArray<CoreFunctionPass> = [refineDirectCallEffects];

/** Whole-program facts are solved once, then ordinary local cleanup consumes them. */
const CORE_FACT_DRIVEN_PASSES: ReadonlyArray<CoreFunctionPass> = [
	foldWholeProgramValueKinds,
	refinePrimitiveOperatorEffects,
	refineExactShapeOwnSlotEffects,
	refineExactCollectionBuiltinEffects,
	eliminateRedundantPrimitiveCoercions,
];

/**
 * Exact builtin selection deletes the property seam that kept these blocks and
 * values alive. Every pass here is deletion-only, so the structural measure in
 * the scheduler is a termination proof rather than an iteration allowance.
 */
const CORE_EXACT_BUILTIN_CLEANUP_PASSES: ReadonlyArray<CoreFunctionPass> = [
	deadInstructionElimination,
	eliminateTrivialBlockArguments,
	pruneVacuousExceptionHandlers,
	foldEmptyForwardingBlocks,
	combineLinearBlocks,
];

/**
 * Complete every certificate in `fn` with its admission record: where the
 * license's semantic-epoch dependencies are tested, and whether that one test
 * covers the whole interior.
 *
 * The question is the same for every region kind — it is about the license's
 * epoch dependencies and the interior's effects, not about what the region does —
 * so it is derived once here instead of restated by each selecting pass. Only
 * `region.data` is rewritten, so no claim can be invalidated, and the Core
 * verifier re-derives the same answer from the graph.
 */
function annotateRegionAdmission(
	fn: CoreFunction,
	analyses: CoreAnalysisManager,
): CoreFunction {
	if (fn.regions.length === 0) return fn;
	const cfg = analyses.controlFlow(fn);
	const model = analyses.regionValidity(fn);
	const costModel = coreGeneratedCodeCostModel(fn, cfg);
	let changed = false;
	const regions = fn.regions.flatMap((region): ReadonlyArray<CoreRegion> => {
		const license = coreRegionLicense(region);
		const anchor = region.anchors[0];
		if (license === undefined || anchor === undefined) return [region];
		const guard = attributeObject(license.guard);
		const guardCount =
			license.guard === "structural"
				? 1
				: (Array.isArray(guard?.dependencies) ? guard.dependencies.length : 0) +
					(Array.isArray(guard?.obligations) ? guard.obligations.length : 0);
		const encodedCost = attributeObject(region.data.cost);
		const benefitScore = typeof encodedCost?.score === "number" ? encodedCost.score : 1;
		const admissionQuery = coreRegionAdmissionQuery(region, anchor);
		const mode =
			region.kind === "string-char-code-at-chain" ||
			region.kind === "builtin-collection-call-chain"
				? "capture"
				: coreRegionAdmissionMode(fn, cfg, model, admissionQuery);
		const strategy = Object.hasOwn(CORE_REGION_STRATEGIES, region.kind)
			? coreRegionStrategy(region.kind as RegisteredCoreRegionKind)
			: undefined;
		const generatedCost = costModel.forRegion(region.claimedInstructions, {
			guards: guardCount,
			duplicatedInstructions: region.claimedInstructions.length,
			genericTwins: license.genericTwin === "retained" ? 1 : 0,
			admissionChecks: mode === "per-use" ? region.claimedInstructions.length : 1,
			materializationPaths: license.materialization === "none" ? 0 : 1,
			stateSynchronizations:
				strategy === undefined || strategy.stateSynchronization === "none" ? 0 : 1,
		});
		if (!coreGeneratedCodeAdmitsRegion(generatedCost, benefitScore)) {
			changed = true;
			return [];
		}
		const existing = coreRegionAdmission(region);
		if (
			existing?.anchor === anchor &&
			existing.mode === mode &&
			stableAttributeValue(region.data.generatedCodeCost) ===
				stableAttributeValue(generatedCost)
		) {
			return [region];
		}
		changed = true;
		return [
			{
				...region,
				data: {
					...region.data,
					generatedCodeCost: { ...generatedCost },
					license: {
						...license,
						admission: { anchor: { $coreInstruction: anchor }, mode },
					},
				},
			},
		];
	});
	return changed ? { ...fn, regions, mutationEpoch: fn.mutationEpoch + 1 } : fn;
}

const CORE_REGION_CANDIDATE_PASSES: ReadonlyArray<CoreFunctionPass> = [
	selectStackObjectRegions,
	selectRegExpExecProjectionRegions,
	selectRegExpIteratorProjectionRegions,
	selectStringSplitCursorRegions,
	selectStringSplitProjectionRegions,
	selectStringSliceNumberRegions,
	selectStringCharCodeAtChainRegions,
	selectBuiltinCollectionCallChainRegions,
	selectIteratorCursorRegions,
	selectIteratorResultVirtualizationRegions,
	selectIndexedLengthLoopRegions,
	selectNumericFusionRegions,
];

function regionCandidateKey(region: CoreRegion): string {
	return `${region.kind}\0${region.anchors.join(",")}\0${region.claimedInstructions.join(",")}`;
}

function regionCandidatesConflict(left: CoreRegion, right: CoreRegion): boolean {
	const leftClaims = new Set(left.claimedInstructions);
	if (!right.claimedInstructions.some((instruction) => leftClaims.has(instruction))) {
		return false;
	}
	const leftStrategy = Object.hasOwn(CORE_REGION_STRATEGIES, left.kind)
		? coreRegionStrategy(left.kind as RegisteredCoreRegionKind)
		: undefined;
	const rightStrategy = Object.hasOwn(CORE_REGION_STRATEGIES, right.kind)
		? coreRegionStrategy(right.kind as RegisteredCoreRegionKind)
		: undefined;
	if (
		leftStrategy?.composition === "overlay" &&
		rightStrategy?.composition === "overlay"
	) {
		return leftStrategy.compositionLayer === rightStrategy.compositionLayer;
	}
	return (
		leftStrategy?.composition !== "overlay" && rightStrategy?.composition !== "overlay"
	);
}

function regionCandidateWeight(region: CoreRegion): number {
	const encodedCost = attributeObject(region.data.cost);
	const generated = attributeObject(region.data.generatedCodeCost);
	const encodedBenefit =
		typeof encodedCost?.score === "number" && Number.isFinite(encodedCost.score)
			? encodedCost.score
			: 1;
	const strategy = Object.hasOwn(CORE_REGION_STRATEGIES, region.kind)
		? coreRegionStrategy(region.kind as RegisteredCoreRegionKind)
		: undefined;
	const benefitPerClaim =
		strategy?.family === "stateful-protocol" ||
		strategy?.family === "projection" ||
		strategy?.family === "virtual-object"
			? 8
			: strategy?.family === "operation-chain"
				? 4
				: 1;
	const benefit = encodedBenefit + region.claimedInstructions.length * benefitPerClaim;
	const runtimeCost =
		typeof generated?.runtimeScore === "number" && Number.isFinite(generated.runtimeScore)
			? generated.runtimeScore
			: 0;
	const compile =
		typeof generated?.compileScore === "number" && Number.isFinite(generated.compileScore)
			? generated.compileScore
			: 0;
	const frequency =
		typeof generated?.loopFrequency === "number" &&
		Number.isFinite(generated.loopFrequency)
			? generated.loopFrequency
			: 1;
	return Math.max(1, benefit * Math.max(1, frequency) * 16 - runtimeCost - compile);
}

function exactRegionIndependentSet(
	component: ReadonlyArray<number>,
	conflicts: ReadonlyArray<ReadonlySet<number>>,
	weights: ReadonlyArray<number>,
	keys: ReadonlyArray<string>,
): ReadonlyArray<number> {
	let best: Array<number> = [];
	let bestWeight = -1;
	const visit = (
		remaining: ReadonlyArray<number>,
		chosen: Array<number>,
		weight: number,
	) => {
		if (remaining.length === 0) {
			const chosenKey = chosen
				.map((index) => keys[index])
				.sort()
				.join("\0");
			const bestKey = best
				.map((index) => keys[index])
				.sort()
				.join("\0");
			if (weight > bestWeight || (weight === bestWeight && chosenKey < bestKey)) {
				best = [...chosen];
				bestWeight = weight;
			}
			return;
		}
		const optimistic =
			weight + remaining.reduce((total, index) => total + weights[index]!, 0);
		if (optimistic < bestWeight) return;
		const [head, ...tail] = remaining as [number, ...Array<number>];
		visit(tail, chosen, weight);
		visit(
			tail.filter((index) => !conflicts[head]!.has(index)),
			[...chosen, head],
			weight + weights[head]!,
		);
	};
	visit(component, [], 0);
	return best;
}

function greedyRegionIndependentSet(
	component: ReadonlyArray<number>,
	conflicts: ReadonlyArray<ReadonlySet<number>>,
	weights: ReadonlyArray<number>,
	keys: ReadonlyArray<string>,
): ReadonlyArray<number> {
	const selected = new Set<number>();
	const ordered = [...component].sort((left, right) => {
		const leftDensity = (weights[left] ?? 0) / ((conflicts[left]?.size ?? 0) + 1);
		const rightDensity = (weights[right] ?? 0) / ((conflicts[right]?.size ?? 0) + 1);
		return rightDensity - leftDensity || keys[left]!.localeCompare(keys[right]!);
	});
	for (const candidate of ordered) {
		if ([...selected].some((chosen) => conflicts[candidate]!.has(chosen))) continue;
		selected.add(candidate);
	}
	for (const candidate of ordered) {
		if (selected.has(candidate)) continue;
		const displaced = [...selected].filter((chosen) => conflicts[candidate]!.has(chosen));
		if (
			displaced.length > 0 &&
			weights[candidate]! >
				displaced.reduce((total, chosen) => total + weights[chosen]!, 0)
		) {
			for (const chosen of displaced) selected.delete(chosen);
			selected.add(candidate);
		}
	}
	return [...selected];
}

const selectGuardedRegions: CoreFunctionPass = {
	name: "select-guarded-regions",
	run(fn, analyses, program) {
		const baseKeys = new Set(fn.regions.map(regionCandidateKey));
		const candidates = new Map<string, CoreRegion>();
		for (const pass of CORE_REGION_CANDIDATE_PASSES) {
			const result = pass.run(fn, analyses, program);
			for (const region of result.regions) {
				const key = regionCandidateKey(region);
				if (!baseKeys.has(key)) candidates.set(key, region);
			}
		}
		if (candidates.size === 0) return annotateRegionAdmission(fn, analyses);
		const admitted = annotateRegionAdmission(
			{
				...fn,
				regions: [...fn.regions, ...candidates.values()],
				mutationEpoch: fn.mutationEpoch + 1,
			},
			analyses,
		);
		const choices = admitted.regions.filter(
			(region) => !baseKeys.has(regionCandidateKey(region)),
		);
		const eligible = choices.filter(
			(candidate) =>
				!fn.regions.some((existing) => regionCandidatesConflict(candidate, existing)),
		);
		const conflicts = eligible.map(() => new Set<number>());
		for (let left = 0; left < eligible.length; left++) {
			for (let right = left + 1; right < eligible.length; right++) {
				if (!regionCandidatesConflict(eligible[left]!, eligible[right]!)) continue;
				conflicts[left]!.add(right);
				conflicts[right]!.add(left);
			}
		}
		const weights = eligible.map(regionCandidateWeight);
		const keys = eligible.map(regionCandidateKey);
		const unseen = new Set(eligible.map((_region, index) => index));
		const selected = new Set<number>();
		while (unseen.size > 0) {
			const seed = Math.min(...unseen);
			const component: Array<number> = [];
			const pending = [seed];
			unseen.delete(seed);
			while (pending.length > 0) {
				const current = pending.pop()!;
				component.push(current);
				for (const adjacent of conflicts[current]!) {
					if (!unseen.delete(adjacent)) continue;
					pending.push(adjacent);
				}
			}
			const chosen =
				component.length <= 18
					? exactRegionIndependentSet(component, conflicts, weights, keys)
					: greedyRegionIndependentSet(component, conflicts, weights, keys);
			for (const index of chosen) selected.add(index);
		}
		const regions = [
			...fn.regions,
			...eligible.filter((_region, index) => selected.has(index)),
		];
		return {
			...fn,
			regions,
			mutationEpoch: Math.max(fn.mutationEpoch + 1, admitted.mutationEpoch),
		};
	},
};

const CORE_FINALIZATION_PASSES: ReadonlyArray<CoreFunctionPass> = [
	annotateFreshDenseIndexedReserves,
	annotateBoundedStringCharCodeAtPositions,
	selectGuardedRegions,
	materializeContainedAggregateOwnSlots,
];

function claimedInstructionSnapshots(
	fn: CoreFunction,
): ReadonlyMap<CoreInstructionId, string> {
	const claimed = new Set(
		fn.regions.flatMap(({ claimedInstructions }) => claimedInstructions),
	);
	if (claimed.size === 0) return new Map();
	const snapshots = new Map<CoreInstructionId, string>();
	for (const block of fn.blocks) {
		for (const instruction of [...block.instructions, block.terminator]) {
			if (!claimed.has(instruction.id)) continue;
			snapshots.set(instruction.id, `${block.id}\0${stableAttributeValue(instruction)}`);
		}
	}
	return snapshots;
}

function genericCoreCallCount(functions: ReadonlyArray<CoreFunction>): number {
	let count = 0;
	for (const fn of functions) {
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.opcode === "call") count++;
			}
		}
	}
	return count;
}

function scalarCoreRepresentationRank(functions: ReadonlyArray<CoreFunction>): number {
	let rank = 0;
	for (const fn of functions) {
		for (const value of fn.values) {
			if (value.representation === "i32") rank += 2;
			else if (
				value.representation === "f64" ||
				value.representation === "boolean" ||
				value.representation === "string"
			)
				rank++;
		}
	}
	return rank;
}

function scalarCoreConsumerPotential(functions: ReadonlyArray<CoreFunction>): number {
	let potential = 0;
	for (const fn of functions) {
		for (const value of fn.values) {
			if (value.representation === "boxed") potential += 2;
			else if (value.representation === "f64") potential++;
		}
		for (const block of fn.blocks) {
			for (const parameter of block.parameters) {
				if (parameter.representation === "boxed") potential += 2;
				else if (parameter.representation === "f64") potential++;
			}
			for (const instruction of block.instructions) {
				if (
					instruction.opcode === "loadPropertyStatic" &&
					instruction.attributes[CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE] !== true
				) {
					potential++;
				}
			}
		}
	}
	return potential;
}

function directCallResultConsumerPotential(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
): number {
	let potential = 0;
	for (const fn of program.functions) {
		const representations = new Map(
			fn.values.map(({ id, representation }) => [id, representation] as const),
		);
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.opcode !== "call") continue;
				const output = instruction.outputs[0];
				if (output === undefined) continue;
				const claim = summaries.callSite(fn.functionIndex, instruction.id);
				const representation =
					claim === undefined ? "boxed" : coreCallResultRepresentation(claim);
				if (representations.get(output) !== representation) potential += 2;
				const expected =
					claim === undefined || representation === "boxed"
						? undefined
						: coreCallSummaryAttribute(claim);
				if (
					stableAttributeValue(instruction.attributes[CORE_CALL_SUMMARY_ATTRIBUTE]) !==
					stableAttributeValue(expected)
				) {
					potential++;
				}
			}
		}
	}
	return potential;
}

function deletionOnlyCoreMeasure(functions: ReadonlyArray<CoreFunction>): number {
	let measure = 0;
	for (const fn of functions) {
		measure += fn.blocks.length + fn.values.length + fn.facts.length;
		for (const block of fn.blocks) {
			measure +=
				block.instructions.length +
				block.parameters.length +
				(block.handler === undefined ? 0 : 1);
		}
	}
	return measure;
}

function claimingRegionKinds(fn: CoreFunction, instruction: CoreInstructionId): string {
	return fn.regions
		.filter(({ claimedInstructions }) => claimedInstructions.includes(instruction))
		.map(({ kind }) => kind)
		.join(", ");
}

/**
 * A region certificate proves a property of exact instructions in exact blocks,
 * so any later edit to one of them invalidates the proof it licenses. Returns the
 * broken claim, or undefined when every previously claimed instruction survived
 * unchanged; newly claimed instructions are how region selection makes progress.
 */
function claimedRegionViolation(
	before: CoreFunction,
	after: CoreFunction,
): string | undefined {
	if (before === after || before.regions.length === 0) return undefined;
	const claimedBefore = claimedInstructionSnapshots(before);
	if (claimedBefore.size === 0) return undefined;
	const claimedAfter = claimedInstructionSnapshots(after);
	for (const [instruction, snapshot] of claimedBefore) {
		const current = claimedAfter.get(instruction);
		if (current === snapshot) continue;
		const regions = claimingRegionKinds(before, instruction);
		if (current !== undefined) {
			return `pass mutated instruction @${instruction} claimed by region ${regions}`;
		}
		return coreInstructionBlock(after, instruction) === undefined
			? `pass deleted instruction @${instruction} claimed by region ${regions}`
			: `pass dropped the region ${regions} claim on instruction @${instruction}`;
	}
	return undefined;
}

/**
 * Development verification reports the pass that invalidated a certificate; the
 * release profile keeps the last graph whose certificates were still proven.
 */
function acceptPassResult(
	fn: CoreFunction,
	candidate: CoreFunction,
	verification: CoreVerificationProfile,
	context: CoreVerificationContext,
): CoreFunction {
	const violation = claimedRegionViolation(fn, candidate);
	if (violation === undefined) return candidate;
	if (verification === "per-pass") throw new CoreIrVerificationError(violation, context);
	return fn;
}

export function executeCoreOptimizations(
	program: CoreProgram,
	options: CoreOptimizationOptions = {},
): CoreOptimizationResult {
	const maxRounds = options.maxRounds ?? 8;
	if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
		throw new Error(`Invalid Core optimization round limit ${maxRounds}`);
	}
	const verification = options.verification ?? "boundary";
	let compilationContext = options.context;
	// Owned boundary: no caller can hand an unverified graph to the optimizer.
	verifyCoreProgram(
		program,
		coreOpcodeRegistry,
		{ stage: "pre-optimization" },
		compilationContext,
	);
	const verifyMutatedProgram = (
		candidate: CoreProgram,
		context: CoreVerificationContext,
	): void => {
		if (verification === "per-pass") {
			verifyCoreProgram(candidate, coreOpcodeRegistry, context, compilationContext);
		}
	};
	let analyses = new CoreAnalysisManager(program.stringConstants, compilationContext);
	const optimizationTrace: Array<OptimizationPassDelta> = [];
	const collectOptimizationTrace = compilationContext?.optimizationTrace !== undefined;
	let tracedMetrics = collectOptimizationTrace
		? coreOptimizationMetrics(program)
		: undefined;
	// A previous optimizer run may have published target-facing shape hints. They
	// describe that run's final graph and must not be cloned or carried through a
	// new normalization/fixpoint. The final selector republishes current hints.
	const shapeRetraction = retractCoreKnownOwnSlots(program);
	if (shapeRetraction.changed) {
		verifyMutatedProgram(shapeRetraction.program, {
			stage: "normalization",
			pass: "retract-known-own-slots",
		});
	}
	const optimizationInput = shapeRetraction.program;
	const inlineBefore = tracedMetrics;
	const inlineAblated = options.ablations?.has("inlining") === true;
	const inlineResult = inlineAblated
		? {
				program: optimizationInput,
				context: compilationContext,
				changed: false,
			}
		: inlineSimpleCoreFunctions(optimizationInput, verification, compilationContext);
	compilationContext = inlineResult.context;
	if (inlineResult.changed) {
		verifyMutatedProgram(inlineResult.program, {
			stage: "normalization",
			pass: "inline-small-functions",
		});
	}
	const inlineAfter =
		inlineBefore === undefined
			? undefined
			: coreOptimizationMetrics(inlineResult.program);
	if (inlineAfter !== undefined) tracedMetrics = inlineAfter;
	const directBefore = tracedMetrics;
	const directResult = annotateCoreDirectCallTargets(
		inlineResult.program,
		compilationContext,
	);
	compilationContext = directResult.context;
	analyses = new CoreAnalysisManager(
		directResult.program.stringConstants,
		compilationContext,
	);
	if (directResult.changed) {
		verifyMutatedProgram(directResult.program, {
			stage: "normalization",
			pass: "annotate-direct-call-targets",
		});
	}
	let workingProgram = directResult.program;
	let changed = shapeRetraction.changed || inlineResult.changed || directResult.changed;
	let functions = [...workingProgram.functions];
	let activeFunctions = new Set(functions.map(({ functionIndex }) => functionIndex));
	if (inlineBefore !== undefined) {
		optimizationTrace.push(
			optimizationPassDelta(
				{
					pass: "inline-small-functions",
					stage: "normalization",
					status: inlineAblated ? "ablated" : "executed",
					changed: inlineResult.changed,
					ablation: "inlining",
				},
				inlineBefore,
				inlineAfter!,
			),
		);
	}
	if (directBefore !== undefined) {
		const directAfter = coreOptimizationMetrics(workingProgram);
		tracedMetrics = directAfter;
		optimizationTrace.push(
			optimizationPassDelta(
				{
					pass: "annotate-direct-call-targets",
					stage: "normalization",
					status: "executed",
					changed: directResult.changed,
				},
				directBefore,
				directAfter,
			),
		);
	}
	const runFixpointPasses = (
		passes: ReadonlyArray<CoreFunctionPass>,
		round: number,
	): boolean => {
		let roundChanged = false;
		const nextActiveFunctions = new Set<number>();
		for (const pass of passes) {
			const featureGated =
				options.simplifyValues === false &&
				(pass === copyAndValueNumber || pass === deadInstructionElimination);
			const ablated =
				pass.ablation !== undefined && options.ablations?.has(pass.ablation) === true;
			const beforeProgram = { ...workingProgram, functions };
			const before = tracedMetrics;
			if (featureGated) {
				if (before !== undefined) {
					optimizationTrace.push(
						optimizationPassDelta(
							{
								pass: pass.name,
								stage: "fixpoint",
								round,
								status: "feature-gated",
								changed: false,
							},
							before,
							before,
						),
					);
				}
				continue;
			}
			if (ablated) {
				if (before !== undefined) {
					optimizationTrace.push(
						optimizationPassDelta(
							{
								pass: pass.name,
								stage: "fixpoint",
								round,
								status: "ablated",
								changed: false,
								ablation: pass.ablation,
							},
							before,
							before,
						),
					);
				}
				continue;
			}
			let passChanged = false;
			let regionBlockedFunctions = 0;
			let nextFunctions: Array<CoreFunction> | undefined;
			for (
				let functionPosition = 0;
				functionPosition < functions.length;
				functionPosition++
			) {
				const fn = functions[functionPosition]!;
				if (pass.dependsOnProgram !== true && !activeFunctions.has(fn.functionIndex)) {
					continue;
				}
				if (fn.regions.length > 0 && pass.changesControlFlow === true) {
					regionBlockedFunctions++;
					continue;
				}
				const next = acceptPassResult(
					fn,
					pass.run(fn, analyses, beforeProgram),
					verification,
					{
						stage: "fixpoint",
						pass: pass.name,
						round,
						functionIndex: fn.functionIndex,
					},
				);
				const functionChanged = next !== fn;
				if (functionChanged) {
					analyses.inheritControlFlow(fn, next);
					analyses.inheritCanonicalValues(fn, next);
					passChanged = true;
					roundChanged = true;
					changed = true;
					activeFunctions.add(fn.functionIndex);
					nextActiveFunctions.add(fn.functionIndex);
					(nextFunctions ??= [...functions])[functionPosition] = next;
				}
			}
			if (nextFunctions !== undefined) functions = nextFunctions;
			const afterProgram = { ...workingProgram, functions };
			if (passChanged) {
				if (pass.preservesValueKinds === true) {
					analyses.inheritValueKinds(beforeProgram, afterProgram);
				}
				verifyMutatedProgram(afterProgram, { stage: "fixpoint", pass: pass.name, round });
			}
			if (before !== undefined) {
				const after = coreOptimizationMetrics(afterProgram);
				tracedMetrics = after;
				optimizationTrace.push(
					optimizationPassDelta(
						{
							pass: pass.name,
							stage: "fixpoint",
							round,
							status:
								regionBlockedFunctions === 0
									? "executed"
									: regionBlockedFunctions === functions.length
										? "region-blocked"
										: "partially-region-blocked",
							changed: passChanged,
							...(regionBlockedFunctions === 0 ? {} : { regionBlockedFunctions }),
							...(pass.ablation === undefined ? {} : { ablation: pass.ablation }),
						},
						before,
						after,
					),
				);
			}
		}
		activeFunctions = nextActiveFunctions;
		return roundChanged;
	};
	let traceRound = 0;
	for (let epoch = 0; epoch < maxRounds; epoch++) {
		for (let localRound = 0; localRound < maxRounds; localRound++) {
			const localChanged = runFixpointPasses(CORE_LOCAL_PASSES, traceRound++);
			if (!localChanged) break;
		}
		const programChanged = runFixpointPasses(CORE_PROGRAM_PASSES, traceRound++);
		if (!programChanged) break;
	}
	// Exact fresh-array builtin selection is monotone: every successful pass turns
	// at least one generic call into callBuiltin, and the cleanup group can only
	// delete structure. Re-run the selector only when that deletion exposes a
	// stronger containment proof; the two strict measures make this a fixpoint,
	// not a guessed extra round. This must precede call-target refresh, compaction,
	// and region selection so all three describe the cleaned graph.
	let remainingGenericCalls = genericCoreCallCount(functions);
	for (;;) {
		activeFunctions = new Set(functions.map(({ functionIndex }) => functionIndex));
		const exactBuiltinChanged = runFixpointPasses(
			[rewriteContainedFreshArrayBuiltins],
			traceRound++,
		);
		if (!exactBuiltinChanged) break;
		const callsAfterSelection = genericCoreCallCount(functions);
		if (callsAfterSelection >= remainingGenericCalls) {
			throw new Error(
				"Exact fresh-array builtin selection changed without consuming a generic call",
			);
		}
		remainingGenericCalls = callsAfterSelection;
		for (;;) {
			const beforeCleanup = deletionOnlyCoreMeasure(functions);
			const cleanupChanged = runFixpointPasses(
				CORE_EXACT_BUILTIN_CLEANUP_PASSES,
				traceRound++,
			);
			if (!cleanupChanged) break;
			if (deletionOnlyCoreMeasure(functions) >= beforeCleanup) {
				throw new Error(
					"Exact fresh-array builtin cleanup changed without deleting Core structure",
				);
			}
		}
		workingProgram = { ...workingProgram, functions };
	}
	let postFactCleanupChanged = false;
	const exactHeapPublishedEarly = options.ablations?.has("fact-driven") !== true;
	if (exactHeapPublishedEarly) {
		const heapBefore = tracedMetrics;
		const heapInput = { ...workingProgram, functions };
		const heapSelection = selectCoreExactHeapAccesses(
			heapInput,
			compilationContext,
			(fn) => analyses.controlFlow(fn),
			options.ablations?.has("interprocedural") === true
				? undefined
				: analyses.summaries(heapInput),
			(fn) => analyses.canonicalValues(fn),
		);
		if (heapSelection.changed) {
			workingProgram = heapSelection.program;
			functions = [...heapSelection.program.functions];
			analyses = new CoreAnalysisManager(
				heapSelection.program.stringConstants,
				compilationContext,
			);
			changed = true;
			postFactCleanupChanged = true;
			verifyMutatedProgram(heapSelection.program, {
				stage: "fixpoint",
				pass: "publish-exact-heap-consequences",
				round: traceRound,
			});
		}
		if (heapBefore !== undefined) {
			const heapAfter = coreOptimizationMetrics(heapSelection.program);
			tracedMetrics = heapAfter;
			optimizationTrace.push(
				optimizationPassDelta(
					{
						pass: "publish-exact-heap-consequences",
						stage: "fixpoint",
						round: traceRound++,
						status: "executed",
						changed: heapSelection.changed,
						ablation: "fact-driven",
					},
					heapBefore,
					heapAfter,
				),
			);
		}

		const shapeBefore = tracedMetrics;
		const shapeInput = { ...workingProgram, functions };
		const shapeSummaries = analyses.summaries(shapeInput);
		const shapeProvenance = analyzeCoreShapeProvenance(shapeInput, {
			registry: coreOpcodeRegistry,
			calleeTargets: shapeSummaries.targets,
			summaries: shapeSummaries,
			...(compilationContext === undefined ? {} : { context: compilationContext }),
			controlFlow: (fn) => analyses.controlFlow(fn),
			canonicalValues: (fn) => analyses.canonicalValues(fn),
		});
		const shapeSelection = selectCoreExactShapeOwnSlots(shapeInput, shapeProvenance);
		if (shapeSelection.changed) {
			workingProgram = shapeSelection.program;
			functions = [...shapeSelection.program.functions];
			analyses = new CoreAnalysisManager(
				shapeSelection.program.stringConstants,
				compilationContext,
			);
			changed = true;
			postFactCleanupChanged = true;
			verifyMutatedProgram(shapeSelection.program, {
				stage: "fixpoint",
				pass: "publish-exact-shape-consequences",
				round: traceRound,
			});
		}
		if (shapeBefore !== undefined) {
			const shapeAfter = coreOptimizationMetrics(shapeSelection.program);
			tracedMetrics = shapeAfter;
			optimizationTrace.push(
				optimizationPassDelta(
					{
						pass: "publish-exact-shape-consequences",
						stage: "fixpoint",
						round: traceRound++,
						status: "executed",
						changed: shapeSelection.changed,
						ablation: "fact-driven",
					},
					shapeBefore,
					shapeAfter,
				),
			);
		}

		workingProgram = { ...workingProgram, functions };
	}
	let scalarChanged = false;
	if (options.ablations?.has("interprocedural") !== true) {
		const scalarBefore = tracedMetrics;
		// Consumers strictly discharge representation or summary-metadata debt;
		// materialization strictly raises scalar rank, so neither side needs a round cap.
		for (;;) {
			let consumersChanged = false;
			for (const consumer of [
				refineStackObjectCellRepresentations,
				refineDirectCallResultRepresentations,
				refineValueRepresentations,
			]) {
				const consumerInput = { ...workingProgram, functions };
				const consumerPotential =
					consumer === refineDirectCallResultRepresentations
						? directCallResultConsumerPotential(
								consumerInput,
								analyses.summaries(consumerInput),
							)
						: scalarCoreConsumerPotential(functions);
				activeFunctions = new Set(functions.map(({ functionIndex }) => functionIndex));
				const consumerChanged = runFixpointPasses([consumer], traceRound++);
				const nextConsumerInput = { ...workingProgram, functions };
				const nextConsumerPotential =
					consumer === refineDirectCallResultRepresentations
						? directCallResultConsumerPotential(
								nextConsumerInput,
								analyses.summaries(nextConsumerInput),
							)
						: scalarCoreConsumerPotential(functions);
				if (nextConsumerPotential > consumerPotential) {
					throw new Error(
						`${consumer.name} widened exact scalar proof state (${consumerPotential} -> ${nextConsumerPotential})`,
					);
				}
				if (consumerChanged && nextConsumerPotential === consumerPotential) {
					throw new Error(`${consumer.name} changed without reducing imprecision`);
				}
				consumersChanged ||= consumerChanged;
			}
			workingProgram = { ...workingProgram, functions };
			const scalarInput = workingProgram;
			const publishedScalarRank = scalarCoreRepresentationRank(functions);
			const scalarSelection = materializeCoreExactScalarRepresentations(
				scalarInput,
				compilationContext,
				analyses.summaries(scalarInput),
			);
			for (const [index, fn] of scalarSelection.program.functions.entries()) {
				const before = functions[index];
				if (before !== undefined && before !== fn) {
					analyses.inheritControlFlow(before, fn);
				}
			}
			workingProgram = scalarSelection.program;
			functions = [...scalarSelection.program.functions];
			scalarChanged ||= consumersChanged || scalarSelection.changed;
			const nextPublishedScalarRank = scalarCoreRepresentationRank(functions);
			if (scalarSelection.changed && nextPublishedScalarRank <= publishedScalarRank) {
				throw new Error(
					"Exact scalar materialization changed without publishing a scalar representation",
				);
			}
			if (!consumersChanged && !scalarSelection.changed) break;
		}
		if (scalarChanged) {
			changed = true;
			verifyMutatedProgram(workingProgram, {
				stage: "fixpoint",
				pass: "converge-exact-scalar-consumers",
				round: traceRound,
			});
		}
		if (scalarBefore !== undefined) {
			const scalarAfter = coreOptimizationMetrics(workingProgram);
			tracedMetrics = scalarAfter;
			optimizationTrace.push(
				optimizationPassDelta(
					{
						pass: "converge-exact-scalar-consumers",
						stage: "fixpoint",
						status: "executed",
						changed: scalarChanged,
						ablation: "interprocedural",
					},
					scalarBefore,
					scalarAfter,
				),
			);
		}
	}
	activeFunctions = new Set(functions.map(({ functionIndex }) => functionIndex));
	const factDrivenChanged = runFixpointPasses(CORE_FACT_DRIVEN_PASSES, traceRound++);
	postFactCleanupChanged ||= scalarChanged || factDrivenChanged;
	if (postFactCleanupChanged) {
		activeFunctions = new Set(functions.map(({ functionIndex }) => functionIndex));
		for (let localRound = 0; localRound < maxRounds; localRound++) {
			if (!runFixpointPasses(CORE_LOCAL_PASSES, traceRound++)) break;
		}
		workingProgram = { ...workingProgram, functions };
	}
	// Local passes can expose a stable callee after the normalization-time solve.
	// Solve the final graph once, then share that exact analysis between advisory
	// dispatch annotation and reachability. Compaction only removes unreachable
	// rows, so it can rebase singleton dispatch decisions without a second solve.
	{
		const targetRefreshBefore = tracedMetrics;
		const targetRefreshInput = { ...workingProgram, functions };
		const targetAnalysis = analyzeCoreCalleeTargets(
			targetRefreshInput,
			coreOpcodeRegistry,
			compilationContext,
		);
		const targetRefresh = annotateCoreDirectCallTargets(
			targetRefreshInput,
			compilationContext,
			targetAnalysis,
			true,
		);
		compilationContext = targetRefresh.context;
		for (const [index, fn] of targetRefresh.program.functions.entries()) {
			const before = functions[index];
			if (before !== undefined && before !== fn) analyses.inheritControlFlow(before, fn);
		}
		if (targetRefresh.changed) {
			changed = true;
			verifyMutatedProgram(targetRefresh.program, {
				stage: "fixpoint",
				pass: "refresh-direct-call-targets",
				round: maxRounds,
			});
		}
		workingProgram = targetRefresh.program;
		functions = [...targetRefresh.program.functions];
		if (targetRefreshBefore !== undefined) {
			const targetRefreshAfter = coreOptimizationMetrics(targetRefresh.program);
			tracedMetrics = targetRefreshAfter;
			optimizationTrace.push(
				optimizationPassDelta(
					{
						pass: "refresh-direct-call-targets",
						stage: "fixpoint",
						round: maxRounds,
						status: "executed",
						changed: targetRefresh.changed,
					},
					targetRefreshBefore,
					targetRefreshAfter,
				),
			);
		}

		const beforeCompaction = targetRefresh.program;
		const reachability = analyzeCoreFunctionReachability(
			beforeCompaction,
			targetAnalysis,
			compilationContext,
		);
		const compaction = compactCoreProgramFunctions(
			beforeCompaction,
			reachability,
			compilationContext,
		);
		compilationContext = compaction.context;
		if (compaction.changed) {
			const compactionBefore = tracedMetrics;
			const refreshed = compaction.program;
			verifyCoreProgram(
				refreshed,
				coreOpcodeRegistry,
				{
					stage: "fixpoint",
					pass: "eliminate-unreachable-functions",
					round: maxRounds,
				},
				compilationContext,
			);
			workingProgram = refreshed;
			functions = [...refreshed.functions];
			analyses = new CoreAnalysisManager(refreshed.stringConstants, compilationContext);
			changed = true;
			if (compactionBefore !== undefined) {
				const compactionAfter = coreOptimizationMetrics(refreshed);
				tracedMetrics = compactionAfter;
				optimizationTrace.push(
					optimizationPassDelta(
						{
							pass: "eliminate-unreachable-functions",
							stage: "fixpoint",
							round: maxRounds,
							status: "executed",
							changed: true,
						},
						compactionBefore,
						compactionAfter,
					),
				);
			}
		}
	}
	// A later pass in the last allowed round can change a callee value or make a
	// transitive summary more precise after the round's summary pass has run. Give
	// summary-owned facts one final refresh before region selection freezes exact
	// instruction snapshots. This is proof maintenance only: the normal in-round
	// invocation is the one whose refinements feed the memory optimizers.
	if (options.ablations?.has("interprocedural") !== true) {
		const refreshBefore = tracedMetrics;
		const refreshProgram = { ...workingProgram, functions };
		let refreshChanged = false;
		functions = functions.map((fn) => {
			const candidate = acceptPassResult(
				fn,
				refineDirectCallEffects.run(fn, analyses, refreshProgram),
				verification,
				{
					stage: "fixpoint",
					pass: "refresh-direct-call-effects",
					round: maxRounds,
					functionIndex: fn.functionIndex,
				},
			);
			const functionChanged = candidate !== fn;
			if (functionChanged) analyses.inheritControlFlow(fn, candidate);
			if (functionChanged) refreshChanged = true;
			return candidate;
		});
		if (refreshChanged) {
			changed = true;
			verifyMutatedProgram(
				{ ...workingProgram, functions },
				{
					stage: "fixpoint",
					pass: "refresh-direct-call-effects",
					round: maxRounds,
				},
			);
		}
		if (refreshBefore !== undefined) {
			const refreshAfter = coreOptimizationMetrics({
				...workingProgram,
				functions,
			});
			tracedMetrics = refreshAfter;
			optimizationTrace.push(
				optimizationPassDelta(
					{
						pass: "refresh-direct-call-effects",
						stage: "fixpoint",
						round: maxRounds,
						status: "executed",
						changed: refreshChanged,
						ablation: "interprocedural",
					},
					refreshBefore,
					refreshAfter,
				),
			);
		}

		const representationBefore = tracedMetrics;
		const representationProgram = { ...workingProgram, functions };
		// The refresh rewrites only summary-owned call metadata. That metadata is not
		// an input to the summary solver, so the result-representation consumer can
		// reuse the exact solve that licensed the refresh.
		analyses.inheritSummaries(refreshProgram, representationProgram);
		let representationChanged = false;
		functions = functions.map((fn) => {
			const candidate = acceptPassResult(
				fn,
				refineDirectCallResultRepresentations.run(fn, analyses, representationProgram),
				verification,
				{
					stage: "fixpoint",
					pass: refineDirectCallResultRepresentations.name,
					round: maxRounds,
					functionIndex: fn.functionIndex,
				},
			);
			const functionChanged = candidate !== fn;
			if (functionChanged) analyses.inheritControlFlow(fn, candidate);
			if (functionChanged) representationChanged = true;
			return candidate;
		});
		if (representationChanged) {
			changed = true;
			verifyMutatedProgram(
				{ ...workingProgram, functions },
				{
					stage: "fixpoint",
					pass: refineDirectCallResultRepresentations.name,
					round: maxRounds,
				},
			);
		}
		if (representationBefore !== undefined) {
			const representationAfter = coreOptimizationMetrics({
				...workingProgram,
				functions,
			});
			tracedMetrics = representationAfter;
			optimizationTrace.push(
				optimizationPassDelta(
					{
						pass: refineDirectCallResultRepresentations.name,
						stage: "fixpoint",
						round: maxRounds,
						status: "executed",
						changed: representationChanged,
						ablation: "interprocedural",
					},
					representationBefore,
					representationAfter,
				),
			);
		}
	}
	const earlyShapeRetractionBefore = tracedMetrics;
	const earlyShapeRetraction = retractCoreKnownOwnSlots({ ...workingProgram, functions });
	if (earlyShapeRetraction.changed) {
		workingProgram = earlyShapeRetraction.program;
		functions = [...earlyShapeRetraction.program.functions];
		analyses = new CoreAnalysisManager(
			earlyShapeRetraction.program.stringConstants,
			compilationContext,
		);
		changed = true;
		verifyMutatedProgram(earlyShapeRetraction.program, {
			stage: "finalization",
			pass: "retract-early-shape-consequences",
		});
	}
	if (earlyShapeRetractionBefore !== undefined) {
		const earlyShapeRetractionAfter = coreOptimizationMetrics(
			earlyShapeRetraction.program,
		);
		tracedMetrics = earlyShapeRetractionAfter;
		optimizationTrace.push(
			optimizationPassDelta(
				{
					pass: "retract-early-shape-consequences",
					stage: "finalization",
					status: "executed",
					changed: earlyShapeRetraction.changed,
					ablation: "fact-driven",
				},
				earlyShapeRetractionBefore,
				earlyShapeRetractionAfter,
			),
		);
	}
	for (const pass of CORE_FINALIZATION_PASSES) {
		const beforeProgram = { ...workingProgram, functions };
		const before = tracedMetrics;
		const ablated =
			pass.ablation !== undefined && options.ablations?.has(pass.ablation) === true;
		let passChanged = false;
		if (!ablated) {
			functions = functions.map((fn) => {
				const candidate = acceptPassResult(
					fn,
					pass.run(fn, analyses, beforeProgram),
					verification,
					{
						stage: "finalization",
						pass: pass.name,
						functionIndex: fn.functionIndex,
					},
				);
				const functionChanged = candidate !== fn;
				if (functionChanged) analyses.inheritControlFlow(fn, candidate);
				if (functionChanged) {
					passChanged = true;
					changed = true;
				}
				return candidate;
			});
			if (passChanged) {
				verifyMutatedProgram(
					{ ...workingProgram, functions },
					{ stage: "finalization", pass: pass.name },
				);
			}
		}
		if (before !== undefined) {
			const after = coreOptimizationMetrics({ ...workingProgram, functions });
			tracedMetrics = after;
			optimizationTrace.push(
				optimizationPassDelta(
					{
						pass: pass.name,
						stage: "finalization",
						status: ablated ? "ablated" : "executed",
						changed: passChanged,
						...(pass.ablation === undefined ? {} : { ablation: pass.ablation }),
					},
					before,
					after,
				),
			);
		}
	}
	// Value classes are whole-program ownership facts: an exact allocation may be
	// stored in a compiler-certified cell and consumed by a different closure. Run
	// this after local finalization so it sees the graph the target will consume,
	// and publish only exact brands whose complete use graph remains closed.
	const valueClassBefore = tracedMetrics;
	const valueClassInput = { ...workingProgram, functions };
	const valueClassSummaries =
		options.ablations?.has("interprocedural") === true
			? undefined
			: analyses.summaries(valueClassInput);
	const valueClassSelection = exactHeapPublishedEarly
		? { program: valueClassInput, changed: false }
		: selectCoreExactHeapAccesses(
				valueClassInput,
				compilationContext,
				(fn) => analyses.controlFlow(fn),
				valueClassSummaries,
				(fn) => analyses.canonicalValues(fn),
			);
	for (const [index, fn] of valueClassSelection.program.functions.entries()) {
		const before = functions[index];
		if (before !== undefined && before !== fn) analyses.inheritControlFlow(before, fn);
	}
	if (valueClassSelection.changed) {
		changed = true;
		verifyMutatedProgram(valueClassSelection.program, {
			stage: "finalization",
			pass: "select-exact-heap-accesses",
		});
	}
	workingProgram = valueClassSelection.program;
	functions = [...valueClassSelection.program.functions];
	if (valueClassBefore !== undefined) {
		const valueClassAfter = coreOptimizationMetrics(valueClassSelection.program);
		tracedMetrics = valueClassAfter;
		optimizationTrace.push(
			optimizationPassDelta(
				{
					pass: "select-exact-heap-accesses",
					stage: "finalization",
					status: "executed",
					changed: valueClassSelection.changed,
				},
				valueClassBefore,
				valueClassAfter,
			),
		);
	}
	const scalarArgumentBefore = tracedMetrics;
	const scalarArgumentInput = { ...workingProgram, functions };
	const scalarArgumentSummaries =
		options.ablations?.has("interprocedural") === true
			? undefined
			: analyses.summaries(scalarArgumentInput);
	const scalarArgumentSelection = selectCoreExactValueFacts(
		scalarArgumentInput,
		compilationContext,
		scalarArgumentSummaries,
	);
	analyses.inheritSummaries(scalarArgumentInput, scalarArgumentSelection.program);
	for (const [index, fn] of scalarArgumentSelection.program.functions.entries()) {
		const before = functions[index];
		if (before !== undefined && before !== fn) analyses.inheritControlFlow(before, fn);
	}
	if (scalarArgumentSelection.changed) {
		changed = true;
		verifyMutatedProgram(scalarArgumentSelection.program, {
			stage: "finalization",
			pass: "select-exact-value-facts",
		});
	}
	workingProgram = scalarArgumentSelection.program;
	functions = [...scalarArgumentSelection.program.functions];
	if (scalarArgumentBefore !== undefined) {
		const scalarArgumentAfter = coreOptimizationMetrics(scalarArgumentSelection.program);
		tracedMetrics = scalarArgumentAfter;
		optimizationTrace.push(
			optimizationPassDelta(
				{
					pass: "select-exact-value-facts",
					stage: "finalization",
					status: "executed",
					changed: scalarArgumentSelection.changed,
					ablation: "interprocedural",
				},
				scalarArgumentBefore,
				scalarArgumentAfter,
			),
		);
	}
	// Publish summaries before the final shape hint. Shape provenance consumes the
	// same closed entry/call topology and scans the already-compacted graph, so it
	// neither re-solves callee targets nor carries pre-compaction coordinates.
	// The hint is summary-transparent, which keeps the selector the absolute last
	// mutating phase without forcing another whole-program analysis.
	const summaryProgram = { ...workingProgram, functions };
	const summaries =
		options.ablations?.has("interprocedural") === true
			? undefined
			: analyses.summaries(summaryProgram);
	const shapeProvenance = analyzeCoreShapeProvenance(summaryProgram, {
		registry: coreOpcodeRegistry,
		...(summaries === undefined ? {} : { calleeTargets: summaries.targets, summaries }),
		...(compilationContext === undefined ? {} : { context: compilationContext }),
		controlFlow: (fn) => analyses.controlFlow(fn),
		canonicalValues: (fn) => analyses.canonicalValues(fn),
	});
	const shapeSelectionBefore = tracedMetrics;
	const shapeSelection = selectCoreKnownOwnSlots(summaryProgram, shapeProvenance);
	if (shapeSelection.changed) {
		changed = true;
		verifyMutatedProgram(shapeSelection.program, {
			stage: "finalization",
			pass: "select-known-own-slots",
		});
	}
	workingProgram = shapeSelection.program;
	functions = [...shapeSelection.program.functions];
	if (shapeSelectionBefore !== undefined) {
		const shapeSelectionAfter = coreOptimizationMetrics(shapeSelection.program);
		tracedMetrics = shapeSelectionAfter;
		optimizationTrace.push(
			optimizationPassDelta(
				{
					pass: "select-known-own-slots",
					stage: "finalization",
					status: "executed",
					changed: shapeSelection.changed,
				},
				shapeSelectionBefore,
				shapeSelectionAfter,
			),
		);
	}
	// Published on the final graph, so a recorded summary describes the program the
	// backend consumes rather than an intermediate round. These maps stay in
	// process: function indices are compilation-local, so nothing derived from them
	// may be serialized or carried into another compilation.
	const optimized: CoreProgram = {
		...workingProgram,
		functions,
	};
	const optimizedContext =
		compilationContext === undefined
			? undefined
			: {
					...compilationContext,
					...(collectOptimizationTrace ? { optimizationTrace } : {}),
					...(summaries === undefined
						? {}
						: {
								facts: {
									...compilationContext.facts,
									functionEffects: coreFunctionEffectSummaries(summaries),
									moduleEffects: coreModuleEffectSummaries(summaries),
								},
							}),
				};
	// Owned boundary: region selection is final, so every certificate this program
	// carries must still describe the graph the backend will consume.
	verifyCoreProgram(
		optimized,
		coreOpcodeRegistry,
		{ stage: "final-region-selection" },
		optimizedContext,
		summaries === undefined ? undefined : { summaries },
	);
	return {
		program: optimized,
		...(optimizedContext === undefined ? {} : { context: optimizedContext }),
		...(summaries === undefined ? {} : { targetAnalyses: { summaries } }),
		changed,
	};
}
