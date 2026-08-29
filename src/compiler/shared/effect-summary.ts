/**
 * The single effect vocabulary shared by Core instruction descriptors and by
 * interprocedural summaries, plus the independent escape, return-provenance, and
 * return-representation lattices a summary carries.
 *
 * One vocabulary is the point: a summary that could not be expressed in the same
 * domains an instruction declares would have to be translated before it could
 * license a refinement, and a translation is exactly where an unsound widening
 * hides. Core re-exports these names as `CORE_EFFECT_DOMAINS`,
 * `CoreEffectDomain`, and `CoreInstructionEffects`.
 *
 * Every lattice here is a join semilattice with an explicit bottom (nothing
 * observed yet) and an explicit top (everything possible). Dimensions are
 * deliberately independent: reaching the top of one never forces the top of
 * another, so an unprovable suspension does not resurrect a proven-absent write.
 */

/**
 * Memory and world effects an operation can have. Domains that can alias share a
 * name, so invalidation flows through the domain rather than through a rule each
 * analysis has to remember.
 */
export const EFFECT_DOMAINS = [
	"captured-slot",
	"local-slot",
	"activation-this",
	"global-slot",
	"global-property",
	"object-property",
	"array-element",
	"host",
	"io",
] as const;

export type EffectDomain = (typeof EFFECT_DOMAINS)[number];

const DOMAIN_ORDER: ReadonlyMap<EffectDomain, number> = new Map(
	EFFECT_DOMAINS.map((domain, index) => [domain, index]),
);

/**
 * What an operation, or a whole function's transitive execution, may do.
 *
 * `reads` and `writes` are deduplicated and kept in `EFFECT_DOMAINS` order so two
 * summaries of the same content are structurally equal and hash to the same
 * digest. `callsUserCode` means control may reach code whose effects this record
 * does not account for; it is therefore the flag every memory consumer treats as
 * a barrier for cells it cannot attribute to a base.
 */
export interface EffectSummary {
	readonly reads: ReadonlyArray<EffectDomain>;
	readonly writes: ReadonlyArray<EffectDomain>;
	readonly mayThrow: boolean;
	readonly maySuspend: boolean;
	readonly mayGc: boolean;
	readonly callsUserCode: boolean;
}

const NO_DOMAINS: ReadonlyArray<EffectDomain> = Object.freeze([]);

/** Bottom: nothing observed. Sound only as a fixed-point starting value. */
export const NO_EFFECT_SUMMARY: EffectSummary = Object.freeze({
	reads: NO_DOMAINS,
	writes: NO_DOMAINS,
	mayThrow: false,
	maySuspend: false,
	mayGc: false,
	callsUserCode: false,
});

/** Top: every domain, every flag. The answer whenever nothing was proven. */
export const EVERY_EFFECT_SUMMARY: EffectSummary = Object.freeze({
	reads: Object.freeze([...EFFECT_DOMAINS]),
	writes: Object.freeze([...EFFECT_DOMAINS]),
	mayThrow: true,
	maySuspend: true,
	mayGc: true,
	callsUserCode: true,
});

/** Deduplicated, in declaration order, so equal content is structurally equal. */
export function normalizeEffectDomains(
	domains: ReadonlyArray<EffectDomain>,
): ReadonlyArray<EffectDomain> {
	if (domains.length <= 1) return domains.length === 0 ? NO_DOMAINS : domains;
	const seen = new Set(domains);
	if (seen.size === domains.length) {
		let ordered = true;
		for (let index = 1; index < domains.length; index += 1) {
			if (DOMAIN_ORDER.get(domains[index - 1]!)! >= DOMAIN_ORDER.get(domains[index]!)!) {
				ordered = false;
				break;
			}
		}
		if (ordered) return domains;
	}
	return EFFECT_DOMAINS.filter((domain) => seen.has(domain));
}

/** Canonical form of an arbitrarily built summary. */
export function normalizeEffectSummary(effects: EffectSummary): EffectSummary {
	return {
		...effects,
		reads: normalizeEffectDomains(effects.reads),
		writes: normalizeEffectDomains(effects.writes),
	};
}

function domainsEqual(
	left: ReadonlyArray<EffectDomain>,
	right: ReadonlyArray<EffectDomain>,
): boolean {
	return (
		left.length === right.length && left.every((domain, index) => domain === right[index])
	);
}

/** Structural equality of two canonical summaries. */
export function effectSummariesEqual(left: EffectSummary, right: EffectSummary): boolean {
	return (
		left.mayThrow === right.mayThrow &&
		left.maySuspend === right.maySuspend &&
		left.mayGc === right.mayGc &&
		left.callsUserCode === right.callsUserCode &&
		domainsEqual(left.reads, right.reads) &&
		domainsEqual(left.writes, right.writes)
	);
}

