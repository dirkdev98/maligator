import { primordialGlobalBindings } from "../src/compiler/shared/builtin-registry.ts";

type RawValue =
	| { ref: number }
	| { string: string }
	| { bits: string }
	| { bigint: string };
type RawKey = { string: string } | { symbol: number };
interface RawNode {
	type: "node";
	id: number;
	kind: "object" | "symbol";
	locked?: boolean;
	prototype?: RawValue;
	implementation?: number;
	callbackOffset?: string;
	callable?: boolean;
	constructable?: boolean;
	slots?: number;
	description?: string | null;
}
interface RawDescriptor {
	type: "descriptor";
	owner: number;
	key: RawKey;
	flags: number;
	value?: RawValue;
	get?: RawValue;
	set?: RawValue;
}
type RawRecord =
	| RawNode
	| RawDescriptor
	| { type: "phase"; name: string }
	| { type: "root"; name: string; value: RawValue }
	| { type: "host-root"; installer: number; name: string; value: RawValue };

export interface InventoryHostInstall {
	readonly installer: string;
	readonly exports: ReadonlyArray<{ readonly name: string; readonly slot: number }>;
}

export function normalizePrimordialInventory(
	jsonl: string,
	hostInstalls: ReadonlyArray<InventoryHostInstall>,
	callbackSymbols?: ReadonlyMap<string, string>,
) {
	const phases = new Map<string, Array<RawRecord>>();
	let current: Array<RawRecord> | undefined;
	for (const line of jsonl.trim().split("\n")) {
		const row = JSON.parse(line) as RawRecord;
		if (row.type === "phase") {
			current = [];
			phases.set(row.name, current);
		} else {
			if (current === undefined) throw new Error("Inventory record precedes phase");
			current.push(row);
		}
	}
	return [...phases].map(([phase, rows]) =>
		normalizePhase(phase, rows, hostInstalls, callbackSymbols),
	);
}

