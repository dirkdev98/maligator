import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { compilerOperatorIsPrimitiveStringConcatenation } from "../../src/compiler/shared/compiler-value-kinds.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("String concatenation with proven primitive operands", () => {
	const fixture = "tests/local/primitive-string-concatenation.js";
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-primitive-string-concat-"));
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	it("converts Number, Boolean and nullish operands exactly as + does", () => {
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "primitive-string-concat",
			config: resolveBuildConfig({}),
			mainFile: HOST_MAIN,
			outDir,
		});
		const mixedConcatenations = pair.programImage.native.functions.flatMap((fn) =>
			fn.body.instructions.flatMap((op, ip) => {
				const proof = fn.instructions[ip];
				return op.opcode === "BINARY" &&
					proof?.kind === "operator-input-kinds" &&
					!proof.inputKindMasks.every((mask) => mask === 16) &&
					compilerOperatorIsPrimitiveStringConcatenation(
						"binary",
						op.operator,
						proof.inputKindMasks,
					)
					? [proof.inputKindMasks]
					: [];
			}),
		);
		expect(mixedConcatenations.length).toBeGreaterThan(0);
		for (const binary of [pair.compiled, pair.interpreted])
			for (const env of [{}, STRESS_ENV])
				expect(runToStdout(binary, { env })).toBe(expected);
	});
});
