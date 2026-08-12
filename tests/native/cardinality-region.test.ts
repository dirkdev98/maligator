import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/cardinality-region.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-cardinality-region-"));

describe("native cardinality-only array regions", () => {
	let compiled: string;
	let concurrent: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture,
			name: "cardinality-region",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "cardinality-region-ni",
			compiled: false,
			outDir,
		});
		concurrent = buildNativeBinary({
			fixture,
			name: "cardinality-region-concurrent",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_GC_CONCURRENT: "1" },
		});
	}, 600_000);

	it("preserves fast execution and materializing mutation fallbacks", () => {
		assertPassLine(runToStdout(compiled), "cardinality-region");
	});

	it("keeps virtual history and materialized rows rooted under GC stress", () => {
		assertPassLine(
			runToStdout(compiled, { env: STRESS_ENV, timeoutMs: 60_000 }),
			"cardinality-region",
		);
	});

	it("retains interpreter parity without native proof metadata", () => {
		assertPassLine(runToStdout(interpreted), "cardinality-region");
	});

	it("publishes root-history writes safely under concurrent verified GC", () => {
		assertPassLine(
			runToStdout(concurrent, {
				env: { ...STRESS_ENV, MAL_GC_CONCURRENT: "1" },
				timeoutMs: 60_000,
			}),
			"cardinality-region",
		);
	});
});
