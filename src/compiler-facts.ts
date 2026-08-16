import type { ResolvedBuildConfig } from "./build-config.ts";
import { builtinOperations, primordialGlobalBindings } from "./builtin-registry.ts";

/** Stable identifiers used by proofs instead of pass-local object identity. */
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

export type FactScope =
	| { kind: "world" }
	| { kind: "program"; entrypoint: string }
	| { kind: "module"; path: string }
	| { kind: "function"; id: number }
	| { kind: "site"; id: SourceSiteId };

export type FactDependency =
	| { kind: "world"; fact: WorldFactId }
	| { kind: "epoch"; family: SemanticEpochFamily }
	| { kind: "guard"; id: string }
	| { kind: "summary"; id: string };

export type FactObligation =
	| { kind: "fallback"; id: string }
	| { kind: "materialize"; id: string };

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

function dependencyKey(dependency: FactDependency): string {
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

function mergedProof(left: FactProof, right: FactProof): FactProof | undefined {
	if (JSON.stringify(left.scope) !== JSON.stringify(right.scope)) {
		return undefined;
	}
	const dependencies = new Map<string, FactDependency>();
	for (const dependency of [...left.dependencies, ...right.dependencies]) {
		dependencies.set(dependencyKey(dependency), dependency);
	}
	const obligations = new Map<string, FactObligation>();
	for (const obligation of [...left.obligations, ...right.obligations]) {
		obligations.set(`${obligation.kind}:${obligation.id}`, obligation);
	}
	return {
		scope: left.scope,
		dependencies: [...dependencies.entries()]
			.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
			.map(([, dependency]) => dependency),
		obligations: [...obligations.entries()]
			.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
			.map(([, obligation]) => obligation),
		origin: left.origin === right.origin ? left.origin : `${left.origin}+${right.origin}`,
	};
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

export interface WorldFacts {
	readonly primordialPolicy: "locked" | "mutable";
	readonly authorityClosure: "closed";
	readonly sourceClosure: CompilerFact<"closed">;
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
	const worldProof: FactProof = {
		scope: { kind: "world" },
		dependencies: [{ kind: "world", fact: "eval.disabled" }],
		obligations: [],
		origin: "resolved-build-config",
	};
	return {
		primordialPolicy: config.engine.primordials,
		authorityClosure: "closed",
		sourceClosure:
			evalMode === "disabled"
				? knownFact("closed", worldProof)
				: unknownFact("eval-visible"),
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

export interface FunctionEffectSummary {
	readonly id: string;
	readonly effects: ReadonlyArray<EffectKind>;
	readonly callees: ReadonlyArray<string>;
	readonly externallyReachable: boolean;
	readonly parameterEscape: ReadonlyArray<"none" | "invoked" | "returned" | "retained">;
	readonly restParameterEscape: "none" | "invoked" | "returned" | "retained";
	readonly receiverEscape: "none" | "invoked" | "returned" | "retained";
	readonly returnProvenance: "fresh" | "primitive" | "param" | "unknown";
}

export interface ModuleEffectSummary {
	readonly id: string;
	readonly effects: ReadonlyArray<EffectKind>;
	readonly functions: ReadonlyArray<string>;
	readonly externallyReachable: boolean;
}

/** Monotone summary merge used by the existing program-wide fixed-point driver. */
export function mergeEffectSummaries(
	left: FunctionEffectSummary,
	right: FunctionEffectSummary,
): FunctionEffectSummary {
	if (left.id !== right.id) {
		throw new Error(`cannot merge summaries for ${left.id} and ${right.id}`);
	}
	return {
		id: left.id,
		effects: [...new Set([...left.effects, ...right.effects])].sort(),
		callees: [...new Set([...left.callees, ...right.callees])].sort(),
		externallyReachable: left.externallyReachable || right.externallyReachable,
		parameterEscape: left.parameterEscape.map((escape, index) => {
			const rightEscape = right.parameterEscape[index] ?? right.restParameterEscape;
			const rank = { none: 0, invoked: 1, returned: 2, retained: 3 } as const;
			return rank[escape] >= rank[rightEscape] ? escape : rightEscape;
		}),
		restParameterEscape:
			left.restParameterEscape === "retained" || right.restParameterEscape === "retained"
				? "retained"
				: left.restParameterEscape === "returned" ||
					  right.restParameterEscape === "returned"
					? "returned"
					: left.restParameterEscape === "invoked" ||
						  right.restParameterEscape === "invoked"
						? "invoked"
						: "none",
		receiverEscape:
			left.receiverEscape === "retained" || right.receiverEscape === "retained"
				? "retained"
				: left.receiverEscape === "returned" || right.receiverEscape === "returned"
					? "returned"
					: left.receiverEscape === "invoked" || right.receiverEscape === "invoked"
						? "invoked"
						: "none",
		returnProvenance:
			left.returnProvenance === right.returnProvenance
				? left.returnProvenance
				: "unknown",
	};
}

export interface KnownBuiltinCall {
	readonly operation: string;
	readonly identity: CompilerFact<string>;
	/** Logical site identity is attached when source-position metadata is available. */
	readonly sourceSite?: SourceSiteId;
}

export interface CompilerProgramFacts {
	readonly world: WorldFacts;
	readonly compilationMode: "development" | "full";
	/** Current runtime protector state expressed independently of its consumers. */
	readonly protectors: ReadonlyMap<SemanticEpochFamily, CompilerFact<"valid">>;
	/** Semantic builtin identities; lowering may still retain guards and fallbacks. */
	readonly builtinIdentities: ReadonlyMap<string, CompilerFact<string>>;
	/** Global primordial aliases which the locked-world contract makes immutable. */
	readonly immutableGlobalBindings: ReadonlyMap<string, CompilerFact<"immutable">>;
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

function epochProof(family: SemanticEpochFamily, origin: string): FactProof {
	return {
		scope: { kind: "world" },
		dependencies: [{ kind: "epoch", family }],
		obligations: [{ kind: "fallback", id: "generic-operation" }],
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

function compilerProgramFacts(world: WorldFacts): CompilerProgramFacts {
	return {
		world,
		compilationMode: "full",
		...sharedSemanticFacts(world),
		functionEffects: new Map(),
		moduleEffects: new Map(),
	};
}

/** Conservative seed for compiler entry points that do not yet carry a build config. */
export function conservativeCompilerProgramFacts(): CompilerProgramFacts {
	return compilerProgramFacts({
		primordialPolicy: "mutable",
		authorityClosure: "closed",
		sourceClosure: unknownFact("open-world-reachability"),
		eval: "runtime",
		realms: true,
		ecmaFeatures: { regexp: true, temporal: true, intl: true },
		protectedSurface: "ecmascript",
	});
}

export function compilerProgramFactsFromConfig(
	config: ResolvedBuildConfig,
): CompilerProgramFacts {
	return compilerProgramFacts(worldFactsFromConfig(config));
}
