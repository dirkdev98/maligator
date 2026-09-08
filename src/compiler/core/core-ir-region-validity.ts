import { knownBuiltinCallProves } from "../shared/compiler-facts.ts";
import type { CompilerGuardPlan, KnownBuiltinCall } from "../shared/compiler-facts.ts";
import type { FactDependency } from "../shared/fact-implication.ts";
import { factDependencyArraysEqual } from "../shared/fact-implication.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { analyzeCoreCallGraph } from "./core-ir-call-targets.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import { discoverCoreLocalSpecializationCandidates } from "./core-ir-provenance.ts";
import type { CoreLocalSpecializationCandidate } from "./core-ir-provenance.ts";
import {
	coreTargetSupportsNumericFusionOperator,
	coreTargetSupportsSpecialization,
} from "./core-ir-region-strategies.ts";
import type {
	CoreOptimizationPlan,
	CorePlanAdmission,
	CorePlanCost,
	CorePlanRepresentation,
	CorePlanSpecialization,
	VerifiedCoreOptimizationPlan,
} from "./core-ir-regions.ts";
import type {
	CoreBlockId,
	CoreEffectDomain,
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
	CoreRepresentation,
} from "./core-ir.ts";
import { coreBlockId, coreInstructionId } from "./core-ir.ts";
import { coreSpecializedOnlyFunctions } from "./core-native-body-reachability.ts";
import {
	coreArgumentObservation,
	coreNativeEntryProofIsCurrent,
} from "./core-native-entry-analysis.ts";
import {
	coreOperatorInputProofIsCurrent,
	coreUnsignedArithmeticProofIsCurrent,
} from "./core-native-numeric-analysis.ts";
import { certifyCoreOptimizationPlan } from "./core-optimization-plan-certificate.ts";
import { projectCoreSpecializationRecipes } from "./core-specialization-recipes.ts";
import type { CoreFunctionStore, CoreProgram, SealedCoreProgram } from "./core-store.ts";

const EPOCH_INVALIDATING_WRITES: ReadonlySet<CoreEffectDomain> = new Set([
	"object-property",
	"array-element",
	"global-property",
	"host",
	"io",
]);

function bodyInstructionCount(fn: CoreFunctionStore, block: CoreBlockId): number {
	const terminator = fn.blockTerminator(block);
	let count = 0;
	for (
		let cursor = fn.kernel.blockFirstInstruction(block);
		cursor >= 0 && cursor !== terminator;
		cursor = fn.kernel.instructionNext(coreInstructionId(cursor))
	) {
		count++;
	}
	return count;
}

export interface CorePlanAdmissionQuery {
	readonly anchor: CoreInstructionId;
	readonly dependencies: ReadonlyArray<FactDependency>;
	readonly claimedInstructions: ReadonlyArray<CoreInstructionId>;
	readonly ordinaryBlocks: ReadonlyArray<CoreBlockId>;
	readonly exceptionalBlocks: ReadonlyArray<CoreBlockId>;
}

function instructionEpochTransparent(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): boolean {
	const effects = coreInstructionEffects(fn, instruction);
	if (effects.maySuspend) return false;
	const opcode = fn.instructionOpcodeName(instruction);
	let scalarArithmetic = opcode === "binary" || opcode === "unary";
	const operandStart = fn.kernel.instructionOperandStart(instruction);
	const operandCount = fn.kernel.instructionOperandCount(instruction);
	for (let index = 0; scalarArithmetic && index < operandCount; index++) {
		scalarArithmetic =
			fn.valueRepresentation(fn.kernel.operandAt(operandStart + index)) !== "boxed";
	}
	if (!scalarArithmetic && effects.callsUserCode) return false;
	return !effects.writes.some(
		(domain) =>
			EPOCH_INVALIDATING_WRITES.has(domain) && !(scalarArithmetic && domain === "host"),
	);
}

function planInteriorKeepsAdmission(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	query: CorePlanAdmissionQuery,
): boolean {
	const interior = new Set([...query.ordinaryBlocks, ...query.exceptionalBlocks]);
	if (!fn.isInstructionLive(query.anchor)) return false;
	const anchorBlock = fn.instructionBlock(query.anchor);
	if (!interior.has(anchorBlock)) return false;
	const order = new Map<CoreInstructionId, number>();
	for (const block of interior) {
		let index = 0;
		const terminator = fn.blockTerminator(block);
		for (
			let cursor = fn.kernel.blockFirstInstruction(block);
			cursor >= 0 && cursor !== terminator;
			cursor = fn.kernel.instructionNext(coreInstructionId(cursor))
		) {
			const instruction = coreInstructionId(cursor);
			order.set(instruction, index++);
		}
		order.set(terminator, index);
	}
	const anchorOrder = order.get(query.anchor);
	if (anchorOrder === undefined) return false;
	for (const claimed of query.claimedInstructions) {
		if (!fn.isInstructionLive(claimed)) return false;
		const block = fn.instructionBlock(claimed);
		const claimedOrder = order.get(claimed);
		if (
			claimedOrder === undefined ||
			!interior.has(block) ||
			!cfg.dominates(anchorBlock, block) ||
			(block === anchorBlock && claimedOrder < anchorOrder)
		) {
			return false;
		}
	}
	const handler = fn.kernel.blockHandlerBlock(anchorBlock);
	if (handler !== undefined && interior.has(handler)) return false;
	for (const block of interior) {
		if (!cfg.dominates(anchorBlock, block)) return false;
		if (
			block !== anchorBlock &&
			(cfg.predecessors[block] ?? []).some(({ from }) => !interior.has(from))
		) {
			return false;
		}
	}
	const scanEnds = new Map<CoreBlockId, number>();
	const markEnd = (block: CoreBlockId, end: number): void => {
		scanEnds.set(block, Math.max(scanEnds.get(block) ?? -1, end));
	};
	for (const claimed of query.claimedInstructions) {
		const target = fn.instructionBlock(claimed);
		markEnd(target, order.get(claimed)!);
		if (target === anchorBlock) continue;
		const pending = [target];
		const visited = new Set<CoreBlockId>([target]);
		while (pending.length > 0) {
			const block = pending.pop()!;
			for (const { from } of cfg.predecessors[block] ?? []) {
				if (!interior.has(from)) continue;
				markEnd(from, bodyInstructionCount(fn, from));
				if (from === anchorBlock || visited.has(from)) continue;
				visited.add(from);
				pending.push(from);
			}
		}
	}
	for (const [block, end] of scanEnds) {
		const start = block === anchorBlock ? anchorOrder + 1 : 0;
		const terminator = fn.blockTerminator(block);
		let index = 0;
		for (
			let cursor = fn.kernel.blockFirstInstruction(block);
			cursor >= 0 && cursor !== terminator;
			cursor = fn.kernel.instructionNext(coreInstructionId(cursor)), index++
		) {
			const instruction = coreInstructionId(cursor);
			if (index < start || index > end) continue;
			if (!instructionEpochTransparent(fn, instruction)) return false;
		}
	}
	return true;
}

export function corePlanAdmissionMode(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	query: CorePlanAdmissionQuery,
): CorePlanAdmission["mode"] {
	if (!query.dependencies.some(({ kind }) => kind === "epoch")) return "stable";
	return planInteriorKeepsAdmission(fn, cfg, query) ? "stable" : "per-use";
}

function stableVersionKey(program: CoreProgram): string {
	const programPart = Object.values(program.versions).join(":");
	const functionPart = [...program.functionIds()]
		.map(
			(functionId) =>
				`${functionId}:${Object.values(program.function(functionId).versions).join(":")}`,
		)
		.join("|");
	return `p:${programPart}|f:${functionPart}`;
}

export function corePlanVersionStamp(
	program: CoreProgram,
): CoreOptimizationPlan["version"] {
	return Object.freeze({
		key: stableVersionKey(program),
		program: Object.freeze({ ...program.versions }),
		functions: Object.freeze(
			[...program.functionIds()].map((functionId) =>
				Object.freeze({
					function: functionId,
					versions: Object.freeze({ ...program.function(functionId).versions }),
				}),
			),
		),
	});
}

export class CoreOptimizationPlanVerificationError extends Error {
	constructor(message: string) {
		super(`Invalid Core optimization plan: ${message}`);
		this.name = "CoreOptimizationPlanVerificationError";
	}
}

function fail(message: string): never {
	throw new CoreOptimizationPlanVerificationError(message);
}

function sameRecord(left: object, right: object): boolean {
	const leftRecord = left as Readonly<Record<string, unknown>>;
	const rightRecord = right as Readonly<Record<string, unknown>>;
	const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
	return [...keys].every((key) => leftRecord[key] === rightRecord[key]);
}

function sameNumbers(left: ReadonlyArray<number>, right: ReadonlyArray<number>): boolean {
	return (
		left.length === right.length && left.every((value, index) => value === right[index])
	);
}

function verifyCost(cost: CorePlanCost, id: string): void {
	for (const [name, value] of Object.entries(cost)) {
		if (!Number.isSafeInteger(value) || value < 0) {
			fail(`${id} has invalid ${name} cost ${value}`);
		}
	}
}

