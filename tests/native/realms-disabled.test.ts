import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

// The runtime half of `engine.realms: false` (the compile-time / cache-suffix half
// is covered by tests/build-config.test.ts). Passing realmsEnabled:false routes the
// build through the same plumbing the CLI uses — resolveBuildConfig sets
// engine.realms:false, buildConfigCacheSuffix then returns a non-empty hash, so the
// realms-off C archive lands in its own `-<hash>` suffixed dir (the Rust cache suffix
// ignores realms, so the canonical ICU/regress/ada archive is reused). That this
// binary LINKS at all with `-DMAL_REALMS=0` — the Realm surface compiled away, the
// host entry's realm install gated out, no dangling `mal_realm_*` symbols — is the
// core assertion. The test also proves core intrinsics run on the selected
// realms-off artifacts via an existing generic Array-intrinsics fixture.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-realms-off-"));
const cleanFixture = path.join(outDir, "default-driver-clean.js");
writeFileSync(
	cleanFixture,
	`if (typeof globalThis.$262 !== "undefined") {
	throw new Error("ordinary default driver exposed $262");
}
console.log("default-driver-clean PASS 1/1");
`,
);

describe("engine.realms: false runtime gate", () => {
	let realmsOffHostBin: string;
	let realmsOffDefaultBin: string;
	let realmsOnDefaultBin: string;
	beforeAll(() => {
		realmsOffHostBin = buildNativeBinary({
			fixture: "tests/local/array-to-object.js",
			name: "realms-disabled-host",
			mainFile: HOST_MAIN,
			outDir,
			realmsEnabled: false,
		});
		realmsOffDefaultBin = buildNativeBinary({
			fixture: "tests/local/array-to-object.js",
			name: "realms-disabled-default",
			outDir,
			realmsEnabled: false,
		});
		realmsOnDefaultBin = buildNativeBinary({
			fixture: cleanFixture,
			name: "realms-enabled-default",
			outDir,
			realmsEnabled: true,
		});
	});

	it("links with the Realm surface gone; core intrinsics still run", () => {
		assertPassLine(runToStdout(realmsOffHostBin), "array-to-object");
	});

	it("still holds under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertPassLine(runToStdout(realmsOffHostBin, { env: STRESS_ENV }), "array-to-object");
	});

	it("links and runs through the default driver", () => {
		assertPassLine(runToStdout(realmsOffDefaultBin), "array-to-object");
	});

	it("does not install $262 in an ordinary realms-on default-driver build", () => {
		assertPassLine(runToStdout(realmsOnDefaultBin), "default-driver-clean");
	});
});
