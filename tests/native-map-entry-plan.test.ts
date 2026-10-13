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
			"/map-entries.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
	);
}
const body = `const first=source.get(1); const second=source.get(2);
 source.set(1,first+1);source.set(2,second+1);return first+second;`;
describe("region-local Map entries", () => {
	it.each(["mutable", "locked"] as const)(
		"carries reference keys and values outside protected ranges under %s primordials",
		(mode) => {
			const source = `try { observe(); } catch { escape(); }
const first=source.get(escape); const second=source.get(observe);
observe(); source.set(escape,{previous:first}); source.set(observe,{previous:second});
return [first,second];`;
			const image = compile(source, mode);
			const native = image.native.functions[1]!;
			expect(native.body.handlers.length).toBeGreaterThan(0);
			expect(native.storage!.mapEntries).toHaveLength(2);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			expect(() => emitProgramImage(image, {})).not.toThrow();
		},
	);
	it.each(["mutable", "locked"] as const)(
		"declines entry state within or across a protected range under %s primordials",
		(mode) => {
			for (const source of [
				`try { ${body} } catch { observe(); }`,
				`const first=source.get(1); const second=source.get(2);
try { observe(); } catch { escape(); }
source.set(1,first); source.set(2,second);`,
			]) {
				expect(compile(source, mode).native.functions[1]!.storage!.mapEntries).toEqual(
					[],
				);
			}
		},
	);
	it.each(["mutable", "locked"] as const)(
		"carries several indices under %s primordials",
		(mode) => {
			const image = compile(body, mode);
			expect(image.native.functions[1]!.storage!.mapEntries).toHaveLength(2);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			expect(() => emitProgramImage(image, {})).not.toThrow();
		},
	);
	it("rejects forged entry dependencies", () => {
		const image = compile(body),
			native = image.native.functions[1]!;
		const plan = native.storage!.mapEntries[0]!;
		expect(() =>
			serializeCompilerArtifact({
				...image,
				native: {
					...image.native,
					functions: image.native.functions.with(1, {
						...native,
						storage: { ...native.storage!, mapEntries: [{ ...plan, setIp: plan.getIp }] },
					}),
				},
			}),
		).toThrow(/invalid or stale storage plan/);
	});
	it("declines unrelated owners and mixed control-flow", () => {
		for (const body of [
			"const a=source.get(1);source.set(1,a+1);const b=source.get(2);source.set(2,b+1);",
			"const x=source.get(1);observe.set(1,x+1);",
			"const x=source.get(1);if(escape)observe();source.set(1,x+1);",
		]) {
			expect(compile(body).native.functions[1]!.storage!.mapEntries).toEqual([]);
		}
	});
});
