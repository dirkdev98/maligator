import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

describe("number-to-uint32 conversion boundaries", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	])(
		"preserves truncation and modulo semantics in %s mode",
		(_name, compiled) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-uint32-boundaries-"));
			try {
				const binary = buildNativeBinary({
					fixture: "tests/local/number-to-uint32-boundaries.js",
					name: `number-to-uint32-boundaries-${compiled ? "compiled" : "interpreted"}`,
					outDir,
					compiled,
				});
				assertResultPass(runToStdout(binary));
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		300_000,
	);
});
