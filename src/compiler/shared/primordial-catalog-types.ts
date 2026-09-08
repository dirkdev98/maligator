export type PrimordialValue =
	| number
	| readonly ["string" | "bits" | "bigint" | "runtime", string];

export type PrimordialProperty = readonly [
	key: string | readonly [symbol: number],
	flags: number,
	value: PrimordialValue | null,
	getter: number,
	setter: number,
];

export type PrimordialNode = readonly [
	id: string,
	prototype: number,
	flags: number,
	implementation: string | null,
	properties: ReadonlyArray<PrimordialProperty>,
	aliases: ReadonlyArray<string>,
];

export interface PrimordialCatalog {
	readonly nodes: ReadonlyArray<PrimordialNode>;
	readonly roots: ReadonlyArray<readonly [string, PrimordialValue]>;
}
