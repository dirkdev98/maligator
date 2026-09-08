declare const staticDescriptionBrand: unique symbol;
export type StaticDescriptionId = number & { readonly [staticDescriptionBrand]: true };

export type StaticPrototype =
	| { readonly kind: "intrinsic"; readonly id: string }
	| { readonly kind: "null" }
	| { readonly kind: "operand"; readonly index: number }
	| { readonly kind: "unknown" };

export type StaticMember =
	| { readonly kind: "constant"; readonly description: StaticDescriptionId }
	| {
			readonly kind: "allocation";
			readonly description: StaticDescriptionId;
			readonly identitySlot: number;
	  }
	| { readonly kind: "operand"; readonly index: number }
	| { readonly kind: "hole" };

export interface StaticPropertyDescription {
	readonly key: string | { readonly symbolIdentitySlot: number };
	readonly enumerable: boolean;
	readonly configurable: boolean;
	readonly descriptor:
		| { readonly kind: "data"; readonly writable: boolean; readonly value: StaticMember }
		| {
				readonly kind: "accessor";
				readonly get: StaticMember;
				readonly set: StaticMember;
		  };
}

export type StaticDescription =
	| { readonly kind: "undefined" | "null" }
	| { readonly kind: "boolean"; readonly value: boolean }
	| { readonly kind: "number"; readonly low: number; readonly high: number }
	| { readonly kind: "string"; readonly codeUnits: ReadonlyArray<number> }
	| { readonly kind: "bigint"; readonly decimal: string }
	| { readonly kind: "symbol"; readonly description?: string }
	| {
			readonly kind: "function";
			readonly codeIdentity: string;
			readonly captures: ReadonlyArray<StaticMember>;
	  }
	| {
			readonly kind: "array";
			readonly prototype: StaticPrototype;
			readonly elements: ReadonlyArray<StaticMember>;
	  }
	| {
			readonly kind: "object";
			readonly prototype: StaticPrototype;
			readonly properties: ReadonlyArray<StaticPropertyDescription>;
	  }
	| {
			readonly kind: "engine-payload";
			readonly format: string;
			readonly targetContract: string;
			readonly words: ReadonlyArray<number>;
	  };

export interface StaticDescriptionSummary {
	readonly constantContents: boolean;
	readonly operandSlots: ReadonlyArray<number>;
	readonly identitySlots: ReadonlyArray<number>;
}

export class StaticDescriptionInterner {
	readonly #descriptions: Array<StaticDescription> = [];
	readonly #indices = new Map<string, StaticDescriptionId>();
	readonly #summaries: Array<StaticDescriptionSummary> = [];

	get size(): number {
		return this.#descriptions.length;
	}

	intern(description: StaticDescription): StaticDescriptionId {
		const key = JSON.stringify(description);
		const prior = this.#indices.get(key);
		if (prior !== undefined) return prior;
		const operands = new Set<number>();
		const identities = new Set<number>();
		const member = (value: StaticMember) => {
			if (value.kind === "operand") operands.add(value.index);
			if (value.kind === "allocation") identities.add(value.identitySlot);
			if (value.kind === "constant" || value.kind === "allocation") {
				const kind = this.description(value.description).kind;
				const identityBearing = ["array", "object", "function", "symbol"].includes(kind);
				if (value.kind === "constant" && identityBearing)
					throw new Error("Identity-bearing members require allocation bindings");
				if (value.kind === "allocation" && !identityBearing && kind !== "engine-payload")
					throw new Error("Primitive members do not have allocation identities");
				const child = this.summary(value.description);
				for (const slot of child.operandSlots) operands.add(slot);
				for (const slot of child.identitySlots) identities.add(slot);
			}
		};
		if (description.kind === "array") description.elements.forEach(member);
		if (description.kind === "function") description.captures.forEach(member);
		if (description.kind === "object")
			for (const property of description.properties) {
				if (typeof property.key !== "string")
					identities.add(property.key.symbolIdentitySlot);
				if (property.descriptor.kind === "data") member(property.descriptor.value);
				else {
					member(property.descriptor.get);
					member(property.descriptor.set);
				}
			}
		if (
			(description.kind === "array" || description.kind === "object") &&
			description.prototype.kind === "operand"
		)
			operands.add(description.prototype.index);
		for (const slot of [...operands, ...identities])
			if (!Number.isSafeInteger(slot) || slot < 0)
				throw new Error("Invalid static description binding slot");
		// Copy the owned recipe; callers cannot mutate an interned description through their input.
		const copy = JSON.parse(key) as StaticDescription;
		const freeze = (value: unknown): void => {
			if (value === null || typeof value !== "object") return;
			for (const child of Object.values(value)) freeze(child);
			Object.freeze(value);
		};
		freeze(copy);
		const id = this.#descriptions.length as StaticDescriptionId;
		this.#indices.set(key, id);
		this.#descriptions.push(copy);
		this.#summaries.push(
			Object.freeze({
				constantContents: operands.size === 0,
				operandSlots: Object.freeze([...operands].sort((a, b) => a - b)),
				identitySlots: Object.freeze([...identities].sort((a, b) => a - b)),
			}),
		);
		return id;
	}

	description(id: StaticDescriptionId): StaticDescription {
		const description = this.#descriptions[id];
		if (description === undefined) throw new Error(`Unknown static description ${id}`);
		return description;
	}

	summary(id: StaticDescriptionId): StaticDescriptionSummary {
		const summary = this.#summaries[id];
		if (summary === undefined) throw new Error(`Unknown static description ${id}`);
		return summary;
	}
}

export function staticNumberDescription(value: number): StaticDescription {
	const bits = new DataView(new ArrayBuffer(8));
	bits.setFloat64(0, value, true);
	return { kind: "number", low: bits.getUint32(0, true), high: bits.getUint32(4, true) };
}