function normalizePhase(
	phase: string,
	rows: ReadonlyArray<RawRecord>,
	hostInstalls: ReadonlyArray<InventoryHostInstall>,
	callbackSymbols?: ReadonlyMap<string, string>,
) {
	const nodes = new Map(
		rows.filter((row) => row.type === "node").map((row) => [row.id, row]),
	);
	const descriptors = rows.filter((row) => row.type === "descriptor");
	const own = new Map<number, Array<RawDescriptor>>();
	const repeatedKeys = new Map<number, Array<RawKey>>();
	for (const row of descriptors) {
		let list = own.get(row.owner);
		if (list === undefined) {
			list = [];
			own.set(row.owner, list);
		}
		const prior = list.find(
			(descriptor) => JSON.stringify(descriptor.key) === JSON.stringify(row.key),
		);
		if (prior !== undefined) {
			if (JSON.stringify(prior) !== JSON.stringify(row))
				throw new Error("Conflicting descriptors for one property");
			let repeated = repeatedKeys.get(row.owner);
			if (repeated === undefined) {
				repeated = [];
				repeatedKeys.set(row.owner, repeated);
			}
			repeated.push(row.key);
		} else list.push(row);
	}
	const roots = rows
		.filter((row) => row.type === "root" || row.type === "host-root")
		.map((row) => ({
			name:
				row.type === "root"
					? row.name
					: `${hostInstalls[row.installer]!.installer}:${row.name}`,
			value: row.value,
		}));
	const publicNames = new Map<string, string>();
	for (const binding of primordialGlobalBindings) {
		if (binding.intrinsic === "MAL_INTRINSIC_COUNT") continue;
		publicNames.set(binding.intrinsic, binding.name);
		if (binding.intrinsic.endsWith("_CONSTRUCTOR"))
			publicNames.set(
				binding.intrinsic.replace(/_CONSTRUCTOR$/, "_PROTOTYPE"),
				`${binding.name}.prototype`,
			);
	}
	const names = new Map<number, string>();
	const queue: Array<number> = [];
	const assign = (value: RawValue, name: string) => {
		if (!("ref" in value) || names.has(value.ref)) return;
		if (!nodes.has(value.ref)) throw new Error(`Missing inventory node ${value.ref}`);
		names.set(value.ref, name);
		queue.push(value.ref);
	};
	for (const root of roots) {
		const publicName = publicNames.get(root.name);
		if (publicName !== undefined) assign(root.value, publicName);
		else if (root.name.startsWith("MAL_INTRINSIC_SYMBOL_") && "ref" in root.value) {
			assign(root.value, `%${nodes.get(root.value.ref)!.description}%`);
		}
	}
	const keyName = (key: RawKey) =>
		"string" in key
			? `[${JSON.stringify(key.string)}]`
			: `[${names.get(key.symbol) ?? `%symbol:${nodes.get(key.symbol)?.description ?? ""}%`}]`;
	const propertyPath = (owner: string, key: RawKey) =>
		"string" in key && /^[A-Za-z_$][\w$]*$/.test(key.string)
			? `${owner}.${key.string}`
			: `${owner}${keyName(key)}`;
	const keyOrder = (key: RawKey) => keyName(key).replace('"trimLeft"', '"trimStart~"');
	const drain = () => {
		for (let i = 0; i < queue.length; i++) {
			const id = queue[i]!;
			const owner = names.get(id)!;
			for (const descriptor of [...(own.get(id) ?? [])].sort((a, b) =>
				keyOrder(a.key) < keyOrder(b.key)
					? -1
					: keyOrder(a.key) > keyOrder(b.key)
						? 1
						: 0,
			)) {
				if ("symbol" in descriptor.key && !names.has(descriptor.key.symbol)) {
					assign(
						{ ref: descriptor.key.symbol },
						`${owner}.[[SymbolKey:${nodes.get(descriptor.key.symbol)?.description ?? ""}]]`,
					);
				}
				const property = propertyPath(owner, descriptor.key);
				if (descriptor.value !== undefined) assign(descriptor.value, property);
				if (descriptor.get !== undefined) assign(descriptor.get, `${property}<get>`);
				if (descriptor.set !== undefined) assign(descriptor.set, `${property}<set>`);
			}
			const prototype = nodes.get(id)!.prototype;
			if (prototype !== undefined) assign(prototype, `${owner}.[[Prototype]]`);
		}
		queue.length = 0;
	};
	drain();
	for (const root of roots) {
		assign(root.value, `%${root.name}%`);
		drain();
	}
	if (names.size !== nodes.size) throw new Error("Unreachable inventory nodes");
	const value = (raw: RawValue) => ("ref" in raw ? { ref: names.get(raw.ref)! } : raw);
	const aliases = new Map<number, Set<string>>(
		[...nodes.keys()].map((id) => [id, new Set()]),
	);
	for (const root of roots)
		if ("ref" in root.value) aliases.get(root.value.ref)!.add(root.name);
	for (const descriptor of descriptors) {
		const property = propertyPath(names.get(descriptor.owner)!, descriptor.key);
		for (const [half, raw] of [
			["", descriptor.value],
			["<get>", descriptor.get],
			["<set>", descriptor.set],
		] as const) {
			if (raw !== undefined && "ref" in raw) aliases.get(raw.ref)!.add(property + half);
		}
	}
	const callbacks = new Map<number, Array<string>>();
	for (const node of nodes.values()) {
		if (node.implementation === undefined) continue;
		let list = callbacks.get(node.implementation);
		if (list === undefined) {
			list = [];
			callbacks.set(node.implementation, list);
		}
		list.push(names.get(node.id)!);
	}
	const implementations = new Map(
		[...callbacks].map(([id, names]) => [id, names.sort()[0]!]),
	);
	return {
		phase,
		repeatedOwnKeys: [...repeatedKeys].map(([owner, keys]) => ({
			owner: names.get(owner)!,
			keys: keys.map(keyName),
		})),
		roots: roots
			.map((root) => ({ name: root.name, value: value(root.value) }))
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
		nodes: [...nodes.values()]
			.map((node) => ({
				id: names.get(node.id)!,
				kind: node.kind,
				aliases: [...aliases.get(node.id)!].sort(),
				...(node.description === undefined ? {} : { description: node.description }),
				...(node.prototype === undefined
					? {}
					: { prototype: value(node.prototype), locked: node.locked }),
				...(node.implementation === undefined
					? {}
					: {
							implementation: implementations.get(node.implementation)!,
							...(callbackSymbols === undefined
								? {}
								: { nativeSymbol: callbackSymbols.get(node.callbackOffset ?? "") }),
							callable: node.callable,
							constructable: node.constructable,
							slots: node.slots,
						}),
				descriptors: (own.get(node.id) ?? []).map((descriptor) => ({
					key:
						"string" in descriptor.key
							? descriptor.key
							: { symbol: names.get(descriptor.key.symbol)! },
					flags: descriptor.flags,
					...(descriptor.value === undefined ? {} : { value: value(descriptor.value) }),
					...(descriptor.get === undefined ? {} : { get: value(descriptor.get) }),
					...(descriptor.set === undefined ? {} : { set: value(descriptor.set) }),
				})),
			}))
			.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
	};
}

export type PrimordialInventoryPhase = ReturnType<
	typeof normalizePrimordialInventory
>[number];

export function primordialInventoryContract(
	phases: ReadonlyArray<PrimordialInventoryPhase>,
) {
	return phases.map((phase) => ({
		...phase,
		roots: phase.roots.map((root) => {
			if (!root.name.startsWith("mal_host_install_") || "ref" in root.value) return root;
			return {
				...root,
				value: {
					runtimeKind:
						"string" in root.value
							? "string"
							: "bigint" in root.value
								? "bigint"
								: "primitive",
				},
			};
		}),
		nodes: phase.nodes.map((node) => ({
			...node,
			descriptors: node.descriptors.map((descriptor) => {
				const value = descriptor.value;
				if (
					phase.phase === "language-initialized" ||
					node.locked ||
					node.callable ||
					value === undefined ||
					"ref" in value ||
					(descriptor.flags & 16) !== 0
				)
					return descriptor;
				// Host data is sampled runtime state; its descriptor shape is the catalog contract.
				return {
					...descriptor,
					value: {
						runtimeKind:
							"string" in value ? "string" : "bigint" in value ? "bigint" : "primitive",
					},
				};
			}),
		})),
	}));
}
