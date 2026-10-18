import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/private-shape-slots.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-private-shape-slots-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("private elements in shape slots", () => {
	it.each([true, false])(
		"hide from reflection and survive integrity and representation changes (compiled: %s)",
		(compiled) => {
			const binary = buildNativeBinary({
				fixture,
				name: `private-shape-slots-${compiled ? "c" : "i"}`,
				compiled,
				mainFile: HOST_MAIN,
				outDir,
			});
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
		},
		600000,
	);
});