function requireInstruction(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	role: string,
	id: string,
): void {
	if (!fn.isInstructionLive(instruction))
		fail(`${id} names stale ${role} @${instruction}`);
}

function blockHasExceptionalExit(fn: CoreFunctionStore, block: CoreBlockId): boolean {
	const terminator = fn.blockTerminator(block);
	if (fn.instructionKind(terminator) === "throw") return true;
	for (
		let cursor = fn.kernel.blockFirstInstruction(block);
		cursor >= 0 && cursor !== terminator;
		cursor = fn.kernel.instructionNext(coreInstructionId(cursor))
	) {
		const instruction = coreInstructionId(cursor);
		const effects =
			fn.instructionEffectRefinement(instruction)?.effects ??
			fn.registry.byId(fn.instructionOpcode(instruction)).effects;
		if (effects.mayThrow) return true;
	}
	return false;
}

function exceptionalReversePostorder(fn: CoreFunctionStore): ReadonlyArray<CoreBlockId> {
	const reached = new Set<CoreBlockId>([fn.entry]);
	const postorder: Array<CoreBlockId> = [];
	const pending: Array<{ readonly block: CoreBlockId; next: number }> = [
		{ block: fn.entry, next: 0 },
	];
	while (pending.length > 0) {
		const frame = pending.at(-1)!;
		const terminator = fn.blockTerminator(frame.block);
		const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
		const edgeCount = fn.kernel.terminatorEdgeCount(terminator);
		let target: CoreBlockId | undefined;
		if (frame.next < edgeCount) {
			target = fn.kernel.terminatorEdgeBlock(edgeStart + frame.next++);
		} else if (frame.next === edgeCount) {
			frame.next++;
			const handler = fn.kernel.blockHandlerBlock(frame.block);
			if (handler !== undefined && blockHasExceptionalExit(fn, frame.block)) {
				target = handler;
			}
		}
		if (target !== undefined) {
			if (!reached.has(target)) {
				reached.add(target);
				pending.push({ block: target, next: 0 });
			}
			continue;
		}
		postorder.push(frame.block);
		pending.pop();
	}
	return postorder.reverse();
}

interface CorePlanBlockProof {
	readonly included: ReadonlySet<CoreBlockId>;
	readonly instructionOrder: ReadonlyMap<CoreInstructionId, number>;
}

function verifyBlockOrders(
	program: SealedCoreProgram,
	plan: CoreOptimizationPlan,
): ReadonlyMap<CoreFunctionId, CorePlanBlockProof> {
	if (plan.blockOrders.length !== plan.liveFunctions.length) {
		fail("block lowering order does not match the live function set");
	}
	const proofs = new Map<CoreFunctionId, CorePlanBlockProof>();
	for (const [index, entry] of plan.blockOrders.entries()) {
		const functionId = plan.liveFunctions[index];
		if (functionId === undefined || entry.function !== functionId) {
			fail("block lowering order does not follow the live function order");
		}
		const fn = program.function(entry.function);
		const expectedBlocks = exceptionalReversePostorder(fn);
		if (
			entry.blocks.length !== expectedBlocks.length ||
			entry.blocks.some((block, blockIndex) => block !== expectedBlocks[blockIndex])
		) {
			fail(
				`block lowering order for function ${entry.function} is not exceptional-CFG RPO`,
			);
		}
		const included = new Set(entry.blocks);
		const expectedOmitted: Array<CoreBlockId> = [];
		for (let blockIndex = 0; blockIndex < fn.blockCapacity; blockIndex++) {
			const block = coreBlockId(blockIndex);
			if (fn.kernel.blockLive(block) !== 0 && !included.has(block)) {
				expectedOmitted.push(block);
			}
		}
		if (
			entry.omittedBlocks.length !== expectedOmitted.length ||
			entry.omittedBlocks.some(
				(block, blockIndex) => block !== expectedOmitted[blockIndex],
			)
		) {
			fail(
				`block lowering order for function ${entry.function} misclassifies unreachable blocks`,
			);
		}
		const instructionOrder = new Map<CoreInstructionId, number>();
		let instructionIndex = 0;
		for (const block of entry.blocks) {
			const terminator = fn.blockTerminator(block);
			for (
				let cursor = fn.kernel.blockFirstInstruction(block);
				cursor >= 0 && cursor !== terminator;
				cursor = fn.kernel.instructionNext(coreInstructionId(cursor))
			) {
				const instruction = coreInstructionId(cursor);
				instructionOrder.set(instruction, instructionIndex++);
			}
		}
		proofs.set(entry.function, { included, instructionOrder });
	}
	return proofs;
}

function localCandidate(
	program: SealedCoreProgram,
	cache: Map<
		CoreFunctionId,
		ReadonlyMap<number, ReadonlyArray<CoreLocalSpecializationCandidate>>
	>,
	functionId: CoreFunctionId,
	key: string,
): CoreLocalSpecializationCandidate | undefined {
	let candidates = cache.get(functionId);
	if (candidates === undefined) {
		const indexed = new Map<number, Array<CoreLocalSpecializationCandidate>>();
		for (const candidate of discoverCoreLocalSpecializationCandidates(program, functionId)
			.candidates) {
			const hash = numericStringHash(candidate.key);
			const bucket = indexed.get(hash) ?? [];
			bucket.push(candidate);
			indexed.set(hash, bucket);
		}
		candidates = indexed;
		cache.set(functionId, candidates);
	}
	return candidates
		.get(numericStringHash(key))
		?.find((candidate) => candidate.key === key);
}

