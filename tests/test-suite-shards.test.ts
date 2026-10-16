import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	parseShard,
	partitionShards,
	readShardDurations,
} from "../scripts/test-suite-shards.ts";
import type { ShardItem } from "../scripts/test-suite-shards.ts";

function item(id: string, seconds: number, preparations: Array<string> = []): ShardItem {
	return { id, seconds, preparations };
}

function load(
	shard: Array<string>,
	items: ReadonlyArray<ShardItem>,
	preparationSeconds = 0,
): number {
	const selected = items.filter((entry) => shard.includes(entry.id));
	const preparations = new Set(selected.flatMap((entry) => entry.preparations));
	return (
		selected.reduce((total, entry) => total + entry.seconds, 0) +
		preparations.size * preparationSeconds
	);
}

describe("test suite shards", () => {
	const items = [
		item("a", 700),
		item("b", 600),
		item("c", 300),
		item("d", 250),
		item("e", 200),
		item("f", 120),
		item("g", 60),
		item("h", 10),
	];

	it("assigns every item to exactly one shard", () => {
		const shards = partitionShards(items, 3, () => 0);
		expect(shards).toHaveLength(3);
		expect(shards.flat().sort()).toEqual(items.map((entry) => entry.id).sort());
	});

	it("balances recorded durations across shards", () => {
		const loads = partitionShards(items, 3, () => 0).map((shard) => load(shard, items));
		expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(150);
	});

	it("selects the same partition regardless of input order", () => {
		expect(partitionShards([...items].reverse(), 3, () => 0)).toEqual(
			partitionShards(items, 3, () => 0),
		);
	});

	it("prepares a shared runtime once when its files fit in one shard", () => {
		const prepared = [
			item("perf-1", 50, ["perf"]),
			item("perf-2", 50, ["perf"]),
			item("perf-3", 50, ["perf"]),
			item("plain-1", 200),
			item("plain-2", 200),
			item("plain-3", 200),
		];
		const shards = partitionShards(prepared, 2, () => 300);
		const owners = shards.filter((shard) => shard.some((id) => id.startsWith("perf-")));
		expect(owners).toHaveLength(1);
		expect(Math.max(...shards.map((shard) => load(shard, prepared, 300)))).toBe(600);
	});

	it("spreads a preparation group that exceeds one shard's share", () => {
		const prepared = Array.from({ length: 6 }, (_, index) =>
			item(`perf-${index}`, 300, ["perf"]),
		);
		const shards = partitionShards(prepared, 2, () => 100);
		expect(shards.map((shard) => shard.length)).toEqual([3, 3]);
	});

	it("leaves surplus shards empty instead of splitting an item", () => {
		expect(partitionShards([item("only", 5)], 3, () => 0)).toEqual([["only"], [], []]);
	});

	it.each(["0/2", "3/2", "1/0", "1", "a/b", "1/2/3"])("rejects shard %j", (value) => {
		expect(() => parseShard(value)).toThrow("--shard requires INDEX/COUNT");
	});

	it("parses a shard request", () => {
		expect(parseShard("2/5")).toEqual({ index: 2, count: 5 });
	});

	function withTable<T>(document: unknown, read: (root: string) => T): T {
		const root = mkdtempSync(path.join(os.tmpdir(), "maligator-shard-durations-"));
		try {
			mkdirSync(path.join(root, "tests"));
			writeFileSync(
				path.join(root, "tests/test-suite-durations.json"),
				JSON.stringify(document),
			);
			return read(root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	it("reads the host platform's files and file-less stage weights", () => {
		const durations = withTable(
			{
				schema: 2,
				platforms: {
					darwin: { files: { "a.test.ts": 3 }, stages: { "full: leak audit": 500 } },
					linux: { files: { "a.test.ts": 1 }, stages: {} },
				},
			},
			(root) => readShardDurations(root, "darwin"),
		);
		expect(durations.files.get("a.test.ts")).toBe(3);
		expect(durations.stages.get("full: leak audit")).toBe(500);
	});

	it("balances an unrecorded platform with the Linux weights", () => {
		const durations = withTable(
			{ schema: 2, platforms: { linux: { files: { "a.test.ts": 1 } } } },
			(root) => readShardDurations(root, "win32"),
		);
		expect(durations.files.get("a.test.ts")).toBe(1);
		expect(durations.stages.size).toBe(0);
	});

	it.each([
		{ schema: 1, seconds: {} },
		{ schema: 2, platforms: { linux: { files: { "a.test.ts": -1 } } } },
		{ schema: 2, platforms: { linux: { files: "a.test.ts" } } },
	])("rejects an invalid duration table %j", (document) => {
		expect(() =>
			withTable(document, (root) => readShardDurations(root, "linux")),
		).toThrow();
	});
});
