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

describe("merged record read lifetimes", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves field observations and later effects with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(join(tmpdir(), "mal-record-read-prefixes-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture: "tests/local/record-read-prefixes.mjs",
					name: `record-read-prefixes-${primordials}`,
					mainFile: HOST_MAIN,
					outDir,
					nativeStackRoots: "precise",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: true },
					}),
				});
				const ownReads = (name: string) => {
					const fn = pair.programImage.native.functions.find(
						(candidate) =>
							String.fromCharCode(
								...(pair.programImage.runtime.stringConstants[
									candidate.body.nameStringIndex
								] ?? []),
							) === name,
					)!;
					expect(fn, name).toBeDefined();
					return fn.instructions.filter((plan) => plan?.kind === "known-own-data");
				};
				for (const name of [
					"beforeEscape",
					"beforeWrite",
					"branchEscape",
					"freshLoop",
					"beforeHeapEscape",
					"beforeStringEscape",
					"suspendedHeap",
					"awaitedHeap",
				])
					expect(ownReads(name).length, name).toBeGreaterThan(0);
				for (const name of ["afterEscape", "differentLifetime", "reusedLoop"])
					expect(ownReads(name), name).toHaveLength(0);
				for (const binary of [pair.compiled, pair.interpreted])
					for (const env of [{}, { ...STRESS_ENV, MAL_HOST_GC: "1" }])
						assertExactLines(runToStdout(binary, { env }), ["record-read-prefixes PASS"]);
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
	);
});
