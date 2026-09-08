import type {
	PrimordialCatalog,
	PrimordialProperty,
} from "../src/compiler/shared/primordial-catalog-types.ts";

export const staticValueAxes = [
	"R",
	"D",
	"T",
	"F",
	"X",
	"A",
	"V",
	"M",
	"U",
	"L",
	"P",
	"C",
	"Z",
] as const;
export const staticValueProfiles = [
	"static-observable",
	"static-receiver-dynamic-argument",
	"dynamic-receiver-static-parameter",
	"brand-with-unknown-contents",
	"known-consumer",
	"escaping-identity",
	"adapted-invocation",
	"mutable-proxy-realm",
	"effectful-guard-failure",
	"unused-result",
	"large-recursive-loop",
	"environment-state-gc-suspension",
] as const;

export interface CoverageWitness {
	readonly file: string;
	readonly test: string;
}
export interface CoverageDecision {
	readonly profile: string;
	readonly axis: string;
	readonly state: "implemented" | "not-applicable";
	readonly reason?: string;
	readonly positive?: CoverageWitness;
	readonly negative: CoverageWitness;
	readonly lowering:
		| "resolved"
		| "direct"
		| "specialized"
		| "constant"
		| "virtual"
		| "materialized"
		| "residual-throw"
		| "eliminated"
		| "semantic-boundary";
}
export interface StaticValueCoverageRow {
	readonly id: string;
	readonly owner: string;
	readonly key: string;
	readonly kind: "data" | "accessor" | "call" | "construct" | "binding";
	readonly ownerPaths: ReadonlyArray<string>;
	readonly operations: ReadonlyArray<string>;
	readonly task: string;
	readonly decisions: ReadonlyArray<CoverageDecision>;
}
export interface StaticValueCoverage {
	readonly schema: 1;
	readonly defaultObligation: "pending-specialized-witnesses";
	readonly axes: ReadonlyArray<string>;
	readonly profiles: ReadonlyArray<string>;
	readonly rows: ReadonlyArray<StaticValueCoverageRow>;
	readonly implementations: ReadonlyArray<{
		readonly id: string;
		readonly identities: ReadonlyArray<string>;
	}>;
	readonly seeds: ReadonlyArray<{
		readonly owner: string;
		readonly key: string;
		readonly task: string;
		readonly exposures: ReadonlyArray<string>;
		readonly state:
			| "reconciled"
			| "not-installed-in-full-inventory"
			| "expansion-obligation";
	}>;
}

export function catalogPropertyKey(
	catalog: PrimordialCatalog,
	descriptor: PrimordialProperty,
): string {
	return typeof descriptor[0] === "string"
		? descriptor[0]
		: `symbol:${catalog.nodes[descriptor[0][0]]![0]}`;
}

export function catalogExposureId(owner: string, key: string): string {
	return JSON.stringify([owner, key]);
}

export function validateStaticValueCoverage(
	coverage: StaticValueCoverage,
	catalog: PrimordialCatalog,
	options: {
		readonly closure?: boolean;
		readonly witnessExists?: (witness: CoverageWitness) => boolean;
	} = {},
): void {
	if (
		coverage.defaultObligation !== "pending-specialized-witnesses" ||
		JSON.stringify(coverage.axes) !== JSON.stringify(staticValueAxes) ||
		JSON.stringify(coverage.profiles) !== JSON.stringify(staticValueProfiles)
	)
		throw new Error("Coverage must retain every axis and profile");
	const expected = new Set(
		catalog.nodes.flatMap((node) => [
			...node[4].map((property) =>
				catalogExposureId(node[0], catalogPropertyKey(catalog, property)),
			),
			...((node[2] & 2) !== 0
				? [
						catalogExposureId(node[0], "<call>"),
						catalogExposureId(node[0], "<construct>"),
					]
				: []),
		]),
	);
	for (const [root] of catalog.roots) expected.add(catalogExposureId("[[roots]]", root));
	const actual = new Set<string>();
	for (const row of coverage.rows) {
		if (actual.has(row.id) || !expected.has(row.id))
			throw new Error(`Unexpected coverage exposure ${row.id}`);
		if (
			row.id !== catalogExposureId(row.owner, row.key) ||
			!/^[C-N]-\d\d$/.test(row.task)
		)
			throw new Error(`Unassigned coverage exposure ${row.id}`);
		actual.add(row.id);
		const node = catalog.nodes.find((node) => node[0] === row.owner);
		const expectedPaths =
			row.kind === "binding"
				? ["[[roots]]"]
				: node === undefined
					? []
					: [...new Set([node[0], ...node[5]])].sort();
		if (JSON.stringify(row.ownerPaths) !== JSON.stringify(expectedPaths))
			throw new Error(`Uncovered owner paths: ${row.id}`);
		const cells = new Set<string>();
		for (const decision of row.decisions) {
			const cell = `${decision.profile}/${decision.axis}`;
			if (
				!coverage.profiles.includes(decision.profile) ||
				!coverage.axes.includes(decision.axis) ||
				cells.has(cell)
			)
				throw new Error(`Invalid coverage cell ${row.id}/${cell}`);
			cells.add(cell);
			if (
				!decision.negative.file ||
				!decision.negative.test ||
				options.witnessExists?.(decision.negative) === false
			)
				throw new Error(`Missing rejection witness ${row.id}/${cell}`);
			if (decision.state === "not-applicable") {
				if (
					!decision.reason ||
					/not (yet )?(implemented|supported)|runtime.only|generic.dispatch|budget|pending/i.test(
						decision.reason,
					) ||
					decision.lowering !== "semantic-boundary"
				)
					throw new Error(
						`Implementation limitation is not semantic inapplicability: ${row.id}/${cell}`,
					);
			} else {
				if (
					!decision.positive?.file ||
					!decision.positive.test ||
					options.witnessExists?.(decision.positive) === false
				)
					throw new Error(`Missing positive witness ${row.id}/${cell}`);
				if (
					["A", "V", "U"].includes(decision.axis) &&
					["resolved", "direct", "materialized"].includes(decision.lowering)
				)
					throw new Error(
						`Direct dispatch does not discharge virtualization: ${row.id}/${cell}`,
					);
			}
		}
		if (options.closure && cells.size !== coverage.axes.length * coverage.profiles.length)
			throw new Error(`Pending optimization obligations: ${row.id}`);
	}
	for (const id of expected)
		if (!actual.has(id))
			throw new Error(`Installed descriptor has no coverage record: ${id}`);
	if (options.closure && coverage.seeds.some((seed) => seed.state !== "reconciled"))
		throw new Error("Unreconciled seed obligations remain");
}