/** Domain-wise union and flag-wise or; the join of the summary lattice. */
export function joinEffectSummaries(
	left: EffectSummary,
	right: EffectSummary,
): EffectSummary {
	if (left === right) return left;
	const reads =
		right.reads.length === 0
			? normalizeEffectDomains(left.reads)
			: left.reads.length === 0
				? normalizeEffectDomains(right.reads)
				: normalizeEffectDomains([...left.reads, ...right.reads]);
	const writes =
		right.writes.length === 0
			? normalizeEffectDomains(left.writes)
			: left.writes.length === 0
				? normalizeEffectDomains(right.writes)
				: normalizeEffectDomains([...left.writes, ...right.writes]);
	return {
		reads,
		writes,
		mayThrow: left.mayThrow || right.mayThrow,
		maySuspend: left.maySuspend || right.maySuspend,
		mayGc: left.mayGc || right.mayGc,
		callsUserCode: left.callsUserCode || right.callsUserCode,
	};
}

function domainsInclude(
	outer: ReadonlyArray<EffectDomain>,
	inner: ReadonlyArray<EffectDomain>,
): boolean {
	if (inner.length === 0) return true;
	const allowed = new Set(outer);
	return inner.every((domain) => allowed.has(domain));
}

/**
 * Whether `claim` covers everything `actual` may do. This is the soundness test a
 * verifier applies: a claim may be weaker than reality, never stronger.
 */
export function effectSummaryCovers(
	claim: EffectSummary,
	actual: EffectSummary,
): boolean {
	return (
		domainsInclude(claim.reads, actual.reads) &&
		domainsInclude(claim.writes, actual.writes) &&
		(claim.mayThrow || !actual.mayThrow) &&
		(claim.maySuspend || !actual.maySuspend) &&
		(claim.mayGc || !actual.mayGc) &&
		(claim.callsUserCode || !actual.callsUserCode)
	);
}

/** Stable text form used inside proof digests; never parsed back. */
export function effectSummaryKey(effects: EffectSummary): string {
	const flags = [
		effects.mayThrow ? "t" : "-",
		effects.maySuspend ? "s" : "-",
		effects.mayGc ? "g" : "-",
		effects.callsUserCode ? "u" : "-",
	].join("");
	return `r[${effects.reads.join(",")}]w[${effects.writes.join(",")}]${flags}`;
}

/**
 * How far a value the caller supplied can travel. `invoked` means it was called
 * but never stored; `returned` means it can leave through the result; `retained`
 * is the top and means some reachable store, unmodelled use, or unresolvable
 * callee could keep it alive past the call.
 */
export type ValueEscapeFact = "none" | "invoked" | "returned" | "retained";

const ESCAPE_RANK: Readonly<Record<ValueEscapeFact, number>> = Object.freeze({
	none: 0,
	invoked: 1,
	returned: 2,
	retained: 3,
});

export function joinValueEscape(
	left: ValueEscapeFact,
	right: ValueEscapeFact,
): ValueEscapeFact {
	return ESCAPE_RANK[left] >= ESCAPE_RANK[right] ? left : right;
}

/** Whether `claim` is at least as pessimistic as `actual`. */
export function valueEscapeCovers(
	claim: ValueEscapeFact,
	actual: ValueEscapeFact,
): boolean {
	return ESCAPE_RANK[claim] >= ESCAPE_RANK[actual];
}

/**
 * Whether a value can cross the function without losing a caller-owned exact
 * allocation proof. `preserved` permits forwarding, strict identity/typeof
 * observation, and returning the exact reference. `unknown` covers every
 * property, reflection, invocation, retention, throw, host, or unmodelled use.
 *
 * This is deliberately independent of escape: a value can remain unretained yet
 * still have its shape mutated, and scalar/alias consumers need both proofs.
 */
export type ValueContainmentFact = "preserved" | "unknown";

export function joinValueContainment(
	left: ValueContainmentFact,
	right: ValueContainmentFact,
): ValueContainmentFact {
	return left === "unknown" || right === "unknown" ? "unknown" : "preserved";
}

export function valueContainmentCovers(
	claim: ValueContainmentFact,
	actual: ValueContainmentFact,
): boolean {
	return claim === "unknown" || actual === "preserved";
}

/**
 * Where a function's result comes from. `none` is the bottom — no reachable
 * return was observed — and `unknown` is the top. `parameter` and `receiver`
 * describe this function's own frame, so a caller must substitute its argument
 * before consuming them.
 */
export type ReturnProvenance =
	| { readonly kind: "none" }
	| { readonly kind: "fresh" }
	| { readonly kind: "primitive" }
	| { readonly kind: "parameter"; readonly index: number }
	| { readonly kind: "receiver" }
	| { readonly kind: "unknown" };

