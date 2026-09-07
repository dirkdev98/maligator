import { readdirSync } from "node:fs";
import * as path from "node:path";
import { parseModule, parseScript } from "../compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../compiler/frontend/semantic-analysis.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../compiler/frontend/semantic-program.ts";
import { SyntaxDiagnostic } from "../compiler/frontend/syntax-diagnostic.ts";
import { compileSemanticProgramToProgramImage } from "../compiler/pipeline/compile-core.ts";
import type { ProgramImage } from "../compiler/target/program-image.ts";
import { TEST262_METADATA } from "./constants.ts";
import { test262CompileNegativeVerdict } from "./policy.ts";
import type { Test262File, Test262Result } from "./types.ts";

export interface Test262Compilation {
	image?: ProgramImage;
	result: Test262Result;
	failure?: string;
}

export function compileTest262ProgramImage(
	file: Test262File,
	strict: boolean,
	corpusRoot = TEST262_METADATA.path,
): Test262Compilation {
	const source = file.content;
	const isModule = file.frontmatter.flags?.includes("module") ?? false;
	const hasDynamicImport = file.frontmatter.features?.includes("dynamic-import") ?? false;
	try {
		let parsed: ReturnType<typeof parseScript>;
		try {
			parsed = isModule ? parseModule(source) : parseScript(source, { strict });
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new SyntaxDiagnostic("parse", error.message, { cause: error });
			}
			throw error;
		}

		const filePath = path.join(corpusRoot, file.path);
		const dynamicImportCandidates = hasDynamicImport
			? readdirSync(path.dirname(filePath))
					.filter((name) => name.endsWith("_FIXTURE.js") && source.includes(name))
					.map((name) => path.join(path.dirname(filePath), name))
			: undefined;
		const semantic =
			isModule || hasDynamicImport
				? loadEntrypointAndRunSemanticAnalysis(filePath, {
						entryGoal: isModule ? "module" : "script",
						entryStrict: strict,
						entrySource: source,
						dependencyGoalOverride: "module",
						dynamicImportCandidates,
					})
				: analyzeSourceAndRunSemanticAnalysis(source, file.path, parsed);
		const image = compileSemanticProgramToProgramImage(semantic);
		const negative = file.frontmatter.negative;
		if (negative !== undefined && negative.phase !== "runtime") {
			return {
				result: "FAILED",
				failure: `negative(${negative.phase}): expected ${negative.type} but compiled`,
			};
		}
		return { result: "UNKNOWN", image };
	} catch (error) {
		const verdict = test262CompileNegativeVerdict(file, error);
		if (verdict?.passed) return { result: "PASSED" };
		const message = error instanceof Error ? error.message : String(error);
		return {
			result: "COMPILE_FAILED",
			failure:
				verdict === undefined ? `compile: ${message}` : `${verdict.reason}: ${message}`,
		};
	}
}
