import type { ResolvedBuildConfig } from "../../build-config.ts";
import { builtinOperations, primordialGlobalBindings } from "./builtin-registry.ts";
import type {
	FunctionEffectSummary,
	ModuleEffectSummary,
	ValueEscapeFact,
} from "./effect-summary.ts";
import type {
	FactDependency,
	FactObligation,
	SemanticEpochFamily,
} from "./fact-implication.ts";
import { authorityFallback, normalizeFactRequirements } from "./fact-implication.ts";

/**
 * Stable identifiers used by proofs instead of pass-local object identity. The
 * vocabulary and its implication order live in `fact-implication.ts`; every
 * consumer keeps importing them from here.
 */
export type {
	FactDependency,
	FactObligation,
	FactObligationCause,
	FactRequirements,
	SemanticEpochFamily,
	WorldFactId,
} from "./fact-implication.ts";

/**
 * Summary contracts and the effect vocabulary they share with Core. Declared in
 * `effect-summary.ts` so neither the fact system nor Core owns the vocabulary;
 * consumers keep importing them from here.
 */
export type {
	EffectDomain,
	EffectSummary,
	FunctionEffectSummary,
	ModuleEffectSummary,
	ReturnProvenance,
	ReturnRepresentation,
	SummaryRootReason,
	ValueEscapeFact,
} from "./effect-summary.ts";

export type FactScope =
	| { kind: "world" }
	| { kind: "program"; entrypoint: string }
	| { kind: "module"; path: string }
	| { kind: "function"; id: number }
	| { kind: "site"; id: SourceSiteId };

export interface FactProof {
	readonly scope: FactScope;
	readonly dependencies: ReadonlyArray<FactDependency>;
	/** Semantic obligations lowering must retain until another proof removes them. */
	readonly obligations: ReadonlyArray<FactObligation>;
	readonly origin: string;
}

export type UnknownFactReason =
	| "not-analyzed"
	| "conflicting-control-flow"
	| "unknown-call-target"
	| "invalidatable-epoch"
	| "escaping-result"
	| "observable-identity"
	| "unsupported-consumer"
	| "representation-mismatch"
	| "eval-visible"
	| "open-world-reachability";

export type CompilerFact<T> =
	| { readonly kind: "known"; readonly value: T; readonly proof: FactProof }
	| { readonly kind: "unknown"; readonly reason: UnknownFactReason };

export interface FactJoin<T> {
	readonly fact: CompilerFact<T>;
	/** The predecessor that first made an otherwise-known fact unavailable. */
	readonly lostBy?: "left" | "right" | "conflict";
}

export function knownFact<T>(value: T, proof: FactProof): CompilerFact<T> {
	return { kind: "known", value, proof };
}

export function unknownFact<T>(reason: UnknownFactReason): CompilerFact<T> {
	return { kind: "unknown", reason };
}

/**
 * Join two proofs of the same value in the same scope. The union of both
 * requirement sets is normalized, so a branch proving the value from the locked
 * world and a branch proving it from a covered epoch join to the world proof
 * rather than carrying both plus the epoch's invalidation fallback.
 */
function mergedProof(left: FactProof, right: FactProof): FactProof | undefined {
	if (JSON.stringify(left.scope) !== JSON.stringify(right.scope)) {
		return undefined;
	}
	return normalizeFactRequirements({
		scope: left.scope,
		dependencies: [...left.dependencies, ...right.dependencies],
		obligations: [...left.obligations, ...right.obligations],
		origin: left.origin === right.origin ? left.origin : `${left.origin}+${right.origin}`,
	});
}

/** Conservative control-flow join: retain only equal payloads in the same scope. */
export function joinFacts<T>(
	left: CompilerFact<T>,
	right: CompilerFact<T>,
	equals: (left: T, right: T) => boolean = Object.is,
): FactJoin<T> {
	if (left.kind === "unknown") {
		return { fact: left, lostBy: "left" };
	}
	if (right.kind === "unknown") {
		return { fact: right, lostBy: "right" };
	}
	if (!equals(left.value, right.value)) {
		return {
			fact: unknownFact("conflicting-control-flow"),
			lostBy: "conflict",
		};
	}
	const proof = mergedProof(left.proof, right.proof);
	if (proof === undefined) {
		return {
			fact: unknownFact("conflicting-control-flow"),
			lostBy: "conflict",
		};
	}
	return { fact: knownFact(left.value, proof) };
}

export type SourceSiteId = string & { readonly __sourceSiteId: unique symbol };

/** Stable across compilation sessions; inlining retains this logical identity. */
export function sourceSiteId(
	path: string,
	line: number,
	column: number,
	kind: string,
): SourceSiteId {
	return `${encodeURIComponent(path)}:${line}:${column}:${encodeURIComponent(kind)}` as SourceSiteId;
}

