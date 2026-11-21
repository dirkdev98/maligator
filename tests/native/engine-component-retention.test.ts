import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-engine-components-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it("installs the Intl services and Temporal that locale and Date methods reach", () => {
	const fixture = path.join(outDir, "methods.mjs");
	writeFileSync(
		fixture,
		[
			`console.log((1234.5).toLocaleString("de-DE"));`,
			`console.log(["z", "\\u00e4"].sort((a, b) => a.localeCompare(b, "de")).join(""));`,
			`console.log("i".toLocaleUpperCase("tr") === "\\u0130");`,
			`console.log(new Date(0).toTemporalInstant().epochMilliseconds);`,
		].join("\n"),
	);
	const binaries = buildBackendPairFromOneProgramImage({
		fixture,
		name: "engine-component-methods",
		outDir,
		config: resolveBuildConfig({ engine: { temporal: true, intl: { enabled: true } } }),
	});
	for (const backend of [binaries.compiled, binaries.interpreted]) {
		expect(runToStdout(backend)).toBe("1.234,5\näz\ntrue\n0\n");
	}
});
