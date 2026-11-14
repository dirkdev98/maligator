import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { compileEntrypoint } from "../../src/compiler/pipeline/compile-program.ts";

export const sequence =
	"function* sequence(seed) { for (let index = 0; index < 12; index++) yield seed + index * 2; }";
export const sequenceExpression =
	"const sequence = function* (seed) { for (let index = 0; index < 12; index++) yield seed + index * 2; };";
export const traversal = "for (const value of sequence(round)) checksum += value;";

type Engine = { realms?: boolean; primordials?: "locked" | "mutable"; eval?: boolean };

/** Compiles `generator`, a `hot` loop running `body` and `extra` through Core optimization. */
export function compileFusions(
	generator: string,
	body: string,
	extra: string,
	engine: Engine,
	entry: string,
): { fusions: number; instructions: number } {
	const source = `${generator}
		function hot(count) {
			let checksum = 0;
			for (let round = 0; round < count; round++) { ${body} }
			return checksum;
		}
		${extra}
		console.log(hot(32));`;
	let result: { fusions: number; instructions: number } | undefined;
	const directory = mkdtempSync(join(tmpdir(), "mal-generator-fusion-"));
	try {
		const sourcePath = join(directory, entry);
		writeFileSync(sourcePath, source);
		compileEntrypoint(sourcePath, {
			buildConfig: resolveBuildConfig({ engine }),
			coreInstrumentation: "full",
			afterCoreOptimization(program, _context, report) {
				let instructions = 0;
				for (const id of program.functionIds())
					instructions += [...program.function(id).instructionIds()].length;
				result = {
					fusions: report.transforms.appliedByKind["generator-fusion"]!,
					instructions,
				};
			},
		});
		return result!;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

export function fusionCount(
	generator = sequence,
	body = traversal,
	extra = "",
	engine: Engine = {},
	entry = "main.mjs",
): number {
	return compileFusions(generator, body, extra, engine, entry).fusions;
}
