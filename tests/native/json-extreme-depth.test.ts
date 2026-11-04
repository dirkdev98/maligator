import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	resolveHarnessExecutionInvocation,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(tmpdir(), "mal-json-extreme-"));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
beforeAll(() => {
	pair = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/json-extreme-depth.mjs",
		name: "json-extreme-depth",
		outDir,
		config: resolveBuildConfig({
			engine: { eval: false, realms: false, regexp: false, intl: { enabled: false } },
			surface: { node: true, webPlatform: false },
		}),
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it.each(["array", "object"])("parses 100,000 nested %s containers", (shape) => {
	check("parse", shape);
});
it.each(["array", "object"])(
	"revives 100,000 nested %s containers with source contexts",
	(shape) => {
		check("reviver", shape);
	},
);
it.each(["array", "object"])("serializes 100,000 nested %s containers", (shape) => {
	check("stringify", shape);
});
it.each(["array", "object"])(
	"visits 100,000 nested %s containers through a replacer",
	(shape) => {
		check("replacer", shape);
	},
);

function check(mode: string, shape: string): void {
	for (const binary of [pair.compiled, pair.interpreted]) {
		const invocation = resolveHarnessExecutionInvocation(binary);
		expect(
			execFileSync(invocation.executable, [...invocation.args, mode, shape], {
				encoding: "utf8",
				env: { ...process.env, MAL_GC_VERIFY: "1" },
				timeout: 30_000,
			}),
		).toBe(`${mode} ${shape} 100000 PASS\n`);
	}
}
