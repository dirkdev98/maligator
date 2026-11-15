import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/commonjs-mapped-arguments.cjs";
const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" })
	.trimEnd()
	.split("\n");

describe.each(["mutable", "locked"] as const)(
	"CommonJS mapped arguments with %s primordials",
	(primordials) => {
		const outDir = mkdtempSync(join(tmpdir(), "mal-commonjs-mapped-arguments-"));
		const outputs = new Map<string, { normal: Array<string>; stress: Array<string> }>();
		beforeAll(() => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `commonjs-mapped-arguments-${primordials}`,
				outDir,
				config: resolveBuildConfig({ engine: { primordials } }),
			});
			for (const backend of ["compiled", "interpreted"] as const) {
				outputs.set(backend, {
					normal: runToStdout(pair[backend]).trimEnd().split("\n"),
					stress: runToStdout(pair[backend], { env: STRESS_ENV }).trimEnd().split("\n"),
				});
			}
		});
		afterAll(() => rmSync(outDir, { recursive: true, force: true }));

		describe.each(["compiled", "interpreted"] as const)("%s backend", (backend) => {
			it.each(expected)("matches Node for %s with and without GC stress", (line) => {
				expect(outputs.get(backend)?.normal).toContain(line);
				expect(outputs.get(backend)?.stress).toContain(line);
			});
		});
	},
);
