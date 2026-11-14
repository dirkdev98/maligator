import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/fixed-typed-array-integer-products.js";
const loopKernels = [
	...readFileSync(fixture, "utf8").matchAll(
		/^function (\w*(?:Products|Stores|Input|Integers))\(/gm,
	),
].map(([, name]) => name!);
const outDir = mkdtempSync(join(tmpdir(), "mal-integer-products-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
const behaviors = [
	["negativeZero", "preserves the sign of zero products after repeated region entry"],
	["unsafe", "rounds products outside the safe integer range as doubles"],
	["modular", "stores negative safe integers modulo each integer element width"],
	["clamped", "clamps integral stores to the Uint8Clamped range"],
	["carried", "carries an outer integer counter through the product chain"],
	["fractional", "keeps fractional invariant inputs as doubles"],
	["dataView", "stores integral DataView values at either byte order"],
] as const;

describe.each(["mutable", "locked"] as const)(
	"integer products in fixed numeric regions with %s primordials",
	(primordials) => {
		let expected: Record<string, unknown>;
		let actual: Array<Record<string, unknown>>;
		let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
		beforeAll(() => {
			expected = JSON.parse(
				execFileSync(process.execPath, [fixture], { encoding: "utf8" }),
			) as Record<string, unknown>;
			pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `integer-products-${primordials}`,
				outDir,
				config: resolveBuildConfig({ engine: { primordials } }),
			});
			actual = [
				JSON.parse(runToStdout(pair.compiled)) as Record<string, unknown>,
				JSON.parse(runToStdout(pair.interpreted)) as Record<string, unknown>,
				JSON.parse(runToStdout(pair.compiled, { env: STRESS_ENV })) as Record<
					string,
					unknown
				>,
			];
		}, 300_000);

		it("selects fixed numeric regions for the conversion and fallback kernels", () => {
			expect(loopKernels.length).toBeGreaterThan(0);
			for (const name of loopKernels) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				);
				expect(
					fn?.storage?.numericLoopRegions.some(
						(region) => region.kind === "fixed-numeric",
					),
					name,
				).toBe(true);
			}
		});

		it.each(behaviors)("%s: %s", (key) => {
			for (const output of actual) expect(output[key]).toEqual(expected[key]);
		});
	},
);
