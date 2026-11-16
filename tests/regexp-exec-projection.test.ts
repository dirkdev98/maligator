import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	serializeCompilerArtifact,
	deserializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";
import { mergeProgramImages } from "../src/test262/program-image-merge.ts";
function compile(body: string) {
	const source = `globalThis.project=function(pattern,text){const match=pattern.exec(text);${body}};`;
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			source,
			"regexp-projection.js",
			parseScript(source, { strict: false }),
		),
		{ facts: compilerProgramFactsFromConfig(resolveBuildConfig({})) },
	);
}
function projections(image: ProgramImage) {
	return image.native.functions.flatMap((fn) =>
		fn.specializations.filter((region) => region.kind === "regexp-exec-projection"),
	);
}
describe("RegExp exec projection certificates", () => {
	it.each([
		["whole match", "if(match===null)return -1;return match[0].length;", true],
		["match index", "if(match===null)return -1;return match.index;", true],
		[
			"named span chain",
			"if(match===null)return -1;return match.groups.tag.trim().slice(1).length;",
			true,
		],
		[
			"named branch",
			"return match ? match[0].length+match.index+(match.groups ? match.groups.tag.length : match[1].length) : -1;",
			true,
		],
		["escaping capture", "if(match===null)return null;return match.groups.tag;", true],
		[
			"groups alias",
			"if(match===null)return null;const groups=match.groups;return groups ? groups.tag : null;",
			true,
		],
		["escaping result", "return match;", false],
		["escaping groups", "if(match===null)return null;return match.groups;", false],
		[
			"groups enumeration",
			"if(match===null)return null;return Object.keys(match.groups);",
			false,
		],
		[
			"groups mutation",
			'if(match===null)return null;match.groups.tag="b";return match.groups.tag;',
			false,
		],
		["transported result", "return match || 0;", false],
		[
			"groups identity",
			"if(match===null)return null;return match.groups === null;",
			false,
		],
		[
			"excess outputs",
			`if(match===null)return null;return [${Array.from({ length: 9 }, (_, i) => `match[${i}]`).join(",")}];`,
			false,
		],
	] as const)("admits only closed %s consumers", (_name, body, expected) => {
		expect(projections(compile(body)).length > 0).toBe(expected);
	});
	it("round trips whole, index and named selectors with their groups aliases", () => {
		const image = compile(
			"return match ? match[0].length+match.index+(match.groups ? match.groups.tag.length : match[1].length) : -1;",
		);
		const regions = projections(image);
		expect(
			new Set(
				regions.flatMap((region) => region.loads.map((load) => load.selector.kind)),
			),
		).toEqual(new Set(["capture", "match-index", "groups", "named-capture"]));
		expect(
			projections(
				deserializeCompilerArtifact(
					serializeCompilerArtifact(image, { debugInfo: false }),
				),
			),
		).toEqual(regions);
	});
	it("relocates named selectors when standards images are merged", () => {
		const merged = mergeProgramImages([
			compile("return 1;"),
			compile("if(match===null)return null;return match.groups.tag;"),
		]).image;
		expect(
			projections(
				deserializeCompilerArtifact(
					serializeCompilerArtifact(merged, { debugInfo: false }),
				),
			),
		).toEqual(projections(merged));
	});
	it("retains named captures through String span continuations", () => {
		const image = compile(
			"if(match===null)return -1;return match.groups.tag.trim().slice(1).length;",
		);
		expect(() =>
			deserializeCompilerArtifact(serializeCompilerArtifact(image, { debugInfo: false })),
		).not.toThrow();
	});
	it("rejects a selector that names a different static property", () => {
		const image = compile("if(match===null)return -1;return match.index;");
		const region = projections(image)[0]!;
		const load = region.loads[0]!;
		Object.assign(load, { selector: { kind: "groups" } });
		expect(() => serializeCompilerArtifact(image, { debugInfo: false })).toThrow(
			/RegExp.exec projection/,
		);
	});
});
