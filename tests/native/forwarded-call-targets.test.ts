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

describe("forwarded function call targets", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves closure environments, traps and completions with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(join(tmpdir(), "mal-forwarded-targets-"));
			try {
				const { compiled, interpreted, programImage } =
					buildBackendPairFromOneProgramImage({
						fixture: "tests/local/forwarded-call-targets.js",
						name: "forwarded-call-targets",
						outDir,
						mainFile: HOST_MAIN,
						nativeStackRoots: "precise",
						config: resolveBuildConfig({
							engine: { primordials, eval: false, realms: false },
						}),
					});
				const name = (index: number) =>
					String.fromCharCode(...(programImage.runtime.stringConstants[index] ?? []));
				const produced = new Set(
					programImage.native.functions
						.filter((fn) => name(fn.body.nameStringIndex) === "produced")
						.map((fn) => fn.functionIndex),
				);
				const caller = programImage.native.functions.find(
					(fn) => name(fn.body.nameStringIndex) === "invokeReturned",
				)!;
				expect(produced.size).toBeGreaterThan(0);
				expect(
					caller.instructions.some(
						(op) =>
							op?.kind === "call" &&
							((op.directFunctionIndex !== undefined &&
								produced.has(op.directFunctionIndex)) ||
								op.guardedFunctionIndices?.some((target) => produced.has(target))),
					),
				).toBe(true);
				const env = {
					MAL_HOST_GC: "1",
					...(process.env.MAL_ASAN === "1" || process.env.MAL_UBSAN === "1"
						? { MAL_GC_VERIFY: "1" }
						: STRESS_ENV),
				};
				for (const binary of [compiled, interpreted])
					assertExactLines(runToStdout(binary, { env }), ["forwarded-call-targets PASS"]);
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
});
