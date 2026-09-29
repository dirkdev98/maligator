import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { compileEntrypoint } from "../../src/compiler/pipeline/compile-program.ts";
import {
	buildNativeProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it("preserves result-only closure calls through coercion, reentry and collection", () => {
	const fixture = "tests/local/closure-result-contracts.js";
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	const config = resolveBuildConfig({
		engine: { primordials: "locked", eval: false, realms: false },
	});
	const image = compileEntrypoint(resolve(fixture), { buildConfig: config });
	const index = image.runtime.functions.findIndex(
		(fn) =>
			String.fromCharCode(
				...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
			) === "resultOnlyLeaf",
	);
	expect(index).toBeGreaterThanOrEqual(0);
	// Parity must exercise the new ABI, not just a canonical or inlined body.
	expect(image.native.functions[index]!.directEntries).toContainEqual(
		expect.objectContaining({
			parameterRepresentations: ["boxed"],
			resultRepresentation: "number",
		}),
	);
	const outDir = mkdtempSync(join(tmpdir(), "mal-closure-result-contracts-"));
	try {
		for (const compiled of [true, false]) {
			const binary = buildNativeProgramImage(image, {
				name: `closure-result-contracts-${compiled ? "native" : "interpreted"}`,
				config,
				compiled,
				outDir,
			});
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60_000 })).toBe(expected);
		}
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}, 600_000);
