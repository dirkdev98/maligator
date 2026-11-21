import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

const fixture = "tests/local/interpreter-number-fast-paths.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-interpreter-number-fast-paths-"));

describe("interpreter number fast paths", () => {
	let expected: string;
	const binaries = new Map<string, string>();

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf-8" });
		const worlds = {
			locked: resolveBuildConfig({}),
			open: resolveBuildConfig({
				engine: { primordials: "mutable", eval: true, realms: true },
			}),
		};
		for (const [world, config] of Object.entries(worlds)) {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `interpreter-number-fast-paths-${world}`,
				outDir,
				config,
			});
			binaries.set(`${world} compiled`, pair.compiled);
			binaries.set(`${world} interpreted`, pair.interpreted);
		}
	}, 1_200_000);

	it("matches Node for unary, Math, DataView and typed-array length operands and their fallbacks", () => {
		for (const [label, binary] of binaries) {
			expect(runToStdout(binary), label).toBe(expected);
		}
	});
});
