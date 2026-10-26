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

describe("fresh record field kind observations", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves coercion, mutation, prototypes and suspension with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(join(tmpdir(), "mal-record-field-kinds-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture: "tests/local/record-field-kinds.mjs",
					name: `record-field-kinds-${primordials}`,
					mainFile: HOST_MAIN,
					outDir,
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: true },
					}),
				});
				const named = (name: string) =>
					pair.programImage.native.functions.find(
						(candidate) =>
							String.fromCharCode(
								...(pair.programImage.runtime.stringConstants[
									candidate.body.nameStringIndex
								] ?? []),
							) === name,
					)!;
				for (const name of ["readStable", "readUnion"]) {
					expect(named(name)).toBeDefined();
					expect(
						named(name).body.instructions.some(
							({ opcode }) => opcode === "TYPEOF_COMPARE",
						),
					).toBe(false);
				}
				for (const name of ["readEscaped", "readGetterMutated", "readPublic"]) {
					expect(named(name)).toBeDefined();
					expect(
						named(name).body.instructions.some(
							(op) => op.opcode === "UNARY" && op.operator === "typeof",
						),
					).toBe(true);
				}
				for (const binary of [pair.compiled, pair.interpreted])
					for (const env of [{}, { ...STRESS_ENV, MAL_HOST_GC: "1" }])
						assertExactLines(runToStdout(binary, { env }), ["record-field-kinds PASS"]);
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
	);
});