export const RETURN_PROVENANCE_NONE: ReturnProvenance = Object.freeze({ kind: "none" });
export const RETURN_PROVENANCE_UNKNOWN: ReturnProvenance = Object.freeze({
	kind: "unknown",
});

export function returnProvenanceKey(provenance: ReturnProvenance): string {
	return provenance.kind === "parameter"
		? `parameter:${provenance.index}`
		: provenance.kind;
}

export function joinReturnProvenance(
	left: ReturnProvenance,
	right: ReturnProvenance,
): ReturnProvenance {
	if (left.kind === "none") return right;
	if (right.kind === "none") return left;
	return returnProvenanceKey(left) === returnProvenanceKey(right)
		? left
		: RETURN_PROVENANCE_UNKNOWN;
}

/**
 * Machine shape of a function's result. `none` is the bottom; `boxed` is the top,
 * because every value has a boxed form and no consumer is wrong to assume it.
 * Core representations outside this set collapse to `boxed`: they describe a
 * region-local encoding rather than something a call boundary can hand back.
 */
export type ReturnRepresentation =
	| "none"
	| "boxed"
	| "f64"
	| "i32"
	| "boolean"
	| "string";

export function joinReturnRepresentation(
	left: ReturnRepresentation,
	right: ReturnRepresentation,
): ReturnRepresentation {
	if (left === "none") return right;
	if (right === "none") return left;
	return left === right ? left : "boxed";
}

/** Why the world outside the analyzed graph can enter a function. */
export type SummaryRootReason =
	/** The image's eager entry: module top levels are merged into it. */
	| "program-entry"
	/** A CommonJS wrapper the require intrinsic can enter. */
	| "commonjs-module"
	/** Its identity is installed into a global slot the host writes and reads. */
	| "host-install"
	/** Its identity reaches a sink this analysis cannot follow. */
	| "published-identity"
	/** No closure certificate proves the compiler saw the whole program. */
	| "open-world";

const ROOT_REASON_ORDER: ReadonlyArray<SummaryRootReason> = [
	"open-world",
	"program-entry",
	"commonjs-module",
	"host-install",
	"published-identity",
];

/** Deduplicated in a fixed order so a summary map is a function of the graph. */
export function normalizeRootReasons(
	reasons: Iterable<SummaryRootReason>,
): ReadonlyArray<SummaryRootReason> {
	const seen = new Set(reasons);
	return ROOT_REASON_ORDER.filter((reason) => seen.has(reason));
}

/**
 * Interprocedural summary of one function, in the same vocabulary Core
 * instructions declare.
 *
 * `effects` is transitive: it already includes every callee this analysis could
 * name. `callees` lists only the edges it could name; `openCallEdge` records that
 * at least one edge could not be, which is why an otherwise narrow `effects` may
 * still be saturated. Escape and return facts describe this function's own frame.
 */
export interface FunctionEffectSummary {
	readonly id: string;
	readonly functionIndex: number;
	/** Owning module summary id, so the two maps are navigable in both directions. */
	readonly module: string;
	readonly effects: EffectSummary;
	readonly callees: ReadonlyArray<string>;
	readonly openCallEdge: boolean;
	readonly externallyReachable: boolean;
	readonly rootReasons: ReadonlyArray<SummaryRootReason>;
	readonly parameterEscape: ReadonlyArray<ValueEscapeFact>;
	/** Covers every argument past the declared formals, however it is observed. */
	readonly restParameterEscape: ValueEscapeFact;
	readonly receiverEscape: ValueEscapeFact;
	readonly parameterContainment: ReadonlyArray<ValueContainmentFact>;
	readonly restParameterContainment: ValueContainmentFact;
	readonly receiverContainment: ValueContainmentFact;
	readonly returnProvenance: ReturnProvenance;
	readonly returnRepresentation: ReturnRepresentation;
}

export interface ModuleEffectSummary {
	readonly id: string;
	readonly sourcePath: string;
	readonly effects: EffectSummary;
	readonly functions: ReadonlyArray<string>;
	readonly externallyReachable: boolean;
	/** The program evaluates this module eagerly, rather than only on demand. */
	readonly evaluated: boolean;
}

/**
 * Summary identities. Both encode the source path, so a key stays meaningful
 * after function indices shift and two modules with the same basename never
 * collide. Indices are compilation-local, which is exactly why a summary-derived
 * proof must never be serialized.
 */
export function moduleSummaryId(sourcePath: string): string {
	return encodeURIComponent(sourcePath);
}

export function functionSummaryId(sourcePath: string, functionIndex: number): string {
	return `${moduleSummaryId(sourcePath)}#${functionIndex}`;
}
