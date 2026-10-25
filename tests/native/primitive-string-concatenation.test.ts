import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_STRING,
	compilerOperatorIsPrimitiveStringConcatenation,
} from "../../src/compiler/shared/compiler-value-kinds.ts";
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

	it.each(["mutable", "locked"] as const)(
		"converts primitive operands with %s primordials across suspension and collection",
		(primordials) => {
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `primitive-string-concat-${primordials}`,
				config: resolveBuildConfig({ engine: { primordials } }),
				mainFile: HOST_MAIN,
				outDir,
				nativeStackRoots: "precise",
			});
			const mixedConcatenations = pair.programImage.native.functions.flatMap((fn) =>
				fn.body.instructions.flatMap((op, ip) => {
					const proof = fn.facts?.[ip];
					return op.opcode === "BINARY" &&
						proof?.inputKindMasks !== undefined &&
						!proof.inputKindMasks.every((mask) => mask === COMPILER_VALUE_KIND_STRING) &&
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
			expect(
				mixedConcatenations.some((masks) =>
					masks.some((mask) => (mask & COMPILER_VALUE_KIND_BIGINT) !== 0),
				),
			).toBe(true);
			for (const binary of [pair.compiled, pair.interpreted])
				for (const env of [{}, STRESS_ENV])
					expect(runToStdout(binary, { env })).toBe(expected);
		},
	);
});
