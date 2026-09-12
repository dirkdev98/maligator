import { deepStrictEqual, equal, notEqual, ok } from "node:assert";
import { describe, it } from "vitest";
import { getPrimordialCatalog } from "../src/compiler/shared/primordial-catalog-data.ts";
import {
	primordialNode,
	resolvePrimordialProperty,
} from "../src/compiler/shared/primordial-catalog.ts";
import type {
	PrimordialKey,
	PrimordialResolution,
} from "../src/compiler/shared/primordial-catalog.ts";

function linearResolution(
	id: string,
	key: PrimordialKey,
): PrimordialResolution | undefined {
	const nodes = getPrimordialCatalog().nodes;
	let owner = primordialNode(id);
	const chain: Array<string> = [];
	while (owner !== undefined) {
		if (chain.includes(owner[0])) throw new Error("Cyclic fixture prototype chain");
		chain.push(owner[0]);
		const descriptor = owner[4].find((property) =>
			typeof key === "string"
				? property[0] === key
				: typeof property[0] !== "string" && nodes[property[0][0]]![0] === key.symbol,
		);
		if (descriptor !== undefined) {
			return {
				owner,
				descriptor,
				chain,
				...(typeof descriptor[2] === "number" ? { value: nodes[descriptor[2]]! } : {}),
				...(descriptor[3] >= 0 ? { getter: nodes[descriptor[3]]! } : {}),
				...(descriptor[4] >= 0 ? { setter: nodes[descriptor[4]]! } : {}),
			};
		}
		owner = owner[1] < 0 ? undefined : nodes[owner[1]];
	}
	return undefined;
}

describe("Primordial descriptor indexes", () => {
	it("matches linear resolution for catalog properties, aliases and misses", () => {
		const nodes = getPrimordialCatalog().nodes;
		for (const node of nodes) {
			const keys: Array<PrimordialKey> = [
				"__proto__",
				"constructor",
				"__maligator_missing_property__",
				{ symbol: "__maligator_missing_symbol__" },
			];
			for (const [key] of node[4]) {
				keys.push(typeof key === "string" ? key : { symbol: nodes[key[0]]![0] });
			}
			for (const id of [node[0], ...node[5]]) {
				for (const key of keys) {
					deepStrictEqual(resolvePrimordialProperty(id, key), linearResolution(id, key));
				}
			}
		}
	});

	it("keeps string and symbol key namespaces separate", () => {
		const nodes = getPrimordialCatalog().nodes;
		const owner = nodes.find((node) => node[4].some(([key]) => typeof key !== "string"));
		ok(owner);
		const property = owner[4].find(([key]) => typeof key !== "string");
		ok(property && typeof property[0] !== "string");
		const name = nodes[property[0][0]]![0];
		const symbol = resolvePrimordialProperty(owner[0], { symbol: name });
		const string = resolvePrimordialProperty(owner[0], name);
		equal(symbol?.descriptor, property);
		notEqual(symbol?.descriptor, string?.descriptor);
		deepStrictEqual(string, linearResolution(owner[0], name));
		equal(resolvePrimordialProperty("__missing_node__", name), undefined);
	});

	it("does not share mutable resolution chains between lookups", () => {
		const first = resolvePrimordialProperty("Object.prototype", "constructor");
		const second = resolvePrimordialProperty("Object.prototype", "constructor");
		ok(first && second);
		equal(first.descriptor, second.descriptor);
		notEqual(first.chain, second.chain);
		deepStrictEqual(first.chain, second.chain);
	});
});
