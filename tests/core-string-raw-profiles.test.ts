import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";
import {
	stringRawProfiles,
	stringRawSegments,
	stringRawSource,
} from "./helpers/string-raw-profiles.ts";

describe("dynamic String.raw segments", () => {
	for (const profile of stringRawProfiles) {
		it.each(stringRawSegments)(
			`consumes %s without a template or raw array through ${profile}`,
			(segments) => {
				const out = inspectStaticValueFunction(
					stringRawSource(segments, profile),
					"probe",
				);
				expect(out.structure.allocations).toBe(0);
				expect(
					out.core.filter(
						(op) =>
							["loadProperty", "loadPropertyStatic"].includes(op.opcode) &&
							!op.attributes.primitiveStringLength,
					),
				).toEqual([]);
				expect(out.core.some((op) => op.attributes.operation === "String.raw")).toBe(
					false,
				);
			},
		);
		it.each(stringRawSegments)(
			`retains mutable raw templates for %s through ${profile}`,
			(segments) => {
				const out = inspectStaticValueFunction(
					stringRawSource(segments, profile),
					"probe",
					{
						locked: false,
					},
				);
				expect(out.structure.allocations).toBeGreaterThan(0);
				expect(out.structure.genericLookups).toBeGreaterThan(0);
			},
		);
	}
	it.each([
		"const template={raw:[x,x]};effect(template);return String.raw(template,y);",
		"const raw=[x,x];effect(raw);return String.raw({raw},y);",
		"return String.raw({get raw(){return [x,x];}},y);",
		"return String.raw({raw:[x,,x]},y);",
		"return String.raw({raw:new Proxy([x,x],y)},y);",
		"return String.raw({raw:x},y);",
		"const raw=[x,x];effect(()=>{raw[1]=y;});return String.raw({raw},y);",
	])("retains observable template structure in %s", (body) => {
		const out = inspectStaticValueFunction(
			`function probe(x,y,effect){${body}}globalThis.probe=probe;`,
			"probe",
		);
		expect(out.core.some((op) => op.attributes.operation === "String.raw")).toBe(true);
	});
});
