import { builtinOperationDescriptor } from "./builtin-registry.ts";
import { builtinInvocationSummary } from "./builtin-semantics.ts";
import { knownFact } from "./compiler-facts.ts";
import type { FactProof, KnownBuiltinCall } from "./compiler-facts.ts";
import { getPrimordialCatalog } from "./primordial-catalog-data.ts";
import type { PrimordialNode } from "./primordial-catalog-types.ts";

export interface KnownOperation {
	readonly id: string;
	readonly node: number;
	readonly constructable: boolean;
	readonly implementation: string | null;
	readonly semantics: ReturnType<typeof builtinInvocationSummary>;
}

let operations: ReadonlyArray<KnownOperation> | undefined;
let indices: ReadonlyMap<string, number> | undefined;

export function knownOperations(): ReadonlyArray<KnownOperation> {
	if (operations === undefined) {
		operations = getPrimordialCatalog().nodes.flatMap((node, index) => {
			if ((node[2] & 3) !== 3) return [];
			const split = node[0].lastIndexOf(".");
			return [
				{
					id: node[0],
					node: index,
					constructable: (node[2] & 4) !== 0,
					implementation: node[3],
					semantics: builtinInvocationSummary(
						node[0].slice(0, split),
						node[0].slice(split + 1),
					),
				},
			];
		});
	}
	return operations;
}

export function knownOperationIndex(id: string): number | undefined {
	indices ??= new Map(knownOperations().map((operation, index) => [operation.id, index]));
	return indices.get(id);
}

export function knownOperationCall(id: string, functionId: number): KnownBuiltinCall {
	const operation = knownOperations()[knownOperationIndex(id) ?? -1];
	if (operation === undefined) throw new Error(`Unknown semantic operation ${id}`);
	const proof: FactProof = {
		scope: { kind: "function", id: functionId },
		dependencies: [
			{ kind: "world", fact: "primordials.locked" },
			{ kind: "world", fact: "realms.disabled" },
		],
		obligations: [],
		origin: "captured-primordial-identity",
	};
	return {
		operation: id,
		identity: knownFact(id, proof),
		semantics: knownFact(
			{
				effects: [
					"coerce",
					"property-access",
					"call-user-code",
					"allocate",
					"throw",
					"safepoint",
				],
				result: builtinOperationDescriptor(id)?.result ?? operation.semantics.result,
				lowerings: ["generic-known-operation"],
			},
			proof,
		),
	};
}

export interface PrimordialBinding {
	readonly parent: number;
	readonly kind: "intrinsic" | "prototype" | "value" | "getter" | "setter";
	readonly key: string | { readonly symbol: number };
}

export function primordialBindings(): ReadonlyArray<PrimordialBinding | undefined> {
	const catalog = getPrimordialCatalog();
	const bindings: Array<PrimordialBinding | undefined> = new Array<
		PrimordialBinding | undefined
	>(catalog.nodes.length);
	const queue: Array<number> = [];
	const bind = (index: number, binding: PrimordialBinding) => {
		if (bindings[index] !== undefined) return;
		bindings[index] = binding;
		queue.push(index);
	};
	const intrinsic = (node: PrimordialNode) =>
		node[5].find((alias) => alias.startsWith("MAL_INTRINSIC_"));
	for (const [index, node] of catalog.nodes.entries()) {
		const key = intrinsic(node);
		if (key !== undefined) bind(index, { parent: -1, kind: "intrinsic", key });
	}
	for (let cursor = 0; cursor < queue.length; cursor++) {
		const parent = queue[cursor]!;
		const node = catalog.nodes[parent]!;
		if (node[1] >= 0) bind(node[1], { parent, kind: "prototype", key: "" });
		for (const [key, , value, getter, setter] of node[4]) {
			const property = typeof key === "string" ? key : { symbol: key[0] };
			if (typeof value === "number")
				bind(value, { parent, kind: "value", key: property });
			if (getter >= 0) bind(getter, { parent, kind: "getter", key: property });
			if (setter >= 0) bind(setter, { parent, kind: "setter", key: property });
		}
	}
	return bindings;
}

export const knownArgumentModes = [
	"array-like",
	"nullable-array-like",
	"array",
	"iterable",
] as const;
export type KnownArgumentMode = (typeof knownArgumentModes)[number];

export function knownOperationFlags(operation: {
	readonly construct?: true;
	readonly argumentMode?: KnownArgumentMode;
}): number {
	return (
		(operation.construct ? 1 : 0) |
		((operation.argumentMode === undefined
			? 0
			: knownArgumentModes.indexOf(operation.argumentMode) + 1) <<
			1)
	);
}
