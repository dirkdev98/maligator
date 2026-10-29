import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { decodeInstructionEffects } from "../../src/compiler/shared/instruction-facts.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("builtin callback effects", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves callback state, validation and suspension with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(join(tmpdir(), "mal-callback-effects-"));
			try {
				const { compiled, interpreted, programImage } =
					buildBackendPairFromOneProgramImage({
						fixture: "tests/local/builtin-callback-effects.js",
						name: "builtin-callback-effects",
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
						) === "callbackUntouched",
				)!;
				expect(caller).toBeDefined();
				if (primordials === "locked") {
					const ip = caller.body.instructions.findIndex(
						(op) =>
							op.opcode === "CALL_KNOWN" && op.operation === "Map.prototype.forEach",
					);
					expect(ip).toBeGreaterThanOrEqual(0);
					expect(decodeInstructionEffects(caller.facts![ip]!.effectMask!)).toMatchObject({
						callsUserCode: false,
						writes: [],
						mayThrow: true,
						mayGc: true,
					});
				}
				const env = {
					MAL_HOST_GC: "1",
					...(process.env.MAL_ASAN === "1" || process.env.MAL_UBSAN === "1"
						? { MAL_GC_VERIFY: "1" }
						: STRESS_ENV),
				};
				for (const binary of [compiled, interpreted])
					assertExactLines(runToStdout(binary, { env }), [
						"builtin-callback-effects PASS",
					]);
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
});
