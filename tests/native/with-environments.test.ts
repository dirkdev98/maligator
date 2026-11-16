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

const fixture = "tests/local/with-environments.cjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-with-environments-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("with environment entry and abrupt lookup", () => {
	let expected: Record<string, unknown>;
	const outputs: Array<Record<string, unknown>> = [];
	beforeAll(() => {
		expected = JSON.parse(
			execFileSync(process.execPath, [fixture], { encoding: "utf8" }),
		) as Record<string, unknown>;
		for (const nativeStackRoots of ["conservative", "precise"] as const) {
			const binaries = buildBackendPairFromOneProgramImage({
				nativeStackRoots,
				fixture,
				name: "with-environments",
				outDir,
				entryGoal: "script",
				entryStrict: false,
				config: resolveBuildConfig({
					engine: {
						primordials: "mutable",
						eval: false,
						realms: false,
						intl: { enabled: false },
					},
				}),
			});
			const sanitized = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
				(key) => process.env[key] === "1",
			);
			for (const binary of [binaries.compiled, binaries.interpreted])
				for (const env of sanitized ? [{}] : [{}, STRESS_ENV])
					outputs.push(
						JSON.parse(runToStdout(binary, { env })) as Record<string, unknown>,
					);
		}
	});
	it("retains the original object across lookups and escaped closures", () => {
		for (const output of outputs) expect(output.object).toEqual(expected.object);
	});
	it.each(["string", "number", "boolean", "symbol", "bigint"])(
		"retains one %s wrapper per entry across calls and escaped closures",
		(kind) => {
			for (const output of outputs) expect(output[kind]).toEqual(expected[kind]);
		},
	);
	it("boxes String properties before resolving names", () => {
		for (const output of outputs)
			expect(output.stringProperties).toEqual(expected.stringProperties);
	});
	it("rejects null and undefined before entering the body", () => {
		for (const output of outputs) expect(output.nil).toEqual(expected.nil);
	});
	it.each(
		["has", "unscopables", "blockedName"].flatMap((kind) =>
			["write", "update", "loop", "call", "read"].map(
				(operation) => `${kind}-${operation}`,
			),
		),
	)("preserves the throw and leaves binding data unchanged after %s", (key) => {
		for (const output of outputs) expect(output[key]).toEqual(expected[key]);
	});
});
