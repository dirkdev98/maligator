import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-buffer-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("global Buffer and node:buffer", () => {
	let esmCompiled: string;
	let esmInterpreted: string;
	let cjsCompiled: string;
	let cjsInterpreted: string;
	let globalOnly: string;
	let expressDependencySmoke: string;

	beforeAll(() => {
		esmCompiled = buildNativeBinary({
			fixture: "tests/local/node-buffer.mjs",
			name: "node-buffer-esm-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		esmInterpreted = buildNativeBinary({
			fixture: "tests/local/node-buffer.mjs",
			name: "node-buffer-esm-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
		cjsCompiled = buildNativeBinary({
			fixture: "tests/local/node-buffer.cjs",
			name: "node-buffer-cjs-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		cjsInterpreted = buildNativeBinary({
			fixture: "tests/local/node-buffer.cjs",
			name: "node-buffer-cjs-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
		globalOnly = buildNativeBinary({
			fixture: "tests/local/node-buffer-global.mjs",
			name: "node-buffer-global",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		expressDependencySmoke = buildNativeBinary({
			fixture: "tests/fixtures/express-5/buffer-smoke.cjs",
			name: "node-buffer-express-dependency-smoke",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
	}, 600_000);

	it("passes ESM compiled", () => {
		assertResultPass(runToStdout(esmCompiled));
	});

	it("passes ESM interpreted", () => {
		assertResultPass(runToStdout(esmInterpreted));
	});

	it("passes CommonJS compiled", () => {
		assertResultPass(runToStdout(cjsCompiled));
	});

	it("passes CommonJS interpreted", () => {
		assertResultPass(runToStdout(cjsInterpreted));
	});

	it("installs Buffer for a free global without an import", () => {
		assertResultPass(runToStdout(globalOnly));
	});

	it("supports Express's safer-buffer dependency", () => {
		assertResultPass(runToStdout(expressDependencySmoke));
	});

	it("passes compiled paths under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(esmCompiled, { env: STRESS_ENV }));
		assertResultPass(runToStdout(cjsCompiled, { env: STRESS_ENV }));
		assertResultPass(runToStdout(globalOnly, { env: STRESS_ENV }));
		assertResultPass(runToStdout(expressDependencySmoke, { env: STRESS_ENV }));
	});
});

describe("node:buffer text validation", () => {
	it("recognizes encoding names without coercion and preserves construction behavior", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-buffer-encoding-"));
		const fixture = "tests/local/node-buffer-encoding.mjs";
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
		}).trim();
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: "node-buffer-encoding",
				outDir: directory,
				mainFile: HOST_MAIN,
				nodeEnabled: true,
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				for (const env of [{}, STRESS_ENV])
					expect(runToStdout(binary, { env }).trim()).toBe(expected);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("validates encoded bytes and observable argument errors like Node", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-buffer-validation-"));
		const fixture = "tests/local/node-buffer-validation.mjs";
		const reference = JSON.parse(
			execFileSync(process.execPath, [fixture], { encoding: "utf8" }),
		) as Array<[string, unknown]>;
		// Node 26 accepts detached buffers despite the documented validation contract.
		const expected = JSON.stringify(
			reference.map(([name, value]) => [
				name,
				name.startsWith("detached-buffer:") ? ["Error", "ERR_INVALID_STATE"] : value,
			]),
		);
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: "node-buffer-validation",
				nodeEnabled: true,
				mainFile: HOST_MAIN,
				outDir: directory,
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary).trim()).toBe(expected);
				expect(runToStdout(binary, { env: STRESS_ENV }).trim()).toBe(expected);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("matches Node's numeric accessors, search, fill and encoding methods", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-buffer-api-"));
		const fixture = "tests/local/node-buffer-api.mjs";
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: "node-buffer-api",
				nodeEnabled: true,
				mainFile: HOST_MAIN,
				outDir: directory,
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary)).toBe(expected);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
