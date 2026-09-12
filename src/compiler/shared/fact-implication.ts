/**
 * Canonical vocabulary for what a compiler proof *depends on* and what it still
 * *owes*, plus the implication order that lets a stronger dependency retire a
 * weaker duplicate.
 *
 * The two axes are deliberately independent. A dependency says which world,
 * epoch, guard, or summary must hold; an obligation says which residual runtime
 * work lowering must still emit. Locking primordials collapses dependencies, but
 * it never proves a receiver has no own shadowing property, that a value stays
 * unescaped, that an operand is a number, or that a virtual value never needs
 * materializing. Only obligations that explicitly name authority as their cause,
 * and name the exact dependency that would retire them, can ever be discharged.
 */

export type WorldFactId =
	| "primordials.locked"
	| "authority.closed"
	| "source.closed"
	| "eval.disabled"
	| "realms.disabled"
	| "regexp.enabled"
	| "temporal.enabled"
	| "intl.enabled";

export type SemanticEpochFamily =
	| "primitive-methods"
	| "watched-methods"
	| "array-elements"
	| "global-bindings"
	| "object-shapes";

export type FactDependency =
	| { kind: "world"; fact: WorldFactId }
	| { kind: "epoch"; family: SemanticEpochFamily }
	| { kind: "guard"; id: string }
	| { kind: "summary"; id: string };

/**
 * Why a proof still owes residual work. Exactly one cause — `authority` — is
 * about who may mutate the world; every other cause is a semantic property of
 * this operation's own values and therefore survives any world closure.
 */
export type FactObligationCause =
	/** Primordial identity or an invalidatable semantic epoch. */
	| "authority"
	/** The callee was loaded from a receiver that may own a shadowing property. */
	| "loaded-callee"
	/** The receiver must be the exact expected object, brand, or primitive class. */
	| "receiver-identity"
	/** An operand must belong to a value class the fast path assumes. */
	| "value-class"
	/** The intrinsic must belong to the calling Realm, not merely be primordial. */
	| "realm"
	/** A virtualized value may become observable through an escaping edge. */
	| "escape"
	/** The call must supply the argument count the specialized ABI expects. */
	| "arity"
	/** The region keeps its generic twin so a virtual value can be materialized. */
	| "materialization"
	/** A post-wire runtime boundary still requires the ordinary operation. */
	| "runtime-contract";

export type FactObligation =
	| {
			kind: "fallback";
			id: string;
			cause: FactObligationCause;
			/** The dependency whose presence retires an `authority` fallback. */
			dischargedBy?: FactDependency;
	  }
	| { kind: "materialize"; id: string; cause: FactObligationCause };

/** Requirement pair shared by `FactProof` and `CompilerGuardPlan`. */
export interface FactRequirements {
	readonly dependencies: ReadonlyArray<FactDependency>;
	readonly obligations: ReadonlyArray<FactObligation>;
}

export function factDependencyEquals(
	left: FactDependency,
	right: FactDependency,
): boolean {
	if (left.kind !== right.kind) return false;
	switch (left.kind) {
		case "world":
			return right.kind === "world" && left.fact === right.fact;
		case "epoch":
			return right.kind === "epoch" && left.family === right.family;
		case "guard":
			return right.kind === "guard" && left.id === right.id;
		case "summary":
			return right.kind === "summary" && left.id === right.id;
	}
}

export function factObligationEquals(
	left: FactObligation,
	right: FactObligation,
): boolean {
	return (
		left.kind === right.kind &&
		left.id === right.id &&
		left.cause === right.cause &&
		(left.kind !== "fallback" ||
			(right.kind === "fallback" &&
				(left.dischargedBy === undefined
					? right.dischargedBy === undefined
					: right.dischargedBy !== undefined &&
						factDependencyEquals(left.dischargedBy, right.dischargedBy))))
	);
}

export function factDependencyArraysEqual(
	left: ReadonlyArray<FactDependency>,
	right: ReadonlyArray<FactDependency>,
): boolean {
	return (
		left.length === right.length &&
		left.every((dependency, index) => factDependencyEquals(dependency, right[index]!))
	);
}

export function factRequirementsEqual(
	left: FactRequirements,
	right: FactRequirements,
): boolean {
	return (
		factDependencyArraysEqual(left.dependencies, right.dependencies) &&
		left.obligations.length === right.obligations.length &&
		left.obligations.every((obligation, index) =>
			factObligationEquals(obligation, right.obligations[index]!),
		)
	);
}

export function factDependencyKey(dependency: FactDependency): string {
	switch (dependency.kind) {
		case "world":
			return `world:${dependency.fact}`;
		case "epoch":
			return `epoch:${dependency.family}`;
		case "guard":
			return `guard:${dependency.id}`;
		case "summary":
			return `summary:${dependency.id}`;
	}
}

export function factObligationKey(obligation: FactObligation): string {
	const dischargedBy =
		obligation.kind === "fallback" && obligation.dischargedBy !== undefined
			? factDependencyKey(obligation.dischargedBy)
			: "";
	return `${obligation.kind}:${obligation.id}:${obligation.cause}:${dischargedBy}`;
}

