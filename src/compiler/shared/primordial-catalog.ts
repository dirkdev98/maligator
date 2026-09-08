import type { WorldFacts } from "./compiler-facts.ts";
import { getPrimordialCatalog } from "./primordial-catalog-data.ts";
import type { PrimordialNode, PrimordialProperty } from "./primordial-catalog-types.ts";

export type PrimordialKey = string | { readonly symbol: string };

let indices: Map<string, number> | undefined;
function nodeIndex(id: string): number | undefined {
	if (indices === undefined) {
		indices = new Map(
			getPrimordialCatalog().nodes.map((node, index) => [node[0], index]),
		);
		for (const [index, node] of getPrimordialCatalog().nodes.entries())
			for (const alias of node[5]) indices.set(alias, index);
		for (const [root, value] of getPrimordialCatalog().roots)
			if (typeof value === "number") indices.set(root, value);
	}
	return indices.get(id);
}

export function primordialNode(id: string): PrimordialNode | undefined {
	const index = nodeIndex(id);
	return index === undefined ? undefined : getPrimordialCatalog().nodes[index];
}

export interface PrimordialResolution {
	readonly owner: PrimordialNode;
	readonly descriptor: PrimordialProperty;
	readonly chain: ReadonlyArray<string>;
	readonly value?: PrimordialNode;
	readonly getter?: PrimordialNode;
	readonly setter?: PrimordialNode;
}

export function resolvePrimordialProperty(
	id: string,
	key: PrimordialKey,
): PrimordialResolution | undefined {
	let index = nodeIndex(id);
	const chain: Array<string> = [];
	while (index !== undefined && index >= 0) {
		const owner = getPrimordialCatalog().nodes[index]!;
		if (chain.includes(owner[0])) throw new Error("Cyclic primordial prototype chain");
		chain.push(owner[0]);
		const descriptor = owner[4].find((property) =>
			typeof key === "string"
				? property[0] === key
				: typeof property[0] !== "string" &&
					getPrimordialCatalog().nodes[property[0][0]]![0] === key.symbol,
		);
		if (descriptor !== undefined)
			return {
				owner,
				descriptor,
				chain,
				...(typeof descriptor[2] === "number"
					? { value: getPrimordialCatalog().nodes[descriptor[2]]! }
					: {}),
				...(descriptor[3] >= 0
					? { getter: getPrimordialCatalog().nodes[descriptor[3]]! }
					: {}),
				...(descriptor[4] >= 0
					? { setter: getPrimordialCatalog().nodes[descriptor[4]]! }
					: {}),
			};
		index = owner[1];
	}
	return undefined;
}

export function primordialOwnKeys(id: string): ReadonlyArray<PrimordialKey> {
	return (
		primordialNode(id)?.[4].map(([key]) =>
			typeof key === "string"
				? key
				: { symbol: getPrimordialCatalog().nodes[key[0]]![0] },
		) ?? []
	);
}

export type PrimordialReceiverEvidence =
	| { readonly kind: "brand-only"; readonly brand: string }
	| {
			readonly kind: "intrinsic";
			readonly id: string;
			readonly realm: "current" | "unknown";
	  }
	| {
			readonly kind: "primitive" | "fresh-allocation";
			readonly prototype: string;
			readonly realm: "current" | "unknown";
			readonly ownKeys: ReadonlyArray<PrimordialKey>;
			readonly ownKeysComplete: boolean;
			readonly stableUntilRead: boolean;
	  };

export interface PrimordialAccessProof {
	readonly kind: "descriptor" | "absent";
	readonly resolution?: PrimordialResolution;
	readonly dependencies: ReadonlyArray<string>;
}

export function provePrimordialAccess(
	world: WorldFacts,
	receiver: PrimordialReceiverEvidence,
	key: PrimordialKey,
): PrimordialAccessProof | undefined {
	if (
		world.primordialPolicy !== "locked" ||
		receiver.kind === "brand-only" ||
		receiver.realm !== "current"
	)
		return undefined;
	if (
		receiver.kind !== "intrinsic" &&
		(!receiver.ownKeysComplete ||
			!receiver.stableUntilRead ||
			receiver.ownKeys.some((own) =>
				typeof own === "string"
					? own === key
					: typeof key !== "string" && own.symbol === key.symbol,
			))
	)
		return undefined;
	const id = receiver.kind === "intrinsic" ? receiver.id : receiver.prototype;
	const resolvedId = primordialNode(id)?.[0];
	if (resolvedId?.startsWith("Intl")) {
		if (!world.ecmaFeatures.intl) return undefined;
		const services = world.ecmaFeatures.intlServices;
		if (services === undefined) return undefined;
		const service = resolvedId
			.split(".")[1]
			?.replace(
				/[A-Z]/g,
				(letter, offset: number) => (offset === 0 ? "" : "-") + letter.toLowerCase(),
			);
		if (services.length > 0 && (service === undefined || !services.includes(service)))
			return undefined;
	}
	const resolution = resolvePrimordialProperty(id, key);
	let node = primordialNode(id);
	if (node === undefined) return undefined;
	const dependencies = [
		"primordials.locked",
		"realm.current",
		"own-descriptor.exact-or-absent",
	];
	const seen = new Set<string>();
	while (node !== undefined) {
		if ((node[2] & 1) === 0 || seen.has(node[0])) return undefined;
		seen.add(node[0]);
		if (
			(node[0].startsWith("Intl") && !world.ecmaFeatures.intl) ||
			(node[0].startsWith("Temporal") && !world.ecmaFeatures.temporal) ||
			(node[0].startsWith("RegExp") && !world.ecmaFeatures.regexp) ||
			(node[0].startsWith("Realm") && !world.realms)
		)
			return undefined;
		dependencies.push(`prototype:${node[0]}`);
		if (resolution?.owner === node)
			return {
				kind: "descriptor",
				resolution,
				dependencies: [
					...dependencies,
					`descriptor:${node[0]}:${typeof key === "string" ? key : key.symbol}`,
				],
			};
		node = node[1] < 0 ? undefined : getPrimordialCatalog().nodes[node[1]];
	}
	return { kind: "absent", dependencies };
}
