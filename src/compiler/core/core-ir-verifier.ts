import {
	compilerValueKindMaskIsSubset,
	compilerValueKindMaskIsValid,
} from "../shared/compiler-value-kinds.ts";
import { effectSummariesEqual, effectSummaryCovers } from "../shared/effect-summary.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { CORE_FINITE_DISPATCH_TARGET_ATTRIBUTE } from "./core-ir-call-targets.ts";
import { buildCoreControlFlow, coreTerminatorEdges } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import {
	CORE_FACT_ALTERNATIVE_LIMIT,
	CORE_FACT_CLAIM_LIMIT,
	coreFactClaimIsSatisfiable,
} from "./core-ir-fact-implication.ts";
import {
	coreMemoryAccesses,
	coreMemoryLocationFamily,
	coreMemoryLocationIsExact,
} from "./core-ir-memory.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import {
	CORE_CONTAINED_AGGREGATE_OWN_SLOT_FACT,
	CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE,
	CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE,
	CORE_OWN_DATA_CELL_FACT,
	coreContainedAggregateProvenance,
	coreOwnCellResolver,
	coreOwnCellsEqual,
	coreProvenance,
} from "./core-ir-provenance.ts";
import {
	coreRegionAdmission,
	coreRegionAdmissionQuery,
	coreRegionInteriorKeepsAdmission,
	coreRegionLicense,
	coreRegionLicenseEpochFamilies,
	coreRegionValidityModel,
} from "./core-ir-region-validity.ts";
import type { CoreRegionValidityModel } from "./core-ir-region-validity.ts";
import {
	analyzeCoreShapeProvenance,
	CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE,
	CORE_EXACT_SHAPE_OWN_SLOT_EFFECT_FACT,
	CORE_KNOWN_OWN_SLOT_ATTRIBUTE,
	CORE_SHAPE_CASE_CANDIDATES_ATTRIBUTE,
	CORE_SHAPE_CASE_MAX_LOADS,
	CORE_SHAPE_CASE_MAX_SPAN,
	CORE_SHAPE_CASE_MIN_LOADS,
	CORE_SHAPE_CASE_SLOTS_ATTRIBUTE,
	coreExactShapeOwnSlotFromAttribute,
	coreExactShapeOwnSlotDigest,
	coreExactShapeOwnSlotEffects,
	coreKnownOwnSlotFromAttribute,
	coreShapeCaseCandidatesFromAttribute,
	coreShapeCaseSlotsFromAttribute,
	coreShapeOriginKeys,
} from "./core-ir-shape-provenance.ts";
import {
	CORE_CALL_EFFECT_SUMMARY_FACT,
	CORE_CALL_SUMMARY_ATTRIBUTE,
	analyzeCoreProgramSummaries,
	coreCallResultRepresentation,
	coreCallSummaryClaimFromAttribute,
	coreCallSummaryClaimFromFactValue,
	coreCallSummaryClaimHolds,
	coreCallSummaryDigest,
	coreCallValueSummaryDigest,
	deriveCoreCallEffectRefinement,
} from "./core-ir-summaries.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import {
	analyzeCoreValueClasses,
	CORE_EXACT_COLLECTION_BUILTIN_EFFECT_FACT,
	CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE,
	CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE,
	coreCollectionReceiverBrandForOperation,
	coreExactCollectionBrand,
	coreExactCollectionBuiltinEffects,
	coreNumericTypedArrayKind,
} from "./core-ir-value-classes.ts";
import type { CoreValueClassAnalysis } from "./core-ir-value-classes.ts";
import {
	analyzeCoreValueKinds,
	CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE,
	CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE,
	CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE,
	CORE_PRIMITIVE_OPERATOR_EFFECT_FACT,
	coreBinaryInputKindMasksHaveExactNativeSemantics,
	coreExactBinaryInputKindMasks,
	coreExactCallArgumentRepresentations,
	corePrimitiveOperatorEffectRefinement,
} from "./core-ir-value-kinds.ts";
import type { CoreValueKindAnalysis } from "./core-ir-value-kinds.ts";
import type {
	CoreBlock,
	CoreBlockId,
	CoreEdge,
	CoreEffectDomain,
	CoreFact,
	CoreFunction,
	CoreInstruction,
	CoreInstructionEffects,
	CoreInstructionId,
	CoreOpcodeRegistry,
	CoreProgram,
	CoreRegion,
	CoreTerminator,
	CoreValue,
	CoreValueId,
} from "./core-ir.ts";

/**
 * Verification stages, in pipeline order. Every stage is a proof boundary: the
 * program entering it is already verified, so a failure names the transform that
 * produced the broken graph rather than the place that later noticed it.
 */
export type CoreVerificationStage =
	| "construction"
	| "pre-optimization"
	| "normalization"
	| "fixpoint"
	| "finalization"
	| "final-region-selection"
	| "pre-target";

export interface CoreVerificationContext {
	readonly stage: CoreVerificationStage;
	readonly pass?: string;
	readonly round?: number;
	readonly functionIndex?: number;
}

/**
 * `boundary` verifies only the optimizer's input and output. `per-pass` adds a
 * whole-program verification after every mutating pass, which is what makes an
 * invalid graph attributable to the pass that produced it.
 */
export type CoreVerificationProfile = "boundary" | "per-pass";

function formatVerificationContext(context: CoreVerificationContext | undefined): string {
	if (context === undefined) return "";
	const parts = [`stage=${context.stage}`];
	if (context.pass !== undefined) parts.push(`pass=${context.pass}`);
	if (context.round !== undefined) parts.push(`round=${context.round}`);
	if (context.functionIndex !== undefined)
		parts.push(`function=${context.functionIndex}`);
	return ` [${parts.join(" ")}]`;
}

export class CoreIrVerificationError extends Error {
	/** Invariant text without the stage prefix, so contexts nest without repeating. */
	readonly detail: string;
	readonly context: CoreVerificationContext | undefined;

	constructor(detail: string, context?: CoreVerificationContext) {
		super(`Core IR verification failed${formatVerificationContext(context)}: ${detail}`);
		this.name = "CoreIrVerificationError";
		this.detail = detail;
		this.context = context;
	}
}

function fail(message: string): never {
	throw new CoreIrVerificationError(message);
}

function withVerificationContext<T>(
	context: CoreVerificationContext | undefined,
	run: () => T,
): T {
	if (context === undefined) return run();
	try {
		return run();
	} catch (error) {
		if (error instanceof CoreIrVerificationError && error.context === undefined) {
			throw new CoreIrVerificationError(error.detail, context);
		}
		throw error;
	}
}

function checkArity(kind: string, count: number, minimum: number, maximum: number): void {
	if (count < minimum || count > maximum) {
		fail(`${kind} has ${count} operands, expected ${minimum}..${maximum}`);
	}
}

function isSubset<T>(candidate: ReadonlyArray<T>, baseline: ReadonlyArray<T>): boolean {
	const allowed = new Set(baseline);
	return candidate.every((value) => allowed.has(value));
}

function verifyEffectRefinement(
	instructionId: CoreInstructionId,
	refined: CoreInstructionEffects,
	baseline: CoreInstructionEffects,
): void {
	if (!isSubset<CoreEffectDomain>(refined.reads, baseline.reads)) {
		fail(`instruction @${instructionId} adds read effects in a refinement`);
	}
	if (!isSubset<CoreEffectDomain>(refined.writes, baseline.writes)) {
		fail(`instruction @${instructionId} adds write effects in a refinement`);
	}
	for (const flag of ["mayThrow", "maySuspend", "mayGc", "callsUserCode"] as const) {
		if (refined[flag] && !baseline[flag]) {
			fail(`instruction @${instructionId} adds ${flag} in a refinement`);
		}
	}
}

function terminatorUses(terminator: CoreTerminator): ReadonlyArray<CoreValueId> {
	switch (terminator.kind) {
		case "jump":
			return terminator.edge.arguments;
		case "branch":
			return [
				terminator.condition,
				...terminator.consequent.arguments,
				...terminator.alternate.arguments,
			];
		case "guard":
			return [
				terminator.condition,
				...terminator.success.arguments,
				...terminator.fallback.arguments,
			];
		case "switch":
			return [
				terminator.discriminant,
				...terminator.cases.flatMap(({ edge }) => edge.arguments),
				...terminator.default.arguments,
			];
		case "return":
		case "throw":
			return [terminator.value];
		case "unreachable":
			return [];
	}
}

/** Input position of a `call` callee; a deferred property producer feeds only this. */
const CORE_CALLEE_POSITION = 0;

/** Control-flow uses carry no input position and must never satisfy a placement. */
const CORE_CONTROL_FLOW_POSITION = -1;

interface GuardLocation {
	readonly instruction: CoreInstructionId;
	readonly fact: CoreFact["id"];
	readonly block: CoreBlockId;
	readonly success: CoreBlockId;
}

function verifyEdge(
	edge: CoreEdge,
	from: CoreBlock,
	blocks: ReadonlyArray<CoreBlock>,
): void {
	const target = blocks[edge.block];
	if (target === undefined)
		fail(`block b${from.id} targets unknown block b${edge.block}`);
	if (target.parameters[0]?.role === "exception") {
		fail(`ordinary edge b${from.id} -> b${edge.block} targets an exception entry`);
	}
	if (edge.arguments.length !== target.parameters.length) {
		fail(
			`edge b${from.id} -> b${edge.block} passes ${edge.arguments.length} values to ${target.parameters.length} parameters`,
		);
	}
}

function requireDenseIds<T extends { readonly id: number }>(
	values: ReadonlyArray<T>,
	kind: string,
): void {
	for (let index = 0; index < values.length; index++) {
		if (values[index]?.id !== index) {
			fail(
				`${kind} ids must be dense and ordered; index ${index} has id ${values[index]?.id}`,
			);
		}
	}
}

function requireStableIds<T extends { readonly id: number }>(
	values: ReadonlyArray<T>,
	kind: string,
): void {
	let previous = -1;
	for (const value of values) {
		if (!Number.isSafeInteger(value.id) || value.id < 0)
			fail(`invalid ${kind} id ${value.id}`);
		if (value.id <= previous)
			fail(`${kind} ids must stay in monotonically allocated order`);
		previous = value.id;
	}
}

