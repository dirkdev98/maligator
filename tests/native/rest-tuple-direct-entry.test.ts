import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it("carries exact four-number rest tuples through direct entries", () => {
	const fixture = "tests/local/rest-tuple-direct-entry.js";
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	const outDir = mkdtempSync(join(tmpdir(), "mal-rest-tuple-direct-entry-"));
	try {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "rest-tuple-direct-entry",
			config: resolveBuildConfig({
				engine: { primordials: "locked", eval: false, realms: false },
			}),
			outDir,
		});
		const functions = pair.programImage.native.functions.flatMap((fn, functionIndex) =>
			fn.directEntries
				.filter(
					(entry) =>
						entry.argumentRepresentations?.length === 5 &&
						entry.argumentRepresentations.every(
							(representation) => representation === "number",
						),
				)
				.map((entry) => ({ entry, fn, functionIndex })),
		);
		expect(functions).toHaveLength(2);
		for (const { entry, fn, functionIndex } of functions) {
			const emitted = emitCompiledFunction(
				pair.programImage.runtime.functions[functionIndex]!,
				fn,
				functionIndex,
				"",
				false,
			);
			const direct = emitted?.directEntries.find(
				(candidate) => candidate.id === entry.id,
			);
			expect(direct?.source).not.toMatch(/\barg_count\b|\bargs\[/);
			expect(direct?.source).not.toContain("mal_ops_is_number(");
			expect(direct?.source).not.toContain("mal_vm_binary_op(");
			expect(direct?.source).toMatch(/switch \(__rest_index_/);
			expect(direct?.source).toMatch(/\bp1\b/);
			expect(direct?.source).toMatch(/\bp4\b/);
		}
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60_000 })).toBe(expected);
		}
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}, 600_000);
