import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import { preparedNativeEvalConfig } from "../helpers/native-eval-config.ts";

describe("dynamic imports from runtime-compiled code", () => {
	const fixture = "tests/local/eval-dynamic-import.mjs";
	const outDir = mkdtempSync(join(tmpdir(), "mal-eval-dynamic-import-"));
	let binaries: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	beforeAll(() => {
		binaries = buildBackendPairFromOneProgramImage({
			fixture,
			name: "eval-dynamic-import",
			outDir,
			config: preparedNativeEvalConfig(),
		});
	});

	it.each([
		["shares the static builtin namespace with eval", "eval"],
		["loads a builtin first named in a Function body", "function"],
		["shares the static builtin namespace with runInThisContext", "vm"],
		["shares a runtime-loaded namespace with a later static import", "first"],
		["loads a source builtin first named by runtime code", "source"],
		["rejects an import of a missing package", "missing"],
		["rejects an incompatible builtin import attribute", "attributes"],
	])("%s", (_behavior, selection) => {
		const env = { MAL_EVAL_IMPORT_CASE: selection };
		const expected = execFileSync(process.execPath, ["--no-warnings", fixture], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		for (const binary of [binaries.compiled, binaries.interpreted])
			expect(runToStdout(binary, { env })).toBe(expected);
	});

	it("loads builtin namespaces inside a ShadowRealm under GC stress", () => {
		const expected = "file\n";
		for (const binary of [binaries.compiled, binaries.interpreted])
			expect(
				runToStdout(binary, { env: { ...STRESS_ENV, MAL_EVAL_IMPORT_CASE: "shadow" } }),
			).toBe(expected);
	});
});
