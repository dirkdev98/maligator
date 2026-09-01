export type CoreRegionFamily =
	| "operation-chain"
	| "stateful-protocol"
	| "projection"
	| "virtual-object"
	| "structural";

export type CoreRegionCorrespondence =
	| "operation-trace"
	| "forward-simulation"
	| "projected-observation"
	| "virtual-object-observation"
	| "local-equivalence";

export type CoreRegionStateSynchronization =
	| "none"
	| "authoritative-language-object"
	| "materialize-before-observation";

export type CoreRegionFallbackFrontier =
	| "before-fast-operation"
	| "before-state-mutation"
	| "materialize-then-generic"
	| "retained-instruction";

export type CoreRegionLifetime =
	| "single-operation"
	| "claimed-region"
	| "function-activation";

export type CoreRegionInvalidatingEffect =
	| "escape"
	| "guard-failure"
	| "observation"
	| "semantic-epoch-change"
	| "suspension";

export interface CoreRegionStrategyDefinition {
	readonly artifactTag: number;
	readonly family: CoreRegionFamily;
	readonly representation: string;
	readonly composition: "exclusive" | "overlay";
	readonly compositionLayer?: "iterator-entry-pair" | "iterator-result" | "numeric-value";
	readonly correspondence: CoreRegionCorrespondence;
	readonly lifetime: CoreRegionLifetime;
	readonly invalidatingEffects: ReadonlyArray<CoreRegionInvalidatingEffect>;
	readonly stateSynchronization: CoreRegionStateSynchronization;
	readonly fallbackFrontier: CoreRegionFallbackFrontier;
	readonly maximumClaims: number;
}

