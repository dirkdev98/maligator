import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-language-components-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it("installs both engines before runtime-compiled code can use them", () => {
	const fixture = path.join(outDir, "dynamic.mjs");
	writeFileSync(
		fixture,
		`console.log(new Function('return "abc".match("b")[0] + "e\\\\u0301".normalize()')());`,
	);
	const binaries = buildBackendPairFromOneProgramImage({
		fixture,
		name: "dynamic-language-components",
		outDir,
		config: resolveBuildConfig({ engine: { eval: true } }),
	});
	for (const backend of [binaries.compiled, binaries.interpreted]) {
		expect(runToStdout(backend)).toBe("bé\n");
	}
});