function verifyAttributeValue(
	value: unknown,
	path: string,
	ancestors: Set<object> = new Set(),
): void {
	if (
		value === undefined ||
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string"
	) {
		return;
	}
	if (typeof value !== "object") fail(`${path} has unsupported attribute data`);
	const objectValue = value;
	if (ancestors.has(objectValue)) fail(`${path} contains cyclic attribute data`);
	ancestors.add(objectValue);
	if (Array.isArray(value)) {
		const arrayValue: ReadonlyArray<unknown> = value;
		for (const [index, entry] of arrayValue.entries()) {
			verifyAttributeValue(entry, `${path}[${index}]`, ancestors);
		}
		ancestors.delete(objectValue);
		return;
	}
	const prototype = Object.getPrototypeOf(value) as unknown;
	if (prototype !== Object.prototype && prototype !== null) {
		fail(`${path} has a non-data attribute object`);
	}
	for (const [key, entry] of Object.entries(value as Readonly<Record<string, unknown>>)) {
		verifyAttributeValue(entry, `${path}.${key}`, ancestors);
	}
	ancestors.delete(objectValue);
}

/**
 * Verify a region's `propertyPlacement` decision. Placement is semantic Core
 * metadata: it tells a backend whether the region's ordinary property producer may
 * be skipped on the fast path and re-run only where the region declines. A
 * placement-carrying certificate names the consuming call as its first anchor, so
 * the proof obligations checkable from the graph alone are that the producer is
 * claimed, defined in the anchor's block, and observed by nothing but the anchor's
 * callee operand. The pinned-method-table half of the license is kind-specific and
 * stays with the selecting pass and the target boundary.
 */
function verifyRegionPropertyPlacement(
	region: CoreRegion,
	instructionBlocks: ReadonlyArray<CoreBlockId | undefined>,
	instructionOutputs: ReadonlyArray<ReadonlyArray<CoreValueId> | undefined>,
	valueUses: ReadonlyArray<
		| ReadonlyArray<{
				readonly instruction: CoreInstructionId;
				readonly position: number;
		  }>
		| undefined
	>,
): void {
	const data = region.data as Readonly<Record<string, unknown>>;
	const placement = data.propertyPlacement;
	if (placement === undefined) return;
	if (placement !== "in-place" && placement !== "call-fallback") {
		const description = typeof placement === "string" ? placement : typeof placement;
		fail(`region ${region.kind} has invalid property placement ${description}`);
	}
	if (placement === "in-place") return;
	const reference = data.property as
		| Readonly<{ readonly $coreInstruction?: unknown }>
		| undefined;
	const named = reference?.$coreInstruction;
	if (typeof named !== "number") {
		fail(`region ${region.kind} defers a property producer it does not name`);
	}
	const property = named as CoreInstructionId;
	const call = region.anchors[0]!;
	if (instructionBlocks[property] !== instructionBlocks[call]) {
		fail(
			`region ${region.kind} defers @${property} across the block of its call @${call}`,
		);
	}
	const outputs = instructionOutputs[property] ?? [];
	if (outputs.length !== 1) {
		fail(`region ${region.kind} defers @${property}, which is not a single producer`);
	}
	const uses = valueUses[outputs[0]!] ?? [];
	if (
		uses.length !== 1 ||
		uses[0]?.instruction !== call ||
		uses[0]?.position !== CORE_CALLEE_POSITION
	) {
		fail(
			`region ${region.kind} defers @${property}, which is not consumed only as the callee of @${call}`,
		);
	}
}

/**
 * Epoch families no native backend can lower a region license for. Rejecting them
 * here makes an unlowerable selection a Core verification failure at the boundary
 * that produced it, rather than a throw at C emission.
 */
const UNLICENSABLE_EPOCH_FAMILIES: ReadonlySet<string> = new Set([
	"global-bindings",
	"object-shapes",
]);

/**
 * Verify the part of a region license every layer downstream depends on: that the
 * license is readable, keeps its generic twin, names a lowerable set of epoch
 * families, and carries an admission record whose `once` claim the graph actually
 * supports.
 *
 * The `once` proof is recomputed here rather than trusted, following the
 * own-data-cell precedent: a transform that lets an opaque instruction into a
 * licensed interior fails at this boundary instead of silently keeping a stale
 * proof. `per-use` needs no interior proof — re-testing at each use is always
 * sound — so only the claim that removes work carries an obligation.
 */
function verifyRegionLicense(
	fn: CoreFunction,
	cfg: CoreControlFlow,
	model: CoreRegionValidityModel,
	region: CoreRegion,
): void {
	const license = coreRegionLicense(region);
	if (license === undefined) {
		fail(`region ${region.kind} has no readable license`);
		return;
	}
	if (license.genericTwin !== "retained") {
		fail(`region ${region.kind} does not retain its generic twin`);
	}
	if (
		license.materialization !== "none" &&
		license.materialization !== "on-demand" &&
		license.materialization !== "whole-region"
	) {
		fail(`region ${region.kind} has an invalid materialization plan`);
	}
	const families = coreRegionLicenseEpochFamilies(region);
	if (families === undefined) {
		fail(`region ${region.kind} has an unreadable license guard`);
		return;
	}
	for (const family of families) {
		if (UNLICENSABLE_EPOCH_FAMILIES.has(family)) {
			fail(`region ${region.kind} depends on unlowerable epoch family ${family}`);
		}
	}
	const admission = coreRegionAdmission(region);
	if (admission === undefined) {
		fail(`region ${region.kind} has no readable license admission`);
		return;
	}
	if (!region.claimedInstructions.includes(admission.anchor)) {
		fail(`region ${region.kind} admits at unclaimed instruction @${admission.anchor}`);
	}
	if (
		admission.validity === "once" &&
		families.size > 0 &&
		!coreRegionInteriorKeepsAdmission(
			fn,
			cfg,
			model,
			coreRegionAdmissionQuery(region, admission.anchor),
		)
	) {
		fail(
			`region ${region.kind} claims one admission at @${admission.anchor} without an epoch-stable interior`,
		);
	}
}

function verifyRegionReferences(
	value: unknown,
	path: string,
	instructions: ReadonlySet<CoreInstructionId>,
	claimedInstructions: ReadonlySet<CoreInstructionId>,
	blocks: ReadonlyArray<CoreBlock>,
): void {
	if (value === null || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) {
			verifyRegionReferences(
				entry,
				`${path}[${index}]`,
				instructions,
				claimedInstructions,
				blocks,
			);
		}
		return;
	}
	const object = value as Readonly<Record<string, unknown>>;
	if (Object.keys(object).length === 1 && typeof object.$coreInstruction === "number") {
		if (!instructions.has(object.$coreInstruction as CoreInstructionId)) {
			fail(`${path} references unknown instruction @${object.$coreInstruction}`);
		}
		if (!claimedInstructions.has(object.$coreInstruction as CoreInstructionId)) {
			fail(
				`${path} references instruction @${object.$coreInstruction} that is not claimed`,
			);
		}
		return;
	}
	if (Object.keys(object).length === 1 && typeof object.$coreBlock === "number") {
		if (blocks[object.$coreBlock as CoreBlockId] === undefined) {
			fail(`${path} references unknown block b${object.$coreBlock}`);
		}
		return;
	}
	for (const [key, entry] of Object.entries(object)) {
		verifyRegionReferences(
			entry,
			`${path}.${key}`,
			instructions,
			claimedInstructions,
			blocks,
		);
	}
}

/**
 * A property access may only claim it runs no user code while its base still
 * must-aliases a contained allocation and its key is one of that allocation's own
 * writable data slots. That is the whole content of the claim: lose containment
 * and the same access could reach an accessor, a Proxy trap, or a prototype.
 *
 * Checking it here rather than trusting the pass that made the claim means a later
 * transform that lets the reference escape fails at the boundary that produced the
 * graph instead of miscompiling.
 *
 * Only refinements whose proof is an own-data-cell fact are re-proved. A guard or
 * epoch fact establishes the same narrowing from a different premise, and holding
 * it to a containment it never claimed would reject a sound graph. Selecting the
 * work by proof kind is what makes this check skippable, so no transform may move
 * a refinement off such a proof: see `CORE_REPROVED_FACT_KINDS`.
 */
function verifyOwnDataCellRefinements(
	fn: CoreFunction,
	cfg: ReturnType<typeof buildCoreControlFlow>,
	facts: ReadonlyArray<CoreFact | undefined>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): void {
	const refined = fn.blocks.flatMap(({ instructions }) =>
		instructions.filter((instruction) => {
			const refinement = instruction.effectRefinement;
			return (
				refinement !== undefined &&
				facts[refinement.proof]?.kind === CORE_OWN_DATA_CELL_FACT
			);
		}),
	);
	if (refined.length === 0) return;
	const provenance = coreProvenance(fn, cfg, stringConstants);
	const resolution = {
		ownCell: (
			base: CoreValueId,
			key: Parameters<typeof provenance.ownCell>[1],
			mode: Parameters<typeof provenance.ownCell>[2],
		) => {
			const resolved = provenance.ownCell(base, key, mode);
			return resolved === undefined
				? undefined
				: { allocation: resolved.layout.instruction, cell: resolved.cell };
		},
	};
	for (const instruction of refined) {
		const fact = facts[instruction.effectRefinement!.proof]!;
		const factValue =
			typeof fact.value === "object" && fact.value !== null
				? (fact.value as Record<string, unknown>)
				: undefined;
		const factCell =
			typeof factValue?.cell === "object" && factValue.cell !== null
				? (factValue.cell as Record<string, unknown>)
				: undefined;
		const accesses = coreMemoryAccesses(instruction, resolution).filter((access) =>
			["object-slot", "element", "shape", "prototype"].includes(
				coreMemoryLocationFamily(access.location),
			),
		);
		let proven:
			| {
					readonly allocation: CoreInstructionId;
					readonly cell:
						| { readonly kind: "object-slot"; readonly key: number }
						| { readonly kind: "element"; readonly index: number };
			  }
			| undefined;
		let exactCells = 0;
		for (const access of accesses) {
			if (access.base === undefined || access.key === undefined) {
				fail(
					`instruction @${instruction.id} carries an own-data-cell proof without a key`,
				);
			}
			const cell = provenance.ownCell(access.base, access.key, access.mode);
			if (cell === undefined) {
				fail(
					`instruction @${instruction.id} carries an own-data-cell proof without a contained own data cell`,
				);
			}
			const current = { allocation: cell.layout.instruction, cell: cell.cell };
			if (
				proven !== undefined &&
				(proven.allocation !== current.allocation ||
					!coreOwnCellsEqual(proven.cell, current.cell))
			) {
				fail(`instruction @${instruction.id} carries an own-data-cell proof for aliases`);
			}
			proven = current;
			if (coreMemoryLocationIsExact(access.location)) exactCells += 1;
		}
		const cellMatchesFact =
			proven?.cell.kind === "element"
				? factCell?.kind === "element" && factCell.index === proven.cell.index
				: proven?.cell.kind === "object-slot"
					? factCell?.kind === "object-slot" && factCell.key === proven.cell.key
					: false;
		if (
			proven === undefined ||
			exactCells !== 1 ||
			factValue?.allocation !== proven.allocation ||
			!cellMatchesFact
		) {
			fail(`instruction @${instruction.id} carries an invalid own-data-cell proof`);
		}
	}
}

