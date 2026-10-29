import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("builtin operand observations", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves calls, accessors and Proxy errors with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(join(tmpdir(), "mal-builtin-observations-"));
			try {
				const { compiled, interpreted, programImage } =
					buildBackendPairFromOneProgramImage({
						fixture: "tests/local/builtin-operand-observations.js",
						name: "builtin-operand-observations",
						mainFile: HOST_MAIN,
						outDir,
						nativeStackRoots: "precise",
						config: resolveBuildConfig({
							engine: { primordials, eval: false, realms: false },
						}),
					});
				const caller = programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
						) === "builtinUntouched",
				)!;
				expect(caller).toBeDefined();
				expect(caller.body.instructions.some((op) => op.opcode === "CALL")).toBe(true);
				if (primordials === "locked")
					expect(
						caller.body.instructions.some(
							(op) =>
								op.opcode.startsWith("LOAD_PROPERTY_STATIC") &&
								"stringIndex" in op &&
								typeof op.stringIndex === "number" &&
								String.fromCharCode(
									...(programImage.runtime.stringConstants[op.stringIndex] ?? []),
								) === "x",
						),
					).toBe(false);
				const env = {
					MAL_HOST_GC: "1",
					...(process.env.MAL_ASAN === "1" || process.env.MAL_UBSAN === "1"
						? { MAL_GC_VERIFY: "1" }
						: STRESS_ENV),
				};
				for (const binary of [compiled, interpreted])
					assertExactLines(runToStdout(binary, { env }), [
						"builtin-operand-observations PASS",
					]);
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
});
