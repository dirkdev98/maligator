import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { buildDerivationFromConfig } from "../../src/build-config.ts";
import { compileBuildFrontend } from "../../src/build-frontend-cache.ts";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
import { buildDevelopmentRunner } from "../../src/local-build.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";
import { compileRelocatableTestImage } from "../../src/testing/fragment-cache.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const root = mkdtempSync(path.join(os.tmpdir(), "mal-test-runner-regression-"));
const cacheDirectory = path.join(root, "cache");
const config = resolveBuildConfig({});
let runner: string;

function write(file: string, source: string | Uint8Array): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, source);
}

function compileSupportWire(file: string): Array<Uint8Array> {
	const frontend = compileBuildFrontend({
		entrypoint: file,
		config,
		stripTypes: stripCompactTypes,
		stripperIdentity: "test-runner-regression-stripper",
		cacheDirectory,
		optimization: "development",
		relocatable: true,
	});
	return frontend.wires ?? [frontend.wire];
}

function runTestFile(testFile: string, stress = false) {
	const testImage = compileRelocatableTestImage({
		files: [testFile],
		config,
		stripTypes: stripCompactTypes,
		stripperIdentity: "test-runner-regression-stripper",
		testModuleSource: readFileSyncForFixture("src/testing/runtime.mjs"),
		cacheDirectory,
	});
	const setup = path.join(root, "setup.mjs");
	write(
		setup,
		`globalThis.__maligatorTestOptions = ${JSON.stringify({
			files: [testFile],
			repeat: 1,
			bail: false,
			timeoutMs: 5000,
		})};\n`,
	);
	const report = path.join(root, "report.mjs");
	write(
		report,
		`const result = globalThis.__maligatorTestResult;
if (result === undefined) throw new Error("test runner did not publish a result");
console.log(\`RUNNER_RESULT \${result.passed}/\${result.failed}\`);
if (result.passed !== 1 || result.failed !== 0) throw new Error("unexpected test result");
`,
	);
	const runnerWire = testImage.wires.at(-1);
	if (runnerWire?.kind !== "runner") throw new Error("test image is missing its runner");
	const wires = [
		...testImage.wires.slice(0, -1).map((wire) => wire.wire),
		...compileSupportWire(setup),
		runnerWire.wire,
		...compileSupportWire(report),
	];
	const wirePaths = wires.map((wire, index) => {
		const wirePath = path.join(root, `wire-${index}.malw`);
		write(wirePath, wire);
		return wirePath;
	});
	return spawnSync(
		runner,
		["--maligator-internal-run-wires", String(wirePaths.length), testFile, ...wirePaths],
		{
			encoding: "utf-8",
			env: {
				...process.env,
				MAL_GC_AT_EXIT: "1",
				...(stress ? { MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" } : {}),
			},
		},
	);
}

function readFileSyncForFixture(file: string): string {
	return readFileSync(path.join(repositoryRoot, file), "utf-8");
}

beforeAll(() => {
	const derivation = buildDerivationFromConfig(config);
	runner = buildDevelopmentRunner(
		resolveNativeBuildContext({ features: derivation.features }),
		false,
		derivation.cacheSuffix,
	).binaryPath;
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("maligator:test runner startup regressions", () => {
	for (const [issue, relativeFixture] of [
		[31, "tests/fixtures/maligator-test-runner/minimal.test.ts"],
		[38, "tests/fixtures/maligator-test-runner/esm/runner-repro.test.ts"],
	] as const) {
		it(`completes the minimal issue #${issue} test without a signal`, () => {
			const testFile = path.join(repositoryRoot, relativeFixture);
			for (const stress of [false, true]) {
				const result = runTestFile(testFile, stress);
				expect(result.signal, result.stderr).toBeNull();
				expect(result.status, result.stderr || result.stdout).toBe(0);
				expect(result.stdout).toContain("RUNNER_RESULT 1/0");
			}
		});
	}
});