/** How a module becomes an independently entered root of the program. */
export type ClosureRootKind =
	| "entry-module"
	| "static-module"
	| "dynamic-module"
	| "host-module"
	| "virtual-module";

export interface ClosureRoot {
	readonly kind: ClosureRootKind;
	/** Absolute path, host specifier (`node:path`), or virtual module specifier. */
	readonly module: string;
}

export type ClosureOpeningKind =
	| "not-analyzed"
	| "dynamic-code"
	| "host-wire-splicing"
	| "relocatable-artifact"
	| "computed-module-specifier"
	| "unresolved-module-target"
	| "unresolved-runtime-load";

export interface ClosureOpening {
	readonly kind: ClosureOpeningKind;
	/** Module the edge was observed in; absent for whole-artifact openings. */
	readonly module?: string;
	readonly detail: string;
}

/**
 * Whether an opening lets source the compiler never saw enter the running program.
 * `computed-module-specifier` and `unresolved-module-target` do not: both lower to
 * a bounded candidate set over graph modules plus a deterministic rejection, so
 * they cost reachability precision rather than source closure.
 */
export function closureOpeningBreaksSourceClosure(kind: ClosureOpeningKind): boolean {
	switch (kind) {
		case "not-analyzed":
		case "dynamic-code":
		case "host-wire-splicing":
		case "relocatable-artifact":
		case "unresolved-runtime-load":
			return true;
		case "computed-module-specifier":
		case "unresolved-module-target":
			return false;
	}
}

export type ClosureScope =
	| { readonly kind: "unanalyzed" }
	| { readonly kind: "whole-program"; readonly entry: string }
	| { readonly kind: "fragment"; readonly entry: string };

/**
 * Source-closure evidence for one compiled artifact. `sourceClosure` is known only
 * when a real module graph was inspected as a whole program and every enumerated
 * opening is modelled; a build configuration alone can never certify closure.
 */
export interface ProgramClosureCertificate {
	readonly scope: ClosureScope;
	readonly roots: ReadonlyArray<ClosureRoot>;
	readonly openings: ReadonlyArray<ClosureOpening>;
	readonly sourceClosure: CompilerFact<"closed">;
}

/** The certificate every compiler entry point without a module graph must carry. */
export function unanalyzedProgramClosure(detail: string): ProgramClosureCertificate {
	return {
		scope: { kind: "unanalyzed" },
		roots: [],
		openings: [{ kind: "not-analyzed", detail }],
		sourceClosure: unknownFact("open-world-reachability"),
	};
}

/** Assemble a certificate from enumerated roots and openings. */
export function programClosureCertificate(
	scope: ClosureScope,
	roots: ReadonlyArray<ClosureRoot>,
	openings: ReadonlyArray<ClosureOpening>,
): ProgramClosureCertificate {
	const breaking = openings.filter((opening) =>
		closureOpeningBreaksSourceClosure(opening.kind),
	);
	if (scope.kind === "whole-program" && breaking.length === 0) {
		return {
			scope,
			roots,
			openings,
			sourceClosure: knownFact("closed", {
				scope: { kind: "program", entrypoint: scope.entry },
				dependencies: [{ kind: "world", fact: "source.closed" }],
				obligations: [],
				origin: "module-graph-closure-certificate",
			}),
		};
	}
	return {
		scope,
		roots,
		openings,
		sourceClosure: unknownFact(
			breaking.some((opening) => opening.kind === "dynamic-code")
				? "eval-visible"
				: "open-world-reachability",
		),
	};
}

export interface WorldFacts {
	readonly primordialPolicy: "locked" | "mutable";
	readonly eval: "disabled" | "runtime" | "compile-check";
	readonly realms: boolean;
	readonly ecmaFeatures: {
		readonly regexp: boolean;
		readonly temporal: boolean;
		readonly intl: boolean;
	};
	/** Host objects are deliberately outside the Phase 1 primordial graph. */
	readonly protectedSurface: "ecmascript";
}

/** The only build-config-to-analysis projection. Passes consume this value. */
export function worldFactsFromConfig(config: ResolvedBuildConfig): WorldFacts {
	const evalMode =
		config.engine.eval === true
			? "runtime"
			: config.engine.eval === "compile-check"
				? "compile-check"
				: "disabled";
	return {
		primordialPolicy: config.engine.primordials,
		eval: evalMode,
		realms: config.engine.realms,
		ecmaFeatures: {
			regexp: config.engine.regexp,
			temporal: config.engine.temporal,
			intl: config.engine.intl.enabled,
		},
		protectedSurface: "ecmascript",
	};
}