/** Reconstruct transitive private-aggregate ownership before accepting a direct
 * physical slot. Unlike an advisory shape guard, an incorrect slot has no safe
 * fallback, so neither the fact payload nor the pass that produced it is trusted. */
function verifyContainedAggregateOwnSlotRefinements(
	fn: CoreFunction,
	cfg: ReturnType<typeof buildCoreControlFlow>,
	facts: ReadonlyArray<CoreFact | undefined>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): void {
	const refined = fn.blocks.flatMap(({ instructions }) =>
		instructions.filter((instruction) => {
			const refinement = instruction.effectRefinement;
			return (
				refinement !== undefined &&
				facts[refinement.proof]?.kind === CORE_CONTAINED_AGGREGATE_OWN_SLOT_FACT
			);
		}),
	);
	if (refined.length === 0) return;
	const analysis = coreContainedAggregateProvenance(fn, cfg, stringConstants);
	for (const instruction of refined) {
		const fact = facts[instruction.effectRefinement!.proof]!;
		const value =
			typeof fact.value === "object" && fact.value !== null
				? (fact.value as Record<string, unknown>)
				: undefined;
		const rawOrigins = Array.isArray(value?.origins) ? value.origins : undefined;
		const origins = rawOrigins?.map((entry) => {
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
				return undefined;
			}
			const reference = entry as Record<string, unknown>;
			return typeof reference.$coreInstruction === "number"
				? reference.$coreInstruction
				: undefined;
		});
		const proven = analysis.ownSlot(instruction);
		if (
			proven === undefined ||
			value?.slot !== proven.slot ||
			origins === undefined ||
			origins.some((origin) => origin === undefined) ||
			origins.length !== proven.origins.length ||
			origins.some((origin, index) => origin !== proven.origins[index])
		) {
			fail(
				`instruction @${instruction.id} carries an invalid contained-aggregate own-slot proof`,
			);
		}
	}
}

/** Throws CoreIrVerificationError when any canonical middle-end invariant is broken. */
export function verifyCoreFunction(
	fn: CoreFunction,
	registry: CoreOpcodeRegistry,
	context?: CoreVerificationContext,
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
): void {
	withVerificationContext(
		context === undefined ? undefined : { ...context, functionIndex: fn.functionIndex },
		() => verifyCoreFunctionGraph(fn, registry, stringConstants),
	);
}

