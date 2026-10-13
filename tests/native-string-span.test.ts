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
});