/**
 * Coarse builtin-registry effect vocabulary. It describes a declared builtin
 * operation for diagnostics and identity checking, not memory dependence:
 * interprocedural summaries and Core instruction descriptors use
 * `EffectSummary`'s domains instead.
 */
export type EffectKind =
	| "read-global"
	| "write-global"
	| "read-prototype"
	| "write-prototype"
	| "coerce"
	| "property-access"
	| "call-user-code"
	| "allocate"
	| "escape"
	| "throw"
	| "suspend"
	| "safepoint"
	| "unknown-call"
	| "eval-visible";

export interface KnownBuiltinCall {
	readonly operation: string;
	readonly identity: CompilerFact<string>;
	readonly semantics: CompilerFact<KnownBuiltinSemantics>;
	/** Logical site identity is attached when source-position metadata is available. */
	readonly sourceSite?: SourceSiteId;
}

export interface KnownBuiltinSemantics {
	readonly effects: ReadonlyArray<EffectKind>;
	readonly result: string;
	readonly lowerings: ReadonlyArray<string>;
}

/** Proof requirements retained by a speculative lowering or virtual region. */
export interface CompilerGuardPlan {
	readonly dependencies: ReadonlyArray<FactDependency>;
	readonly obligations: ReadonlyArray<FactObligation>;
}

/**
 * Combine independently-produced facts without inventing a new authority source.
 * Unknown inputs conservatively disable the consumer; named requirements are
 * deduplicated so locked-world proofs naturally collapse to one world dependency.
 */
export function compilerGuardPlan(
	facts: ReadonlyArray<CompilerFact<unknown> | undefined>,
	additionalObligations: ReadonlyArray<FactObligation> = [],
): CompilerGuardPlan | undefined {
	const dependencies: Array<FactDependency> = [];
	const obligations: Array<FactObligation> = [];
	for (const fact of facts) {
		if (fact?.kind !== "known") return undefined;
		dependencies.push(...fact.proof.dependencies);
		obligations.push(...fact.proof.obligations);
	}
	obligations.push(...additionalObligations);
	return normalizeFactRequirements({ dependencies, obligations });
}

/** True only when the call's canonical identity fact proves this exact operation. */
export function knownBuiltinCallProves(
	call: KnownBuiltinCall | undefined,
	operation: string,
): boolean {
	const descriptor = builtinOperations.find((candidate) => candidate.id === operation);
	return (
		descriptor !== undefined &&
		call?.operation === operation &&
		call.identity.kind === "known" &&
		call.identity.value === operation &&
		call.semantics.kind === "known" &&
		call.semantics.value.result === descriptor.result &&
		call.semantics.value.effects.join("\0") === descriptor.effects.join("\0") &&
		call.semantics.value.lowerings.join("\0") === descriptor.lowerings.join("\0")
	);
}

/** A known fact whose validity depends only on immutable whole-world policy. */
export function compilerFactIsWorldInvariant<T>(
	fact: CompilerFact<T> | undefined,
): fact is Extract<CompilerFact<T>, { kind: "known" }> {
	return (
		fact?.kind === "known" &&
		fact.proof.dependencies.length > 0 &&
		fact.proof.dependencies.every((dependency) => dependency.kind === "world")
	);
}

export type ShapeFact =
	| { readonly kind: "object"; readonly keys: ReadonlyArray<string> }
	| { readonly kind: "array"; readonly elements: "dense" | "unknown" };

export type RepresentationFact = "heap" | "stack";

/** Residual facts keyed to a final optimized instruction, before register reuse. */
export interface CompilerSiteFacts {
	readonly id: string;
	readonly sourceSite?: SourceSiteId;
	readonly functionId: string;
	readonly instruction: string;
	readonly shape?: CompilerFact<ShapeFact>;
	readonly escape?: CompilerFact<ValueEscapeFact>;
	readonly representation?: CompilerFact<RepresentationFact>;
	readonly builtinIdentity?: CompilerFact<string>;
	readonly builtinSemantics?: CompilerFact<KnownBuiltinSemantics>;
	readonly immutableBinding?: CompilerFact<"immutable">;
}

