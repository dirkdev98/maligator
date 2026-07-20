import { execFileSync } from "node:child_process";
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

// The runtime half of `surface.webPlatform: false` (the cache-suffix / derivation
// half is covered by tests/build-config.test.ts). Builds the host entry into the
// web-off archive: `-DMAL_WEB_PLATFORM=0` compiles web_url.c away and the Rust crate is
// built without the `web-platform` feature, so the ada C++ parser AND the `-lc++`
// link are dropped. That this binary LINKS at all — with the URL install gated out
// of host_main and no `mal_url_*` symbols in the archive — is the core assertion.
// The web-off build selects its own content-addressed artifacts.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-web-off-"));

describe("surface.webPlatform: false runtime gate", () => {
	let webOffBin: string;
	beforeAll(() => {
		webOffBin = buildNativeBinary({
			fixture: "tests/local/web_disabled.js",
			name: "web-disabled",
			mainFile: HOST_MAIN,
			outDir,
			webPlatformEnabled: false,
		});
	});

	it("links with ada gone and installs no URL / URLSearchParams globals", () => {
		assertResultPass(runToStdout(webOffBin));
	});

	it("still holds under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(webOffBin, { env: STRESS_ENV }));
	});

	it("does not retain the host entropy archive member", () => {
		const symbols = execFileSync("nm", ["-g", webOffBin], { encoding: "utf-8" });
		expect(symbols).not.toContain("mal_host_entropy");
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
