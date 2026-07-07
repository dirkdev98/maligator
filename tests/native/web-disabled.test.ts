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
// web-off archive: `-DMAL_WEB_PLATFORM=0` compiles url.c away and the Rust crate is
// built without the `web-platform` feature, so the ada C++ parser AND the `-lc++`
// link are dropped. That this binary LINKS at all — with the URL install gated out
// of host_main and no `mal_url_*` symbols in the archive — is the core assertion.
// This lane does NOT skipRuntimeBuild — the web-off archive is not the one
// globalSetup prebuilt, so it builds its own under a `-<hash>` suffixed dir.
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

	it("drops the ada URL parser (smaller than the web-on binary)", () => {
		const webOnBin = buildNativeBinary({
			fixture: "tests/local/web_disabled.js",
			name: "web-enabled",
			mainFile: HOST_MAIN,
			outDir,
			skipRuntimeBuild: true, // web-on archive was prebuilt by globalSetup
		});
		const offSize = statSync(webOffBin).size;
		const onSize = statSync(webOnBin).size;
		// ada (C++ URL parser) + url.c measure ~0.5 MB; allow generous slack.
		expect(onSize - offSize).toBeGreaterThan(300_000);
	});
});