export const CORE_REGION_STRATEGIES = {
	"string-split-cursor": {
		artifactTag: 2,
		family: "stateful-protocol",
		representation: "split-cursor-spans",
		composition: "exclusive",
		correspondence: "forward-simulation",
		lifetime: "claimed-region",
		invalidatingEffects: ["guard-failure", "observation", "semantic-epoch-change"],
		stateSynchronization: "materialize-before-observation",
		fallbackFrontier: "materialize-then-generic",
		maximumClaims: 96,
	},
	"string-split-projection": {
		artifactTag: 4,
		family: "projection",
		representation: "projected-elements",
		composition: "exclusive",
		correspondence: "projected-observation",
		lifetime: "claimed-region",
		invalidatingEffects: ["guard-failure", "observation", "semantic-epoch-change"],
		stateSynchronization: "materialize-before-observation",
		fallbackFrontier: "materialize-then-generic",
		maximumClaims: 96,
	},
	"regexp-exec-projection": {
		artifactTag: 5,
		family: "projection",
		representation: "regexp-capture-spans",
		composition: "exclusive",
		correspondence: "projected-observation",
		lifetime: "claimed-region",
		invalidatingEffects: ["guard-failure", "observation", "semantic-epoch-change"],
		stateSynchronization: "materialize-before-observation",
		fallbackFrontier: "materialize-then-generic",
		maximumClaims: 96,
	},
	"regexp-iterator-projection": {
		artifactTag: 6,
		family: "stateful-protocol",
		representation: "regexp-iterator-capture-spans",
		composition: "exclusive",
		correspondence: "forward-simulation",
		lifetime: "claimed-region",
		invalidatingEffects: ["guard-failure", "observation", "semantic-epoch-change"],
		stateSynchronization: "authoritative-language-object",
		fallbackFrontier: "before-state-mutation",
		maximumClaims: 96,
	},
	"string-slice-number": {
		artifactTag: 7,
		family: "operation-chain",
		representation: "primitive-string-span-number",
		composition: "exclusive",
		correspondence: "operation-trace",
		lifetime: "claimed-region",
		invalidatingEffects: ["guard-failure", "semantic-epoch-change"],
		stateSynchronization: "none",
		fallbackFrontier: "before-fast-operation",
		maximumClaims: 96,
	},
	"stack-object-plan": {
		artifactTag: 11,
		family: "virtual-object",
		representation: "activation-local-fixed-shape-objects",
		composition: "exclusive",
		correspondence: "virtual-object-observation",
		lifetime: "function-activation",
		invalidatingEffects: ["escape", "guard-failure", "observation"],
		stateSynchronization: "materialize-before-observation",
		fallbackFrontier: "materialize-then-generic",
		maximumClaims: 96,
	},
	"numeric-fusion": {
		artifactTag: 14,
		family: "structural",
		representation: "binary-pairs-f64",
		composition: "overlay",
		compositionLayer: "numeric-value",
		correspondence: "local-equivalence",
		lifetime: "claimed-region",
		invalidatingEffects: ["guard-failure"],
		stateSynchronization: "none",
		fallbackFrontier: "retained-instruction",
		maximumClaims: 64,
	},
	"indexed-length-loop": {
		artifactTag: 15,
		family: "operation-chain",
		representation: "live-indexed-length-loops",
		composition: "exclusive",
		correspondence: "operation-trace",
		lifetime: "claimed-region",
		invalidatingEffects: ["guard-failure"],
		stateSynchronization: "none",
		fallbackFrontier: "retained-instruction",
		maximumClaims: 64,
	},
	"string-char-code-at-chain": {
		artifactTag: 16,
		family: "operation-chain",
		representation: "primitive-string-code-unit",
		composition: "exclusive",
		correspondence: "operation-trace",
		lifetime: "claimed-region",
		invalidatingEffects: ["guard-failure", "semantic-epoch-change"],
		stateSynchronization: "none",
		fallbackFrontier: "before-fast-operation",
		maximumClaims: 8,
	},
	"array-values-iterator-cursor": {
		artifactTag: 17,
		family: "stateful-protocol",
		representation: "array-values-authoritative-cursor",
		composition: "exclusive",
		correspondence: "forward-simulation",
		lifetime: "claimed-region",
		invalidatingEffects: ["guard-failure", "suspension"],
		stateSynchronization: "authoritative-language-object",
		fallbackFrontier: "before-state-mutation",
		maximumClaims: 64,
	},
	"string-iterator-cursor": {
		artifactTag: 18,
		family: "stateful-protocol",
		representation: "string-authoritative-cursor",
		composition: "exclusive",
		correspondence: "forward-simulation",
		lifetime: "claimed-region",
		invalidatingEffects: ["guard-failure", "suspension"],
		stateSynchronization: "authoritative-language-object",
		fallbackFrontier: "before-state-mutation",
		maximumClaims: 64,
	},
	"typed-array-iterator-cursor": {
		artifactTag: 19,
		family: "stateful-protocol",
		representation: "typed-array-authoritative-cursor",
		composition: "exclusive",
		correspondence: "forward-simulation",
		lifetime: "claimed-region",
		invalidatingEffects: ["guard-failure", "suspension"],
		stateSynchronization: "authoritative-language-object",
		fallbackFrontier: "before-state-mutation",
		maximumClaims: 64,
	},
	"map-iterator-cursor": {
		artifactTag: 20,
		family: "stateful-protocol",
		representation: "map-authoritative-cursor",
		composition: "exclusive",
		correspondence: "forward-simulation",
		lifetime: "claimed-region",
		invalidatingEffects: ["guard-failure", "suspension"],
		stateSynchronization: "authoritative-language-object",
		fallbackFrontier: "before-state-mutation",
		maximumClaims: 64,
	},
	"set-iterator-cursor": {
		artifactTag: 21,
		family: "stateful-protocol",
		representation: "set-authoritative-cursor",
		composition: "exclusive",
		correspondence: "forward-simulation",
		lifetime: "claimed-region",
		invalidatingEffects: ["guard-failure", "suspension"],
		stateSynchronization: "authoritative-language-object",
		fallbackFrontier: "before-state-mutation",
		maximumClaims: 64,
	},
	"iterator-result-virtualization": {
		artifactTag: 22,
		family: "virtual-object",
		representation: "virtual-iterator-result",
		composition: "overlay",
		compositionLayer: "iterator-result",
		correspondence: "virtual-object-observation",
		lifetime: "single-operation",
		invalidatingEffects: ["guard-failure", "observation"],
		stateSynchronization: "materialize-before-observation",
		fallbackFrontier: "materialize-then-generic",
		maximumClaims: 64,
	},
	"builtin-collection-call-chain": {
		artifactTag: 23,
		family: "operation-chain",
		representation: "captured-collection-method",
		composition: "exclusive",
		correspondence: "operation-trace",
		lifetime: "single-operation",
		invalidatingEffects: ["guard-failure", "semantic-epoch-change"],
		stateSynchronization: "none",
		fallbackFrontier: "before-fast-operation",
		maximumClaims: 2,
	},
	"iterator-entry-pair-virtualization": {
		artifactTag: 24,
		family: "stateful-protocol",
		representation: "virtual-iterator-entry-pair",
		composition: "overlay",
		compositionLayer: "iterator-entry-pair",
		correspondence: "forward-simulation",
		lifetime: "claimed-region",
		invalidatingEffects: ["guard-failure", "observation", "semantic-epoch-change"],
		stateSynchronization: "authoritative-language-object",
		fallbackFrontier: "before-state-mutation",
		maximumClaims: 16,
	},
	"function-call-chain": {
		artifactTag: 25,
		family: "operation-chain",
		representation: "guarded-function-call-flattening",
		composition: "exclusive",
		correspondence: "operation-trace",
		lifetime: "single-operation",
		invalidatingEffects: ["guard-failure", "semantic-epoch-change"],
		stateSynchronization: "none",
		fallbackFrontier: "before-fast-operation",
		maximumClaims: 2,
	},
} as const satisfies Record<string, CoreRegionStrategyDefinition>;

