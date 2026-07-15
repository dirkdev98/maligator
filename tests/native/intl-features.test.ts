import { mkdtempSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

// engine.intl.features (per-service selection). Builds a "core" subset — collator,
// number-format, date-time-format, plural-rules, list-format — dropping the heavy
// Segmenter (LSTM, ~12 MB) and the experimental trio. Asserts the selected services
// localize, the dropped ones are absent, and the subset binary is much smaller.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-intl-feat-"));
const CORE = [
	"collator",
	"number-format",
	"date-time-format",
	"plural-rules",
	"list-format",
];

describe("engine.intl.features (service subset)", () => {
	let subsetBin: string;
	beforeAll(() => {
		subsetBin = buildNativeBinary({
			fixture: "tests/local/intl_features_subset.js",
			name: "intl-features-subset",
			mainFile: HOST_MAIN,
			outDir,
			intlFeatures: CORE,
		});
	});

	it("selected services localize; dropped services are absent", () => {
		assertResultPass(runToStdout(subsetBin));
	});

	it("holds under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(subsetBin, { env: STRESS_ENV }));
	});

	it("dropping Segmenter + experimental trio is much smaller than full Intl", () => {
		const fullBin = buildNativeBinary({
			fixture: "tests/local/intl_features_subset.js",
			name: "intl-features-full",
			mainFile: HOST_MAIN,
			outDir,
		});
		const subsetSize = statSync(subsetBin).size;
		const fullSize = statSync(fullBin).size;
		// Segmenter's LSTM data alone is ~12 MB; allow generous slack.
		expect(fullSize - subsetSize).toBeGreaterThan(4_000_000);
	});
});
