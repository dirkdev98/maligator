import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-runtime-mechanics-"));

describe("shared runtime mechanics", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/local/runtime-mechanics.mjs",
				name: `runtime-mechanics-${compiled ? "compiled" : "interpreted"}`,
				outDir,
				nodeEnabled: true,
				webPlatformEnabled: false,
				compiled,
			}),
		);
	}, 600_000);

	it("preserves key, accessor, and Node export behavior", () => {
		for (const binary of binaries) assertResultPass(runToStdout(binary));
	});

	it("keeps accessor functions alive under GC stress", () => {
		for (const binary of binaries) {
			assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
		}
	});
});