export type RegisteredCoreRegionKind = keyof typeof CORE_REGION_STRATEGIES;
export type CoreRegionKind = RegisteredCoreRegionKind | `test-${string}`;

const CORE_REGION_KIND_BY_ARTIFACT_TAG = new Map<number, RegisteredCoreRegionKind>(
	Object.entries(CORE_REGION_STRATEGIES).map(([kind, definition]) => [
		definition.artifactTag,
		kind as RegisteredCoreRegionKind,
	]),
);

if (
	CORE_REGION_KIND_BY_ARTIFACT_TAG.size !== Object.keys(CORE_REGION_STRATEGIES).length
) {
	throw new Error("Core region strategy artifact tags must be unique");
}

for (const [kind, definition] of Object.entries(CORE_REGION_STRATEGIES)) {
	if ((definition.composition === "overlay") !== "compositionLayer" in definition) {
		throw new Error(`Core region strategy ${kind} has an invalid composition layer`);
	}
}

export function coreRegionStrategy(
	kind: RegisteredCoreRegionKind,
): CoreRegionStrategyDefinition {
	return CORE_REGION_STRATEGIES[kind];
}

export function coreRegionKindFromArtifactTag(
	tag: number,
): RegisteredCoreRegionKind | undefined {
	return CORE_REGION_KIND_BY_ARTIFACT_TAG.get(tag);
}

const CORE_PLAN_ONLY_TARGET_STRATEGIES: ReadonlySet<string> = new Set([
	"dense-array-plan",
	"guarded-direct-call",
	"numeric-fusion",
	"regexp-exec-projection",
	"regexp-iterator-projection",
	"stack-object-plan",
	"string-slice-number",
	"string-split-projection",
	"string-char-code-at-chain",
	"builtin-collection-call-chain",
	"array-values-iterator-cursor",
	"string-iterator-cursor",
	"typed-array-iterator-cursor",
	"map-iterator-cursor",
	"set-iterator-cursor",
	"iterator-result-virtualization",
	"iterator-entry-pair-virtualization",
	"fresh-array-length",
	"indexed-length-loop",
	"function-call-chain",
	"string-split-cursor",
]);

const CORE_NUMERIC_FUSION_START_OPERATORS: ReadonlySet<string> = new Set([
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

const CORE_NUMERIC_FUSION_FINISH_OPERATORS: ReadonlySet<string> = new Set([
	...CORE_NUMERIC_FUSION_START_OPERATORS,
	"<",
	"<=",
	">",
	">=",
	"==",
	"!=",
	"===",
	"!==",
]);

export function coreTargetSupportsSpecialization(kind: string): boolean {
	return CORE_PLAN_ONLY_TARGET_STRATEGIES.has(kind);
}

export function coreTargetSupportsNumericFusionOperator(
	operator: unknown,
	role: "start" | "finish",
): operator is string {
	return (
		typeof operator === "string" &&
		(role === "start"
			? CORE_NUMERIC_FUSION_START_OPERATORS
			: CORE_NUMERIC_FUSION_FINISH_OPERATORS
		).has(operator)
	);
}
