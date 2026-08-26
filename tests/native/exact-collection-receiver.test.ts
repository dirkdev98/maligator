import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/exact-collection-receiver.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-exact-collection-receiver-"));

describe("exact collection receiver brands", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "exact-collection-receiver",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "locked" } }),
		});
		compiled = pair.compiled;
		interpreted = pair.interpreted;
	}, 600_000);

	it("preserves private, global, shadowed, and cross-brand behavior", () => {
		for (const binary of [compiled, interpreted]) {
			assertExactLines(runToStdout(binary), ["exact-collection-receiver PASS"]);
		}
	});

	it("keeps collection contents alive under GC stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), [
			"exact-collection-receiver PASS",
		]);
	});
});
