import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	runToStdout,
	scaledNativeRunTimeoutMs,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-realms-"));

describe("generic realm runtime API", () => {
	let bin: string;
	let arrayOfCompiled: string;
	let arrayOfInterpreted: string;
	let dynamicCompiled: string;
	let dynamicInterpreted: string;

	beforeAll(() => {
		bin = buildNativeBinary({
			fixture: "tests/local/array-to-object.js",
			name: "realm",
			mainFile: "runtime/realm_test_main.c",
			outDir,
			realmsEnabled: true,
		});
		arrayOfCompiled = buildNativeBinary({
			fixture: "tests/local/array-of-cross-realm.js",
			name: "array-of-cross-realm",
			compiled: true,
			mainFile: "runtime/test262_main.c",
			outDir,
			realmsEnabled: true,
		});
		arrayOfInterpreted = buildNativeBinary({
			fixture: "tests/local/array-of-cross-realm.js",
			name: "array-of-cross-realm-ni",
			compiled: false,
			mainFile: "runtime/test262_main.c",
			outDir,
			realmsEnabled: true,
		});
		dynamicCompiled = buildNativeBinary({
			fixture: "tests/local/dynamic-function-cross-realm.js",
			name: "dynamic-function-cross-realm",
			compiled: true,
			mainFile: "runtime/test262_main.c",
			outDir,
			realmsEnabled: true,
		});
		dynamicInterpreted = buildNativeBinary({
			fixture: "tests/local/dynamic-function-cross-realm.js",
			name: "dynamic-function-cross-realm-ni",
			compiled: false,
			mainFile: "runtime/test262_main.c",
			outDir,
			realmsEnabled: true,
		});
	});

	it("isolates realm state and crosses call boundaries", () => {
		assertPassLine(runToStdout(bin), "realm");
	});

	it("survives MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertPassLine(runToStdout(bin, { env: STRESS_ENV }), "realm");
	});

	it.each([
		["compiled", () => arrayOfCompiled],
		["interpreted", () => arrayOfInterpreted],
	] as const)("preserves %s Array.of constructor realms", (_name, binary) => {
		assertPassLine(
			runToStdout(binary(), { env: { MAL_TEST262: "1" } }),
			"array-of-cross-realm",
		);
	});

	it.each([
		["compiled", () => arrayOfCompiled],
		["interpreted", () => arrayOfInterpreted],
	] as const)(
		"roots %s Array.of results under GC stress",
		(_name, binary) => {
			assertPassLine(
				runToStdout(binary(), {
					env: { ...STRESS_ENV, MAL_TEST262: "1" },
					timeoutMs: 60_000,
				}),
				"array-of-cross-realm",
			);
		},
		scaledNativeRunTimeoutMs(60_000),
	);

	it.each([
		["compiled", () => dynamicCompiled],
		["interpreted", () => dynamicInterpreted],
	] as const)("preserves %s dynamic-function constructor realms", (_name, binary) => {
		assertPassLine(
			runToStdout(binary(), { env: { MAL_TEST262: "1" } }),
			"dynamic-function-cross-realm",
		);
	});

	it.each([
		["compiled", () => dynamicCompiled],
		["interpreted", () => dynamicInterpreted],
	] as const)("roots %s dynamic-function realms under GC stress", (_name, binary) => {
		assertPassLine(
			runToStdout(binary(), {
				env: {
					...STRESS_ENV,
					// The self-hosted compiler has thousands of safepoints. A
					// bounded interval still collects repeatedly throughout every
					// dynamic-function family without turning this focused realm
					// test into a compiler stress benchmark.
					MAL_GC_STRESS: "10",
					MAL_TEST262: "1",
				},
			}),
			"dynamic-function-cross-realm",
		);
	});
});
