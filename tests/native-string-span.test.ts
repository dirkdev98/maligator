import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { vmRegionActions } from "../src/compiler/target/program-image.ts";
import type {
	ProgramImage,
	VmStringSpanRegion,
} from "../src/compiler/target/program-image.ts";

function compile(
	body: string,
	primordials: "locked" | "mutable" = "mutable",
): ProgramImage {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.inspect = function(value, start, end, escape, observer) { ${body} };`,
			"/string-span.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
	);
}
function spans(image: ProgramImage): Array<VmStringSpanRegion> {
	return image.native.functions.flatMap((fn) =>
		fn.specializations.filter((region) => region.kind === "string-span"),
	);
}
const branching = `const part = value.slice(start, end); const length = part.length;
 if (part === "ab") { if (escape) return part; return length; }
 if (escape) return observer(part);
 return Number(part) + length;`;

describe("composable string spans", () => {
	it.each(["mutable", "locked"] as const)(
		"shares substring bounds with the span consumers under %s primordials",
		(mode) => {
			const image = compile(branching.replace(".slice(", ".substring("), mode);
			expect(spans(image)).toHaveLength(1);
			expect(spans(image)[0]!.rangeOperation).toBe("substring");
			expect(spans(image)[0]!.consumers.map((consumer) => consumer.kind)).toEqual(
				expect.arrayContaining(["length", "equal", "number", "materialize"]),
			);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);
	it.each(["", "start", "start, end"])(
		"selects substring character consumers with arguments (%s)",
		(args) => {
			const image = compile(`const part=value.substring(${args}); observer();
 return part.charCodeAt(escape)+part.length;`);
			expect(spans(image)).toHaveLength(1);
			expect(spans(image)[0]!.rangeOperation).toBe("substring");
			expect(spans(image)[0]!.consumers.map((consumer) => consumer.kind)).toContain(
				"charCodeAtCall",
			);
		},
	);
	it.each(["slice", "substring"] as const)(
		"rejects a forged range operation for a %s producer",
		(operation) => {
			const image = compile(
				`const part=value.${operation}(start,end);return part.length;`,
			);
			const owner = image.native.functions[1]!;
			expect(spans(image)).toHaveLength(1);
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...owner,
							specializations: owner.specializations.map((region) =>
								region.kind === "string-span"
									? {
											...region,
											rangeOperation: operation === "slice" ? "substring" : "slice",
										}
									: region,
							),
						}),
					},
				}),
			).toThrow(/string-span/i);
		},
	);
	it.each(["mutable", "locked"] as const)(
		"keeps character-code consumers inside the span under %s primordials",
		(mode) => {
			const image = compile(
				"const part=value.slice(start,end); observer(); return part.charCodeAt(escape)+part.length;",
				mode,
			);
			expect(spans(image)).toHaveLength(1);
			expect(spans(image)[0]!.consumers.map((value) => value.kind)).toContain(
				"charCodeAtCall",
			);
			expect(spans(image)[0]!.consumers.map((value) => value.kind)).not.toContain(
				"materialize",
			);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);
	it.each(["mutable", "locked"] as const)(
		"retains projections and branch materialization with %s methods",
		(primordials) => {
			const image = compile(branching, primordials);
			expect(spans(image)).toHaveLength(1);
			expect(
				spans(image)[0]!
					.consumers.map((consumer) => consumer.kind)
					.sort(),
			).toEqual(["equal", "length", "materialize", "materialize", "number"]);
			expect(
				spans(deserializeCompilerArtifact(serializeCompilerArtifact(image))),
			).toEqual(spans(image));
		},
	);
	it("retains the span across an effect and rechecks the numeric consumer identity", () => {
		const image = compile(
			`const part = value.slice(start, end); observer(); return part.length + Number(part);`,
		);
		expect(spans(image)).toHaveLength(1);
		expect(
			spans(image)[0]!
				.consumers.map((consumer) => consumer.kind)
				.sort(),
		).toEqual(["length", "number"]);
	});
	it("rejects mixed span and ordinary values at a join", () => {
		expect(
			spans(
				compile(
					`let part = value.slice(start, end); if (escape) part = "ordinary"; return part.length;`,
				),
			),
		).toHaveLength(0);
	});
	it("retains index coercion when the substring is its own character position", () => {
		const image = compile(
			"const part=value.slice(start,end); return part.charCodeAt(part)+part.length;",
		);
		expect(spans(image)).toHaveLength(0);
	});
	it("rejects a forged artifact that omits an escaping observer", () => {
		const image = compile(branching);
		const index = image.native.functions.findIndex((fn) =>
			fn.specializations.some((region) => region.kind === "string-span"),
		);
		const owner = image.native.functions[index]!;
		const specializations = owner.specializations.map((region) => {
			if (region.kind !== "string-span") return region;
			const omitted = region.consumers.find(
				(consumer) => consumer.kind === "materialize",
			)!;
			return {
				...region,
				consumers: region.consumers.filter((consumer) => consumer !== omitted),
				claimedIps: region.claimedIps.filter((ip) => ip !== omitted.ip),
				cost: { ...region.cost, metadataOperations: region.cost.metadataOperations - 1 },
			};
		});
		const forged = {
			...image,
			native: {
				...image.native,
				functions: image.native.functions.with(index, {
					...owner,
					specializations,
					regionActions: vmRegionActions(specializations),
				}),
			},
		};
		expect(() => serializeCompilerArtifact(forged)).toThrow(/string-span/);
	});
	it.each([
		["charCodeAtProperty", "charCodeAtCall"],
		["charCodeAtCall", "charCodeAtProperty"],
		["length", "charCodeAtProperty"],
		["number", "charCodeAtCall"],
	] as const)("rejects a %s consumer forged as %s", (original, kind) => {
		const image = compile(
			"const part=value.slice(start,end); return part.charCodeAt(escape)+part.length+Number(part);",
		);
		const index = image.native.functions.findIndex((fn) =>
			fn.specializations.some((region) => region.kind === "string-span"),
		);
		const owner = image.native.functions[index]!;
		const region = spans(image)[0]!;
		expect(region.consumers.some((consumer) => consumer.kind === original)).toBe(true);
		const specializations = owner.specializations.map((candidate) =>
			candidate !== region
				? candidate
				: {
						...region,
						consumers: region.consumers.map((consumer) =>
							consumer.kind === original ? { ...consumer, kind } : consumer,
						),
					},
		);
		expect(() =>
			serializeCompilerArtifact({
				...image,
				native: {
					...image.native,
					functions: image.native.functions.with(index, {
						...owner,
						specializations,
						regionActions: vmRegionActions(specializations),
					}),
				},
			}),
		).toThrow(/string-span/);
	});
});
