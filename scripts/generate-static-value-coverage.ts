import { readFileSync, writeFileSync } from "node:fs";
import { HOST_MODULES } from "../src/compiler/frontend/host-modules.ts";
import { getPrimordialCatalog } from "../src/compiler/shared/primordial-catalog-data.ts";
const primordialCatalog = getPrimordialCatalog();
import {
	catalogExposureId,
	catalogPropertyKey,
	staticValueAxes,
	staticValueProfiles,
	validateStaticValueCoverage,
} from "./static-value-coverage.ts";
import type {
	StaticValueCoverage,
	StaticValueCoverageRow,
} from "./static-value-coverage.ts";

type CoverageSeed = StaticValueCoverage["seeds"][number];

const output = "tests/fixtures/primordial-inventory/coverage.json";
const previous = JSON.parse(readFileSync(output, "utf8")) as StaticValueCoverage;
const seeds = previous.seeds;
const normalizedOwner = (owner: string) =>
	owner
		.replace(/^globalThis\./, "")
		.replace(/^%?MAL_INTRINSIC_(?:NODE_)?/, "")
		.replace(/_CONSTRUCTOR%?$/, "")
		.replace(/[^a-zA-Z0-9]/g, "")
		.toLowerCase();
const seedOwners = new Map(
	seeds.map((seed) => [normalizedOwner(seed.owner), seed.owner]),
);
const hostInstallers = new Map(
	[...HOST_MODULES.values()].map((module) => [module.installer, module.id]),
);
function reconciledOwner(owner: string): string {
	const host = owner.replace(/^%|%$/g, "").match(/^(mal_host_install_[^:]+):default$/);
	if (host !== null && hostInstallers.has(host[1]!)) return hostInstallers.get(host[1]!)!;
	return seedOwners.get(normalizedOwner(owner)) ?? owner;
}
const seedKey = (owner: string, key: string) =>
	JSON.stringify([reconciledOwner(owner), key.replace(/^symbol:%(Symbol\.\w+)%$/, "$1")]);
const exact = new Map(seeds.map((seed) => [seedKey(seed.owner, seed.key), seed.task]));

const invocationTasks = new Map<string, { task: string; canonical: boolean }>();
for (const node of primordialCatalog.nodes) {
	for (const property of node[4]) {
		const key = catalogPropertyKey(primordialCatalog, property);
		const task = exact.get(seedKey(node[0], key));
		if (task === undefined || task === "H-10") continue;
		for (const index of [
			typeof property[2] === "number" ? property[2] : -1,
			property[3],
			property[4],
		]) {
			const target = primordialCatalog.nodes[index];
			if (target === undefined || (target[2] & 2) === 0) continue;
			const path = key.startsWith("symbol:")
				? `${node[0]}[${key.slice(7)}]`
				: `${node[0]}.${key}`;
			const canonical =
				target[0] === path ||
				target[0] === `${path}<get>` ||
				target[0] === `${path}<set>` ||
				(node[0] === "globalThis" && target[0] === key);
			const previous = invocationTasks.get(target[0]);
			if (previous === undefined || (!previous.canonical && canonical))
				invocationTasks.set(target[0], { task, canonical });
		}
	}
}
function ownerTask(owner: string, key: string): string {
	const exactTask = exact.get(seedKey(owner, key));
	if (exactTask !== undefined) return exactTask;
	if (key === "<call>" || key === "<construct>") {
		const task = exact.get(seedKey(owner, "<call>")) ?? invocationTasks.get(owner)?.task;
		if (task !== undefined) return task;
	}
	if (
		[
			"name",
			"length",
			"prototype",
			"constructor",
			"arguments",
			"caller",
			"symbol:%Symbol.toStringTag%",
			"symbol:%Symbol.species%",
		].includes(key)
	)
		return "H-10";
	const matches = seeds.filter(
		(seed) => seed.owner === owner || owner.startsWith(`${seed.owner}.`),
	);
	if (matches.length > 0)
		return matches.sort(
			(a, b) => b.owner.length - a.owner.length || a.task.localeCompare(b.task),
		)[0]!.task;
	if (/mal_host_install_node_(buffer|path|url|util|os)/.test(owner)) return "N-04";
	if (/mal_host_install_/.test(owner)) return "N-05";
	if (
		/^globalThis\.(URL|TextEncoder|TextDecoder|Blob|File|FormData|Headers|Request|Response)/.test(
			owner,
		)
	)
		return "N-02";
	if (/^globalThis\./.test(owner)) return "N-03";
	return "N-06";
}
const priorRows = new Map(previous.rows.map((row) => [row.id, row]));
const priorSeeds = new Map(
	previous.seeds.map((seed) => [catalogExposureId(seed.owner, seed.key), seed]),
);
const rows: Array<StaticValueCoverageRow> = primordialCatalog.nodes.flatMap((node) =>
	node[4].map((property) => {
		const key = catalogPropertyKey(primordialCatalog, property);
		const values = [
			typeof property[2] === "number" ? property[2] : -1,
			property[3],
			property[4],
		];
		return {
			id: catalogExposureId(node[0], key),
			owner: node[0],
			ownerPaths: [...new Set([node[0], ...node[5]])].sort(),
			key,
			kind: (property[1] & 8) !== 0 ? "accessor" : "data",
			operations: [
				...new Set(
					values
						.filter((index) => index >= 0)
						.flatMap((index) =>
							primordialCatalog.nodes[index]![3] === null
								? []
								: [primordialCatalog.nodes[index]![3]],
						),
				),
			],
			task: ownerTask(node[0], key),
			decisions: priorRows.get(catalogExposureId(node[0], key))?.decisions ?? [],
		};
	}),
);
for (const node of primordialCatalog.nodes) {
	if ((node[2] & 2) === 0) continue;
	for (const mode of ["call", "construct"] as const) {
		const key = `<${mode}>`;
		rows.push({
			id: catalogExposureId(node[0], key),
			owner: node[0],
			ownerPaths: [...new Set([node[0], ...node[5]])].sort(),
			key,
			kind: mode,
			operations: node[3] === null ? [] : [node[3]],
			task: ownerTask(node[0], key),
			decisions: priorRows.get(catalogExposureId(node[0], key))?.decisions ?? [],
		});
	}
}
for (const [root, value] of primordialCatalog.roots) {
	const separator = root.indexOf(":");
	const owner = hostInstallers.get(root.slice(0, separator)) ?? root;
	const key = separator < 0 ? "<binding>" : root.slice(separator + 1);
	const node = typeof value === "number" ? primordialCatalog.nodes[value] : undefined;
	const id = catalogExposureId("[[roots]]", root);
	rows.push({
		id,
		owner: "[[roots]]",
		ownerPaths: ["[[roots]]"],
		key: root,
		kind: "binding",
		operations: node === undefined || node[3] === null ? [] : [node[3]],
		task: ownerTask(owner, key),
		decisions: priorRows.get(id)?.decisions ?? [],
	});
}
const implementations = new Map<string, Array<string>>();
for (const node of primordialCatalog.nodes) {
	if (node[3] === null) continue;
	let identities = implementations.get(node[3]);
	if (identities === undefined) {
		identities = [];
		implementations.set(node[3], identities);
	}
	identities.push(node[0]);
}
const exposureIndex = new Map<string, Array<string>>();
for (const row of rows)
	for (const owner of row.ownerPaths) {
		const key = seedKey(owner, row.key);
		const entries = exposureIndex.get(key) ?? [];
		if (!entries.includes(row.id)) entries.push(row.id);
		exposureIndex.set(key, entries);
	}
