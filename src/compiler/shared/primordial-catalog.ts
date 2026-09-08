import type { WorldFacts } from "./compiler-facts.ts";
import { getPrimordialCatalog } from "./primordial-catalog-data.ts";
import type {
	PrimordialNode,
	PrimordialProperty,
	PrimordialValue,
} from "./primordial-catalog-types.ts";
import { staticNumberDescription } from "./static-values.ts";
import type { StaticDescription } from "./static-values.ts";

export function primordialConstantDescription(
	value: PrimordialValue | null,
):
	| Extract<
			StaticDescription,
			{ readonly kind: "number" | "boolean" | "string" | "bigint" | "null" | "undefined" }
	  >
	| undefined {
	if (value === null || typeof value === "number" || value[0] === "runtime")
		return undefined;
	if (value[0] === "string")
		return {
			kind: "string",
			codeUnits: Array.from({ length: value[1].length }, (_, index) =>
				value[1].charCodeAt(index),
			),
		};
	if (value[0] === "bigint") return { kind: "bigint", decimal: value[1] };
	const high = parseInt(value[1].slice(0, 8), 16),
		low = parseInt(value[1].slice(8), 16);
	if (high === 0x7ff90000) return staticNumberDescription(low | 0);
	if (high === 0x7ff80000) {
		if (low === 2) return { kind: "null" };
		if (low === 3) return { kind: "undefined" };
		if (low === 4 || low === 5) return { kind: "boolean", value: low === 4 };
		if (low === 1 || low === 6 || low === 7 || low === 8)
			return staticNumberDescription(
				low === 1 ? NaN : low === 6 ? -0 : low === 7 ? Infinity : -Infinity,
			);
		return undefined;
	}
	if ((high & 0x7ff80000) === 0x7ff80000) return undefined;
	return { kind: "number", high, low };
}

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
	// The global object stays extensible, but its protected primordial bindings are immutable.
	if (
		receiver.kind === "intrinsic" &&
		node[0] === "globalThis" &&
		resolution?.owner === node &&
		(resolution.descriptor[1] & 16) !== 0 &&
		(resolution.descriptor[1] & 13) === 0
	) {
		return {
			kind: "descriptor",
			resolution,
			dependencies: [
				...dependencies,
				`protected-global:${typeof key === "string" ? key : key.symbol}`,
			],
		};
	}
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
