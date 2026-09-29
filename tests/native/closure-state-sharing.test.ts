import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { compileEntrypoint } from "../../src/compiler/pipeline/compile-program.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	buildNativeProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it("retains selected closure storage and active lexical roots through collection", () => {
	const outDir = mkdtempSync(join(tmpdir(), "mal-closure-capture-retention-"));
	try {
		const binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "closure-capture-retention",
			mainFile: "tests/fixtures/closure-capture-retention/main.c",
			config: resolveBuildConfig({ engine: { eval: false, realms: false } }),
			outDir,
		});
		expect(
			runToStdout(binary, {
				env: { MAL_GC_STRESS: "0", MAL_GC_VERIFY: "1" },
				timeoutMs: 60_000,
			}),
		).toBe("closure-capture-retention PASS\n");
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}, 600_000);

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
	// Assert the conversion on the product image before testing both backends;
	// parity alone could otherwise exercise only the original generic entry.
	const image = compileEntrypoint(resolve(fixture), { buildConfig: config });
	const privateIndices = image.runtime.functions.flatMap((fn, index) =>
		fn.parameterCount === 2 &&
		fn.length === 1 &&
		!fn.instructions.some((op) => op.opcode === "LOAD_CAPTURED") &&
		image.native.functions[index]!.directEntries.some(
			(entry) => entry.parameterRepresentations.length === 2,
		)
			? [index]
			: [],
	);
	// Both the arrow expression and the hoisted declaration must reach this path.
	expect(privateIndices.length).toBeGreaterThanOrEqual(2);
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

it("preserves connected scalar calls and generic bridges across collection", () => {
	const fixture = "tests/local/connected-native-calls.js";
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	const config = resolveBuildConfig({
		engine: { primordials: "locked", eval: false, realms: false },
	});
	const image = compileEntrypoint(resolve(fixture), { buildConfig: config });
	const names = image.runtime.functions.map((fn) =>
		String.fromCharCode(...(image.runtime.stringConstants[fn.nameStringIndex] ?? [])),
	);
	const graph = ["leaf", "helper", "visitor"].map((name) => {
		const index = names.indexOf(name);
		expect(index).toBeGreaterThanOrEqual(0);
		return image.native.functions[index]!;
	});
	const entries = graph.flatMap((fn) => fn.directEntries);
	expect(
		entries.flatMap((entry) => entry.callOverrides ?? []).length,
	).toBeGreaterThanOrEqual(2);
	for (const fn of graph) {
		expect(fn.specializedOnly).toBeUndefined();
		expect(fn.directEntries).toContainEqual(
			expect.objectContaining({
				parameterRepresentations: ["number", "number"],
				resultRepresentation: "number",
			}),
		);
	}
	const outDir = mkdtempSync(join(tmpdir(), "mal-connected-native-calls-"));
	try {
		for (const compiled of [true, false]) {
			const binary = buildNativeProgramImage(image, {
				name: `connected-native-calls-${compiled ? "native" : "interpreted"}`,
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
