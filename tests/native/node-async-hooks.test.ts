import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-async-hooks-"));

describe("node:async_hooks context compatibility", () => {
	let compiled: string;
	let interpreted: string;
	let expressFoundations: string;
	let storageCompiled: string;
	let storageInterpreted: string;
	let storageExpected: string;
	let storageV26Binaries: Array<string>;
	let storageV26Expected: string | undefined;
	let httpStorageBinaries: Array<string>;
	let httpStorageExpected: string;
	let netStorageBinaries: Array<string>;
	let netStorageExpected: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/node-async-hooks.mjs",
			name: "node-async-hooks-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/node-async-hooks.mjs",
			name: "node-async-hooks-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
		expressFoundations = buildNativeBinary({
			fixture: "tests/fixtures/express-5/node-foundations-smoke.cjs",
			name: "node-express-body-compat",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		storageCompiled = buildNativeBinary({
			fixture: "tests/local/node-async-local-storage.mjs",
			name: "node-async-local-storage-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		storageInterpreted = buildNativeBinary({
			fixture: "tests/local/node-async-local-storage.mjs",
			name: "node-async-local-storage-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
		storageExpected = execFileSync(
			process.execPath,
			["tests/local/node-async-local-storage.mjs"],
			{ encoding: "utf-8" },
		);
		storageV26Binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/local/node-async-local-storage-v26.mjs",
				name: compiled
					? "node-async-local-storage-v26-compiled"
					: "node-async-local-storage-v26-interpreted",
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
				compiled,
			}),
		);
		if (Number.parseInt(process.versions.node, 10) >= 26) {
			storageV26Expected = execFileSync(
				process.execPath,
				["tests/local/node-async-local-storage-v26.mjs"],
				{ encoding: "utf-8" },
			);
		}
		httpStorageBinaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/local/node-async-local-storage-http.cjs",
				name: compiled
					? "node-async-local-storage-http-compiled"
					: "node-async-local-storage-http-interpreted",
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
				compiled,
			}),
		);
		httpStorageExpected = execFileSync(
			process.execPath,
			["tests/local/node-async-local-storage-http.cjs"],
			{ encoding: "utf-8" },
		);
		netStorageBinaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/local/node-async-local-storage-net.cjs",
				name: compiled
					? "node-async-local-storage-net-compiled"
					: "node-async-local-storage-net-interpreted",
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
				compiled,
			}),
		);
		netStorageExpected = execFileSync(
			process.execPath,
			["tests/local/node-async-local-storage-net.cjs"],
			{ encoding: "utf-8" },
		);
	});

	it("passes compiled", () => {
		assertResultPass(runToStdout(compiled));
	});

	it("passes interpreted", () => {
		assertResultPass(runToStdout(interpreted));
	});

	it("supports pinned on-finished and iconv-lite consumers", () => {
		assertResultPass(runToStdout(expressFoundations));
	});

	it("passes compiled under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
	});

	it("passes interpreted under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(interpreted, { env: STRESS_ENV }));
	});

	it("passes the pinned foundations smoke under GC stress", () => {
		assertResultPass(runToStdout(expressFoundations, { env: STRESS_ENV }));
	});

	it("matches real Node for AsyncLocalStorage when compiled", () => {
		expect(runToStdout(storageCompiled)).toBe(storageExpected);
	});

	it("matches real Node for AsyncLocalStorage when interpreted", () => {
		expect(runToStdout(storageInterpreted)).toBe(storageExpected);
	});

	it("passes AsyncLocalStorage under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		expect(runToStdout(storageCompiled, { env: STRESS_ENV })).toBe(storageExpected);
		expect(runToStdout(storageInterpreted, { env: STRESS_ENV })).toBe(storageExpected);
	});

	it("supports the Node 26 AsyncLocalStorage surface", () => {
		for (const binary of storageV26Binaries) {
			const output = runToStdout(binary);
			if (storageV26Expected === undefined) assertResultPass(output);
			else expect(output).toBe(storageV26Expected);
		}
	});

	it("keeps Node 26 disposable scopes rooted under GC stress", () => {
		for (const binary of storageV26Binaries) {
			const output = runToStdout(binary, { env: STRESS_ENV });
			if (storageV26Expected === undefined) assertResultPass(output);
			else expect(output).toBe(storageV26Expected);
		}
	});

	it("isolates overlapping HTTP request contexts like real Node", () => {
		for (const binary of httpStorageBinaries) {
			expect(runToStdout(binary)).toBe(httpStorageExpected);
		}
	});

	it("keeps HTTP async contexts rooted under GC stress", () => {
		for (const binary of httpStorageBinaries) {
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(httpStorageExpected);
		}
	});

	it("propagates raw socket resource and write contexts like real Node", () => {
		for (const binary of netStorageBinaries) {
			expect(runToStdout(binary)).toBe(netStorageExpected);
		}
	});

	it("keeps raw socket async contexts rooted under GC stress", () => {
		for (const binary of netStorageBinaries) {
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(netStorageExpected);
		}
	});
});
