import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-authority-regions-"));
const lockedConfig = resolveBuildConfig({
	engine: { primordials: "locked", eval: true, realms: true, regexp: true },
});
const mutableConfig = resolveBuildConfig({
	engine: { primordials: "mutable", eval: true, realms: true, regexp: true },
});

describe("Core-owned guarded-region authority decisions", () => {
	const binaries: Array<string> = [];

	beforeAll(() => {
		for (const [policy, config] of [
			["locked", lockedConfig],
			["mutable", mutableConfig],
		] as const) {
			for (const compiled of [true, false]) {
				binaries.push(
					buildNativeBinary({
						fixture: "tests/local/authority-region-decisions.js",
						name: `authority-region-decisions-${policy}-${compiled ? "compiled" : "interpreted"}`,
						compiled,
						outDir,
						config,
					}),
				);
			}
		}
	});

	it("preserves locked, mutable, eval, and cross-Realm behavior", () => {
		for (const binary of binaries) assertResultPass(runToStdout(binary));
	});
});
