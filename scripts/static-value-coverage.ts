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
	readonly case?: string;
}
export interface CoverageDecision {
	readonly profiles: ReadonlyArray<string>;
	readonly axes: ReadonlyArray<string>;
	readonly state: "implemented" | "not-applicable";
	readonly implementation?: { readonly file: string; readonly symbol: string };
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
	readonly schema: 2;
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
		readonly instanceObservation?: {
			readonly producer: string;
			readonly positive: CoverageWitness;
			readonly negative: CoverageWitness;
		};
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
		readonly tasks?: ReadonlyArray<string>;
		readonly witnessExists?: (witness: CoverageWitness) => boolean;
		readonly implementationExists?: (
			implementation: NonNullable<CoverageDecision["implementation"]>,
		) => boolean;
	} = {},
): void {
	if (
		coverage.schema !== 2 ||
		coverage.defaultObligation !== "pending-specialized-witnesses" ||
		JSON.stringify(coverage.axes) !== JSON.stringify(staticValueAxes) ||
		JSON.stringify(coverage.profiles) !== JSON.stringify(staticValueProfiles)
	)
		throw new Error("Coverage must retain every axis and profile");
	if (
		options.tasks?.length === 0 ||
		options.tasks?.some((task) => !coverage.rows.some((row) => row.task === task))
	)
		throw new Error("Unknown coverage closure task");
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
			if (decision.state !== "implemented" && decision.state !== "not-applicable")
				throw new Error(`Invalid coverage state ${row.id}`);
			if (decision.profiles.length === 0 || decision.axes.length === 0)
				throw new Error(`Empty coverage decision ${row.id}`);
			for (const profile of decision.profiles)
				for (const axis of decision.axes) {
					const cell = `${profile}/${axis}`;
					if (
						!coverage.profiles.includes(profile) ||
						!coverage.axes.includes(axis) ||
						cells.has(cell)
					)
						throw new Error(`Invalid coverage cell ${row.id}/${cell}`);
					cells.add(cell);
				}
			const cell = `${decision.profiles.join(",")}/${decision.axes.join(",")}`;
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
					decision.axes.some((axis) => ["A", "V", "U"].includes(axis)) &&
					["resolved", "direct", "materialized"].includes(decision.lowering)
				)
					throw new Error(
						`Direct dispatch does not discharge virtualization: ${row.id}/${cell}`,
					);
				if (
					!decision.implementation?.file ||
					!decision.implementation.symbol ||
					options.implementationExists?.(decision.implementation) === false
				)
					throw new Error(`Missing implementation path ${row.id}/${cell}`);
			}
		}
		if (
			options.closure &&
			(options.tasks === undefined || options.tasks.includes(row.task)) &&
			cells.size !== coverage.axes.length * coverage.profiles.length
		)
			throw new Error(`Pending optimization obligations: ${row.id}`);
	}
	for (const id of expected)
		if (!actual.has(id))
			throw new Error(`Installed descriptor has no coverage record: ${id}`);
	const seeds = new Set<string>();
	for (const seed of coverage.seeds) {
		const id = catalogExposureId(seed.owner, seed.key);
		if (seeds.has(id)) throw new Error(`Duplicate coverage seed ${id}`);
		seeds.add(id);
		if (
			!["reconciled", "not-installed-in-full-inventory", "expansion-obligation"].includes(
				seed.state,
			) ||
			!/^[C-N]-\d\d$/.test(seed.task) ||
			new Set(seed.exposures).size !== seed.exposures.length ||
			seed.exposures.some((exposure) => !actual.has(exposure)) ||
			(seed.state === "reconciled") !== seed.exposures.length > 0
		)
			throw new Error(`Invalid seed reconciliation ${id}`);
		const observation = seed.instanceObservation;
		if (observation !== undefined) {
			const producer = coverage.rows.find((row) => row.id === observation.producer);
			if (
				!seed.owner.endsWith(" instances") ||
				producer?.kind !== "construct" ||
				producer.owner !== seed.owner.slice(0, -" instances".length) ||
				!seed.exposures.includes(producer.id) ||
				producer.task !== seed.task ||
				!observation.positive.file ||
				!observation.positive.test ||
				!observation.negative.file ||
				!observation.negative.test ||
				options.witnessExists?.(observation.positive) === false ||
				options.witnessExists?.(observation.negative) === false
			)
				throw new Error(`Invalid instance observation ${id}`);
		} else if (seed.owner.endsWith(" instances") && seed.state === "reconciled")
			throw new Error(`Missing instance observation ${id}`);
	}
	if (
		options.closure &&
		coverage.seeds.some(
			(seed) =>
				(options.tasks === undefined || options.tasks.includes(seed.task)) &&
				seed.state !== "reconciled",
		)
	)
		throw new Error("Unreconciled seed obligations remain");
	if (
		options.closure &&
		(options.witnessExists === undefined || options.implementationExists === undefined)
	)
		throw new Error("Coverage closure requires witness and implementation validation");
}

export function summarizeStaticValueCoverage(
	coverage: StaticValueCoverage,
	tasks?: ReadonlyArray<string>,
) {
	const summary = new Map<
		string,
		{
			task: string;
			exposures: number;
			implemented: number;
			notApplicable: number;
			pending: number;
			unreconciledSeeds: number;
		}
	>();
	for (const row of coverage.rows) {
		if (tasks !== undefined && !tasks.includes(row.task)) continue;
		let group = summary.get(row.task);
		if (group === undefined) {
			group = {
				task: row.task,
				exposures: 0,
				implemented: 0,
				notApplicable: 0,
				pending: 0,
				unreconciledSeeds: coverage.seeds.filter(
					(seed) => seed.task === row.task && seed.state !== "reconciled",
				).length,
			};
			summary.set(row.task, group);
		}
		group.exposures++;
		let decided = 0;
		for (const decision of row.decisions) {
			const cells = decision.profiles.length * decision.axes.length;
			decided += cells;
			if (decision.state === "implemented") group.implemented += cells;
			else group.notApplicable += cells;
		}
		group.pending += coverage.axes.length * coverage.profiles.length - decided;
	}
	return [...summary.values()].sort((a, b) => a.task.localeCompare(b.task));
}