function verifyCoreFunctionGraph(
	fn: CoreFunction,
	registry: CoreOpcodeRegistry,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): void {
	if (!Number.isSafeInteger(fn.functionIndex) || fn.functionIndex < 0) {
		fail(`invalid function index ${fn.functionIndex}`);
	}
	if (fn.metadata.sourcePath.length === 0) fail("function source path is empty");
	for (const [name, value] of [
		["name string index", fn.metadata.nameStringIndex],
		["length", fn.metadata.length],
		["captured count", fn.metadata.capturedCount],
	] as const) {
		if (!Number.isSafeInteger(value) || value < 0) fail(`invalid ${name} ${value}`);
	}
	if (!fn.metadata.mappedArguments && fn.metadata.mappedArgumentSlots.length !== 0) {
		fail("unmapped function carries mapped argument slots");
	}
	if (fn.metadata.mappedArgumentSlots.length > fn.parameters.length) {
		fail("mapped argument slots exceed parameter count");
	}
	for (const slot of fn.metadata.mappedArgumentSlots) {
		if (!Number.isSafeInteger(slot) || slot < -1 || slot >= fn.metadata.capturedCount) {
			fail(`invalid mapped argument slot ${slot}`);
		}
	}
	if (fn.metadata.isDerivedConstructor && !fn.metadata.isClassConstructor) {
		fail("derived constructor metadata is missing the class-constructor flag");
	}
	requireDenseIds(fn.blocks, "block");
	requireStableIds(fn.values, "value");
	requireStableIds(fn.facts, "fact");
	const blocks = fn.blocks;
	if (blocks[fn.entry] === undefined) fail(`unknown entry block b${fn.entry}`);
	if (fn.bodyEntry !== undefined && blocks[fn.bodyEntry] === undefined) {
		fail(`unknown body entry block b${fn.bodyEntry}`);
	}
	const entryBlock = blocks[fn.entry]!;
	if (entryBlock.parameters.length !== fn.parameters.length) {
		fail(
			`entry block has ${entryBlock.parameters.length} parameters for a ${fn.parameters.length}-parameter ABI`,
		);
	}
	for (const [index, parameter] of fn.parameters.entries()) {
		const blockParameter = entryBlock.parameters[index];
		if (
			blockParameter?.value !== parameter ||
			blockParameter.role !== "value" ||
			blockParameter.representation !== "boxed"
		) {
			fail(`ABI parameter ${index} does not match boxed entry parameter ${parameter}`);
		}
	}

	const instructionIds = new Set<CoreInstructionId>();
	const valueCount = (fn.values.at(-1)?.id ?? -1) + 1;
	const definitionBlocks = new Int32Array(valueCount);
	definitionBlocks.fill(-1);
	/** -1 for a block parameter, otherwise the instruction's in-block index. */
	const definitionInstructionIndices = new Int32Array(valueCount);
	const values = new Array<CoreValue | undefined>(valueCount);
	for (const value of fn.values) values[value.id] = value;
	const facts: Array<CoreFact | undefined> = [];
	for (const fact of fn.facts) facts[fact.id] = fact;
	const guards: Array<GuardLocation | undefined> = [];
	const instructionBlocks: Array<CoreBlockId | undefined> = [];
	const instructions: Array<CoreInstruction | undefined> = [];
	const instructionOutputs: Array<ReadonlyArray<CoreValueId> | undefined> = [];
	const valueUses: Array<
		| Array<{
				readonly instruction: CoreInstructionId;
				readonly position: number;
		  }>
		| undefined
	> = [];
	const attributeAncestors = new Set<object>();
	const recordUse = (
		value: CoreValueId,
		instruction: CoreInstructionId,
		position: number,
	): void => {
		const entries = valueUses[value] ?? [];
		entries.push({ instruction, position });
		valueUses[value] = entries;
	};

	for (const block of fn.blocks) {
		let exceptionParameters = 0;
		for (const [index, parameter] of block.parameters.entries()) {
			if (parameter.role === "exception") exceptionParameters++;
			if (parameter.role === "exception" && index !== 0) {
				fail(`exception parameter in b${block.id} must be first`);
			}
			const value = values[parameter.value];
			if (
				value === undefined ||
				value.definition.kind !== "block-parameter" ||
				value.definition.block !== block.id ||
				value.definition.index !== index
			) {
				fail(`parameter ${parameter.value} in b${block.id} has a mismatched definition`);
			}
			if (value.representation !== parameter.representation) {
				fail(
					`parameter ${parameter.value} in b${block.id} has a mismatched representation`,
				);
			}
			definitionBlocks[parameter.value] = block.id;
			definitionInstructionIndices[parameter.value] = -1;
		}
		if (exceptionParameters > 1)
			fail(`block b${block.id} has multiple exception parameters`);

		for (const [instructionIndex, instruction] of block.instructions.entries()) {
			if (instructionIds.has(instruction.id))
				fail(`duplicate instruction id @${instruction.id}`);
			instructionIds.add(instruction.id);
			instructions[instruction.id] = instruction;
			instructionBlocks[instruction.id] = block.id;
			instructionOutputs[instruction.id] = instruction.outputs;
			for (const [position, input] of instruction.inputs.entries()) {
				recordUse(input, instruction.id, position);
			}
			for (const [key, value] of Object.entries(instruction.attributes)) {
				verifyAttributeValue(
					value,
					`instruction @${instruction.id}.${key}`,
					attributeAncestors,
				);
			}
			const descriptor = registry.get(instruction.opcode);
			if (descriptor === undefined)
				fail(`instruction @${instruction.id} has unknown opcode ${instruction.opcode}`);
			checkArity(
				`instruction @${instruction.id} input`,
				instruction.inputs.length,
				descriptor.inputs.minimum,
				descriptor.inputs.maximum,
			);
			checkArity(
				`instruction @${instruction.id} output`,
				instruction.outputs.length,
				descriptor.outputs.minimum,
				descriptor.outputs.maximum,
			);
			for (const [outputIndex, output] of instruction.outputs.entries()) {
				const value = values[output];
				if (
					value === undefined ||
					value.definition.kind !== "instruction" ||
					value.definition.instruction !== instruction.id ||
					value.definition.index !== outputIndex
				) {
					fail(`output ${output} of @${instruction.id} has a mismatched definition`);
				}
				if (definitionBlocks[output] !== -1)
					fail(`value ${output} has multiple definitions`);
				definitionBlocks[output] = block.id;
				definitionInstructionIndices[output] = instructionIndex;
			}
			if (instruction.effectRefinement !== undefined) {
				const proof = facts[instruction.effectRefinement.proof];
				if (proof === undefined) {
					fail(
						`instruction @${instruction.id} references unknown fact ${instruction.effectRefinement.proof}`,
					);
				}
				verifyEffectRefinement(
					instruction.id,
					instruction.effectRefinement.effects,
					descriptor.effects,
				);
				if (
					proof.validity.kind === "asserted" &&
					!proof.obligations.some(({ kind }) => kind === "guard")
				) {
					fail(`asserted fact ${proof.id} refines @${instruction.id} without a guard`);
				}
			}
		}
		if (instructionIds.has(block.terminator.id)) {
			fail(`duplicate instruction id @${block.terminator.id}`);
		}
		instructionIds.add(block.terminator.id);
		instructionBlocks[block.terminator.id] = block.id;
		for (const value of terminatorUses(block.terminator)) {
			recordUse(value, block.terminator.id, CORE_CONTROL_FLOW_POSITION);
		}
		for (const value of block.handler?.arguments ?? []) {
			recordUse(value, block.terminator.id, CORE_CONTROL_FLOW_POSITION);
		}
		if (block.terminator.kind === "guard") {
			if (facts[block.terminator.fact] === undefined) {
				fail(
					`guard @${block.terminator.id} references unknown fact ${block.terminator.fact}`,
				);
			}
			guards[block.terminator.id] = {
				instruction: block.terminator.id,
				fact: block.terminator.fact,
				block: block.id,
				success: block.terminator.success.block,
			};
		}
		for (const edge of coreTerminatorEdges(block.terminator))
			verifyEdge(edge, block, blocks);

		if (block.handler !== undefined) {
			const handler = blocks[block.handler.block];
			if (handler === undefined)
				fail(`block b${block.id} has unknown handler b${block.handler.block}`);
			if (handler.parameters[0]?.role !== "exception") {
				fail(`handler b${block.handler.block} must start with an exception parameter`);
			}
			if (block.handler.arguments.length + 1 !== handler.parameters.length) {
				fail(
					`exception edge b${block.id} -> b${block.handler.block} passes ${block.handler.arguments.length} values to ${handler.parameters.length - 1} explicit parameters`,
				);
			}
		}
	}

	const missingDefinition = fn.values.find(({ id }) => definitionBlocks[id] === -1);
	if (missingDefinition !== undefined) {
		fail(`value ${missingDefinition.id} has no definition`);
	}

	const cfg = buildCoreControlFlow(fn, registry);
	const regionValidity =
		fn.regions.length === 0 ? undefined : coreRegionValidityModel(fn, registry);
	for (const [regionIndex, region] of fn.regions.entries()) {
		if (region.kind.length === 0) fail(`region ${regionIndex} has an empty kind`);
		if (region.anchors.length === 0) fail(`region ${region.kind} has no anchors`);
		const claimed = new Set(region.claimedInstructions);
		if (claimed.size !== region.claimedInstructions.length) {
			fail(`region ${region.kind} claims an instruction more than once`);
		}
		for (const instruction of region.claimedInstructions) {
			if (!instructionIds.has(instruction)) {
				fail(`region ${region.kind} claims unknown instruction @${instruction}`);
			}
		}
		for (const anchor of region.anchors) {
			if (!instructionIds.has(anchor)) {
				fail(`region ${region.kind} has unknown anchor @${anchor}`);
			}
			if (!claimed.has(anchor)) {
				fail(`region ${region.kind} anchor @${anchor} is not claimed`);
			}
		}
		for (const [kind, regionBlocks] of [
			["ordinary", region.ordinaryBlocks],
			["exceptional", region.exceptionalBlocks],
		] as const) {
			if (new Set(regionBlocks).size !== regionBlocks.length) {
				fail(`region ${region.kind} repeats an ${kind} block`);
			}
			for (const block of regionBlocks) {
				if (blocks[block] === undefined)
					fail(`region ${region.kind} has unknown ${kind} block b${block}`);
			}
		}
		verifyAttributeValue(region.data, `region ${region.kind}.data`, attributeAncestors);
		verifyRegionReferences(
			region.data,
			`region ${region.kind}.data`,
			instructionIds,
			claimed,
			blocks,
		);
		verifyRegionPropertyPlacement(
			region,
			instructionBlocks,
			instructionOutputs,
			valueUses,
		);
		verifyRegionLicense(fn, cfg, regionValidity!, region);
	}

	verifyOwnDataCellRefinements(fn, cfg, facts, stringConstants);
	verifyContainedAggregateOwnSlotRefinements(fn, cfg, facts, stringConstants);
	if (cfg.predecessors[fn.entry]!.length !== 0) {
		fail(`entry block b${fn.entry} has predecessors`);
	}
	if (cfg.reachable.size !== fn.blocks.length) {
		const unreachable = fn.blocks.find(({ id }) => !cfg.reachable.has(id));
		fail(`block b${unreachable?.id} is unreachable`);
	}

	for (const fact of fn.facts) {
		if (fact.claims.length > CORE_FACT_CLAIM_LIMIT) {
			fail(`fact ${fact.id} has too many semantic claims`);
		}
		for (const [claimIndex, claim] of fact.claims.entries()) {
			const where = `fact ${fact.id} claim ${claimIndex}`;
			switch (claim.kind) {
				case "identity":
					if (
						claim.identities.length === 0 ||
						claim.identities.length > CORE_FACT_ALTERNATIVE_LIMIT
					) {
						fail(`${where} has an invalid finite identity set`);
					}
					break;
				case "shape":
					if (
						claim.shapes.length === 0 ||
						claim.shapes.length > CORE_FACT_ALTERNATIVE_LIMIT ||
						claim.shapes.some((shape) => shape.length === 0)
					) {
						fail(`${where} has an invalid finite shape set`);
					}
					break;
				case "range":
					// A NaN endpoint is not an ordering constraint, and a claim no value
					// satisfies would establish every claim about the same subject.
					if (
						(claim.minimum !== null && Number.isNaN(claim.minimum)) ||
						(claim.maximum !== null && Number.isNaN(claim.maximum)) ||
						!coreFactClaimIsSatisfiable(claim)
					) {
						fail(`${where} has an invalid numeric interval`);
					}
					break;
				case "effect":
					// Claims become inert when a transform deletes or changes their subject;
					// the live-consumer check below requires an exact current instruction.
					break;
			}
		}
		const guardObligations = fact.obligations.filter(
			(
				obligation,
			): obligation is Extract<(typeof fact.obligations)[number], { kind: "guard" }> =>
				obligation.kind === "guard",
		);
		if (fact.validity.kind === "asserted" && guardObligations.length === 0) {
			fail(`asserted fact ${fact.id} has no guard obligation`);
		}
		if (
			fact.validity.kind === "epoch" &&
			guardObligations.length === 0 &&
			!fact.obligations.some(({ kind }) => kind === "fallback")
		) {
			fail(`epoch fact ${fact.id} has neither a guard nor a fallback`);
		}
		if (fact.validity.kind === "guard") {
			const guard = guards[fact.validity.instruction];
			if (guard === undefined || guard.fact !== fact.id) {
				fail(`fact ${fact.id} names a guard that does not establish it`);
			}
		}
		for (const obligation of fact.obligations) {
			if (obligation.kind === "guard") {
				const guard = guards[obligation.instruction];
				if (guard === undefined || guard.fact !== fact.id) {
					fail(`fact ${fact.id} has an invalid guard obligation`);
				}
			} else if (obligation.id.length === 0) {
				fail(`fact ${fact.id} has an empty ${obligation.kind} obligation`);
			}
		}
	}

	// A fact that states anything at all must state the effects of every refinement
	// it licenses. Claims naming a deleted instruction stay inert rather than
	// invalid, so only live consumers have to be covered.
	for (const instruction of instructions) {
		if (instruction === undefined) continue;
		const refinement = instruction.effectRefinement;
		if (refinement === undefined) continue;
		const fact = facts[refinement.proof]!;
		if (
			fact.claims.length > 0 &&
			!fact.claims.some(
				(claim) =>
					claim.kind === "effect" &&
					claim.instruction === instruction.id &&
					effectSummaryCovers(refinement.effects, claim.effects),
			)
		) {
			fail(
				`fact ${fact.id} does not license the effect refinement on @${instruction.id}`,
			);
		}
	}

	const verifyFactAvailable = (
		fact: CoreFact,
		block: CoreBlock,
		instructionId: CoreInstructionId,
	): void => {
		const guardObligations = fact.obligations.filter(
			(
				obligation,
			): obligation is Extract<(typeof fact.obligations)[number], { kind: "guard" }> =>
				obligation.kind === "guard",
		);
		if (
			(fact.validity.kind === "asserted" || fact.validity.kind === "epoch") &&
			guardObligations.length === 0
		) {
			fail(`fact ${fact.id} cannot refine @${instructionId} without a guard`);
		}
		for (const obligation of guardObligations) {
			const guard = guards[obligation.instruction]!;
			// The guard establishes its fact on the success edge, not in the success
			// block: a block the guard's target also reaches from elsewhere is entered
			// on paths that never ran the check.
			if (!cfg.dominatesEdge(guard.block, guard.success, block.id)) {
				fail(
					`guard @${guard.instruction} for fact ${fact.id} does not dominate @${instructionId} through its success edge`,
				);
			}
		}
	};

	const verifyUse = (
		valueId: CoreValueId,
		block: CoreBlock,
		instructionIndex: number,
		context: string,
	): void => {
		const rawDefinitionBlock = definitionBlocks[valueId];
		if (rawDefinitionBlock === undefined || rawDefinitionBlock === -1) {
			fail(`${context} uses unknown value ${valueId}`);
		}
		const definitionBlock = rawDefinitionBlock as CoreBlockId;
		const definitionInstructionIndex = definitionInstructionIndices[valueId]!;
		if (definitionBlock === block.id) {
			if (definitionInstructionIndex >= instructionIndex) {
				fail(`${context} uses ${valueId} before its definition in b${block.id}`);
			}
			return;
		}
		if (!cfg.dominates(definitionBlock, block.id)) {
			fail(`${context} uses ${valueId}, which does not dominate b${block.id}`);
		}
		if (
			definitionInstructionIndex !== -1 &&
			!cfg.instructionDominatesBlock(definitionBlock, block.id)
		) {
			fail(
				`${context} uses ${valueId}, which is not available on exceptional flow from b${definitionBlock}`,
			);
		}
	};

	for (const block of fn.blocks) {
		for (const [instructionIndex, instruction] of block.instructions.entries()) {
			for (const input of instruction.inputs) {
				verifyUse(input, block, instructionIndex, `instruction @${instruction.id}`);
			}
			if (instruction.effectRefinement !== undefined) {
				verifyFactAvailable(
					facts[instruction.effectRefinement.proof]!,
					block,
					instruction.id,
				);
			}
		}
		for (const value of terminatorUses(block.terminator)) {
			verifyUse(
				value,
				block,
				block.instructions.length,
				`terminator @${block.terminator.id}`,
			);
		}
		if (block.handler !== undefined) {
			for (const argument of block.handler.arguments) {
				const rawDefinitionBlock = definitionBlocks[argument];
				if (rawDefinitionBlock === undefined || rawDefinitionBlock === -1) {
					fail(`handler edge from b${block.id} uses unknown value ${argument}`);
				}
				const definitionBlock = rawDefinitionBlock as CoreBlockId;
				const definitionInstructionIndex = definitionInstructionIndices[argument]!;
				if (
					definitionBlock === block.id
						? definitionInstructionIndex !== -1
						: definitionInstructionIndex === -1
							? !cfg.dominates(definitionBlock, block.id)
							: !cfg.instructionDominatesBlock(definitionBlock, block.id)
				) {
					fail(
						`handler edge from b${block.id} uses ${argument}, which is not available at block entry`,
					);
				}
			}
		}
	}
}

/**
 * Re-prove every summary-derived call refinement from the current graph.
 *
 * A summary refinement is the one narrowing no dominating guard licenses, so this
 * boundary is its whole proof. Nothing here trusts the refinement it finds: the
 * callee-target lattice and the summary solver run again on this program, and the
 * refinement must be exactly what the recorded claim licenses, the claim must
 * still cover what the callee provably does, and the claim's digest must match its
 * own contents. A refinement whose fact says `summary` but whose claim no longer
 * holds — a callee that grew an effect, a call site that no longer resolves to a
 * closed target set, or a hand-written fact — fails here rather than reaching a
 * backend that would honour it.
 *
 * The claim may be weaker than what the graph now proves: a later pass that makes
 * a callee more precise must not invalidate a sound refinement derived from the
 * older, wider claim.
 */
