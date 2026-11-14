import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/array-iteration-branching.mjs";
const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" }).trim();

describe.each(["mutable", "locked"] as const)(
	"branching Array iteration callbacks with %s primordials",
	(primordials) => {
		let outputs: Array<string>;
		beforeAll(() => {
			const outDir = mkdtempSync(join(tmpdir(), "mal-array-iteration-branching-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: `array-iteration-branching-${primordials}`,
					outDir,
					config: resolveBuildConfig({ engine: { primordials, eval: false } }),
				});
				outputs = [pair.compiled, pair.interpreted].flatMap((binary) => [
					runToStdout(binary).trim(),
					runToStdout(binary, { env: STRESS_ENV }).trim(),
				]);
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		});

		it.each([
			["copied", "iterates a private default-species copy"],
			["species", "calls a method installed by a custom species"],
			["exposed", "observes an override on an exposed copy"],
			["bindings", "writes outer bindings and reassigns callback parameters"],
			["branches", "preserves each type-dependent callback branch"],
			["early", "stops after the first matching element"],
			["throw", "preserves captured writes when the callback throws"],
			["mutation", "observes deletions and replacements within the original length"],
			["holes", "skips absent indices"],
			["patched", "honors the primordial method policy"],
		])("%s: %s", (label) => {
			const line = (output: string) =>
				output.split("\n").find((value) => value.startsWith(`${label} `));
			const expectedLine =
				primordials === "locked" && label === "patched"
					? "patched locked"
					: line(expected);
			expect(expectedLine).toBeDefined();
			for (const output of outputs) expect(line(output)).toBe(expectedLine);
		});
	},
);
