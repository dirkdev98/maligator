import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	emitProgramImage,
	emitProgramTranslationUnits,
} from "../../src/compiler/target/emit-program-image.ts";
import { buildLocalBinary } from "../../src/local-build.ts";
import {
	buildNativeBinaryResult,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("checked numeric leaf activation", () => {
	it("balances depth and trace rows, rejects both stack limits, and preserves field behavior in observing modes", () => {
		const outDir = mkdtempSync(join(tmpdir(), "mal-checked-leaf-"));
		for (const profileEnabled of [false, true]) {
			const built = buildNativeBinaryResult({
				fixture: "tests/local/read-only-field-entries.js",
				name: `leaf-observed-${profileEnabled}`,
				mainFile: "runtime/leaf_entry_test_main.c",
				profileEnabled,
				outDir,
			});
			expect(runToStdout(built.binaryPath, { env: STRESS_ENV })).toBe(
				"read-only-field-entries PASS\nchecked-leaf-entry PASS\n",
			);
			if (profileEnabled) continue;
			const source = emitProgramImage(built.programImage, {
				compiled: true,
				debugInfo: false,
			});
			expect(source).toContain("mal_vm_enter_leaf_checked");
			const mixedSource = emitProgramTranslationUnits(
				built.programImage,
				{ compiled: true, debugInfo: false },
				{ targetCodeUnits: 32768, hardMaximumCodeUnits: 32768 },
			);
			expect(mixedSource.map((unit) => unit.source).join("\n")).toContain(
				"mal_function_0_instructions",
			);
			const mixed = buildLocalBinary({
				context: built.context,
				name: "leaf-mixed",
				cSource: mixedSource,
				verbose: false,
				outDir,
				mainFile: "runtime/leaf_entry_test_main.c",
			});
			expect(runToStdout(mixed.binaryPath, { env: STRESS_ENV })).toBe(
				"read-only-field-entries PASS\nchecked-leaf-entry PASS\n",
			);
			const stripped = buildLocalBinary({
				context: built.context,
				name: "leaf-unobserved",
				cSource: source,
				verbose: false,
				outDir,
				mainFile: "runtime/leaf_entry_test_main.c",
			});
			expect(runToStdout(stripped.binaryPath, { env: STRESS_ENV })).toBe(
				"read-only-field-entries PASS\nchecked-leaf-entry PASS\n",
			);
		}
	}, 600_000);
});