interface SummaryEffectRefinement {
	readonly functionIndex: number;
	readonly instruction: CoreInstruction;
	readonly fact: CoreFact;
}

interface SummaryValueClaim {
	readonly functionIndex: number;
	readonly instruction: CoreInstruction;
	readonly representation: CoreValue["representation"];
	readonly attribute: unknown;
}

function collectFunctionSummaryClaims(
	fn: CoreFunction,
	refined: Array<SummaryEffectRefinement>,
	valueClaims: Array<SummaryValueClaim>,
): void {
	let facts: Map<CoreFact["id"], CoreFact> | undefined;
	let representations: Map<CoreValueId, CoreValue["representation"]> | undefined;
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			const attribute = instruction.attributes[CORE_CALL_SUMMARY_ATTRIBUTE];
			const output = instruction.outputs[0];
			const representation =
				output === undefined || (attribute === undefined && instruction.opcode !== "call")
					? undefined
					: (representations ??= new Map(
							fn.values.map(({ id, representation: current }) => [id, current] as const),
						)).get(output);
			if (attribute !== undefined) {
				if (representation === undefined) {
					fail(
						`instruction @${instruction.id} in function ${fn.functionIndex} carries a callee summary without a result`,
					);
				}
				valueClaims.push({
					functionIndex: fn.functionIndex,
					instruction,
					representation,
					attribute,
				});
			} else if (
				instruction.opcode === "call" &&
				representation !== undefined &&
				representation !== "boxed"
			) {
				fail(
					`instruction @${instruction.id} in function ${fn.functionIndex} has an unproved ${representation} call result`,
				);
			}
			const refinement = instruction.effectRefinement;
			if (refinement === undefined) continue;
			const fact = (facts ??= new Map(
				fn.facts.map((current) => [current.id, current] as const),
			)).get(refinement.proof);
			if (fact?.kind !== CORE_CALL_EFFECT_SUMMARY_FACT) continue;
			refined.push({ functionIndex: fn.functionIndex, instruction, fact });
		}
	}
}

function verifySummaryClaims(
	program: CoreProgram,
	registry: CoreOpcodeRegistry,
	summaries: () => CoreProgramSummaries,
): void {
	const refined: Array<SummaryEffectRefinement> = [];
	const valueClaims: Array<SummaryValueClaim> = [];
	for (const fn of program.functions) {
		collectFunctionSummaryClaims(fn, refined, valueClaims);
	}
	if (refined.length === 0 && valueClaims.length === 0) return;
	const currentSummaries = summaries();
	for (const { functionIndex, instruction, fact } of refined) {
		const where = `instruction @${instruction.id} in function ${functionIndex}`;
		if (instruction.opcode !== "call") {
			fail(`${where} carries a callee-summary refinement on ${instruction.opcode}`);
		}
		if (fact.validity.kind !== "summary") {
			fail(`${where} names a callee-summary fact whose validity is not a summary`);
		}
		const claim = coreCallSummaryClaimFromFactValue(fact.value);
		if (claim === undefined) {
			fail(`${where} names a callee-summary fact with an unreadable claim`);
		}
		if (fact.validity.digest !== coreCallSummaryDigest(claim)) {
			fail(`${where} names a callee-summary fact whose digest does not match its claim`);
		}
		const current = currentSummaries.callSite(functionIndex, instruction.id);
		if (current === undefined) {
			fail(
				`${where} claims callee targets [${claim.targets.join(", ")}] the current graph does not prove closed`,
			);
		}
		if (!coreCallSummaryClaimHolds(claim, current)) {
			fail(`${where} carries a callee summary the current graph no longer proves`);
		}
		const licensed = deriveCoreCallEffectRefinement(
			registry.require(instruction.opcode).effects,
			claim,
		);
		if (
			licensed === undefined ||
			!effectSummariesEqual(instruction.effectRefinement!.effects, licensed)
		) {
			fail(`${where} refines further than its callee summary licenses`);
		}
	}
	for (const { functionIndex, instruction, representation, attribute } of valueClaims) {
		const where = `instruction @${instruction.id} in function ${functionIndex}`;
		if (instruction.opcode !== "call") {
			fail(`${where} carries callee value facts on ${instruction.opcode}`);
		}
		const claim = coreCallSummaryClaimFromAttribute(attribute);
		if (claim === undefined) fail(`${where} carries unreadable callee value facts`);
		if (claim.digest !== coreCallValueSummaryDigest(claim)) {
			fail(`${where} carries callee value facts whose digest does not match`);
		}
		const current = currentSummaries.callSite(functionIndex, instruction.id);
		if (current === undefined) {
			fail(`${where} carries callee value facts for a call that is no longer closed`);
		}
		if (claim.digest !== coreCallValueSummaryDigest(current)) {
			fail(`${where} carries callee value facts the current graph no longer proves`);
		}
		const licensed = coreCallResultRepresentation(current);
		if (representation !== "boxed" && representation !== licensed) {
			fail(
				`${where} uses ${representation} for a result whose callee summary licenses ${licensed}`,
			);
		}
	}
}

function verifyPrimitiveOperatorEffectRefinements(
	program: CoreProgram,
	valueKinds: () => CoreValueKindAnalysis,
): void {
	let analysis: CoreValueKindAnalysis | undefined;
	for (const fn of program.functions) {
		const facts = new Map(fn.facts.map((fact) => [fact.id, fact] as const));
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const refinement = instruction.effectRefinement;
				if (refinement === undefined) continue;
				const fact = facts.get(refinement.proof);
				if (fact?.kind !== CORE_PRIMITIVE_OPERATOR_EFFECT_FACT) continue;
				const where = `instruction @${instruction.id} in function ${fn.functionIndex}`;
				if (fact.validity.kind !== "summary") {
					fail(
						`${where} names a primitive-operator fact whose validity is not a summary`,
					);
				}
				const value =
					typeof fact.value === "object" &&
					fact.value !== null &&
					!Array.isArray(fact.value)
						? (fact.value as Record<string, unknown>)
						: undefined;
				const masks = Array.isArray(value?.masks) ? value.masks : undefined;
				if (
					value?.operator !== instruction.attributes.operator ||
					masks === undefined ||
					masks.length !== instruction.inputs.length ||
					!masks.every((mask) => compilerValueKindMaskIsValid(mask, { allowTop: true }))
				) {
					fail(`${where} names an unreadable primitive-operator fact`);
				}
				const typedMasks = masks as ReadonlyArray<number>;
				const digest = `primitive-operator:${String(value!.operator)}:${typedMasks.join(",")}`;
				if (fact.validity.digest !== digest) {
					fail(`${where} names a primitive-operator fact with a mismatched digest`);
				}
				analysis ??= valueKinds();
				if (
					instruction.inputs.some(
						(input, index) =>
							!compilerValueKindMaskIsSubset(
								analysis!.kindMask(fn.functionIndex, input),
								typedMasks[index]!,
							),
					)
				) {
					fail(
						`${where} carries primitive operand kinds that do not cover the current graph`,
					);
				}
				const licensed = corePrimitiveOperatorEffectRefinement(instruction, typedMasks);
				if (
					licensed === undefined ||
					!effectSummariesEqual(refinement.effects, licensed)
				) {
					fail(`${where} refines further than its primitive operand kinds license`);
				}
			}
		}
	}
}

function verifyExactShapeOwnSlotEffectRefinements(program: CoreProgram): void {
	for (const fn of program.functions) {
		const facts = new Map(fn.facts.map((fact) => [fact.id, fact] as const));
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const refinement = instruction.effectRefinement;
				if (refinement === undefined) continue;
				const fact = facts.get(refinement.proof);
				if (fact?.kind !== CORE_EXACT_SHAPE_OWN_SLOT_EFFECT_FACT) continue;
				const where = `instruction @${instruction.id} in function ${fn.functionIndex}`;
				const digest = coreExactShapeOwnSlotDigest(fact.value);
				const currentDigest = coreExactShapeOwnSlotDigest(
					instruction.attributes[CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE],
				);
				if (
					fact.validity.kind !== "summary" ||
					digest === undefined ||
					fact.validity.digest !== digest ||
					currentDigest !== digest
				) {
					fail(`${where} names an invalid exact-shape effect fact`);
				}
				const licensed = coreExactShapeOwnSlotEffects(instruction);
				if (
					licensed === undefined ||
					!effectSummariesEqual(refinement.effects, licensed)
				) {
					fail(`${where} refines further than its exact shape slot licenses`);
				}
			}
		}
	}
}

function verifyExactCollectionBuiltinEffectRefinements(program: CoreProgram): void {
	for (const fn of program.functions) {
		const facts = new Map(fn.facts.map((fact) => [fact.id, fact] as const));
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const refinement = instruction.effectRefinement;
				if (refinement === undefined) continue;
				const fact = facts.get(refinement.proof);
				if (fact?.kind !== CORE_EXACT_COLLECTION_BUILTIN_EFFECT_FACT) continue;
				const operation = instruction.attributes.operation;
				const where = `instruction @${instruction.id} in function ${fn.functionIndex}`;
				if (
					typeof operation !== "string" ||
					fact.value !== operation ||
					fact.validity.kind !== "summary" ||
					fact.validity.digest !== `exact-collection-builtin:${operation}`
				) {
					fail(`${where} names an invalid exact collection builtin effect fact`);
				}
				const licensed = coreExactCollectionBuiltinEffects(instruction);
				if (
					licensed === undefined ||
					!effectSummariesEqual(refinement.effects, licensed)
				) {
					fail(`${where} refines further than its exact collection builtin licenses`);
				}
			}
		}
	}
}

/** Verify function graphs together with the immutable metadata they index. */
interface CoreProgramVerificationCache {
	readonly registry: CoreOpcodeRegistry;
	readonly compilationContext: CoreCompilationContext | undefined;
	common: boolean;
	preTarget: boolean;
}

const coreProgramVerificationCache = new WeakMap<
	CoreProgram,
	CoreProgramVerificationCache
>();

export function verifyCoreProgram(
	program: CoreProgram,
	registry: CoreOpcodeRegistry,
	context?: CoreVerificationContext,
	compilationContext?: CoreCompilationContext,
	analyses?: { readonly summaries?: CoreProgramSummaries },
): void {
	const existing = coreProgramVerificationCache.get(program);
	const cached =
		existing?.registry === registry && existing.compilationContext === compilationContext
			? existing
			: undefined;
	const preTarget = context?.stage === "pre-target";
	if (cached?.common === true && (!preTarget || cached.preTarget)) return;
	const cache: CoreProgramVerificationCache = cached ?? {
		registry,
		compilationContext,
		common: false,
		preTarget: false,
	};
	withVerificationContext(context, () =>
		verifyCoreProgramGraph(
			program,
			registry,
			context,
			compilationContext,
			cache.common,
			analyses?.summaries,
		),
	);
	cache.common = true;
	if (preTarget) cache.preTarget = true;
	coreProgramVerificationCache.set(program, cache);
}

