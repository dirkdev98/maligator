import { describe, expect, it } from "vitest";
import { stablePartitionHash } from "../src/compiler/target/stable-partition-hash.ts";

function materializedHash(value: string, round: number): number {
	let hash = (0x811c9dc5 ^ Math.imul(round + 1, 0x9e3779b1)) >>> 0;
	for (let index = 0; index < value.length; index++)
		hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
	return hash;
}

describe("stable translation-unit partition hashing", () => {
	it.each([
		["", "mal_empty"],
		["no self reference", "mal_absent"],
		["mal_rows[] = { mal_rows, mal_rows };", "mal_rows"],
		["aaaaa", "aa"],
		["mal_$[] = { mal_$ };", "mal_$"],
		["Ω😀mal_😀\ud800mal_😀\udfff", "mal_😀"],
	])("preserves materialized self normalization for %j", (source, symbol) => {
		for (const round of [0, 1])
			expect(stablePartitionHash(source, round, "data array:", symbol)).toBe(
				materializedHash(`data array:${source.replaceAll(symbol, "<self>")}`, round),
			);
	});

	it("preserves unnormalized code and overlay identities", () => {
		for (const round of [0, 1])
			for (const prefix of ["", "compiled function:"])
				expect(stablePartitionHash("worker\u0000direct\u00002😀", round, prefix)).toBe(
					materializedHash(`${prefix}worker\u0000direct\u00002😀`, round),
				);
	});

	it("rejects an empty generated symbol", () => {
		expect(() => stablePartitionHash("source", 0, "data array:", "")).toThrow(/nonempty/);
	});
});
