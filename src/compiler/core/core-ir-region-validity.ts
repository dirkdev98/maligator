import { coreTargetSupportsSpecialization } from "./core-ir-region-strategies.ts";
import type {
	CoreOptimizationPlan,
	CorePlanCost,
	CorePlanRepresentation,
	CorePlanSpecialization,
} from "./core-ir-regions.ts";
import type {
	CoreFunctionId,
	CoreInstructionId,
	CoreRepresentation,
} from "./core-ir.ts";
import type {
	CoreFunctionStore,
	CoreProgram,
	SealedCoreProgram,
} from "./core-store.ts";

function stableVersionKey(program: CoreProgram): string {
	const programPart = Object.values(program.versions).join(":");
	const functionPart = [...program.functionIds()].map((functionId) =>
		`${functionId}:${Object.values(program.function(functionId).versions).join(":")}`,
	).join("|");
	return `p:${programPart}|f:${functionPart}`;
}

export function corePlanVersionStamp(program: CoreProgram): CoreOptimizationPlan["version"] {
	return Object.freeze({
		key: stableVersionKey(program),
		program: Object.freeze({ ...program.versions }),
		functions: Object.freeze([...program.functionIds()].map((functionId) =>
			Object.freeze({
				function: functionId,
				versions: Object.freeze({ ...program.function(functionId).versions }),
			}),
		)),
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

function sameRecord(
	left: object,
	right: object,
): boolean {
	const leftRecord = left as Readonly<Record<string, unknown>>;
	const rightRecord = right as Readonly<Record<string, unknown>>;
	const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
	return [...keys].every((key) => leftRecord[key] === rightRecord[key]);
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
	if (!fn.isInstructionLive(instruction)) fail(`${id} names stale ${role} @${instruction}`);
}

function verifySpecialization(
	program: SealedCoreProgram,
	plan: CoreOptimizationPlan,
	selection: CorePlanSpecialization,
	ids: Set<string>,
	exclusiveClaims: Map<CoreFunctionId, Set<CoreInstructionId>>,
): void {
	if (ids.has(selection.id)) fail(`duplicate specialization id ${selection.id}`);
	ids.add(selection.id);
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
	const ordinary = new Set(selection.ordinaryBlocks);
	const exceptional = new Set(selection.exceptionalBlocks);
	for (const block of [...ordinary, ...exceptional]) {
		if (!fn.isBlockLive(block)) fail(`${selection.id} names stale block b${block}`);
	}
	for (const instruction of claims) {
		requireInstruction(fn, instruction, "claim", selection.id);
		const block = fn.instructionBlock(instruction);
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
		if (!fn.isValueLive(requirement.value) ||
			fn.valueRepresentation(requirement.value) !== requirement.representation) {
			fail(`${selection.id} has a stale representation requirement for %${requirement.value}`);
		}
	}
	if (selection.kind === "guarded-direct-call") {
		if (selection.anchors.length !== 1 || selection.targetFunctions.length === 0) {
			fail(`${selection.id} has an invalid guarded-call target set`);
		}
		const anchor = selection.anchors[0]!;
		if (fn.instructionKind(anchor) !== "operation" ||
			fn.registry.byId(fn.instructionOpcode(anchor)).callTransfer === undefined) {
			fail(`${selection.id} does not anchor a call`);
		}
		const attributes = fn.instructionAttributes(anchor);
		const selectedTargets = selection.targetFunctions;
		const encoded =
			selectedTargets.length === 1 && attributes.directFunctionIndex === selectedTargets[0]
				? [attributes.directFunctionIndex]
				: attributes.guardedFunctionIndices;
		if (!Array.isArray(encoded) || encoded.length !== selectedTargets.length ||
			selectedTargets.some((target, index) => encoded[index] !== target)) {
			fail(`${selection.id} does not match the canonical call guard`);
		}
		for (const target of selectedTargets) {
			if (!plan.liveFunctions.includes(target)) {
				fail(`${selection.id} targets dead function ${target}`);
			}
		}
	}
	verifyCost(selection.cost, selection.id);
	if (selection.composition === "exclusive") {
		const owned = exclusiveClaims.get(selection.function) ?? new Set();
		for (const instruction of claims) {
			if (owned.has(instruction)) {
				fail(`${selection.id} conflicts on @${instruction}`);
			}
			owned.add(instruction);
		}
		exclusiveClaims.set(selection.function, owned);
	}
}

function validPlanRepresentation(value: CoreRepresentation): boolean {
	return value === "boxed" || value === "f64" || value === "i32" ||
		value === "boolean" || value === "string";
}

function planRepresentation(value: CoreRepresentation): CorePlanRepresentation | undefined {
	switch (value) {
		case "boxed":
		case "f64":
		case "i32":
		case "boolean":
		case "string": return value;
		default: return undefined;
	}
}

function total(counts: Readonly<Record<string, number>>): number {
	return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

/** Verify stable identities and target obligations without querying an analysis. */
export function verifyCoreOptimizationPlan(
	program: SealedCoreProgram,
	plan: CoreOptimizationPlan,
): void {
	if (!program.sealed) fail("program is not sealed");
	const current = corePlanVersionStamp(program);
	if (current.key !== plan.version.key ||
		!sameRecord(current.program, plan.version.program) ||
		current.functions.length !== plan.version.functions.length ||
		current.functions.some((entry, index) => {
			const planned = plan.version.functions[index];
			return planned === undefined || entry.function !== planned.function ||
				!sameRecord(entry.versions, planned.versions);
		})) {
		fail("plan version does not match the sealed program");
	}
	if (new Set(plan.liveFunctions).size !== plan.liveFunctions.length ||
		plan.liveFunctions.some((functionId, index) =>
			functionId < 0 || functionId >= program.functionCapacity ||
			(index > 0 && plan.liveFunctions[index - 1]! >= functionId))) {
		fail("live function mapping is not a sorted set of stable IDs");
	}
	const ids = new Set<string>();
	const exclusiveClaims = new Map<CoreFunctionId, Set<CoreInstructionId>>();
	for (const selection of plan.specializations) {
		verifySpecialization(program, plan, selection, ids, exclusiveClaims);
	}
	const entriesByFunction = new Map<CoreFunctionId, number>();
	const callSites = new Set<string>();
	for (const entry of plan.directEntries) {
		if (!plan.liveFunctions.includes(entry.function)) {
			fail(`direct entry targets dead function ${entry.function}`);
		}
		const fn = program.function(entry.function);
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
		if (entry.parameterRepresentations.length !== fn.parameters.length ||
			entry.parameterRepresentations.some((representation) =>
				!validPlanRepresentation(representation)) ||
			!validPlanRepresentation(entry.resultRepresentation)) {
			fail(`direct entry ${entry.function}:${entry.id} has an invalid ABI`);
		}
		if (fn.parameters.some((parameter, index) =>
			planRepresentation(fn.valueRepresentation(parameter)) !==
				entry.parameterRepresentations[index]) ||
			[...fn.blockIds()].some((block) => {
				const terminator = fn.terminatorPayload(fn.blockTerminator(block));
				return terminator.kind === "return" &&
					planRepresentation(fn.valueRepresentation(terminator.value)) !==
						entry.resultRepresentation;
			})) {
			fail(`direct entry ${entry.function}:${entry.id} disagrees with Core representations`);
		}
		if (entry.callSites.length === 0) {
			fail(`direct entry ${entry.function}:${entry.id} has no callsites`);
		}
		for (const site of entry.callSites) {
			const key = `${site.caller}:${site.instruction}`;
			if (callSites.has(key)) fail(`callsite ${key} selects multiple direct entries`);
			callSites.add(key);
			if (!plan.liveFunctions.includes(site.caller)) fail(`direct entry callsite ${key} is dead`);
			const caller = program.function(site.caller);
			requireInstruction(caller, site.instruction, "direct-entry callsite", key);
			if (caller.instructionKind(site.instruction) !== "operation" ||
				caller.registry.byId(caller.instructionOpcode(site.instruction)).callTransfer === undefined ||
				caller.instructionAttributes(site.instruction).directFunctionIndex !== entry.function) {
				fail(`direct entry callsite ${key} lacks its exact callee guard`);
			}
		}
		verifyCost(entry.cost, `direct entry ${entry.function}:${entry.id}`);
	}
	const selected = plan.specializations.length + plan.directEntries.length;
	const generatedCode = [
		...plan.specializations.map(({ cost }) => cost.generatedCode),
		...plan.directEntries.map(({ cost }) => cost.generatedCode),
	].reduce((sum, cost) => sum + cost, 0);
	const compilerWork = [
		...plan.specializations.map(({ cost }) => cost.compilerWork),
		...plan.directEntries.map(({ cost }) => cost.compilerWork),
	].reduce((sum, cost) => sum + cost, 0);
	if (plan.statistics.applied !== selected ||
		total(plan.statistics.selectedByKind) !== selected ||
		plan.statistics.considered !== plan.statistics.applied + plan.statistics.declined ||
		total(plan.statistics.discoveredByKind) !== plan.statistics.considered ||
		plan.statistics.generatedCodeConsumed !== generatedCode ||
		plan.statistics.compilerWorkConsumed !== compilerWork ||
		!Number.isFinite(plan.statistics.verificationMs) || plan.statistics.verificationMs < 0) {
		fail("plan diagnostics do not describe the selected entries");
	}
}