function verifyKnownOwnSlotClaims(
	program: CoreProgram,
	registry: CoreOpcodeRegistry,
	verifyExact: boolean,
	summaries: () => CoreProgramSummaries,
	compilationContext: CoreCompilationContext | undefined,
): void {
	let hasShapeClaims = false;
	for (const fn of program.functions) {
		if (hasShapeClaims) break;
		for (const block of fn.blocks) {
			if (hasShapeClaims) break;
			for (const instruction of block.instructions) {
				if (
					CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE in instruction.attributes ||
					CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes ||
					CORE_SHAPE_CASE_CANDIDATES_ATTRIBUTE in instruction.attributes ||
					CORE_SHAPE_CASE_SLOTS_ATTRIBUTE in instruction.attributes ||
					instruction.opcode === "selectShapeCase" ||
					instruction.opcode === "loadPropertyStaticShapeCase"
				) {
					hasShapeClaims = true;
					break;
				}
			}
		}
	}
	if (!hasShapeClaims) return;
	const cellForString = coreOwnCellResolver(program.stringConstants);
	const instructionsByFunction = program.functions.map(
		(fn) =>
			new Map(
				fn.blocks.flatMap((block) =>
					block.instructions.map((instruction) => [instruction.id, instruction] as const),
				),
			),
	);
	const claimedByFunction = program.functions.map(
		(fn) => new Set(fn.regions.flatMap((region) => region.claimedInstructions)),
	);
	const keysByOrigin = new Map<string, ReadonlyArray<number>>();
	let shapeProvenance: ReturnType<typeof analyzeCoreShapeProvenance> | undefined;
	const exactShapeProvenance = (): ReturnType<typeof analyzeCoreShapeProvenance> => {
		if (shapeProvenance !== undefined) return shapeProvenance;
		const currentSummaries = summaries();
		shapeProvenance = analyzeCoreShapeProvenance(program, {
			registry,
			calleeTargets: currentSummaries.targets,
			summaries: currentSummaries,
			...(compilationContext === undefined ? {} : { context: compilationContext }),
		});
		return shapeProvenance;
	};
	for (const fn of program.functions) {
		const claimed = claimedByFunction[fn.functionIndex] ?? new Set<CoreInstructionId>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const hasExact = CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE in instruction.attributes;
				if (hasExact) {
					if (
						claimed.has(instruction.id) ||
						(instruction.opcode !== "loadPropertyStatic" &&
							instruction.opcode !== "storePropertyStatic") ||
						CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes
					) {
						fail(`instruction @${instruction.id} carries an invalid exact shape slot`);
					}
					const claim = coreExactShapeOwnSlotFromAttribute(
						instruction.attributes[CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE],
					);
					if (claim === undefined) {
						fail(`instruction @${instruction.id} carries an invalid exact shape slot`);
					}
					if (verifyExact) {
						const receiver = instruction.inputs[0];
						const stringIndex = instruction.attributes.stringIndex;
						const current =
							receiver === undefined || typeof stringIndex !== "number"
								? undefined
								: exactShapeProvenance().exactOwnSlot(
										fn.functionIndex,
										receiver,
										stringIndex,
									);
						if (
							current === undefined ||
							current.slot !== claim.slot ||
							current.origins.length !== claim.origins.length ||
							current.origins.some(
								(origin, index) =>
									origin.shapeFunctionIndex !==
										claim.origins[index]?.shapeFunctionIndex ||
									origin.shapeInstruction !== claim.origins[index]?.shapeInstruction,
							)
						) {
							fail(
								`instruction @${instruction.id} carries an exact shape slot the current graph no longer proves`,
							);
						}
					}
				}
				if (!(CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes)) continue;
				if (claimed.has(instruction.id)) {
					fail(
						`instruction @${instruction.id} is claimed by both a Core region and a known own slot`,
					);
				}
				if (
					instruction.opcode !== "loadPropertyStatic" &&
					instruction.opcode !== "storePropertyStatic"
				) {
					fail(
						`instruction @${instruction.id} carries a known own slot on ${instruction.opcode}`,
					);
				}
				const claim = coreKnownOwnSlotFromAttribute(
					instruction.attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE],
				);
				if (claim === undefined) {
					fail(`instruction @${instruction.id} carries an invalid known own slot`);
				}
				const stringIndex = instruction.attributes.stringIndex;
				for (const candidate of claim.candidates) {
					const originIdentity = `${candidate.shapeFunctionIndex}\0${candidate.shapeInstruction}`;
					const originFunction = program.functions[candidate.shapeFunctionIndex];
					const origin = instructionsByFunction[candidate.shapeFunctionIndex]?.get(
						candidate.shapeInstruction,
					);
					if (
						originFunction?.functionIndex !== candidate.shapeFunctionIndex ||
						origin === undefined
					) {
						fail(
							`instruction @${instruction.id} carries a known own slot with an invalid shaped-object origin`,
						);
					}
					let keys = keysByOrigin.get(originIdentity);
					if (keys === undefined) {
						keys = coreShapeOriginKeys(
							program,
							originFunction,
							origin,
							registry,
							cellForString,
						);
						if (keys !== undefined) keysByOrigin.set(originIdentity, keys);
					}
					if (keys === undefined) {
						fail(
							`instruction @${instruction.id} carries a known own slot with an invalid shaped-object origin`,
						);
					}
					if (candidate.slot >= keys.length || keys[candidate.slot] !== stringIndex) {
						fail(
							`instruction @${instruction.id} carries a known own slot for a different static key`,
						);
					}
				}
			}
		}
	}

	for (const fn of program.functions) {
		const claimed = claimedByFunction[fn.functionIndex] ?? new Set<CoreInstructionId>();
		const blocksById = new Map(fn.blocks.map((block) => [block.id, block] as const));
		const selectors = new Map<
			CoreValueId,
			{
				readonly instruction: CoreInstruction;
				readonly block: CoreBlockId;
				readonly index: number;
				readonly candidates: NonNullable<
					ReturnType<typeof coreShapeCaseCandidatesFromAttribute>
				>;
			}
		>();
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				const hasCandidates =
					CORE_SHAPE_CASE_CANDIDATES_ATTRIBUTE in instruction.attributes;
				const hasSlots = CORE_SHAPE_CASE_SLOTS_ATTRIBUTE in instruction.attributes;
				if (instruction.opcode !== "selectShapeCase") {
					if (hasCandidates) {
						fail(
							`instruction @${instruction.id} carries shape-case candidates on ${instruction.opcode}`,
						);
					}
					if (instruction.opcode !== "loadPropertyStaticShapeCase" && hasSlots) {
						fail(
							`instruction @${instruction.id} carries shape-case slots on ${instruction.opcode}`,
						);
					}
					if (
						instruction.opcode === "loadPropertyStaticShapeCase" &&
						(!hasSlots || claimed.has(instruction.id))
					) {
						fail(`instruction @${instruction.id} carries an invalid shape-case load`);
					}
					continue;
				}
				if (!hasCandidates || hasSlots || claimed.has(instruction.id)) {
					fail(`instruction @${instruction.id} carries an invalid shape-case selector`);
				}
				const candidates = coreShapeCaseCandidatesFromAttribute(
					instruction.attributes[CORE_SHAPE_CASE_CANDIDATES_ATTRIBUTE],
				);
				if (candidates === undefined || instruction.outputs.length !== 1) {
					fail(`instruction @${instruction.id} carries an invalid shape-case selector`);
				}
				for (const candidate of candidates) {
					const originIdentity = `${candidate.shapeFunctionIndex}\0${candidate.shapeInstruction}`;
					const originFunction = program.functions[candidate.shapeFunctionIndex];
					const origin = instructionsByFunction[candidate.shapeFunctionIndex]?.get(
						candidate.shapeInstruction,
					);
					if (
						originFunction?.functionIndex !== candidate.shapeFunctionIndex ||
						origin === undefined
					) {
						fail(
							`instruction @${instruction.id} carries a shape case with an invalid shaped-object origin`,
						);
					}
					let keys = keysByOrigin.get(originIdentity);
					if (keys === undefined) {
						keys = coreShapeOriginKeys(
							program,
							originFunction,
							origin,
							registry,
							cellForString,
						);
						if (keys !== undefined) keysByOrigin.set(originIdentity, keys);
					}
					if (keys === undefined) {
						fail(
							`instruction @${instruction.id} carries a shape case with an invalid shaped-object origin`,
						);
					}
				}
				selectors.set(instruction.outputs[0]!, {
					instruction,
					block: block.id,
					index,
					candidates,
				});
			}
		}
		const uses = new Map<CoreValueId, Array<{ block: number; index: number }>>();
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				if (
					instruction.opcode === "loadPropertyStaticShapeCase" &&
					selectors.get(instruction.inputs[1]!) === undefined
				) {
					fail(`instruction @${instruction.id} has no shape-case selector`);
				}
				for (const [position, input] of instruction.inputs.entries()) {
					const selector = selectors.get(input);
					if (selector === undefined) continue;
					if (
						instruction.opcode !== "loadPropertyStaticShapeCase" ||
						position !== 1 ||
						instruction.inputs[0] !== selector.instruction.inputs[0] ||
						block.id !== selector.block ||
						index <= selector.index
					) {
						fail(`shape-case value from @${selector.instruction.id} has an invalid use`);
					}
					const slots = coreShapeCaseSlotsFromAttribute(
						instruction.attributes[CORE_SHAPE_CASE_SLOTS_ATTRIBUTE],
					);
					if (slots?.length !== selector.candidates.length) {
						fail(`instruction @${instruction.id} carries invalid shape-case slots`);
					}
					const stringIndex = instruction.attributes.stringIndex;
					for (const [candidateIndex, candidate] of selector.candidates.entries()) {
						const keys = keysByOrigin.get(
							`${candidate.shapeFunctionIndex}\0${candidate.shapeInstruction}`,
						);
						const slot = slots[candidateIndex]!;
						if (keys === undefined || slot >= keys.length || keys[slot] !== stringIndex) {
							fail(
								`instruction @${instruction.id} carries a shape-case slot for a different static key`,
							);
						}
					}
					const existing = uses.get(input) ?? [];
					existing.push({ block: block.id, index });
					uses.set(input, existing);
				}
			}
			const structuralValues: Array<CoreValueId> = [];
			for (const edge of coreTerminatorEdges(block.terminator)) {
				structuralValues.push(...edge.arguments);
			}
			if (block.terminator.kind === "branch" || block.terminator.kind === "guard") {
				structuralValues.push(block.terminator.condition);
			} else if (block.terminator.kind === "switch") {
				structuralValues.push(block.terminator.discriminant);
			} else if (
				block.terminator.kind === "return" ||
				block.terminator.kind === "throw"
			) {
				structuralValues.push(block.terminator.value);
			}
			structuralValues.push(...(block.handler?.arguments ?? []));
			for (const value of structuralValues) {
				if (selectors.has(value)) fail("shape-case value has a structural use");
			}
		}
		for (const [value, selector] of selectors) {
			const selectorUses = uses.get(value) ?? [];
			if (
				selectorUses.length < CORE_SHAPE_CASE_MIN_LOADS ||
				selectorUses.length > CORE_SHAPE_CASE_MAX_LOADS
			) {
				fail(`shape-case selector @${selector.instruction.id} has invalid use count`);
			}
			const last = selectorUses.at(-1)!;
			if (last.index - selector.index > CORE_SHAPE_CASE_MAX_SPAN) {
				fail(`shape-case selector @${selector.instruction.id} has an oversized span`);
			}
			const block = blocksById.get(selector.block);
			if (block === undefined) {
				fail(`shape-case selector @${selector.instruction.id} has an invalid block`);
			}
			const useIndices = new Set(selectorUses.map(({ index }) => index));
			for (let index = selector.index + 1; index <= last.index; index++) {
				if (useIndices.has(index)) continue;
				const instruction = block.instructions[index]!;
				const effects = coreInstructionEffects(instruction, registry);
				if (
					(instruction.opcode !== "loadThis" || fn.metadata.isDerivedConstructor) &&
					(effects.callsUserCode ||
						effects.maySuspend ||
						effects.mayGc ||
						effects.mayThrow ||
						effects.writes.includes("object-property"))
				) {
					fail(
						`shape-case selector @${selector.instruction.id} crosses an invalid effect`,
					);
				}
			}
		}
	}
}

