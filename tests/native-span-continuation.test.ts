import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";

function compile(body: string, primordials: "mutable" | "locked" = "mutable") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.classify=function(source,escape,observe){${body}};`,
			"/split-span.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
	);
}
const body = `const part=source.split('|')[1]; const size=part.length;
 if(part==='if')return size+10; if(escape)return observe(part); return size;`;
describe("span continuations from split projections", () => {
	it.each(["mutable", "locked"] as const)(
		"composes branching consumers under %s primordials",
		(mode) => {
			const image = compile(body, mode),
				native = image.native.functions[1]!;
			expect(native.storage!.spanContinuations).toHaveLength(1);
			expect(
				native.storage!.spanContinuations[0]!.consumers.map((value) => value.kind).sort(),
			).toEqual(["equal", "length", "materialize"]);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			expect(() => emitProgramImage(image, {})).not.toThrow();
		},
	);
	it("composes character access with the original source span", () => {
		const image = compile(
			"const part=source.split('|')[1];if(part.length===2)return part==='if';return part.charCodeAt(0);",
		);
		const plan = image.native.functions[1]!.storage!.spanContinuations[0]!;
		expect(plan.consumers.map((value) => value.kind)).toContain("charCodeAtCall");
		expect(plan.consumers.map((value) => value.kind)).not.toContain("materialize");
		expect(() => emitProgramImage(image, {})).not.toThrow();
	});
	it.each(["mutable", "locked"] as const)(
		"composes numeric and character consumers under %s primordials",
		(mode) => {
			const image = compile(
				"const part=source.split('|')[1]; return part.charCodeAt(escape)+Number(part);",
				mode,
			);
			const plan = image.native.functions[1]!.storage!.spanContinuations[0]!;
			expect(plan.consumers.map((value) => value.kind)).toEqual(
				expect.arrayContaining(["charCodeAtCall", "number"]),
			);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);
	it("rejects omitted observers and a forged producer lifetime", () => {
		const image = compile(body),
			native = image.native.functions[1]!,
			plan = native.storage!.spanContinuations[0]!;
		for (const forged of [
			{ ...plan, consumers: plan.consumers.slice(0, 1) },
			{ ...plan, sourceCallIp: plan.producerIp },
		]) {
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, spanContinuations: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
		}
	});
	it.each([
		["charCodeAtProperty", "charCodeAtCall"],
		["charCodeAtCall", "charCodeAtProperty"],
		["number", "charCodeAtCall"],
	] as const)("rejects a %s continuation forged as %s", (original, kind) => {
		const image = compile(
			"const part=source.split('|')[1]; return part.charCodeAt(escape)+Number(part);",
		);
		const native = image.native.functions[1]!;
		const plan = native.storage!.spanContinuations[0]!;
		expect(plan.consumers.some((consumer) => consumer.kind === original)).toBe(true);
		expect(() =>
			serializeCompilerArtifact({
				...image,
				native: {
					...image.native,
					functions: image.native.functions.with(1, {
						...native,
						storage: {
							...native.storage!,
							spanContinuations: [
								{
									...plan,
									consumers: plan.consumers.map((consumer) =>
										consumer.kind === original ? { ...consumer, kind } : consumer,
									),
								},
							],
						},
					}),
				},
			}),
		).toThrow(/invalid or stale storage plan/);
	});
	it("materializes before an observing store while retaining projected reads", () => {
		const image = compile(
			"const part=source.split('|')[1];observe.saved=part;return part.length;",
		);
		expect(
			image.native.functions[1]!.storage!.spanContinuations[0]!.consumers.map(
				(value) => value.kind,
			),
		).toEqual(["materialize", "length"]);
	});
	it("materializes a split field used as its own character position", () => {
		const image = compile(
			"const part=source.split('|')[1]; return part.charCodeAt(part)+part.length;",
		);
		const plan = image.native.functions[1]!.storage!.spanContinuations[0]!;
		expect(plan.consumers.map((value) => value.kind)).toContain("materialize");
		expect(plan.consumers.map((value) => value.kind)).not.toContain("charCodeAtCall");
		expect(() => serializeCompilerArtifact(image)).not.toThrow();
	});
});

describe("span continuations from regexp captures", () => {
	const capture = `const match=observe.exec(source); if(match===null)return -1;
 const part=match[1]; if(part===undefined)return 0; const size=part.length;
 if(escape)return part; return part.charCodeAt(0)+Number(part)+size;`;
	it.each(["mutable", "locked"] as const)(
		"composes capture consumers under %s primordials",
		(mode) => {
			const image = compile(capture, mode);
			const native = image.native.functions[1]!;
			expect(native.storage!.spanContinuations).toHaveLength(1);
			const plan = native.storage!.spanContinuations[0]!;
			expect(plan.sourceKind).toBe("regexp");
			expect(plan.consumers.map((consumer) => consumer.kind)).toEqual(
				expect.arrayContaining([
					"equal",
					"length",
					"charCodeAtCall",
					"number",
					"materialize",
				]),
			);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			expect(() => emitProgramImage(image, {})).not.toThrow();
		},
	);
	it("rejects a forged capture source and omitted observer", () => {
		const image = compile(capture);
		const native = image.native.functions[1]!;
		const plan = native.storage!.spanContinuations[0]!;
		for (const forged of [
			{ ...plan, sourceKind: "split" as const },
			{ ...plan, sourceCallIp: plan.producerIp },
			{
				...plan,
				consumers: plan.consumers.filter((consumer) => consumer.kind !== "materialize"),
			},
		]) {
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, spanContinuations: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
		}
	});
	it("rejects a capture that remains live after the next execution of its producer", () => {
		const image = compile(`let prior; let total=0;
 for(let i=0;i<2;i++) {
 const match=observe.exec(source); if(match===null)return total;
 const part=match[1]; if(i)total+=prior.length; prior=part; total+=part.length;
 } return total;`);
		const native = image.native.functions[1]!;
		expect(
			native.specializations.some((region) => region.kind === "regexp-exec-projection"),
		).toBe(true);
		expect(native.storage!.spanContinuations).toHaveLength(0);
	});
});