const ownerNodes = new Map(
	primordialCatalog.nodes.flatMap((node, index) =>
		[node[0], ...node[5]].map((owner) => [reconciledOwner(owner), index] as const),
	),
);
function seedExposures(seed: CoverageSeed): ReadonlyArray<string> {
	const observation = priorSeeds.get(
		catalogExposureId(seed.owner, seed.key),
	)?.instanceObservation;
	if (observation !== undefined) return [observation.producer];
	const host = HOST_MODULES.get(seed.owner);
	if (host !== undefined) {
		const root = `${host.installer}:${seed.key}`;
		if (primordialCatalog.roots.some(([name]) => name === root))
			return [catalogExposureId("[[roots]]", root)];
	}
	const direct = exposureIndex.get(seedKey(seed.owner, seed.key));
	if (direct !== undefined) return direct;
	let index = ownerNodes.get(seed.owner);
	const seen = new Set<number>();
	while (index !== undefined && index >= 0 && !seen.has(index)) {
		seen.add(index);
		const node = primordialCatalog.nodes[index]!;
		const matches = exposureIndex.get(seedKey(node[0], seed.key));
		if (matches !== undefined) return matches;
		index = node[1];
	}
	return [];
}
const coverage: StaticValueCoverage = {
	schema: 2,
	defaultObligation: "pending-specialized-witnesses",
	axes: staticValueAxes,
	profiles: staticValueProfiles,
	rows,
	implementations: [...implementations].map(([id, identities]) => ({ id, identities })),
	seeds: seeds.map((seed) => {
		const exposures = seedExposures(seed);
		return {
			owner: seed.owner,
			key: seed.key,
			task: seed.task,
			exposures,
			...(priorSeeds.get(catalogExposureId(seed.owner, seed.key))?.instanceObservation ===
			undefined
				? {}
				: {
						instanceObservation: priorSeeds.get(catalogExposureId(seed.owner, seed.key))!
							.instanceObservation,
					}),
			state:
				exposures.length > 0
					? "reconciled"
					: seed.state === "expansion-obligation"
						? "expansion-obligation"
						: "not-installed-in-full-inventory",
		};
	}),
};
validateStaticValueCoverage(coverage, primordialCatalog);
writeFileSync(output, `${JSON.stringify(coverage)}\n`);
console.log(
	`${output}: ${rows.length} exposures, ${implementations.size} implementations`,
);
