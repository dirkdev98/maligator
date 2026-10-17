import { readFileSync } from "node:fs";
import * as path from "node:path";

export interface ShardRequest {
	index: number;
	count: number;
}

export interface ShardItem {
	id: string;
	seconds: number;
	/** Optional native preparations this item requires; each costs once per shard. */
	preparations: ReadonlyArray<string>;
}

export function parseShard(value: string | undefined): ShardRequest {
	const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value ?? "");
	const index = Number(match?.[1]);
	const count = Number(match?.[2]);
	if (match === null || index > count) {
		throw new Error("--shard requires INDEX/COUNT with 1 <= INDEX <= COUNT");
	}
	return { index, count };
}

/**
 * Deterministic longest-first partition. Items sharing a preparation move as one unit
 * while that unit fits a shard's fair share, so an expensive prepared runtime is built
 * once; larger groups split and pay the preparation in each shard they reach.
 */
export function partitionShards(
	items: ReadonlyArray<ShardItem>,
	count: number,
	preparationSeconds: (preparation: string) => number,
): Array<Array<string>> {
	if (!Number.isSafeInteger(count) || count < 1) {
		throw new RangeError("shard count must be a positive integer");
	}
	const ids = new Set(items.map((item) => item.id));
	if (ids.size !== items.length) throw new Error("shard items must have unique ids");
	const cost = (preparations: Iterable<string>) =>
		[...preparations].reduce((total, name) => total + preparationSeconds(name), 0);
	const groups = new Map<string, Array<ShardItem>>();
	for (const item of items) {
		const key = [...new Set(item.preparations)].sort().join("\0");
		groups.set(key, [...(groups.get(key) ?? []), item]);
	}
	const total =
		items.reduce((sum, item) => sum + item.seconds, 0) +
		cost(new Set(items.flatMap((item) => item.preparations)));
	const units = [...groups].flatMap(([key, members]) => {
		const seconds = members.reduce((sum, member) => sum + member.seconds, 0);
		const preparations = members[0]!.preparations;
		return key !== "" && seconds + cost(new Set(preparations)) <= total / count
			? [{ ids: members.map((member) => member.id).sort(), seconds, preparations }]
			: members.map((member) => ({ ids: [member.id], ...member }));
	});
	const shards = Array.from({ length: count }, () => ({
		seconds: 0,
		preparations: new Set<string>(),
		items: [] as Array<string>,
	}));
	const standalone = (unit: (typeof units)[number]) =>
		unit.seconds + cost(new Set(unit.preparations));
	units.sort(
		(left, right) =>
			standalone(right) - standalone(left) ||
			(left.ids[0]! < right.ids[0]! ? -1 : left.ids[0]! > right.ids[0]! ? 1 : 0),
	);
	for (const unit of units) {
		let best = 0;
		let bestFinish = Number.POSITIVE_INFINITY;
		for (const [index, shard] of shards.entries()) {
			const finish =
				shard.seconds +
				cost(unit.preparations.filter((name) => !shard.preparations.has(name))) +
				unit.seconds;
			if (finish < bestFinish) {
				best = index;
				bestFinish = finish;
			}
		}
		const shard = shards[best]!;
		shard.seconds = bestFinish;
		for (const name of unit.preparations) shard.preparations.add(name);
		shard.items.push(...unit.ids);
	}
	return shards.map((shard) => shard.items);
}

export interface ShardDurations {
	/** Recorded wall seconds per test file. */
	files: Map<string, number>;
	/** Recorded wall seconds per stage without test files, such as the leak audit. */
	stages: Map<string, number>;
}

function durationMap(label: string, value: unknown): Map<string, number> {
	if (value === undefined) return new Map();
	if (value === null || typeof value !== "object") {
		throw new Error(`tests/test-suite-durations.json has invalid ${label}`);
	}
	return new Map(
		Object.entries(value).map(([name, seconds]) => {
			if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
				throw new Error(`invalid recorded duration for ${name}`);
			}
			return [name, seconds];
		}),
	);
}

/**
 * Recorded durations for one host platform and lane, used only to balance shards.
 * Sanitizers slow files unevenly, so their lane keeps its own table. Hosts differ in
 * relative cost, so a platform without its own table borrows Linux's.
 */
export function readShardDurations(
	root: string,
	platform: NodeJS.Platform = process.platform,
	lane?: string,
): ShardDurations {
	const document = JSON.parse(
		readFileSync(path.join(root, "tests/test-suite-durations.json"), "utf8"),
	) as {
		schema?: unknown;
		platforms?: Record<string, { files?: unknown; stages?: unknown }>;
	};
	if (document.schema !== 3 || document.platforms === undefined) {
		throw new Error("tests/test-suite-durations.json must use schema 3");
	}
	const tables = [
		"linux",
		platform,
		...(lane === "sanitizer" ? ["linux-sanitizer", `${platform}-sanitizer`] : []),
	].filter((name, index, names) => names.indexOf(name) === index);
	const durations: ShardDurations = { files: new Map(), stages: new Map() };
	for (const name of tables) {
		const table = document.platforms[name];
		if (table === undefined) continue;
		for (const entry of durationMap(`${name} files`, table.files))
			durations.files.set(...entry);
		for (const entry of durationMap(`${name} stages`, table.stages))
			durations.stages.set(...entry);
	}
	return durations;
}
