import { effectSummaryCovers, normalizeEffectSummary } from "../shared/effect-summary.ts";
import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import { CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import type {
	CoreBlockId,
	CoreFact,
	CoreFactClaim,
	CoreFactId,
	CoreInstructionEffects,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import { coreBlockId, coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

/** Keep finite alternatives useful to guard chains and bounded dispatch. */
export const CORE_FACT_ALTERNATIVE_LIMIT = 32;
export const CORE_FACT_CLAIM_LIMIT = 16;

type Identity = Extract<
	CoreFactClaim,
	{ readonly kind: "identity" }
>["identities"][number];
type RangeClaim = Extract<CoreFactClaim, { readonly kind: "range" }>;

/**
 * Canonical claim order must be identical on every host: an AOT build cache is
 * keyed on compiler output, and `localeCompare` depends on the ICU data the
 * running Node was built with.
 */
function compareKeys(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function identityKey(identity: Identity): string {
	if (identity === null) return "null";
	switch (typeof identity) {
		case "boolean":
			return identity ? "boolean:true" : "boolean:false";
		case "number":
			return `number:${
				Number.isNaN(identity) ? "NaN" : Object.is(identity, -0) ? "-0" : String(identity)
			}`;
		case "string":
			return `string:${identity}`;
	}
}

/**
 * Length-prefixed alternatives. A plain separator lets one alternative spell a
 * whole list (`["a,b"]` against `["a","b"]`), which would collapse two different
 * claims onto one key and make canonical form depend on input order.
 */
function alternativesKey(values: ReadonlyArray<string>): string {
	return values.map((value) => `${value.length}:${value}`).join(",");
}

function setIsSubset(
	strong: ReadonlyArray<string>,
	weak: ReadonlyArray<string>,
): boolean {
	const strongSet = new Set(strong);
	const allowed = new Set(weak);
	return (
		strongSet.size <= allowed.size && [...strongSet].every((entry) => allowed.has(entry))
	);
}

function lowerIsNarrower(strong: number | null, weak: number | null): boolean {
	return weak === null || (strong !== null && strong >= weak);
}

function upperIsNarrower(strong: number | null, weak: number | null): boolean {
	return weak === null || (strong !== null && strong <= weak);
}

/**
 * Canonical endpoints of a range claim's ordered part: an unbounded end and the
 * corresponding infinity denote the same set of doubles, `-0` and `0` are the
 * same endpoint (membership of `-0` is carried only by `mayBeNegativeZero`), an
 * integer claim's endpoints are the tightest integers its interval can contain,
 * and a NaN endpoint constrains no ordering at all so it widens to unbounded.
 */
function canonicalRangeBounds(claim: RangeClaim): {
	readonly minimum: number | null;
	readonly maximum: number | null;
} {
	let minimum =
		claim.minimum === null ||
		Number.isNaN(claim.minimum) ||
		claim.minimum === Number.NEGATIVE_INFINITY
			? null
			: claim.minimum;
	let maximum =
		claim.maximum === null ||
		Number.isNaN(claim.maximum) ||
		claim.maximum === Number.POSITIVE_INFINITY
			? null
			: claim.maximum;
	if (claim.integer) {
		if (minimum !== null) minimum = Math.ceil(minimum);
		if (maximum !== null) maximum = Math.floor(maximum);
	}
	return {
		minimum: minimum !== null && Object.is(minimum, -0) ? 0 : minimum,
		maximum: maximum !== null && Object.is(maximum, -0) ? 0 : maximum,
	};
}

function rangeIntervalIsEmpty(claim: RangeClaim): boolean {
	const { minimum, maximum } = canonicalRangeBounds(claim);
	if (minimum !== null && maximum !== null && minimum > maximum) return true;
	// After canonicalization only a lower `+Infinity` or an upper `-Infinity`
	// survives, and neither is an integer, so an integer claim denotes nothing.
	return (
		claim.integer &&
		((minimum !== null && !Number.isFinite(minimum)) ||
			(maximum !== null && !Number.isFinite(maximum)))
	);
}

/**
 * Whether any value satisfies the claim. A contradiction is maximally strong
 * along the implication order and would therefore establish every claim on the
 * same subject, so producers must not emit one and consumers must not use one.
 */
export function coreFactClaimIsSatisfiable(claim: CoreFactClaim): boolean {
	switch (claim.kind) {
		case "identity":
			return claim.identities.length > 0;
		case "shape":
			return claim.shapes.length > 0;
		case "range":
			return !rangeIntervalIsEmpty(claim) || claim.mayBeNaN || claim.mayBeNegativeZero;
		case "effect":
			return true;
	}
}

/** Whether one semantic claim establishes another claim at the same point. */
export function coreFactClaimImplies(
	strong: CoreFactClaim,
	weak: CoreFactClaim,
): boolean {
	if (strong.kind !== weak.kind) return false;
	if (!coreFactClaimIsSatisfiable(strong)) return false;
	switch (strong.kind) {
		case "identity": {
			const weaker = weak as Extract<CoreFactClaim, { readonly kind: "identity" }>;
			return (
				strong.subject === weaker.subject &&
				setIsSubset(
					strong.identities.map(identityKey),
					weaker.identities.map(identityKey),
				)
			);
		}
		case "shape": {
			const weaker = weak as Extract<CoreFactClaim, { readonly kind: "shape" }>;
			return (
				strong.subject === weaker.subject && setIsSubset(strong.shapes, weaker.shapes)
			);
		}
		case "range": {
			const weaker = weak as RangeClaim;
			const narrow = canonicalRangeBounds(strong);
			const wide = canonicalRangeBounds(weaker);
			return (
				strong.subject === weaker.subject &&
				lowerIsNarrower(narrow.minimum, wide.minimum) &&
				upperIsNarrower(narrow.maximum, wide.maximum) &&
				(!weaker.integer || strong.integer) &&
				(weaker.mayBeNaN || !strong.mayBeNaN) &&
				(weaker.mayBeNegativeZero || !strong.mayBeNegativeZero)
			);
		}
		case "effect": {
			const weakEffect = weak as Extract<CoreFactClaim, { readonly kind: "effect" }>;
			return (
				strong.instruction === weakEffect.instruction &&
				effectSummaryCovers(weakEffect.effects, strong.effects)
			);
		}
	}
}

/** Every conjunct of the weaker fact is established by a stronger conjunct. */
export function coreFactClaimsImply(
	strong: ReadonlyArray<CoreFactClaim>,
	weak: ReadonlyArray<CoreFactClaim>,
): boolean {
	return (
		weak.length > 0 &&
		weak.every((required) =>
			strong.some((available) => coreFactClaimImplies(available, required)),
		)
	);
}

/**
 * Whether `strong` establishes everything `weak` states. Implication is decided
 * from claims alone: a fact's `kind`/`value` payload is the producer's private
 * description, so two facts with equal payloads may still speak about different
 * subjects, and a fact without claims states nothing a consumer can reuse.
 */
export function coreFactImplies(strong: CoreFact, weak: CoreFact): boolean {
	return strong.id === weak.id || coreFactClaimsImply(strong.claims, weak.claims);
}

/** Index key shared by every pair that can participate in implication. */
export function coreFactClaimFamilyKey(claim: CoreFactClaim): string {
	switch (claim.kind) {
		case "identity":
		case "shape":
		case "range":
			return `${claim.kind}:value:${claim.subject}`;
		case "effect":
			return `effect:instruction:${claim.instruction}`;
	}
}

/**
 * Every family a fact can be found under. Implying claims always share a family
 * key, so scanning one family of a fact's claims finds every fact that could
 * imply it.
 */
export function coreFactFamilyKeys(fact: CoreFact): ReadonlyArray<string> {
	return [...new Set(fact.claims.map(coreFactClaimFamilyKey))].sort(compareKeys);
}

function normalizeIdentities(
	identities: ReadonlyArray<Identity>,
): ReadonlyArray<Identity> {
	const byKey = new Map<string, Identity>();
	for (const identity of identities) {
		const key = identityKey(identity);
		if (!byKey.has(key)) byKey.set(key, identity);
	}
	return [...byKey]
		.sort(([left], [right]) => compareKeys(left, right))
		.map(([, value]) => value);
}

function normalizeStrings(values: ReadonlyArray<string>): ReadonlyArray<string> {
	return [...new Set(values)].sort(compareKeys);
}

function normalizeClaim(claim: CoreFactClaim): CoreFactClaim {
	switch (claim.kind) {
		case "identity":
			return { ...claim, identities: normalizeIdentities(claim.identities) };
		case "shape":
			return { ...claim, shapes: normalizeStrings(claim.shapes) };
		case "range":
			return { ...claim, ...canonicalRangeBounds(claim) };
		case "effect":
			return { ...claim, effects: normalizeEffectSummary(claim.effects) };
	}
}

function boundKey(bound: number | null): string {
	return bound === null ? "*" : String(bound);
}

function claimKey(claim: CoreFactClaim): string {
	switch (claim.kind) {
		case "identity":
			return `${coreFactClaimFamilyKey(claim)}:[${alternativesKey(claim.identities.map(identityKey))}]`;
		case "shape":
			return `${coreFactClaimFamilyKey(claim)}:[${alternativesKey(claim.shapes)}]`;
		case "range": {
			const { minimum, maximum } = canonicalRangeBounds(claim);
			return [
				coreFactClaimFamilyKey(claim),
				boundKey(minimum),
				boundKey(maximum),
				claim.integer ? "i" : "n",
				claim.mayBeNaN ? "nan" : "ordered",
				claim.mayBeNegativeZero ? "-0" : "+0",
			].join(":");
		}
		case "effect": {
			const effects: CoreInstructionEffects = claim.effects;
			return [
				coreFactClaimFamilyKey(claim),
				`r[${alternativesKey(effects.reads)}]`,
				`w[${alternativesKey(effects.writes)}]`,
				effects.mayThrow ? "t" : "-",
				effects.maySuspend ? "s" : "-",
				effects.mayGc ? "g" : "-",
				effects.callsUserCode ? "u" : "-",
			].join(":");
		}
	}
}

/** Canonicalize, deduplicate, and discard weaker conjuncts in one fact. */
export function normalizeCoreFactClaims(
	claims: ReadonlyArray<CoreFactClaim>,
): ReadonlyArray<CoreFactClaim> {
	const byKey = new Map<string, CoreFactClaim>();
	for (const claim of claims.map(normalizeClaim)) {
		const key = claimKey(claim);
		if (!byKey.has(key)) byKey.set(key, claim);
	}
	const entries = [...byKey].sort(([left], [right]) => compareKeys(left, right));
	return entries
		.filter(([, claim], index) =>
			entries.every(
				([, candidate], candidateIndex) =>
					candidateIndex === index ||
					!coreFactClaimImplies(candidate, claim) ||
					coreFactClaimImplies(claim, candidate),
			),
		)
		.map(([, claim]) => claim);
}

export function normalizeCoreFact(fact: CoreFact): CoreFact {
	const claims = normalizeCoreFactClaims(fact.claims);
	return claims.length === fact.claims.length &&
		claims.every((claim, index) => {
			const original = fact.claims[index]!;
			if (claimKey(claim) !== claimKey(original)) return false;
			if (original.kind !== "range") return true;
			const canonical = canonicalRangeBounds(original);
			return (
				Object.is(original.minimum, canonical.minimum) &&
				Object.is(original.maximum, canonical.maximum)
			);
		})
		? fact
		: { ...fact, claims };
}

export interface CoreFactAvailabilityAnalysis {
	readonly facts: ReadonlyArray<CoreFactId>;
	availableAtBlock(block: CoreBlockId): ReadonlyArray<CoreFactId>;
	availableAtInstruction(instruction: CoreInstructionId): ReadonlyArray<CoreFactId>;
	impliesAtBlock(block: CoreBlockId, required: CoreFact): CoreFactId | undefined;
}

function guardSuccess(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): { readonly from: CoreBlockId; readonly to: CoreBlockId } | undefined {
	if (!fn.isInstructionLive(instruction) || fn.instructionKind(instruction) !== "guard")
		return undefined;
	return {
		from: fn.instructionBlock(instruction),
		to: fn.kernel.terminatorEdgeBlock(fn.kernel.terminatorEdgeStart(instruction)),
	};
}

export function analyzeCoreFactAvailability(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
): CoreFactAvailabilityAnalysis {
	const factIds = [...fn.factIds()];
	const available = new Array<ReadonlyArray<CoreFactId> | undefined>(fn.blockCapacity);
	const instructionOrder = new Int32Array(fn.instructionCapacity);
	for (const block of fn.blockIds()) {
		let point = 0;
		for (const instruction of fn.instructionIds(block)) {
			instructionOrder[instruction] = point++;
		}
	}
	const guardAvailable = (
		instruction: CoreInstructionId,
		block: CoreBlockId,
	): boolean => {
		const success = guardSuccess(fn, instruction);
		return success !== undefined && cfg.dominatesEdge(success.from, success.to, block);
	};
	const factAvailable = (fact: CoreFact, block: CoreBlockId): boolean => {
		if (fact.validity.kind === "guard") {
			if (!guardAvailable(fact.validity.instruction, block)) return false;
		} else if (fact.validity.kind !== "world" && fact.validity.kind !== "summary") {
			if (!fact.obligations.some(({ kind }) => kind === "guard")) return false;
		}
		return fact.obligations.every(
			(obligation) =>
				obligation.kind !== "guard" || guardAvailable(obligation.instruction, block),
		);
	};
	const valueAvailableAtInstruction = (
		subject: CoreValueId,
		instruction: CoreInstructionId,
	): boolean => {
		const block = fn.instructionBlock(instruction);
		const owner = fn.kernel.valueDefinitionOwner(subject);
		if (fn.kernel.valueDefinitionKind(subject) === 0) {
			const definitionBlock = coreBlockId(owner);
			return definitionBlock === block || cfg.dominates(definitionBlock, block);
		}
		const definitionInstruction = coreInstructionId(owner);
		const definitionBlock = fn.instructionBlock(definitionInstruction);
		return definitionBlock === block
			? instructionOrder[definitionInstruction]! < instructionOrder[instruction]!
			: cfg.instructionDominatesBlock(definitionBlock, block);
	};
	const subjectsAvailableAtInstruction = (
		fact: CoreFact,
		instruction: CoreInstructionId,
	): boolean =>
		fact.claims.every(
			(claim) =>
				claim.kind === "effect" ||
				valueAvailableAtInstruction(claim.subject, instruction),
		);
	const validAtBlock = (block: CoreBlockId): ReadonlyArray<CoreFactId> => {
		const cached = available[block];
		if (cached !== undefined) return cached;
		const result = Object.freeze(
			factIds.filter((fact) => factAvailable(fn.fact(fact), block)),
		);
		available[block] = result;
		return result;
	};
	const valueAvailableAtBlock = (subject: CoreValueId, block: CoreBlockId): boolean => {
		const owner = fn.kernel.valueDefinitionOwner(subject);
		return fn.kernel.valueDefinitionKind(subject) === 0
			? owner === block || cfg.dominates(coreBlockId(owner), block)
			: cfg.instructionDominatesBlock(
					fn.instructionBlock(coreInstructionId(owner)),
					block,
				);
	};
	const subjectsAvailableAtBlock = (fact: CoreFact, block: CoreBlockId): boolean =>
		fact.claims.every(
			(claim) => claim.kind === "effect" || valueAvailableAtBlock(claim.subject, block),
		);
	const atBlock = (block: CoreBlockId): ReadonlyArray<CoreFactId> =>
		Object.freeze(
			validAtBlock(block).filter((fact) =>
				subjectsAvailableAtBlock(fn.fact(fact), block),
			),
		);
	const result: CoreFactAvailabilityAnalysis = {
		facts: Object.freeze(factIds),
		availableAtBlock: atBlock,
		availableAtInstruction(instruction) {
			return Object.freeze(
				validAtBlock(fn.instructionBlock(instruction)).filter((fact) =>
					subjectsAvailableAtInstruction(fn.fact(fact), instruction),
				),
			);
		},
		impliesAtBlock(block, required) {
			return atBlock(block).find((fact) => coreFactImplies(fn.fact(fact), required));
		},
	};
	return Object.freeze(result);
}

export const CORE_FACT_AVAILABILITY_ANALYSIS: CoreAnalysisDefinition<CoreFactAvailabilityAnalysis> =
	{
		key: "fact-availability",
		scope: "function",
		functionDependencies: ["facts", "body", "cfg"],
		compute({ program, request, get }) {
			if (request.scope !== "function") throw new Error("Expected function analysis");
			return analyzeCoreFactAvailability(
				program.function(request.function),
				get(CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS, request),
			);
		},
	};
