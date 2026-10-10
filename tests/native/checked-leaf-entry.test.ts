import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	emitProgramImage,
	emitProgramTranslationUnits,
} from "../../src/compiler/target/emit-program-image.ts";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";
import { buildLocalBinary } from "../../src/local-build.ts";
import {
	buildNativeBinaryResult,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

// The smallest unit budget that leaves some function interpreted while a leaf call stays compiled.
function mixedLeafUnits(image: ProgramImage) {
	for (let limit = 8192; limit <= 65536; limit *= 2) {
		let units: ReturnType<typeof emitProgramTranslationUnits>;
		try {
			units = emitProgramTranslationUnits(
				image,
				{ compiled: true, debugInfo: false },
				{ targetCodeUnits: limit, hardMaximumCodeUnits: limit },
			);
		} catch (error) {
			if (error instanceof RangeError) continue;
			throw error;
		}
		const text = units.map((unit) => unit.source).join("\n");
		if (
			/mal_function_\d+_instructions\b/.test(text) &&
			text.includes("mal_vm_enter_leaf_checked")
		)
			return units;
	}
	throw new Error("No unit budget mixes interpreted functions with a compiled leaf call");
}

describe("checked numeric leaf activation", () => {
	it("selects checked leaf calls, balances trace rows, and rejects depth and current-stack limits inside large caller frames", () => {
		const outDir = mkdtempSync(join(tmpdir(), "mal-checked-leaf-"));
		for (const profileEnabled of [false, true]) {
			const built = buildNativeBinaryResult({
				fixture: "tests/local/checked-leaf-entry.js",
				name: `leaf-observed-${profileEnabled}`,
				mainFile: "runtime/leaf_entry_test_main.c",
				profileEnabled,
				outDir,
			});
			const source = emitProgramImage(built.programImage, {
				compiled: true,
				debugInfo: false,
			});
			expect(source).toContain("mal_vm_enter_leaf_checked");
			expect(runToStdout(built.binaryPath, { env: STRESS_ENV })).toBe(
				"checked-leaf-fixture PASS\nchecked-leaf-entry PASS\n",
			);
			if (profileEnabled) continue;
			const mixedSource = mixedLeafUnits(built.programImage);
			const mixed = buildLocalBinary({
				context: built.context,
				name: "leaf-mixed",
				cSource: mixedSource,
				verbose: false,
				outDir,
				mainFile: "runtime/leaf_entry_test_main.c",
			});
			expect(runToStdout(mixed.binaryPath, { env: STRESS_ENV })).toBe(
				"checked-leaf-fixture PASS\nchecked-leaf-entry PASS\n",
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
				"checked-leaf-fixture PASS\nchecked-leaf-entry PASS\n",
			);
		}
	}, 600_000);
});