function numericStringHash(value: string): number {
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

function validBuiltinPlanGuard(
	guard: CompilerGuardPlan,
	kind:
		| "string-split-projection"
		| "string-slice-number"
		| "regexp-exec-projection"
		| "string-split-cursor"
		| "string-char-code-at-chain"
		| "builtin-collection-call-chain",
	functionId: CoreFunctionId,
	anchor: CoreInstructionId,
	identity: "authority-invariant" | "runtime-guarded",
	materialize: boolean,
	builtinCall: KnownBuiltinCall,
	operation: string,
): boolean {
	if (
		!knownBuiltinCallProves(builtinCall, operation) ||
		builtinCall.identity.kind !== "known" ||
		!factDependencyArraysEqual(
			builtinCall.identity.proof.dependencies,
			guard.dependencies,
		)
	)
		return false;
	if (guard.dependencies.length !== 1) return false;
	const dependency = guard.dependencies[0];
	const expectedIdentity =
		dependency?.kind === "world" && dependency.fact === "primordials.locked"
			? "authority-invariant"
			: dependency?.kind === "epoch" && dependency.family === "watched-methods"
				? "runtime-guarded"
				: undefined;
	if (identity !== expectedIdentity) return false;
	const fallbackId = `region-twin:${kind}:${functionId}:${anchor}`;
	const materializeId = `${kind}:${functionId}:${anchor}`;
	return (
		guard.obligations.some(
			(obligation) =>
				obligation.kind === "fallback" &&
				obligation.id === fallbackId &&
				obligation.cause === "materialization",
		) &&
		(materialize
			? guard.obligations.some(
					(obligation) =>
						obligation.kind === "materialize" &&
						obligation.id === materializeId &&
						obligation.cause === "materialization",
				)
			: guard.obligations.every((obligation) => obligation.kind !== "materialize"))
	);
}

function validProtectorPlanGuard(
	guard: {
		readonly dependencies: ReadonlyArray<{
			readonly kind: string;
			readonly fact?: string;
			readonly family?: string;
		}>;
		readonly obligations: ReadonlyArray<{
			readonly kind: string;
			readonly id: string;
			readonly cause: string;
		}>;
	},
	kind: "regexp-iterator-projection" | "iterator-entry-pair-virtualization",
	functionId: CoreFunctionId,
	anchor: CoreInstructionId,
): boolean {
	if (guard.dependencies.length !== 1) return false;
	const dependency = guard.dependencies[0];
	if (
		!(
			(dependency?.kind === "world" && dependency.fact === "primordials.locked") ||
			(dependency?.kind === "epoch" && dependency.family === "watched-methods")
		)
	)
		return false;
	return (
		guard.obligations.some(
			(obligation) =>
				obligation.kind === "fallback" &&
				obligation.id === `region-twin:${kind}:${functionId}:${anchor}` &&
				obligation.cause === "materialization",
		) &&
		guard.obligations.some(
			(obligation) =>
				obligation.kind === "materialize" &&
				obligation.id === `${kind}:${functionId}:${anchor}` &&
				obligation.cause === "materialization",
		)
	);
}

function specializationAdmissionDependencies(
	selection: CorePlanSpecialization,
): ReadonlyArray<FactDependency> {
	const guard: unknown = (() => {
		switch (selection.kind) {
			case "string-split-cursor":
				return selection.stringSplitCursor.guard;
			case "string-split-projection":
				return selection.stringSplitProjection.guard;
			case "string-slice-number":
				return selection.stringSliceNumber.guard;
			case "regexp-exec-projection":
				return selection.regexpExecProjection.guard;
			case "regexp-iterator-projection":
				return selection.regexpIteratorProjection.guard;
			case "string-char-code-at-chain":
				return selection.stringCharCodeAt.guard;
			case "builtin-collection-call-chain":
				return selection.builtinCollectionCall.guard;
			case "iterator-result-virtualization":
				return selection.iteratorResultVirtualization.guard;
			case "iterator-entry-pair-virtualization":
				return selection.iteratorEntryPairVirtualization.guard;
			default:
				return undefined;
		}
	})();
	if (guard === undefined) return [];
	if (
		guard === null ||
		typeof guard !== "object" ||
		!Array.isArray((guard as { dependencies?: unknown }).dependencies) ||
		!Array.isArray((guard as { obligations?: unknown }).obligations)
	) {
		fail(`${selection.id} has an unreadable admission guard`);
	}
	return (guard as { readonly dependencies: ReadonlyArray<FactDependency> }).dependencies;
}

function specializationAdmissionAnchor(
	selection: CorePlanSpecialization,
): CoreInstructionId {
	switch (selection.kind) {
		case "string-split-cursor":
			return selection.stringSplitCursor.property ?? selection.stringSplitCursor.call;
		case "string-split-projection":
			return (
				selection.stringSplitProjection.property ?? selection.stringSplitProjection.call
			);
		case "string-slice-number":
			return (
				selection.stringSliceNumber.property ?? selection.stringSliceNumber.sliceCall
			);
		case "regexp-exec-projection":
			return (
				selection.regexpExecProjection.property ?? selection.regexpExecProjection.call
			);
		case "string-char-code-at-chain":
			return selection.stringCharCodeAt.property;
		case "builtin-collection-call-chain":
			return selection.builtinCollectionCall.property;
		case "function-call-chain":
			return selection.functionCall.property;
		default:
			return selection.anchors[0]!;
	}
}

function verifySpecializationAdmission(
	program: SealedCoreProgram,
	fn: CoreFunctionStore,
	selection: CorePlanSpecialization,
): void {
	const admission = selection.admission;
	if (
		admission === undefined ||
		admission.anchor !== specializationAdmissionAnchor(selection) ||
		!selection.claimedInstructions.includes(admission.anchor)
	) {
		fail(`${selection.id} has an invalid admission anchor`);
	}
	if (
		admission.mode !== "capture" &&
		admission.mode !== "stable" &&
		admission.mode !== "per-use"
	) {
		fail(`${selection.id} has an invalid admission mode`);
	}
	const dependencies = specializationAdmissionDependencies(selection);
	if (
		dependencies.some(
			(dependency) => dependency.kind !== "world" && dependency.kind !== "epoch",
		)
	) {
		fail(`${selection.id} has an admission dependency the target cannot lower`);
	}
	const supportedEpochs = new Set([
		"primitive-methods",
		"watched-methods",
		"array-elements",
	]);
	const unsupportedEpoch = dependencies.find(
		(dependency) =>
			dependency.kind === "epoch" && !supportedEpochs.has(dependency.family),
	);
	if (unsupportedEpoch?.kind === "epoch") {
		fail(
			`${selection.id} depends on unlowerable epoch family ${unsupportedEpoch.family}`,
		);
	}
	const expected =
		selection.kind === "string-char-code-at-chain" ||
		selection.kind === "builtin-collection-call-chain" ||
		selection.kind === "iterator-entry-pair-virtualization" ||
		selection.kind === "function-call-chain"
			? "capture"
			: selection.kind === "guarded-direct-call"
				? "per-use"
				: corePlanAdmissionMode(fn, buildCoreControlFlow(program, selection.function), {
						anchor: admission.anchor,
						dependencies,
						claimedInstructions: selection.claimedInstructions,
						ordinaryBlocks: selection.ordinaryBlocks,
						exceptionalBlocks: selection.exceptionalBlocks,
					});
	if (admission.mode !== expected) {
		fail(
			`${selection.id} claims ${admission.mode} admission where Core proves ${expected}`,
		);
	}
}

function verifySpecialization(
	program: SealedCoreProgram,
	plan: CoreOptimizationPlan,
	selection: CorePlanSpecialization,
	ids: Array<string>,
	claimedInstructions: Map<
		CoreFunctionId,
		Map<
			CoreInstructionId,
			{
				exclusive: boolean;
				readonly overlays: Set<CorePlanSpecialization["kind"]>;
			}
		>
	>,
	blocks: CorePlanBlockProof,
	localCandidates: Map<
		CoreFunctionId,
		ReadonlyMap<number, ReadonlyArray<CoreLocalSpecializationCandidate>>
	>,
): void {
	if (ids.includes(selection.id)) fail(`duplicate specialization id ${selection.id}`);
	ids.push(selection.id);
	if (!coreTargetSupportsSpecialization(selection.kind)) {
		fail(`${selection.id} has no target implementation for ${selection.kind}`);
	}
	if (selection.target !== "native" || selection.fallback !== "canonical-core") {
		fail(`${selection.id} does not retain the canonical generic fallback`);
	}
	if (!plan.liveFunctions.includes(selection.function)) {
		fail(`${selection.id} belongs to dead function ${selection.function}`);
	}
	const fn = program.function(selection.function);
	if (selection.anchors.length === 0 || selection.claimedInstructions.length === 0) {
		fail(`${selection.id} has an empty anchor or claim set`);
	}
	const claims = new Set(selection.claimedInstructions);
	if (claims.size !== selection.claimedInstructions.length) {
		fail(`${selection.id} repeats a claimed instruction`);
	}
	for (const anchor of selection.anchors) {
		requireInstruction(fn, anchor, "anchor", selection.id);
		if (!claims.has(anchor)) fail(`${selection.id} anchor @${anchor} is not claimed`);
	}
	verifySpecializationAdmission(program, fn, selection);
	const ordinary = new Set(selection.ordinaryBlocks);
	const exceptional = new Set(selection.exceptionalBlocks);
	for (const block of [...ordinary, ...exceptional]) {
		if (!fn.isBlockLive(block)) fail(`${selection.id} names stale block b${block}`);
		if (!blocks.included.has(block)) {
			fail(`${selection.id} names omitted block b${block}`);
		}
	}
	for (const instruction of claims) {
		requireInstruction(fn, instruction, "claim", selection.id);
		const block = fn.instructionBlock(instruction);
		if (!blocks.included.has(block)) {
			fail(`${selection.id} claims omitted instruction @${instruction}`);
		}
		if (!ordinary.has(block) && !exceptional.has(block)) {
			fail(`${selection.id} claim @${instruction} is outside its control-flow envelope`);
		}
	}
	const requirements = new Set<number>();
	for (const requirement of selection.requiredRepresentations) {
		if (requirements.has(requirement.value)) {
			fail(`${selection.id} repeats representation requirement %${requirement.value}`);
		}
		requirements.add(requirement.value);
		if (
			!fn.isValueLive(requirement.value) ||
			fn.valueRepresentation(requirement.value) !== requirement.representation
		) {
			fail(
				`${selection.id} has a stale representation requirement for %${requirement.value}`,
			);
		}
	}
	const owned =
		claimedInstructions.get(selection.function) ??
		new Map<
			CoreInstructionId,
			{
				exclusive: boolean;
				readonly overlays: Set<CorePlanSpecialization["kind"]>;
			}
		>();
	for (const instruction of claims) {
		const state = owned.get(instruction) ?? {
			exclusive: false,
			overlays: new Set(),
		};
		if (
			(selection.kind === "guarded-direct-call" && state.exclusive) ||
			(selection.composition === "exclusive" &&
				(state.exclusive || state.overlays.has("guarded-direct-call"))) ||
			(selection.composition === "overlay" && state.overlays.has(selection.kind))
		) {
			fail(`${selection.id} conflicts on @${instruction}`);
		}
		if (selection.composition === "exclusive") state.exclusive = true;
		else state.overlays.add(selection.kind);
		owned.set(instruction, state);
	}
	claimedInstructions.set(selection.function, owned);
	if (selection.kind === "guarded-direct-call") {
		if (
			selection.anchors.length !== 1 ||
			selection.targetFunctions.length === 0 ||
			(selection.representation !== "exact-function" &&
				selection.representation !== "finite-function-set") ||
			(selection.representation === "exact-function" &&
				selection.targetFunctions.length !== 1)
		) {
			fail(`${selection.id} has an invalid guarded-call target set`);
		}
		const anchor = selection.anchors[0]!;
		if (
			fn.instructionKind(anchor) !== "operation" ||
			fn.registry.byId(fn.instructionOpcode(anchor)).callTransfer === undefined
		) {
			fail(`${selection.id} does not anchor a call`);
		}
		for (const target of selection.targetFunctions) {
			if (!plan.liveFunctions.includes(target)) {
				fail(`${selection.id} targets dead function ${target}`);
			}
		}
	}
	if (selection.kind === "numeric-fusion") {
		const candidate = localCandidate(
			program,
			localCandidates,
			selection.function,
			selection.id,
		);
		const expectedBlocks =
			candidate?.instructions === undefined
				? []
				: [
						...new Set(
							candidate.instructions.map((instruction) =>
								fn.instructionBlock(instruction),
							),
						),
					].sort((left, right) => left - right);
		if (
			selection.anchors.length !== 1 ||
			selection.claimedInstructions.length !== 2 ||
			selection.composition !== "overlay" ||
			selection.representation !== "binary-pairs-f64" ||
			selection.targetFunctions.length !== 0 ||
			selection.semanticProtectors.length !== 0
		) {
			fail(`${selection.id} has an invalid numeric-fusion certificate`);
		}
		const anchor = selection.anchors[0]!;
		if (
			fn.instructionKind(anchor) !== "operation" ||
			fn.instructionOpcodeName(anchor) !== "binary" ||
			!coreTargetSupportsNumericFusionOperator(
				fn.instructionAttributes(anchor).operator,
				"start",
			)
		) {
			fail(`${selection.id} does not anchor a supported generic binary operation`);
		}
		const result =
			fn.kernel.instructionResultCount(anchor) === 0
				? undefined
				: fn.kernel.resultAt(fn.kernel.instructionResultStart(anchor));
		if (result === undefined || selection.claimedInstructions[0] !== anchor) {
			fail(`${selection.id} has no numeric-fusion continuation`);
		}
		const finish = selection.claimedInstructions[1]!;
		let finishResultUses = 0;
		const finishOperandStart = fn.kernel.instructionOperandStart(finish);
		const finishOperandCount = fn.kernel.instructionOperandCount(finish);
		for (let index = 0; index < finishOperandCount; index++) {
			if (fn.kernel.operandAt(finishOperandStart + index) === result) finishResultUses++;
		}
		if (
			fn.instructionKind(finish) !== "operation" ||
			fn.instructionOpcodeName(finish) !== "binary" ||
			!coreTargetSupportsNumericFusionOperator(
				fn.instructionAttributes(finish).operator,
				"finish",
			) ||
			finishResultUses !== 1 ||
			blocks.instructionOrder.get(anchor)! >= blocks.instructionOrder.get(finish)!
		) {
			fail(`${selection.id} has an invalid numeric-fusion continuation @${finish}`);
		}
		if (
			candidate?.kind !== "numeric-fusion" ||
			selection.anchors[0] !== candidate.root ||
			!sameNumbers(selection.claimedInstructions, candidate.instructions) ||
			!sameNumbers(selection.ordinaryBlocks, expectedBlocks) ||
			selection.exceptionalBlocks.length !== 0
		) {
			fail(`${selection.id} has an invalid numeric-fusion certificate`);
		}
	}
	if (selection.kind === "fresh-array-length") {
		const candidate = localCandidate(
			program,
			localCandidates,
			selection.function,
			selection.id,
		);
		const fresh = selection.freshArrayLength;
		const expectedBlocks =
			candidate?.instructions === undefined
				? []
				: [
						...new Set(
							candidate.instructions.map((instruction) =>
								fn.instructionBlock(instruction),
							),
						),
					].sort((left, right) => left - right);
		if (
			candidate?.kind !== "fresh-array-length" ||
			selection.anchors.length !== 1 ||
			selection.anchors[0] !== candidate.load ||
			fresh.allocation !== candidate.allocation ||
			fresh.load !== candidate.load ||
			fresh.length !== candidate.length ||
			!sameNumbers(selection.claimedInstructions, candidate.instructions) ||
			!sameNumbers(selection.ordinaryBlocks, expectedBlocks) ||
			!sameNumbers(selection.exceptionalBlocks, candidate.exceptionalBlocks) ||
			selection.composition !== "exclusive" ||
			selection.representation !== "exact-array-length" ||
			selection.semanticProtectors.length !== 0 ||
			selection.targetFunctions.length !== 0
		) {
			fail(`${selection.id} has an invalid fresh-array-length certificate`);
		}
	}
	if (selection.kind === "indexed-length-loop") {
		const candidate = localCandidate(
			program,
			localCandidates,
			selection.function,
			selection.id,
		);
		const indexed = selection.indexedLengthLoop;
		const expectedBlocks =
			candidate?.instructions === undefined
				? []
				: [
						...new Set(
							candidate.instructions.map((instruction) =>
								fn.instructionBlock(instruction),
							),
						),
					].sort((left, right) => left - right);
		if (
			candidate?.kind !== "indexed-length-loop" ||
			selection.anchors.length !== 2 ||
			selection.anchors[0] !== candidate.load ||
			selection.anchors[1] !== candidate.comparison ||
			indexed.load !== candidate.load ||
			indexed.comparison !== candidate.comparison ||
			indexed.lengthPosition !== candidate.lengthPosition ||
			indexed.elements.length !== candidate.elements.length ||
			indexed.elements.some(
				(element, index) =>
					element.instruction !== candidate.elements[index]?.instruction ||
					element.kind !== candidate.elements[index]?.kind,
			) ||
			fn.instructionNext(candidate.load) !== candidate.comparison ||
			!sameNumbers(selection.claimedInstructions, candidate.instructions) ||
			!sameNumbers(selection.ordinaryBlocks, expectedBlocks) ||
			!sameNumbers(selection.exceptionalBlocks, candidate.exceptionalBlocks) ||
			selection.composition !== "exclusive" ||
			selection.representation !== "live-indexed-length-loops" ||
			selection.semanticProtectors.length !== 0 ||
			selection.targetFunctions.length !== 0
		) {
			fail(`${selection.id} has an invalid indexed-length-loop certificate`);
		}
	}
	if (selection.kind === "stack-object-plan") {
		const candidate = localCandidate(
			program,
			localCandidates,
			selection.function,
			selection.id,
		);
		const stack = selection.stackObject;
		const expectedBlocks =
			candidate?.instructions === undefined
				? []
				: [
						...new Set(
							candidate.instructions.map((instruction) =>
								fn.instructionBlock(instruction),
							),
						),
					].sort((left, right) => left - right);
		if (
			candidate?.kind !== "stack-object" ||
			selection.anchors.length !== 1 ||
			selection.anchors[0] !== stack.allocation ||
			stack.allocation !== candidate.allocation ||
			stack.mode !== candidate.mode ||
			stack.slotCount !== candidate.slotCount ||
			!sameNumbers(selection.claimedInstructions, candidate.instructions) ||
			!sameNumbers(selection.ordinaryBlocks, expectedBlocks) ||
			selection.exceptionalBlocks.length !== 0 ||
			selection.composition !== "exclusive" ||
			selection.representation !== "activation-local-fixed-shape-objects" ||
			selection.semanticProtectors.length !== 0 ||
			selection.targetFunctions.length !== 0 ||
			stack.accesses.length !== candidate.accesses.length ||
			stack.accesses.some(
				(access, index) =>
					access.instruction !== candidate.accesses[index]?.instruction ||
					access.slot !== candidate.accesses[index]?.slot,
			) ||
			stack.materializations.length !== candidate.materializations.length ||
			stack.materializations.some(
				(materialization, index) =>
					materialization.instruction !==
						candidate.materializations[index]?.instruction ||
					materialization.kind !== candidate.materializations[index]?.kind,
			)
		) {
			fail(`${selection.id} has an invalid stack-object certificate`);
		}
	}
	if (selection.kind === "dense-array-plan") {
		const candidate = localCandidate(
			program,
			localCandidates,
			selection.function,
			selection.id,
		);
		const dense = selection.denseArray;
		const expectedBlocks =
			candidate?.instructions === undefined
				? []
				: [
						...new Set(
							candidate.instructions.map((instruction) =>
								fn.instructionBlock(instruction),
							),
						),
					].sort((left, right) => left - right);
		if (
			candidate?.kind !== "dense-array" ||
			candidate.mode !== "fresh-indexed-fill" ||
			selection.anchors.length !== 1 ||
			selection.anchors[0] !== dense.allocation ||
			dense.allocation !== candidate.allocation ||
			dense.store !== candidate.store ||
			dense.loopHeader !== candidate.loopHeader ||
			dense.length !== candidate.length ||
			!sameNumbers(selection.claimedInstructions, candidate.instructions) ||
			!sameNumbers(selection.ordinaryBlocks, expectedBlocks) ||
			selection.exceptionalBlocks.length !== 0 ||
			selection.composition !== "exclusive" ||
			selection.representation !== "fresh-dense-indexed-fill" ||
			selection.semanticProtectors.length !== 0 ||
			selection.targetFunctions.length !== 0
		) {
			fail(`${selection.id} has an invalid dense-array certificate`);
		}
	}
	if (selection.kind === "string-split-cursor") {
		const candidate = localCandidate(
			program,
			localCandidates,
			selection.function,
			selection.id,
		);
		const cursor = selection.stringSplitCursor;
		const expectedBlocks =
			candidate?.instructions === undefined
				? []
				: [
						...new Set(
							candidate.instructions.map((instruction) =>
								fn.instructionBlock(instruction),
							),
						),
					].sort((left, right) => left - right);
		const expectedPlacement =
			cursor.property !== undefined &&
			cursor.splitIdentity === "authority-invariant" &&
			fn.instructionBlock(cursor.property) === fn.instructionBlock(cursor.call)
				? "call-fallback"
				: "in-place";
		if (
			candidate?.kind !== "string-split-cursor" ||
			selection.anchors.length !== 4 ||
			selection.anchors[0] !== candidate.call ||
			selection.anchors[1] !== candidate.branch ||
			selection.anchors[2] !== candidate.length ||
			selection.anchors[3] !== candidate.backedge ||
			cursor.property !== candidate.property ||
			cursor.call !== candidate.call ||
			cursor.length !== candidate.length ||
			cursor.compare !== candidate.compare ||
			cursor.branch !== candidate.branch ||
			cursor.element !== candidate.element ||
			cursor.trimProperty !== candidate.trimProperty ||
			cursor.trimCall !== candidate.trimCall ||
			cursor.advance !== candidate.advance ||
			cursor.increment !== candidate.increment ||
			cursor.backedge !== candidate.backedge ||
			cursor.exitBlock !== candidate.exitBlock ||
			cursor.propertyPlacement !== expectedPlacement ||
			!sameNumbers(cursor.resultValues, candidate.resultValues) ||
			!sameNumbers(cursor.primitiveStringLengths, candidate.primitiveStringLengths) ||
			!sameNumbers(selection.claimedInstructions, candidate.instructions) ||
			!sameNumbers(selection.ordinaryBlocks, expectedBlocks) ||
			!sameNumbers(selection.exceptionalBlocks, candidate.exceptionalBlocks) ||
			selection.composition !== "exclusive" ||
			selection.representation !== "split-cursor-spans" ||
			selection.semanticProtectors.length !== 0 ||
			selection.targetFunctions.length !== 0 ||
			!validBuiltinPlanGuard(
				cursor.guard,
				"string-split-cursor",
				selection.function,
				cursor.call,
				cursor.splitIdentity,
				true,
				cursor.splitBuiltinCall,
				"String.prototype.split",
			) ||
			!validBuiltinPlanGuard(
				cursor.guard,
				"string-split-cursor",
				selection.function,
				cursor.trimCall,
				cursor.trimIdentity,
				true,
				cursor.trimBuiltinCall,
				"String.prototype.trim",
			)
		) {
			fail(`${selection.id} has an invalid String.split cursor certificate`);
		}
	}
	if (selection.kind === "string-split-projection") {
		const candidate = localCandidate(
			program,
			localCandidates,
			selection.function,
			selection.id,
		);
		const split = selection.stringSplitProjection;
		const expectedPlacement =
			split.property !== undefined &&
			split.splitIdentity === "authority-invariant" &&
			fn.instructionBlock(split.property) === fn.instructionBlock(split.call)
				? "call-fallback"
				: "in-place";
		const expectedBlocks =
			candidate?.instructions === undefined
				? []
				: [
						...new Set(
							candidate.instructions.map((instruction) =>
								fn.instructionBlock(instruction),
							),
						),
					].sort((left, right) => left - right);
		if (
			candidate?.kind !== "string-split-projection" ||
			selection.anchors.length !== 2 ||
			selection.anchors[0] !== candidate.call ||
			selection.anchors[1] !== candidate.loads[0]?.instruction ||
			split.property !== candidate.property ||
			split.call !== candidate.call ||
			split.separator !== candidate.separator ||
			split.separatorStringIndex !== candidate.separatorStringIndex ||
			!sameNumbers(split.resultValues, candidate.resultValues) ||
			!sameNumbers(selection.claimedInstructions, candidate.instructions) ||
			!sameNumbers(selection.ordinaryBlocks, expectedBlocks) ||
			selection.exceptionalBlocks.length !== 0 ||
			selection.composition !== "exclusive" ||
			selection.representation !== "projected-elements" ||
			selection.semanticProtectors.length !== 0 ||
			selection.targetFunctions.length !== 0 ||
			split.loads.length !== candidate.loads.length ||
			split.loads.some((load, index) => {
				const expected = candidate.loads[index];
				return (
					expected === undefined ||
					load.kind !== expected.kind ||
					load.instruction !== expected.instruction ||
					(load.kind === "element" &&
						(expected.kind !== "element" ||
							load.index !== expected.index ||
							load.key !== expected.key))
				);
			}) ||
			split.propertyPlacement !== expectedPlacement ||
			!validBuiltinPlanGuard(
				split.guard,
				"string-split-projection",
				selection.function,
				split.call,
				split.splitIdentity,
				true,
				split.builtinCall,
				"String.prototype.split",
			)
		) {
			fail(`${selection.id} has an invalid String.split projection certificate`);
		}
	}
	if (selection.kind === "string-slice-number") {
		const candidate = localCandidate(
			program,
			localCandidates,
			selection.function,
			selection.id,
		);
		const slice = selection.stringSliceNumber;
		const expectedBlocks =
			candidate?.instructions === undefined
				? []
				: [
						...new Set(
							candidate.instructions.map((instruction) =>
								fn.instructionBlock(instruction),
							),
						),
					].sort((left, right) => left - right);
		if (
			candidate?.kind !== "string-slice-number" ||
			selection.anchors.length !== 2 ||
			selection.anchors[0] !== candidate.sliceCall ||
			selection.anchors[1] !== candidate.numberCall ||
			slice.property !== candidate.property ||
			slice.sliceCall !== candidate.sliceCall ||
			slice.sliceStartInstruction !== candidate.sliceStartInstruction ||
			slice.numberIntrinsic !== candidate.numberIntrinsic ||
			slice.numberCall !== candidate.numberCall ||
			!Object.is(slice.sliceStart, candidate.sliceStart) ||
			!sameNumbers(selection.claimedInstructions, candidate.instructions) ||
			!sameNumbers(selection.ordinaryBlocks, expectedBlocks) ||
			!sameNumbers(selection.exceptionalBlocks, candidate.exceptionalBlocks) ||
			selection.composition !== "exclusive" ||
			selection.representation !== "primitive-string-span-number" ||
			selection.semanticProtectors.length !== 0 ||
			selection.targetFunctions.length !== 0 ||
			(slice.propertyPlacement !== "in-place" &&
				slice.propertyPlacement !== "call-fallback") ||
			(slice.propertyPlacement === "call-fallback" &&
				(slice.builtinIdentities !== "authority-invariant" ||
					(slice.property !== undefined &&
						fn.instructionBlock(slice.property) !==
							fn.instructionBlock(slice.sliceCall)))) ||
			!validBuiltinPlanGuard(
				slice.guard,
				"string-slice-number",
				selection.function,
				slice.sliceCall,
				slice.builtinIdentities,
				false,
				slice.builtinCall,
				"String.prototype.slice",
			)
		) {
			fail(`${selection.id} has an invalid String.slice Number certificate`);
		}
	}
	if (selection.kind === "regexp-exec-projection") {
		const candidate = localCandidate(
			program,
			localCandidates,
			selection.function,
			selection.id,
		);
		const regexp = selection.regexpExecProjection;
		const dependency = regexp.guard.dependencies[0];
		const methodIdentity =
			dependency?.kind === "world" && dependency.fact === "primordials.locked"
				? "authority-invariant"
				: "runtime-guarded";
		const expectedLockedLiteral =
			methodIdentity === "authority-invariant" &&
			candidate?.kind === "regexp-exec-projection"
				? candidate.lockedLiteral
				: undefined;
		const expectedInstructions =
			candidate?.kind === "regexp-exec-projection"
				? [
						...candidate.instructions,
						...(expectedLockedLiteral === undefined
							? []
							: [
									expectedLockedLiteral.constructorIntrinsic,
									expectedLockedLiteral.construct,
								]),
					]
				: [];
		const expectedBlocks = [
			...new Set(
				expectedInstructions.map((instruction) => fn.instructionBlock(instruction)),
			),
		].sort((left, right) => left - right);
		const loadsMatch =
			candidate?.kind === "regexp-exec-projection" &&
			regexp.loads.length === candidate.loads.length &&
			regexp.loads.every((load, index) => {
				const expected = candidate.loads[index];
				if (
					expected === undefined ||
					load.instruction !== expected.instruction ||
					load.key !== expected.key ||
					load.captureIndex !== expected.captureIndex ||
					load.consumer?.kind !== expected.consumer?.kind
				)
					return false;
				const consumer = load.consumer;
				const expectedConsumer = expected.consumer;
				if (consumer === undefined || expectedConsumer === undefined) return true;
				if (consumer.kind === "length" && expectedConsumer.kind === "length") {
					return consumer.property === expectedConsumer.property;
				}
				if (consumer.kind === "number" && expectedConsumer.kind === "number") {
					return (
						consumer.intrinsic === expectedConsumer.intrinsic &&
						consumer.call === expectedConsumer.call
					);
				}
				if (
					consumer.kind === "charCodeAtZero" &&
					expectedConsumer.kind === "charCodeAtZero"
				) {
					return (
						consumer.methodIdentity === methodIdentity &&
						consumer.property === expectedConsumer.property &&
						consumer.call === expectedConsumer.call &&
						consumer.zero === expectedConsumer.zero
					);
				}
				return (
					consumer.kind === "asciiCaseLength" &&
					expectedConsumer.kind === "asciiCaseLength" &&
					consumer.methodIdentity === methodIdentity &&
					consumer.upperProperty === expectedConsumer.upperProperty &&
					consumer.upperCall === expectedConsumer.upperCall &&
					consumer.lowerProperty === expectedConsumer.lowerProperty &&
					consumer.lowerCall === expectedConsumer.lowerCall &&
					sameNumbers(consumer.resultMoves, expectedConsumer.resultMoves) &&
					consumer.lengthProperty === expectedConsumer.lengthProperty
				);
			});
		if (
			candidate?.kind !== "regexp-exec-projection" ||
			selection.anchors.length !== 2 ||
			selection.anchors[0] !== candidate.call ||
			selection.anchors[1] !== candidate.loads[0]?.instruction ||
			regexp.property !== candidate.property ||
			regexp.call !== candidate.call ||
			!sameNumbers(regexp.resultValues, candidate.resultValues) ||
			regexp.nullChecks.length !== candidate.nullChecks.length ||
			regexp.nullChecks.some(
				(check, index) =>
					check.comparison !== candidate.nullChecks[index]?.comparison ||
					check.nullValue !== candidate.nullChecks[index]?.nullValue,
			) ||
			(regexp.lockedLiteral === undefined) !== (expectedLockedLiteral === undefined) ||
			(regexp.lockedLiteral !== undefined &&
				expectedLockedLiteral !== undefined &&
				(regexp.lockedLiteral.constructorIntrinsic !==
					expectedLockedLiteral.constructorIntrinsic ||
					regexp.lockedLiteral.construct !== expectedLockedLiteral.construct)) ||
			!loadsMatch ||
			!sameNumbers(selection.claimedInstructions, expectedInstructions) ||
			!sameNumbers(selection.ordinaryBlocks, expectedBlocks) ||
			selection.exceptionalBlocks.length !== 0 ||
			selection.composition !== "exclusive" ||
			selection.representation !== "regexp-capture-spans" ||
			selection.semanticProtectors.length !== 0 ||
			selection.targetFunctions.length !== 0 ||
			(regexp.propertyPlacement !== "in-place" &&
				regexp.propertyPlacement !== "call-fallback") ||
			(regexp.propertyPlacement === "call-fallback" &&
				(expectedLockedLiteral === undefined ||
					(regexp.property !== undefined &&
						fn.instructionBlock(regexp.property) !==
							fn.instructionBlock(regexp.call)))) ||
			(expectedLockedLiteral !== undefined &&
				regexp.property !== undefined &&
				fn.instructionBlock(regexp.property) === fn.instructionBlock(regexp.call) &&
				regexp.propertyPlacement !== "call-fallback") ||
			!validBuiltinPlanGuard(
				regexp.guard,
				"regexp-exec-projection",
				selection.function,
				regexp.call,
				methodIdentity,
				true,
				regexp.builtinCall,
				"RegExp.prototype.exec",
			)
		) {
			fail(`${selection.id} has an invalid RegExp.exec projection certificate`);
		}
	}
	if (selection.kind === "regexp-iterator-projection") {
		const candidate = localCandidate(
			program,
			localCandidates,
			selection.function,
			selection.id,
		);
		const regexp = selection.regexpIteratorProjection;
		const expectedBlocks =
			candidate?.instructions === undefined
				? []
				: [
						...new Set(
							candidate.instructions.map((instruction) =>
								fn.instructionBlock(instruction),
							),
						),
					].sort((left, right) => left - right);
		if (
			candidate?.kind !== "regexp-iterator-projection" ||
			selection.anchors.length !== 3 ||
			selection.anchors[0] !== candidate.step ||
			selection.anchors[1] !== candidate.doneBranch ||
			selection.anchors[2] !== candidate.loads[0]?.instruction ||
			regexp.step !== candidate.step ||
			regexp.doneBranch !== candidate.doneBranch ||
			regexp.exitBlock !== candidate.exitBlock ||
			!sameNumbers(regexp.resultValues, candidate.resultValues) ||
			regexp.loads.length !== candidate.loads.length ||
			regexp.loads.some(
				(load, index) =>
					load.instruction !== candidate.loads[index]?.instruction ||
					load.key !== candidate.loads[index]?.key ||
					load.captureIndex !== candidate.loads[index]?.captureIndex ||
					load.numberIntrinsic !== candidate.loads[index]?.numberIntrinsic ||
					load.numberCall !== candidate.loads[index]?.numberCall,
			) ||
			!sameNumbers(selection.claimedInstructions, candidate.instructions) ||
			!sameNumbers(selection.ordinaryBlocks, expectedBlocks) ||
			!sameNumbers(selection.exceptionalBlocks, candidate.exceptionalBlocks) ||
			selection.composition !== "exclusive" ||
			selection.representation !== "regexp-iterator-capture-spans" ||
			selection.semanticProtectors.length !== 0 ||
			selection.targetFunctions.length !== 0 ||
			!validProtectorPlanGuard(
				regexp.guard,
				"regexp-iterator-projection",
				selection.function,
				regexp.step,
			)
		) {
			fail(`${selection.id} has an invalid RegExp iterator projection certificate`);
		}
	}
	if (
		selection.kind === "array-values-iterator-cursor" ||
		selection.kind === "string-iterator-cursor" ||
		selection.kind === "typed-array-iterator-cursor" ||
		selection.kind === "map-iterator-cursor" ||
		selection.kind === "set-iterator-cursor"
	) {
		const candidate = localCandidate(
			program,
			localCandidates,
			selection.function,
			selection.id,
		);
		const expected = {
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
		}[selection.kind];
		const cursor = selection.iteratorCursor;
		const expectedBlocks =
			candidate?.instructions === undefined
				? []
				: [
						...new Set(
							candidate.instructions.map((instruction) =>
								fn.instructionBlock(instruction),
							),
						),
					].sort((left, right) => left - right);
		if (
			candidate === undefined ||
			!("initialize" in candidate) ||
			candidate.kind !== selection.kind ||
			selection.anchors.length !== 2 ||
			selection.anchors[0] !== candidate.initialize ||
			selection.anchors[1] !== candidate.steps[0] ||
			cursor.initialize !== candidate.initialize ||
			!sameNumbers(cursor.steps, candidate.steps) ||
			cursor.protocol !== candidate.protocol ||
			cursor.protocol !== expected.protocol ||
			!sameNumbers(selection.claimedInstructions, candidate.instructions) ||
			!sameNumbers(selection.ordinaryBlocks, expectedBlocks) ||
			!sameNumbers(selection.exceptionalBlocks, candidate.exceptionalBlocks) ||
			selection.composition !== "exclusive" ||
			selection.representation !== expected.representation ||
			selection.semanticProtectors.length !== 0 ||
			selection.targetFunctions.length !== 0 ||
			fn.isGenerator ||
			fn.isAsync
		) {
			fail(`${selection.id} has an invalid iterator-cursor certificate`);
		}
	}
	if (selection.kind === "iterator-result-virtualization") {
		const candidate = localCandidate(
			program,
			localCandidates,
			selection.function,
			selection.id,
		);
		const virtualization = selection.iteratorResultVirtualization;
		const expectedBlocks =
			candidate?.instructions === undefined
				? []
				: [
						...new Set(
							candidate.instructions.map((instruction) =>
								fn.instructionBlock(instruction),
							),
						),
					].sort((left, right) => left - right);
		const guard = virtualization.guard;
		const anchor = candidate?.root;
		if (
			candidate?.kind !== "iterator-result-virtualization" ||
			anchor === undefined ||
			selection.anchors.length !== 1 ||
			selection.anchors[0] !== anchor ||
			!sameNumbers(virtualization.steps, candidate.steps) ||
			!sameNumbers(selection.claimedInstructions, candidate.instructions) ||
			!sameNumbers(selection.ordinaryBlocks, expectedBlocks) ||
			!sameNumbers(selection.exceptionalBlocks, candidate.exceptionalBlocks) ||
			selection.composition !== "overlay" ||
			selection.representation !== "virtual-iterator-result" ||
			selection.semanticProtectors.length !== 0 ||
			selection.targetFunctions.length !== 0 ||
			guard.dependencies.length !== 0 ||
			!guard.obligations.some(
				(obligation) =>
					obligation.kind === "fallback" &&
					obligation.id ===
						`region-twin:iterator-result-virtualization:${selection.function}:${anchor}` &&
					obligation.cause === "materialization",
			) ||
			!guard.obligations.some(
				(obligation) =>
					obligation.kind === "materialize" &&
					obligation.id ===
						`iterator-result-virtualization:${selection.function}:${anchor}` &&
					obligation.cause === "materialization",
			)
		) {
			fail(`${selection.id} has an invalid iterator-result certificate`);
		}
	}
	if (selection.kind === "iterator-entry-pair-virtualization") {
		const candidate = localCandidate(
			program,
			localCandidates,
			selection.function,
			selection.id,
		);
		const entry = selection.iteratorEntryPairVirtualization;
		const expectedBlocks =
			candidate?.instructions === undefined
				? []
				: [
						...new Set(
							candidate.instructions.map((instruction) =>
								fn.instructionBlock(instruction),
							),
						),
					].sort((left, right) => left - right);
		if (
			candidate?.kind !== "iterator-entry-pair-virtualization" ||
			selection.anchors.length !== 2 ||
			selection.anchors[0] !== candidate.outerStep ||
			selection.anchors[1] !== candidate.innerInitialize ||
			entry.cursorInitialize !== candidate.cursorInitialize ||
			entry.outerStep !== candidate.outerStep ||
			entry.innerInitialize !== candidate.innerInitialize ||
			!sameNumbers(entry.innerSteps, candidate.innerSteps) ||
			!sameNumbers(entry.innerCloses, candidate.innerCloses) ||
			!sameNumbers(selection.claimedInstructions, candidate.instructions) ||
			!sameNumbers(selection.ordinaryBlocks, expectedBlocks) ||
			!sameNumbers(selection.exceptionalBlocks, candidate.exceptionalBlocks) ||
			selection.composition !== "overlay" ||
			selection.representation !== "virtual-iterator-entry-pair" ||
			selection.semanticProtectors.length !== 0 ||
			selection.targetFunctions.length !== 0 ||
			!validProtectorPlanGuard(
				entry.guard,
				"iterator-entry-pair-virtualization",
				selection.function,
				entry.outerStep,
			)
		) {
			fail(`${selection.id} has an invalid iterator-entry-pair certificate`);
		}
	}
	if (selection.kind === "function-call-chain") {
		const candidate = localCandidate(
			program,
			localCandidates,
			selection.function,
			selection.id,
		);
		const chain = selection.functionCall;
		const expectedBlocks =
			candidate?.instructions === undefined
				? []
				: [
						...new Set(
							candidate.instructions.map((instruction) =>
								fn.instructionBlock(instruction),
							),
						),
					].sort((left, right) => left - right);
		const expectedTargets =
			candidate?.kind === "function-call-chain" && candidate.targetFunction !== undefined
				? [candidate.targetFunction]
				: [];
		if (
			candidate?.kind !== "function-call-chain" ||
			selection.anchors.length !== 2 ||
			selection.anchors[0] !== candidate.property ||
			selection.anchors[1] !== candidate.call ||
			chain.property !== candidate.property ||
			chain.call !== candidate.call ||
			chain.targetFunction !== candidate.targetFunction ||
			!sameNumbers(selection.claimedInstructions, candidate.instructions) ||
			!sameNumbers(selection.ordinaryBlocks, expectedBlocks) ||
			!sameNumbers(selection.exceptionalBlocks, candidate.exceptionalBlocks) ||
			!sameNumbers(selection.targetFunctions, expectedTargets) ||
			selection.composition !== "exclusive" ||
			selection.representation !== "guarded-function-call-flattening" ||
			selection.semanticProtectors.length !== 0 ||
			(expectedTargets[0] !== undefined &&
				!plan.liveFunctions.includes(expectedTargets[0]))
		) {
			fail(`${selection.id} has an invalid Function.call certificate`);
		}
	}
	if (selection.kind === "string-char-code-at-chain") {
		const candidate = localCandidate(
			program,
			localCandidates,
			selection.function,
			selection.id,
		);
		const chain = selection.stringCharCodeAt;
		const expectedBlocks =
			candidate?.instructions === undefined
				? []
				: [
						...new Set(
							candidate.instructions.map((instruction) =>
								fn.instructionBlock(instruction),
							),
						),
					].sort((left, right) => left - right);
		if (
			candidate?.kind !== "string-char-code-at-chain" ||
			selection.anchors.length !== 2 ||
			selection.anchors[0] !== candidate.property ||
			selection.anchors[1] !== candidate.call ||
			chain.property !== candidate.property ||
			chain.call !== candidate.call ||
			(chain.bounded === undefined) !== (candidate.bounded === undefined) ||
			(chain.bounded !== undefined &&
				(chain.bounded.length !== candidate.bounded?.length ||
					chain.bounded.comparison !== candidate.bounded.comparison ||
					chain.bounded.update !== candidate.bounded.update)) ||
			!sameNumbers(selection.claimedInstructions, candidate.instructions) ||
			!sameNumbers(selection.ordinaryBlocks, expectedBlocks) ||
			!sameNumbers(selection.exceptionalBlocks, candidate.exceptionalBlocks) ||
			selection.composition !== "exclusive" ||
			selection.representation !== "primitive-string-code-unit" ||
			selection.semanticProtectors.length !== 0 ||
			selection.targetFunctions.length !== 0 ||
			!validBuiltinPlanGuard(
				chain.guard,
				"string-char-code-at-chain",
				selection.function,
				chain.call,
				chain.methodIdentity,
				false,
				chain.builtinCall,
				"String.prototype.charCodeAt",
			)
		) {
			fail(`${selection.id} has an invalid String.charCodeAt certificate`);
		}
	}
	if (selection.kind === "builtin-collection-call-chain") {
		const candidate = localCandidate(
			program,
			localCandidates,
			selection.function,
			selection.id,
		);
		const chain = selection.builtinCollectionCall;
		const expectedBlocks =
			candidate?.instructions === undefined
				? []
				: [
						...new Set(
							candidate.instructions.map((instruction) =>
								fn.instructionBlock(instruction),
							),
						),
					].sort((left, right) => left - right);
		const dependency = chain.guard.dependencies[0];
		const identity =
			dependency?.kind === "world" && dependency.fact === "primordials.locked"
				? "authority-invariant"
				: "runtime-guarded";
		if (
			candidate?.kind !== "builtin-collection-call-chain" ||
			selection.anchors.length !== 2 ||
			selection.anchors[0] !== candidate.property ||
			selection.anchors[1] !== candidate.call ||
			chain.property !== candidate.property ||
			chain.call !== candidate.call ||
			chain.operation !== candidate.operation ||
			chain.exactReceiver !== candidate.exactReceiver ||
			!sameNumbers(selection.claimedInstructions, candidate.instructions) ||
			!sameNumbers(selection.ordinaryBlocks, expectedBlocks) ||
			!sameNumbers(selection.exceptionalBlocks, candidate.exceptionalBlocks) ||
			selection.composition !== "exclusive" ||
			selection.representation !== "captured-collection-method" ||
			selection.semanticProtectors.length !== 0 ||
			selection.targetFunctions.length !== 0 ||
			!validBuiltinPlanGuard(
				chain.guard,
				"builtin-collection-call-chain",
				selection.function,
				chain.call,
				identity,
				false,
				chain.builtinCall,
				chain.operation,
			)
		) {
			fail(`${selection.id} has an invalid collection-call certificate`);
		}
	}
	verifyCost(selection.cost, selection.id);
}

function validPlanRepresentation(value: CoreRepresentation): boolean {
	return (
		value === "boxed" ||
		value === "f64" ||
		value === "i32" ||
		value === "boolean" ||
		value === "string"
	);
}

function planRepresentation(
	value: CoreRepresentation,
): CorePlanRepresentation | undefined {
	switch (value) {
		case "boxed":
		case "f64":
		case "i32":
		case "boolean":
		case "string":
			return value;
		default:
			return undefined;
	}
}

function total(counts: Readonly<Record<string, number>>): number {
	return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function immutablePlanCopy(plan: CoreOptimizationPlan): CoreOptimizationPlan {
	// These deeply frozen payloads retain proof identities across verified plan copies.
	const proofPayloads = new Set<object>([
		...(plan.operatorInputs ?? []),
		...(plan.unsignedArithmetic ?? []),
	]);
	for (const entry of plan.directEntries) {
		for (const payload of [
			entry.valueRepresentations,
			entry.operatorInputs,
			entry.constantBooleans,
		]) {
			if (payload !== undefined) proofPayloads.add(payload);
		}
	}
	const copies = new Map<object, object>();
	const copy = (value: unknown): unknown => {
		if (value === null || typeof value !== "object") return value;
		if (value === plan.recipes || proofPayloads.has(value)) return value;
		const existing = copies.get(value);
		if (existing !== undefined) return existing;
		if (Array.isArray(value)) {
			const result: Array<unknown> = [];
			copies.set(value, result);
			for (const entry of value) result.push(copy(entry));
			return Object.freeze(result);
		}
		const result: Record<string, unknown> = {};
		copies.set(value, result);
		for (const [key, entry] of Object.entries(value)) result[key] = copy(entry);
		return Object.freeze(result);
	};
	return copy(plan) as CoreOptimizationPlan;
}

/** Verify stable identities and target obligations without querying an analysis. */
export function verifyCoreOptimizationPlan(
	program: SealedCoreProgram,
	plan: CoreOptimizationPlan,
	context?: CoreCompilationContext,
): VerifiedCoreOptimizationPlan {
	const startedAt = Date.now();
	if (!program.sealed) fail("program is not sealed");
	const current = corePlanVersionStamp(program);
	if (
		current.key !== plan.version.key ||
		!sameRecord(current.program, plan.version.program) ||
		current.functions.length !== plan.version.functions.length ||
		current.functions.some((entry, index) => {
			const planned = plan.version.functions[index];
			return (
				planned === undefined ||
				entry.function !== planned.function ||
				!sameRecord(entry.versions, planned.versions)
			);
		})
	) {
		fail("plan version does not match the sealed program");
	}
	if (
		new Set(plan.liveFunctions).size !== plan.liveFunctions.length ||
		plan.liveFunctions.some(
			(functionId, index) =>
				functionId < 0 ||
				functionId >= program.functionCapacity ||
				(index > 0 && plan.liveFunctions[index - 1]! >= functionId),
		)
	) {
		fail("live function mapping is not a sorted set of stable IDs");
	}
	if ((plan.specializedOnlyFunctions?.length ?? 0) > 0) {
		if (context?.facts.closure.sourceClosure.kind !== "known")
			fail("native body omission requires source closure");
		const targets = analyzeCoreCallGraph(program, true, undefined, undefined, context);
		const eligible = new Set(
			coreSpecializedOnlyFunctions(
				program,
				context,
				targets,
				plan.liveFunctions,
				plan.directEntries,
			),
		);
		if (plan.specializedOnlyFunctions!.some((functionId) => !eligible.has(functionId)))
			fail("native body has a reachable generic use");
	}
	const blockProofs = verifyBlockOrders(program, plan);
	const ids: Array<string> = [];
	const claimedInstructions = new Map<
		CoreFunctionId,
		Map<
			CoreInstructionId,
			{
				exclusive: boolean;
				readonly overlays: Set<CorePlanSpecialization["kind"]>;
			}
		>
	>();
	const localCandidates = new Map<
		CoreFunctionId,
		ReadonlyMap<number, ReadonlyArray<CoreLocalSpecializationCandidate>>
	>();
	const specializations = projectCoreSpecializationRecipes(plan.recipes);
	for (const selection of specializations) {
		verifySpecialization(
			program,
			plan,
			selection,
			ids,
			claimedInstructions,
			blockProofs.get(selection.function)!,
			localCandidates,
		);
	}
	for (const operation of plan.operatorInputs ?? []) {
		if (!coreOperatorInputProofIsCurrent(program, operation))
			fail("operator inputs have no current kind proof");
	}
	for (const operation of plan.unsignedArithmetic ?? []) {
		if (!coreUnsignedArithmeticProofIsCurrent(program, operation))
			fail("unsigned arithmetic has no current range proof");
	}
	const entriesByFunction = new Map<CoreFunctionId, number>();
	const callSites = new Map<
		string,
		{
			readonly fieldObject: CoreInstructionId | undefined;
			readonly targets: Set<CoreFunctionId>;
		}
	>();
	for (const entry of plan.directEntries) {
		if (!plan.liveFunctions.includes(entry.function)) {
			fail(`direct entry targets dead function ${entry.function}`);
		}
		const fn = program.function(entry.function);
		if (!coreNativeEntryProofIsCurrent(fn, entry))
			fail(
				`direct entry ${entry.function}:${entry.id} has no current representation proof`,
			);
		if (entry.argumentRepresentations !== undefined) {
			const observation = coreArgumentObservation(fn);
			if (
				entry.argumentRepresentations.length > 16 ||
				entry.argumentRepresentations.some(
					(representation) => !validPlanRepresentation(representation),
				) ||
				observation.kind === "general" ||
				observation.indices.some(
					(index) => index >= entry.argumentRepresentations!.length,
				) ||
				entry.parameterRepresentations.some(
					(representation, index) =>
						representation !== (entry.argumentRepresentations![index] ?? "boxed"),
				)
			)
				fail(
					`direct entry ${entry.function}:${entry.id} has invalid argument observations`,
				);
		}
		if (fn.isGenerator || fn.isAsync || fn.metadata.isClassConstructor) {
			fail(`direct entry targets unsupported function ${entry.function}`);
		}
		const expectedId = entriesByFunction.get(entry.function) ?? 0;
		if (entry.id !== expectedId || entry.id >= 4) {
			fail(`direct entry ${entry.function}:${entry.id} is not densely numbered`);
		}
		entriesByFunction.set(entry.function, expectedId + 1);
		if (entry.target !== "native" || entry.fallback !== "canonical-core") {
			fail(`direct entry ${entry.function}:${entry.id} loses its generic fallback`);
		}
		if (
			entry.parameterRepresentations.length !== fn.parameterCount ||
			entry.parameterRepresentations.some(
				(representation) => !validPlanRepresentation(representation),
			) ||
			!validPlanRepresentation(entry.resultRepresentation)
		) {
			fail(`direct entry ${entry.function}:${entry.id} has an invalid ABI`);
		}
		let parameterRepresentationMismatch = false;
		if (
			entry.valueRepresentations !== undefined &&
			(entry.valueRepresentations.length !== fn.valueCapacity ||
				entry.valueRepresentations.some(
					(representation) => !validPlanRepresentation(representation),
				))
		) {
			fail(
				`direct entry ${entry.function}:${entry.id} has invalid value representations`,
			);
		}
		const representationForValue = (value: CoreValueId) =>
			entry.valueRepresentations?.[value] ??
			planRepresentation(fn.valueRepresentation(value));
		for (let index = 0; index < fn.parameterCount; index++) {
			if (
				representationForValue(fn.kernel.functionParameter(index)) !==
				entry.parameterRepresentations[index]
			) {
				parameterRepresentationMismatch = true;
				break;
			}
		}
		let resultRepresentationMismatch = false;
		for (let blockIndex = 0; blockIndex < fn.blockCapacity; blockIndex++) {
			const block = coreBlockId(blockIndex);
			if (fn.kernel.blockLive(block) === 0) continue;
			const terminator = fn.blockTerminator(block);
			if (
				fn.instructionKind(terminator) === "return" &&
				entry.resultRepresentation !== "boxed" &&
				representationForValue(
					fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator)),
				) !== entry.resultRepresentation
			) {
				resultRepresentationMismatch = true;
				break;
			}
		}
		if (parameterRepresentationMismatch || resultRepresentationMismatch) {
			fail(
				`direct entry ${entry.function}:${entry.id} disagrees with Core representations`,
			);
		}
		if (entry.callSites.length === 0) {
			fail(`direct entry ${entry.function}:${entry.id} has no callsites`);
		}
		for (const site of entry.callSites) {
			if (
				site.numericSortCallbackViaCall !== undefined &&
				(site.numericSortCallbackViaCall !== true ||
					site.numericSortCallback === undefined)
			)
				fail(
					`direct entry ${entry.function}:${entry.id} has an invalid callback invocation`,
				);

			if (
				site.numericSortCallback !== undefined &&
				((site.numericSortCallback !== "sort" &&
					site.numericSortCallback !== "toSorted") ||
					site.guarded !== true ||
					entry.parameterRepresentations.length !== 2 ||
					entry.parameterRepresentations.some(
						(representation) => representation !== "f64",
					) ||
					entry.resultRepresentation !== "f64" ||
					entry.argumentRepresentations !== undefined ||
					entry.fieldParameters !== undefined)
			)
				fail(
					`direct entry ${entry.function}:${entry.id} has an invalid numeric callback contract`,
				);
			const key = `${site.caller}:${site.instruction}`;
			const previous = callSites.get(key);
			if (
				(entry.fieldParameters === undefined) !== (site.fieldObject === undefined) ||
				(previous !== undefined &&
					(site.fieldObject === undefined ||
						previous.fieldObject !== site.fieldObject ||
						previous.targets.has(entry.function)))
			)
				fail(`callsite ${key} selects incompatible direct entries`);
			const targets = previous?.targets ?? new Set<CoreFunctionId>();
			targets.add(entry.function);
			if (targets.size > 4) fail(`callsite ${key} selects too many direct entries`);
			callSites.set(key, { fieldObject: site.fieldObject, targets });
			if (!plan.liveFunctions.includes(site.caller))
				fail(`direct entry callsite ${key} is dead`);
			const caller = program.function(site.caller);
			requireInstruction(caller, site.instruction, "direct-entry callsite", key);
			if (
				!blockProofs
					.get(site.caller)!
					.included.has(caller.instructionBlock(site.instruction))
			) {
				fail(`direct entry callsite ${key} is omitted from target lowering`);
			}
			if (
				caller.instructionKind(site.instruction) !== "operation" ||
				caller.registry.byId(caller.instructionOpcode(site.instruction)).callTransfer ===
					undefined
			) {
				fail(`direct entry callsite ${key} is not a call`);
			}
		}
		verifyCost(entry.cost, `direct entry ${entry.function}:${entry.id}`);
	}
	const selected = plan.recipes.count + plan.directEntries.length;
	const generatedCode = [
		...specializations.map(({ cost }) => cost.generatedCode),
		...plan.directEntries.map(({ cost }) => cost.generatedCode),
	].reduce((sum, cost) => sum + cost, 0);
	const compilerWork = [
		...specializations.map(({ cost }) => cost.compilerWork),
		...plan.directEntries.map(({ cost }) => cost.compilerWork),
	].reduce((sum, cost) => sum + cost, 0);
	if (
		plan.statistics.applied !== selected ||
		total(plan.statistics.selectedByKind) !== selected ||
		plan.statistics.considered !== plan.statistics.applied + plan.statistics.declined ||
		total(plan.statistics.discoveredByKind) !== plan.statistics.considered ||
		plan.statistics.generatedCodeConsumed !== generatedCode ||
		plan.statistics.compilerWorkConsumed !== compilerWork ||
		!Number.isFinite(plan.statistics.verificationMs) ||
		plan.statistics.verificationMs < 0
	) {
		fail("plan diagnostics do not describe the selected entries");
	}
	const verifiedPlan = immutablePlanCopy({
		...plan,
		statistics: {
			...plan.statistics,
			verificationMs: Date.now() - startedAt,
		},
	});
	return certifyCoreOptimizationPlan(program, verifiedPlan);
}