export interface CompilerProgramFacts {
	readonly world: WorldFacts;
	readonly compilationMode: "development" | "full";
	/** Graph-derived source-closure evidence. Open until a producer inspects one. */
	readonly closure: ProgramClosureCertificate;
	/** Current runtime protector state expressed independently of its consumers. */
	readonly protectors: ReadonlyMap<SemanticEpochFamily, CompilerFact<"valid">>;
	/** Semantic builtin identities; lowering may still retain guards and fallbacks. */
	readonly builtinIdentities: ReadonlyMap<string, CompilerFact<string>>;
	/** Global primordial aliases which the locked-world contract makes immutable. */
	readonly immutableGlobalBindings: ReadonlyMap<string, CompilerFact<"immutable">>;
	/** Final residual sites. Populated lazily before register allocation. */
	readonly sites: ReadonlyMap<string, CompilerSiteFacts>;
	/** Object identity bridge for lowering/profile metadata; never serialized. */
	readonly instructionSites: WeakMap<object, CompilerSiteFacts>;
	readonly functionEffects: ReadonlyMap<string, FunctionEffectSummary>;
	readonly moduleEffects: ReadonlyMap<string, ModuleEffectSummary>;
}

function worldProof(origin: string): FactProof {
	return {
		scope: { kind: "world" },
		dependencies: [{ kind: "world", fact: "primordials.locked" }],
		obligations: [],
		origin,
	};
}

/**
 * An invalidatable epoch owes the generic operation as its twin. The witness is
 * the epoch dependency itself: only a world dependency that covers this exact
 * family retires the fallback, so `global-bindings` and `object-shapes` keep it
 * even in a locked build.
 */
function epochProof(family: SemanticEpochFamily, origin: string): FactProof {
	return {
		scope: { kind: "world" },
		dependencies: [{ kind: "epoch", family }],
		obligations: [authorityFallback("generic-operation", { kind: "epoch", family })],
		origin,
	};
}

function sharedSemanticFacts(
	world: WorldFacts,
): Pick<
	CompilerProgramFacts,
	"protectors" | "builtinIdentities" | "immutableGlobalBindings"
> {
	const protectors = new Map<SemanticEpochFamily, CompilerFact<"valid">>();
	for (const family of [
		"primitive-methods",
		"watched-methods",
		"array-elements",
		"global-bindings",
		"object-shapes",
	] as const) {
		const lockedInvariant =
			world.primordialPolicy === "locked" &&
			(family === "primitive-methods" ||
				family === "watched-methods" ||
				family === "array-elements");
		protectors.set(
			family,
			knownFact(
				"valid",
				lockedInvariant
					? worldProof("locked-primordial-protector")
					: epochProof(family, "runtime-semantic-protector"),
			),
		);
	}

	const builtinIdentities = new Map<string, CompilerFact<string>>();
	for (const operation of builtinOperations) {
		builtinIdentities.set(
			operation.id,
			knownFact(
				operation.id,
				world.primordialPolicy === "locked"
					? worldProof("locked-builtin-registry")
					: epochProof("watched-methods", "watched-builtin-identity"),
			),
		);
	}

	const immutableGlobalBindings = new Map<string, CompilerFact<"immutable">>();
	for (const binding of primordialGlobalBindings) {
		immutableGlobalBindings.set(
			binding.name,
			world.primordialPolicy === "locked"
				? knownFact("immutable", worldProof("locked-primordial-binding"))
				: unknownFact("invalidatable-epoch"),
		);
	}
	return { protectors, builtinIdentities, immutableGlobalBindings };
}

function compilerProgramFacts(
	world: WorldFacts,
	closure: ProgramClosureCertificate,
): CompilerProgramFacts {
	return {
		world,
		compilationMode: "full",
		closure,
		...sharedSemanticFacts(world),
		sites: new Map(),
		instructionSites: new WeakMap(),
		functionEffects: new Map(),
		moduleEffects: new Map(),
	};
}

/** Conservative seed for compiler entry points that do not yet carry a build config. */
export function conservativeCompilerProgramFacts(): CompilerProgramFacts {
	return compilerProgramFacts(
		{
			primordialPolicy: "mutable",
			eval: "runtime",
			realms: true,
			ecmaFeatures: { regexp: true, temporal: true, intl: true },
			protectedSurface: "ecmascript",
		},
		unanalyzedProgramClosure(
			"compiler entry point without a build configuration or module graph",
		),
	);
}

/**
 * Config-derived facts only. Closure stays open: `engine.eval` bounds what the
 * runtime can compile, but it says nothing about which modules and entry points
 * the program actually contains, so only a module-graph producer may certify it.
 */
export function compilerProgramFactsFromConfig(
	config: ResolvedBuildConfig,
): CompilerProgramFacts {
	return compilerProgramFacts(
		worldFactsFromConfig(config),
		unanalyzedProgramClosure(
			"a build configuration alone cannot certify program closure",
		),
	);
}

/** Attach a module-graph certificate to otherwise config-derived program facts. */
export function withProgramClosure(
	facts: CompilerProgramFacts,
	closure: ProgramClosureCertificate,
): CompilerProgramFacts {
	return { ...facts, closure };
}
