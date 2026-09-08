import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type {
	PrimordialCatalog,
	PrimordialNode,
	PrimordialProperty,
	PrimordialValue,
} from "../src/compiler/shared/primordial-catalog-types.ts";
import { primordialInventoryContract } from "./primordial-inventory-data.ts";
import type { PrimordialInventoryPhase } from "./primordial-inventory-data.ts";

export function packPrimordialCatalog(
	phase: PrimordialInventoryPhase,
): PrimordialCatalog {
	const normalized = primordialInventoryContract([phase])[0]!;
	const indices = new Map(normalized.nodes.map((node, index) => [node.id, index]));
	function index(id: string): number {
		const result = indices.get(id);
		if (result === undefined) throw new Error(`Missing catalog reference ${id}`);
		return result;
	}
	function value(
		raw:
			| { ref: string }
			| { string: string }
			| { bits: string }
			| { bigint: string }
			| { runtimeKind: string },
	): PrimordialValue {
		if ("ref" in raw) return index(raw.ref);
		if ("string" in raw) return ["string", raw.string];
		if ("bits" in raw) return ["bits", raw.bits];
		if ("bigint" in raw) return ["bigint", raw.bigint];
		return ["runtime", raw.runtimeKind];
	}
	const nodes: Array<PrimordialNode> = normalized.nodes.map((node) => [
		node.id,
		node.prototype !== undefined && "ref" in node.prototype
			? index(node.prototype.ref)
			: -1,
		(node.locked ? 1 : 0) |
			(node.callable ? 2 : 0) |
			(node.constructable ? 4 : 0) |
			(node.kind === "symbol" ? 8 : 0),
		node.implementation ?? null,
		node.descriptors.map(
			(descriptor): PrimordialProperty => [
				"string" in descriptor.key
					? descriptor.key.string
					: [index(descriptor.key.symbol)],
				descriptor.flags,
				descriptor.value === undefined ? null : value(descriptor.value),
				descriptor.get !== undefined && "ref" in descriptor.get
					? index(descriptor.get.ref)
					: -1,
				descriptor.set !== undefined && "ref" in descriptor.set
					? index(descriptor.set.ref)
					: -1,
			],
		),
		node.aliases,
	]);
	return { nodes, roots: normalized.roots.map((root) => [root.name, value(root.value)]) };
}

export function primordialInstallerSourceInventory() {
	return readdirSync("runtime/src", { recursive: true, encoding: "utf8" })
		.filter((file) => /\.(c|h|inc)$/.test(file))
		.sort()
		.flatMap((file) => {
			const source = readFileSync(`runtime/src/${file}`, "utf8");
			if (
				!file.endsWith(".inc") &&
				!/mal_intrinsic_define|mal_host_install|mal_object_define|mal_vm_install|MalIntrinsic|MAL_PRIMORDIAL|MAL_LITERAL_PROTOTYPE/.test(
					source,
				)
			)
				return [];
			return [{ file, sha256: createHash("sha256").update(source).digest("hex") }];
		});
}

export function mergePrimordialInventories(
	phases: ReadonlyArray<PrimordialInventoryPhase>,
): PrimordialInventoryPhase {
	const first = phases[0];
	if (first === undefined) throw new Error("An inventory is required");
	const nodes = new Map(first.nodes.map((node) => [node.id, node]));
	const roots = new Map(first.roots.map((root) => [root.name, root]));
	for (const phase of phases.slice(1)) {
		for (const root of phase.roots) if (!roots.has(root.name)) roots.set(root.name, root);
		for (const node of phase.nodes) {
			const prior = nodes.get(node.id);
			if (prior === undefined) {
				nodes.set(node.id, node);
				continue;
			}
			const descriptors = new Map(
				prior.descriptors.map((descriptor) => [
					JSON.stringify(descriptor.key),
					descriptor,
				]),
			);
			for (const descriptor of node.descriptors)
				if (!descriptors.has(JSON.stringify(descriptor.key)))
					descriptors.set(JSON.stringify(descriptor.key), descriptor);
			nodes.set(node.id, {
				...prior,
				aliases: [...new Set([...prior.aliases, ...node.aliases])].sort(),
				descriptors: [...descriptors.values()],
			});
		}
	}
	return {
		...first,
		nodes: [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
		roots: [...roots.values()].sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		),
	};
}

export function primordialInventoryDigest(
	phases: ReadonlyArray<PrimordialInventoryPhase>,
): string {
	return createHash("sha256")
		.update(JSON.stringify(primordialInventoryContract(phases)))
		.digest("hex");
}