/**
 * Whether `strong` establishes everything `weak` asserts.
 *
 * `authority.closed` is the stronger statement that no host authority can reach
 * the primordial graph at all, so it subsumes the lock. `source.closed` means no
 * source the compiler never saw can enter the program, which subsumes disabled
 * eval. The locked primordial graph pins the method tables and array element
 * protocol, so it subsumes exactly those three epoch families — never
 * `global-bindings` or `object-shapes`, which ordinary user code mutates without
 * touching a primordial.
 */
export function factDependencyImplies(
	strong: FactDependency,
	weak: FactDependency,
): boolean {
	if (factDependencyEquals(strong, weak)) return true;
	if (strong.kind !== "world") return false;
	if (strong.fact === "source.closed") {
		return weak.kind === "world" && weak.fact === "eval.disabled";
	}
	if (strong.fact !== "primordials.locked" && strong.fact !== "authority.closed")
		return false;
	if (weak.kind === "world") return weak.fact === "primordials.locked";
	return (
		weak.kind === "epoch" &&
		(weak.family === "primitive-methods" ||
			weak.family === "watched-methods" ||
			weak.family === "array-elements")
	);
}

/**
 * Deterministic canonical form: deduplicate tagged identities, discard dependencies
 * implied by another retained dependency, then sort for stable artifacts.
 */
export function normalizeFactDependencies(
	dependencies: ReadonlyArray<FactDependency>,
): ReadonlyArray<FactDependency> {
	const seen = new Set<string>();
	const worlds: Array<FactDependency> = [];
	const unique: Array<{ readonly dependency: FactDependency; readonly key: string }> = [];
	for (const dependency of dependencies) {
		const key = factDependencyKey(dependency);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push({ dependency, key });
		if (dependency.kind === "world") worlds.push(dependency);
	}
	// Only a world fact can imply a distinct dependency in this closed vocabulary.
	return unique
		.filter(
			({ dependency }) =>
				!worlds.some(
					(candidate) =>
						candidate !== dependency && factDependencyImplies(candidate, dependency),
				),
		)
		.sort((left, right) => left.key.localeCompare(right.key))
		.map(({ dependency }) => dependency);
}

/**
 * Whether a *world* dependency in this set establishes `witness`.
 *
 * Only a world dependency may retire an authority obligation. Requiring the
 * witness to be world-established is what keeps a proof from discharging its own
 * epoch fallback with the very epoch dependency that fallback exists to cover,
 * and what keeps an unrelated locked-world dependency from retiring an
 * `object-shapes` fallback the lock does not cover. Guard-established witnesses
 * need dominance and are deliberately not modelled here yet.
 */
export function factDependenciesDischarge(
	dependencies: ReadonlyArray<FactDependency>,
	witness: FactDependency,
): boolean {
	return dependencies.some(
		(dependency) =>
			dependency.kind === "world" && factDependencyImplies(dependency, witness),
	);
}

export function factObligationIsDischarged(
	obligation: FactObligation,
	dependencies: ReadonlyArray<FactDependency>,
): boolean {
	return (
		obligation.kind === "fallback" &&
		obligation.cause === "authority" &&
		obligation.dischargedBy !== undefined &&
		factDependenciesDischarge(dependencies, obligation.dischargedBy)
	);
}

/**
 * Deterministic canonical form: deduplicate only semantically identical
 * obligations, drop obligations whose declared authority witness the dependency
 * set establishes, and sort by key. The cause and authority witness are part of
 * identity: two duties may deliberately share a user-facing site id while only
 * one of their witnesses is covered by a closed world.
 * Display keys only select deduplication buckets: IDs and witnesses may contain
 * delimiters, so semantic equality still decides whether a duty is redundant.
 */
export function normalizeFactObligations(
	obligations: ReadonlyArray<FactObligation>,
	dependencies: ReadonlyArray<FactDependency>,
): ReadonlyArray<FactObligation> {
	const buckets = new Map<string, Array<FactObligation>>();
	const unique: Array<{ readonly obligation: FactObligation; readonly key: string }> = [];
	for (const obligation of obligations) {
		const key = factObligationKey(obligation);
		let bucket = buckets.get(key);
		if (bucket === undefined) {
			bucket = [];
			buckets.set(key, bucket);
		} else if (bucket.some((candidate) => factObligationEquals(candidate, obligation))) {
			continue;
		}
		bucket.push(obligation);
		unique.push({ obligation, key });
	}
	return unique
		.filter(({ obligation }) => !factObligationIsDischarged(obligation, dependencies))
		.sort((left, right) => left.key.localeCompare(right.key))
		.map(({ obligation }) => obligation);
}

/**
 * Canonicalize both requirement axes together. Obligations are always tested
 * against the *normalized* dependency set, so an epoch fallback is retired by
 * the same rule that removed its epoch dependency, and never by a stronger
 * dependency that happens to sit beside it without covering it.
 */
export function normalizeFactRequirements<Requirements extends FactRequirements>(
	requirements: Requirements,
): Requirements {
	const dependencies = normalizeFactDependencies(requirements.dependencies);
	return {
		...requirements,
		dependencies,
		obligations: normalizeFactObligations(requirements.obligations, dependencies),
	};
}

/** The authority fallback a specialized site owes until a world proof retires it. */
export function authorityFallback(id: string, witness: FactDependency): FactObligation {
	return { kind: "fallback", id, cause: "authority", dischargedBy: witness };
}
