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
import { preparedNativeEvalConfig } from "../helpers/native-eval-config.ts";
import { matchingNativeSymbols } from "../helpers/native-symbols.ts";

// Linking HOST_MAIN with web and Node disabled must not retain ada or its C++ dependency.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-web-off-"));

describe("surface.webPlatform: false runtime gate", () => {
	let webOffBin: string;
	beforeAll(() => {
		webOffBin = buildNativeBinary({
			fixture: "tests/local/web_disabled.js",
			name: "web-disabled",
			mainFile: HOST_MAIN,
			outDir,
			config: preparedNativeEvalConfig({ webPlatform: false }),
		});
	});

	it("links with ada gone and installs no URL / URLSearchParams globals", () => {
		assertResultPass(runToStdout(webOffBin));
	});

	it("still holds under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(webOffBin, { env: STRESS_ENV }));
	});

	it("does not retain the host entropy archive member", async () => {
		expect(
			await matchingNativeSymbols(webOffBin, (symbol) =>
				symbol.includes("mal_host_entropy"),
			),
		).toEqual([]);
	});

	it("drops the ada URL parser (smaller than the web-on binary)", () => {
		const webOnBin = buildNativeBinary({
			fixture: "tests/local/web_disabled.js",
			name: "web-enabled",
			mainFile: HOST_MAIN,
			outDir,
		});
		const offSize = statSync(webOffBin).size;
		const onSize = statSync(webOnBin).size;
		// ada (C++ URL parser) + web_url.c measure ~0.5 MB; allow generous slack.
		expect(onSize - offSize).toBeGreaterThan(300_000);
	});
});
