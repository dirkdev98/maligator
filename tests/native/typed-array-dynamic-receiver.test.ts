import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/typed-array-dynamic-receiver.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-typed-array-dynamic-receiver-"));

describe("typed array reads through receivers of unproven kind", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "typed-array-dynamic-receiver",
			outDir,
			// The fixture shadows an index on Int32Array.prototype.
			config: resolveBuildConfig({ engine: { primordials: "mutable" } }),
		}));
	}, 600_000);

	it("matches Node for every kind, offset, bound, resize, and detachment", () => {
		for (const binary of [compiled, interpreted])
			expect(runToStdout(binary)).toBe(expected);
	});

	it("keeps the reads correct under GC stress", () => {
		expect(runToStdout(compiled, { env: { MAL_HOST_GC: "1", ...STRESS_ENV } })).toBe(
			expected,
		);
	});
});