function verifyFreshArrayLengthClaims(
	fn: CoreFunction,
	registry: CoreOpcodeRegistry,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): void {
	const claims = fn.blocks.flatMap((block) =>
		block.instructions.filter(
			(instruction) => CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE in instruction.attributes,
		),
	);
	if (claims.length === 0) return;
	const cfg = buildCoreControlFlow(fn, registry);
	const provenance = coreProvenance(fn, cfg, stringConstants);
	const representations = new Map(
		fn.values.map(({ id, representation }) => [id, representation] as const),
	);
	for (const instruction of claims) {
		const stringIndex = instruction.attributes.stringIndex;
		const units =
			typeof stringIndex === "number" ? stringConstants[stringIndex] : undefined;
		const isLength =
			units?.length === 6 &&
			units.every((unit, index) => unit === [0x6c, 0x65, 0x6e, 0x67, 0x74, 0x68][index]);
		if (
			instruction.attributes[CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE] !== true ||
			instruction.opcode !== "loadPropertyStatic" ||
			instruction.inputs.length !== 1 ||
			instruction.outputs.length !== 1 ||
			!isLength ||
			provenance.allocationOf(instruction.inputs[0]!)?.kind !== "indexed" ||
			representations.get(instruction.outputs[0]!) !== "f64"
		) {
			fail(`instruction @${instruction.id} carries an invalid fresh Array length claim`);
		}
	}
}

function verifyContainedDenseArrayElementClaims(
	fn: CoreFunction,
	registry: CoreOpcodeRegistry,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
	compilationContext: CoreCompilationContext | undefined,
): void {
	const claims = fn.blocks.flatMap((block) =>
		block.instructions.filter(
			(instruction) =>
				CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE in instruction.attributes,
		),
	);
	if (claims.length === 0) return;
	if (compilationContext?.facts.world.primordialPolicy !== "locked") {
		fail("contained dense Array element claim requires locked primordials");
	}

	const cfg = buildCoreControlFlow(fn, registry);
	const ordinary = coreProvenance(fn, cfg, stringConstants);
	const representations = new Map(
		fn.values.map(({ id, representation }) => [id, representation] as const),
	);
	const candidateAllocations = new Set<CoreInstructionId>();
	const assumedNonEscapingOperands = new Map<CoreInstructionId, Set<number>>();
	const assumeNonEscaping = (instruction: CoreInstructionId, operand: number): void => {
		const operands = assumedNonEscapingOperands.get(instruction);
		if (operands === undefined) {
			assumedNonEscapingOperands.set(instruction, new Set([operand]));
		} else {
			operands.add(operand);
		}
	};

	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			const operation = instruction.attributes.operation;
			if (
				instruction.opcode !== "callBuiltin" ||
				(operation !== "Array.prototype.push" && operation !== "Array.prototype.pop") ||
				instruction.inputs.length < 1
			) {
				continue;
			}
			const layout = ordinary.allocationOf(instruction.inputs[0]!);
			if (layout?.kind !== "indexed" || layout.elements.size !== layout.length) continue;
			candidateAllocations.add(layout.instruction);
			assumeNonEscaping(instruction.id, 0);
		}
	}
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.opcode !== "loadProperty" || instruction.inputs.length !== 2) {
				continue;
			}
			const layout = ordinary.allocationOf(instruction.inputs[0]!);
			const keyRepresentation = representations.get(instruction.inputs[1]!);
			if (
				layout?.kind === "indexed" &&
				candidateAllocations.has(layout.instruction) &&
				(keyRepresentation === "f64" || keyRepresentation === "i32")
			) {
				assumeNonEscaping(instruction.id, 0);
			}
		}
	}
	const conditional = ordinary.withAssumedNonEscapingOperands(assumedNonEscapingOperands);
	for (const instruction of claims) {
		const receiver = instruction.inputs[0];
		const key = instruction.inputs[1];
		const layout = receiver === undefined ? undefined : ordinary.allocationOf(receiver);
		const keyRepresentation = key === undefined ? undefined : representations.get(key);
		if (
			instruction.attributes[CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE] !== true ||
			instruction.opcode !== "loadProperty" ||
			instruction.inputs.length !== 2 ||
			instruction.outputs.length !== 1 ||
			layout?.kind !== "indexed" ||
			layout.elements.size !== layout.length ||
			!candidateAllocations.has(layout.instruction) ||
			conditional.escape(layout.instruction) !== "contained" ||
			(keyRepresentation !== "f64" && keyRepresentation !== "i32")
		) {
			fail(
				`instruction @${instruction.id} carries an invalid contained dense Array read`,
			);
		}
	}
}

function verifyExactTypedArrayClaims(
	program: CoreProgram,
	valueClasses: () => CoreValueClassAnalysis,
): void {
	const claims = program.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) =>
			block.instructions
				.filter(
					(instruction) =>
						CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE in instruction.attributes,
				)
				.map((instruction) => ({ fn, instruction })),
		),
	);
	if (claims.length === 0) return;
	const analysis = valueClasses();
	for (const { fn, instruction } of claims) {
		const receiver = instruction.inputs[0];
		const claimed = coreNumericTypedArrayKind(
			instruction.attributes[CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE],
		);
		const actual =
			receiver === undefined
				? undefined
				: analysis.exactNumericTypedArray(fn.functionIndex, receiver, instruction.id);
		if (
			instruction.opcode !== "loadProperty" ||
			claimed === undefined ||
			actual !== claimed
		) {
			fail(`instruction @${instruction.id} carries an invalid exact TypedArray claim`);
		}
	}
}

function verifyExactCollectionReceiverClaims(
	program: CoreProgram,
	valueClasses: () => CoreValueClassAnalysis,
): void {
	const claims = program.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) =>
			block.instructions
				.filter(
					(instruction) =>
						CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE in instruction.attributes,
				)
				.map((instruction) => ({ fn, instruction })),
		),
	);
	if (claims.length === 0) return;
	const analysis = valueClasses();
	for (const { fn, instruction } of claims) {
		const receiver = instruction.inputs[1];
		const call = instruction.attributes.knownBuiltinCall;
		const operation =
			call !== null && typeof call === "object" && !Array.isArray(call)
				? (call as Readonly<Record<string, unknown>>).operation
				: undefined;
		const expected = coreCollectionReceiverBrandForOperation(operation);
		const claimed = coreExactCollectionBrand(
			instruction.attributes[CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE],
		);
		const actual =
			receiver === undefined
				? undefined
				: analysis.exactHeapBrand(fn.functionIndex, receiver, instruction.id);
		if (
			instruction.opcode !== "call" ||
			claimed === undefined ||
			claimed !== expected ||
			claimed !== actual
		) {
			fail(
				`instruction @${instruction.id} carries an invalid exact collection receiver claim`,
			);
		}
	}
}

function verifyExactCallArgumentClaims(
	program: CoreProgram,
	valueKinds: () => CoreValueKindAnalysis,
): void {
	const claims = program.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) =>
			block.instructions
				.filter(
					(instruction) =>
						CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE in instruction.attributes,
				)
				.map((instruction) => ({ fn, instruction })),
		),
	);
	if (claims.length === 0) return;
	const analysis = valueKinds();
	for (const { fn, instruction } of claims) {
		const targetIndex = instruction.attributes.directFunctionIndex;
		const target =
			typeof targetIndex === "number" ? program.functions[targetIndex] : undefined;
		const claim = coreExactCallArgumentRepresentations(
			instruction.attributes[CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE],
			target?.parameters.length,
		);
		if (instruction.opcode !== "call" || target === undefined || claim === undefined) {
			fail(`instruction @${instruction.id} carries an invalid exact call-argument claim`);
		}
		for (const [index, representation] of claim.entries()) {
			if (representation === "boxed") continue;
			const argument = instruction.inputs[index + 2];
			if (
				argument === undefined ||
				analysis.exactScalar(fn.functionIndex, argument) !== representation
			) {
				fail(
					`instruction @${instruction.id} no longer proves ${representation} argument ${index}`,
				);
			}
		}
	}
}

function verifyFiniteDispatchClaims(program: CoreProgram): void {
	for (const fn of program.functions) {
		const definitions = new Map<CoreValueId, CoreInstruction>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				for (const output of instruction.outputs) definitions.set(output, instruction);
			}
		}
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const target = instruction.attributes[CORE_FINITE_DISPATCH_TARGET_ATTRIBUTE];
				if (target === undefined) continue;
				const where = `instruction @${instruction.id} in function ${fn.functionIndex}`;
				if (
					instruction.opcode !== "call" ||
					typeof target !== "number" ||
					!Number.isSafeInteger(target) ||
					target < 0 ||
					program.functions[target] === undefined ||
					instruction.attributes.directFunctionIndex !== target
				) {
					fail(`${where} carries an invalid finite-dispatch target`);
				}
				const predecessors = fn.blocks.filter((candidate) =>
					coreTerminatorEdges(candidate.terminator).some(
						({ block: targetBlock }) => targetBlock === block.id,
					),
				);
				const guarded =
					predecessors.length === 1 &&
					predecessors.some((candidate) => {
						if (
							candidate.terminator.kind !== "branch" ||
							candidate.terminator.consequent.block !== block.id
						) {
							return false;
						}
						const guard = definitions.get(candidate.terminator.condition);
						return (
							guard?.opcode === "guardFunctionIndex" &&
							guard.attributes.functionIndex === target &&
							guard.inputs[0] === instruction.inputs[0]
						);
					});
				if (!guarded) fail(`${where} is not protected by its function-index guard`);
			}
		}
	}
}

