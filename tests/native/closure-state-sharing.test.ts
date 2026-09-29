import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { compileEntrypoint } from "../../src/compiler/pipeline/compile-program.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it("preserves closure cells and lexical identities across native and generic calls", () => {
	const fixture = "tests/local/closure-state-sharing.js";
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	const outDir = mkdtempSync(join(tmpdir(), "mal-closure-state-sharing-"));
	try {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "closure-state-sharing",
			config: resolveBuildConfig({
				engine: { primordials: "locked", eval: false, realms: false },
			}),
			outDir,
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60_000 })).toBe(expected);
		}
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}, 600_000);

it("preserves observable closures across the private bridge under collection", () => {
	const fixture = "tests/local/closure-private-bridge.js";
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	const config = resolveBuildConfig({
		engine: { primordials: "locked", eval: false, realms: false },
	});
	// Use the product frontend: the ordinary fixture harness intentionally has no
	// source-closure certificate and would silently skip this optimization.
	const image = compileEntrypoint(resolve(fixture), { buildConfig: config });
	const privateIndex = image.runtime.functions.findIndex(
		(fn) =>
			fn.parameterCount === 2 &&
			fn.length === 1 &&
			!fn.instructions.some((op) => op.opcode === "LOAD_CAPTURED"),
	);
	expect(privateIndex).toBeGreaterThanOrEqual(0);
	expect(
		image.native.functions[privateIndex]!.directEntries.some(
			(entry) => entry.parameterRepresentations.length === 2,
		),
	).toBe(true);
	const outDir = mkdtempSync(join(tmpdir(), "mal-closure-private-bridge-"));
	try {
		for (const compiled of [true, false]) {
			const binary = buildNativeProgramImage(image, {
				name: `closure-private-bridge-${compiled ? "native" : "interpreted"}`,
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
