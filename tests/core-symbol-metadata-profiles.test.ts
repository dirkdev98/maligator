import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";
import {
	symbolMetadataCases,
	symbolMetadataConsumers,
	symbolMetadataProfiles,
	symbolMetadataSource,
} from "./helpers/symbol-metadata-profiles.ts";

describe("dynamic symbol metadata profiles", () => {
	for (const profile of symbolMetadataProfiles) {
		for (const consumer of symbolMetadataConsumers) {
			it.each(symbolMetadataCases)(
				`forwards %s(%s) metadata through ${consumer} and ${profile}`,
				(...entry) => {
					const out = inspectStaticValueFunction(
						symbolMetadataSource(entry, consumer, profile),
						"probe",
					);
					expect(out.structure.genericLookups).toBe(0);
					expect(out.structure.allocations).toBe(0);
					expect(
						out.core.filter((op) =>
							["Symbol.prototype.description<get>", "Symbol.keyFor"].includes(
								op.attributes.operation as string,
							),
						),
					).toEqual([]);
					if (entry[0] === "Symbol.for" || profile !== "direct") {
						expect(
							out.core.filter((op) => op.attributes.operation === entry[0]),
						).toHaveLength(1);
					}
				},
			);
			it.each(symbolMetadataCases)(
				`keeps mutable %s(%s) metadata through ${consumer} and ${profile}`,
				(...entry) => {
					const out = inspectStaticValueFunction(
						symbolMetadataSource(entry, consumer, profile),
						"probe",
						{ locked: false },
					);
					expect(out.structure.genericLookups).toBeGreaterThan(0);
					expect(out.structure.genericCalls).toBeGreaterThan(0);
				},
			);
		}
	}
	it.each([
		"const symbol=Symbol(x);effect(symbol);return symbol.description;",
		"const symbol=x;effect(symbol);return symbol.description;",
		"const symbol=x?Symbol.for('a'):Symbol.for('b');effect(symbol);return symbol.description;",
		"const symbol=new Proxy(Object(Symbol.for(String(x))),{});effect(symbol);return symbol.description;",
	])("retains unproved descriptions for %s", (body) => {
		const out = inspectStaticValueFunction(
			`function probe(x,effect){${body}}globalThis.probe=probe;`,
			"probe",
		);
		expect(
			out.core.some(
				(op) =>
					op.attributes.operation === "Symbol.prototype.description<get>" ||
					op.opcode === "loadPropertyStatic",
			),
		).toBe(true);
	});
});