function verifyExactScalarAfterTdzClaims(
	program: CoreProgram,
	valueKinds: () => CoreValueKindAnalysis,
): void {
	const claims = program.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) =>
			block.instructions.flatMap((instruction, index) =>
				CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE in instruction.attributes
					? [{ fn, block, instruction, index }]
					: [],
			),
		),
	);
	if (claims.length === 0) return;
	const analysis = valueKinds();
	const representations = new Map(
		program.functions.map(
			(fn) =>
				[
					fn.functionIndex,
					new Map(
						fn.values.map(({ id, representation }) => [id, representation] as const),
					),
				] as const,
		),
	);
	for (const { fn, block, instruction, index } of claims) {
		const input = instruction.inputs[0];
		const output = instruction.outputs[0];
		const claim = instruction.attributes[CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE];
		const representation =
			output === undefined
				? undefined
				: representations.get(fn.functionIndex)?.get(output);
		const check = block.instructions[index - 1];
		if (
			instruction.opcode !== "move" ||
			instruction.inputs.length !== 1 ||
			instruction.outputs.length !== 1 ||
			(claim !== "int32" &&
				claim !== "number" &&
				claim !== "boolean" &&
				claim !== "string") ||
			representation !==
				(claim === "int32"
					? "i32"
					: claim === "number"
						? "f64"
						: claim === "boolean"
							? "boolean"
							: "string") ||
			check?.opcode !== "throwIfTdz" ||
			check.inputs[0] !== input ||
			input === undefined ||
			output === undefined ||
			analysis.exactScalar(fn.functionIndex, input) !== claim
		) {
			fail(`instruction @${instruction.id} carries an invalid post-TDZ scalar claim`);
		}
	}
}

function verifyExactBinaryInputKindClaims(
	program: CoreProgram,
	valueKinds: () => CoreValueKindAnalysis,
): void {
	const claims = program.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) =>
			block.instructions
				.filter(
					(instruction) =>
						CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE in instruction.attributes,
				)
				.map((instruction) => ({ fn, instruction })),
		),
	);
	if (claims.length === 0) return;
	const analysis = valueKinds();
	for (const { fn, instruction } of claims) {
		const claim = coreExactBinaryInputKindMasks(
			instruction.attributes[CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE],
		);
		if (
			instruction.opcode !== "binary" ||
			claim === undefined ||
			!coreBinaryInputKindMasksHaveExactNativeSemantics(
				instruction.attributes.operator,
				claim,
			)
		) {
			fail(`instruction @${instruction.id} carries an invalid exact binary-input claim`);
		}
		for (const [index, mask] of claim.entries()) {
			const input = instruction.inputs[index];
			if (input === undefined || analysis.kindMask(fn.functionIndex, input) !== mask) {
				fail(
					`instruction @${instruction.id} no longer proves binary input kind mask ${mask}`,
				);
			}
		}
	}
}

function verifyPreTargetClaims(
	program: CoreProgram,
	registry: CoreOpcodeRegistry,
	compilationContext: CoreCompilationContext | undefined,
	summaries: () => CoreProgramSummaries,
	valueClasses: () => CoreValueClassAnalysis,
	valueKinds: () => CoreValueKindAnalysis,
): void {
	verifyKnownOwnSlotClaims(program, registry, true, summaries, compilationContext);
	verifyExactTypedArrayClaims(program, valueClasses);
	verifyExactCollectionReceiverClaims(program, valueClasses);
	verifyExactScalarAfterTdzClaims(program, valueKinds);
	verifyExactCallArgumentClaims(program, valueKinds);
	verifyExactBinaryInputKindClaims(program, valueKinds);
	for (const fn of program.functions) {
		verifyContainedDenseArrayElementClaims(
			fn,
			registry,
			program.stringConstants,
			compilationContext,
		);
	}
}

function verifyCoreProgramGraph(
	program: CoreProgram,
	registry: CoreOpcodeRegistry,
	context: CoreVerificationContext | undefined,
	compilationContext: CoreCompilationContext | undefined,
	commonAlreadyVerified: boolean,
	initialSummaries?: CoreProgramSummaries,
): void {
	let summariesAnalysis = initialSummaries;
	const summaries = (): CoreProgramSummaries =>
		(summariesAnalysis ??= analyzeCoreProgramSummaries(
			program,
			registry,
			compilationContext,
		));
	let valueClassAnalysis: CoreValueClassAnalysis | undefined;
	const valueClasses = (): CoreValueClassAnalysis =>
		(valueClassAnalysis ??= analyzeCoreValueClasses(
			program,
			compilationContext,
			undefined,
			summaries(),
		));
	let valueKindAnalysis: CoreValueKindAnalysis | undefined;
	const valueKinds = (): CoreValueKindAnalysis =>
		(valueKindAnalysis ??= analyzeCoreValueKinds(
			program,
			compilationContext,
			summaries(),
		));
	if (commonAlreadyVerified) {
		if (context?.stage === "pre-target") {
			verifyPreTargetClaims(
				program,
				registry,
				compilationContext,
				summaries,
				valueClasses,
				valueKinds,
			);
		}
		return;
	}
	if (!Number.isSafeInteger(program.globalCount) || program.globalCount < 0) {
		fail(`invalid global count ${program.globalCount}`);
	}
	if (compilationContext !== undefined) {
		const globalValue: unknown = compilationContext.data.singleAssignmentGlobalSlots;
		if (!Array.isArray(globalValue))
			fail("missing single-assignment global-slot metadata");
		const globals = globalValue as ReadonlyArray<unknown>;
		for (const [index, rawSlot] of globals.entries()) {
			const slot = typeof rawSlot === "number" ? rawSlot : Number.NaN;
			const previous = globals[index - 1];
			if (
				!Number.isSafeInteger(slot) ||
				slot < 0 ||
				slot >= program.globalCount ||
				(index > 0 && typeof previous === "number" && previous >= slot)
			) {
				fail(`invalid single-assignment global slot ${slot}`);
			}
		}
		const capturedValue: unknown = compilationContext.data.singleAssignmentCapturedSlots;
		if (!Array.isArray(capturedValue))
			fail("missing single-assignment captured-slot metadata");
		const captured = capturedValue as ReadonlyArray<unknown>;
		let previousOwner = 0;
		let previousIndex = 0;
		let hasPrevious = false;
		for (const rawCell of captured) {
			const cell =
				typeof rawCell === "object" && rawCell !== null
					? (rawCell as Record<string, unknown>)
					: undefined;
			const owner = typeof cell?.owner === "number" ? cell.owner : Number.NaN;
			const index = typeof cell?.index === "number" ? cell.index : Number.NaN;
			if (
				!Number.isSafeInteger(owner) ||
				owner >= program.functions.length ||
				!Number.isSafeInteger(index) ||
				index < 0 ||
				(hasPrevious &&
					(previousOwner > owner || (previousOwner === owner && previousIndex >= index)))
			) {
				fail(`invalid single-assignment captured slot ${String(owner)}:${String(index)}`);
			}
			previousOwner = owner;
			previousIndex = index;
			hasPrevious = true;
		}
	}
	for (const [index, units] of program.stringConstants.entries()) {
		for (const unit of units) {
			if (!Number.isSafeInteger(unit) || unit < 0 || unit > 0xffff) {
				fail(`string constant ${index} contains invalid UTF-16 unit ${unit}`);
			}
		}
	}
	for (const [index, value] of program.bigintConstants.entries()) {
		if (typeof value !== "bigint") fail(`bigint constant ${index} is not a bigint`);
	}
	for (const [index, value] of program.literalTemplateData.entries()) {
		if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
			fail(`literal template word ${index} is invalid`);
		}
	}
	for (const [index, position] of program.sourcePositions.entries()) {
		if (
			!Number.isSafeInteger(position.line) ||
			position.line < 1 ||
			!Number.isSafeInteger(position.column) ||
			position.column < 0
		) {
			fail(`source position ${index} is invalid`);
		}
		if (
			position.callerPosId !== undefined &&
			(!Number.isSafeInteger(position.callerPosId) ||
				position.callerPosId < -1 ||
				position.callerPosId >= program.sourcePositions.length)
		) {
			fail(`source position ${index} has invalid caller position`);
		}
	}
	const hasExactShapeEffectFacts = program.functions.some((fn) =>
		fn.facts.some(({ kind }) => kind === CORE_EXACT_SHAPE_OWN_SLOT_EFFECT_FACT),
	);
	if (context?.stage === "pre-target") {
		verifyPreTargetClaims(
			program,
			registry,
			compilationContext,
			summaries,
			valueClasses,
			valueKinds,
		);
	} else {
		verifyKnownOwnSlotClaims(
			program,
			registry,
			hasExactShapeEffectFacts,
			summaries,
			compilationContext,
		);
	}
	for (const [index, fn] of program.functions.entries()) {
		if (fn.functionIndex !== index) {
			fail(`function index ${fn.functionIndex} is stored at program index ${index}`);
		}
		if (fn.metadata.nameStringIndex >= program.stringConstants.length) {
			fail(`function ${index} has unknown name string ${fn.metadata.nameStringIndex}`);
		}
		verifyCoreFunction(fn, registry, context, program.stringConstants);
		verifyFreshArrayLengthClaims(fn, registry, program.stringConstants);
		withVerificationContext(
			context === undefined ? undefined : { ...context, functionIndex: index },
			() => {
				for (const block of fn.blocks) {
					for (const instruction of [...block.instructions, block.terminator]) {
						if (
							instruction.sourcePosition !== undefined &&
							instruction.sourcePosition >= program.sourcePositions.length
						) {
							fail(
								`instruction @${instruction.id} has unknown source position ${instruction.sourcePosition}`,
							);
						}
					}
				}
			},
		);
	}
	verifySummaryClaims(program, registry, summaries);
	verifyFiniteDispatchClaims(program);
	verifyPrimitiveOperatorEffectRefinements(program, valueKinds);
	verifyExactShapeOwnSlotEffectRefinements(program);
	verifyExactCollectionBuiltinEffectRefinements(program);
}
