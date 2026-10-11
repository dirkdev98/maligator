import { mkdtempSync, rmSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MaligatorIntlFeature } from "../../src/public-api.d.ts";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-intl-feat-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
const CORE = [
	"collator",
	"number-format",
	"date-time-format",
	"plural-rules",
	"list-format",
] satisfies Array<MaligatorIntlFeature>;

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

	it("builds Segmenter without unrelated Intl services", () => {
		const segmenterBin = buildNativeBinary({
			fixture: "tests/local/intl_segmenter_only.js",
			name: "intl-segmenter-only",
			mainFile: HOST_MAIN,
			outDir,
			intlFeatures: ["segmenter"],
		});
		assertResultPass(runToStdout(segmenterBin));
	});
	describe.each(["relative-time-format", "duration-format"] as const)(
		"only %s enabled",
		(feature) => {
			let binary: string;
			beforeAll(() => {
				binary = buildNativeBinary({
					fixture: "tests/local/intl_isolated_parts.mjs",
					name: `intl-isolated-${feature}`,
					mainFile: HOST_MAIN,
					outDir,
					intlFeatures: [feature],
				});
			}, 600_000);
			it("formats parts", () => {
				assertResultPass(runToStdout(binary));
			});
			it("formats parts under GC stress", () => {
				assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
			});
		},
	);
});
