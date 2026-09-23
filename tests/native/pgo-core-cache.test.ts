import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { compileBuildFrontend } from "../../src/build-frontend-cache.ts";
import type { CorePgoInput } from "../../src/compiler/core/core-pgo.ts";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
import {
	createPgoCapture,
	finalizePgoCapture,
	mergePgoCaptures,
	pgoOptimizationInput,
	preparePgoTraining,
} from "../../src/pgo-artifact.ts";
import { buildNativeProgramImage } from "../../src/test-harness.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "pgo-core-cache-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it("keeps trained library heat and behavior through cold and warm Core reuse", () => {
	const lib = path.join(directory, "lib.mjs");
	const entry = path.join(directory, "entry.mjs");
	writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
	writeFileSync(lib, "export function apply(fn, value) { return fn(value) + 1; }");
	const source =
		"import { apply } from './lib.mjs'; let sum = 0; for (let i = 0; i < 20; i++) sum += apply(x => x * 2, i); console.log(sum);";
	writeFileSync(entry, source);
	const options = {
		entrypoint: entry,
		cacheDirectory: path.join(directory, "cache"),
		config: resolveBuildConfig({}),
		stripTypes: stripCompactTypes,
		stripperIdentity: "pgo-core-cache-native-test",
		forceCompile: true,
	};
	const training = compileBuildFrontend({ ...options, pgoTraining: true });
	const trainingBinary = buildNativeProgramImage(training.programImage, {
		name: "training",
		outDir: directory,
		compiled: false,
		pgoTraining: true,
		evalEnabled: false,
		realmsEnabled: false,
		intlEnabled: false,
		temporalEnabled: false,
		regexpEnabled: false,
		webPlatformEnabled: false,
	});
	const prepared = preparePgoTraining(
		trainingBinary,
		training.programImage,
		"a".repeat(64),
	);
	const capture = createPgoCapture(prepared, "core-cache", directory);
	const trained = spawnSync(trainingBinary, [], {
		encoding: "utf8",
		env: { ...process.env, ...capture.environment, MAL_INTERP: "1" },
	});
	expect(trained.status).toBe(0);
	expect(trained.stderr).toBe("");
	finalizePgoCapture(capture, true);
	const merged = mergePgoCaptures(
		[capture.directory],
		path.join(directory, "merged.json"),
	);
	const base = pgoOptimizationInput(merged.profile);
	const observed: Array<{ functions: number; calls: number }> = [];
	const pgo: CorePgoInput = {
		...base,
		bind(compilation) {
			const hints = base.bind(compilation);
			let functions = 0;
			let calls = 0;
			for (const id of compilation.program.functionIds()) {
				const fn = compilation.program.function(id);
				if (fn.metadata.sourcePath !== lib) continue;
				if ((hints.functionEntries(id) ?? 0) > 0) functions++;
				for (const instruction of fn.instructionIds()) {
					if (
						fn.instructionKind(instruction) === "operation" &&
						(hints.callAttempts(id, instruction) ?? 0) > 0
					)
						calls++;
				}
			}
			observed.push({ functions, calls });
			return hints;
		},
	};
	const ordinary = compileBuildFrontend({ ...options, pgo });
	const cold = compileBuildFrontend({ ...options, coreModuleCache: true, pgo });
	expect(cold.coreModules?.misses).toBe(1);
	expect(cold.coreModules?.optimizedFunctions).toBeGreaterThan(0);
	writeFileSync(entry, `function extra(fn) { return fn(); } extra(() => 0); ${source}`);
	const warm = compileBuildFrontend({ ...options, coreModuleCache: true, pgo });
	expect(warm.coreModules?.hits).toBe(1);
	expect(warm.coreModules?.constructedFunctions).toBe(0);
	expect(warm.coreModules?.optimizedFunctions).toBe(0);
	expect(observed).toHaveLength(3);
	for (const sample of observed) {
		expect(sample.functions).toBeGreaterThan(0);
		expect(sample.calls).toBeGreaterThan(0);
	}
	const node = spawnSync(process.execPath, [entry], { encoding: "utf8" });
	expect(node.status).toBe(0);
	for (const [name, image] of [
		["ordinary", ordinary.programImage],
		["cold", cold.programImage],
		["warm", warm.programImage],
	] as const) {
		const binary = buildNativeProgramImage(image, {
			name,
			outDir: directory,
			compiled: true,
			evalEnabled: false,
			realmsEnabled: false,
			intlEnabled: false,
			temporalEnabled: false,
			regexpEnabled: false,
			webPlatformEnabled: false,
		});
		const result = spawnSync(binary, [], { encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toBe(node.stdout);
	}
}, 120_000);
