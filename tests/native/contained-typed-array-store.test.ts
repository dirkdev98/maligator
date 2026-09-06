import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const kinds = [
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"Float32Array",
	"Float64Array",
];
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-contained-typed-store-"));
const fixture = path.join(outDir, "stores.js");

describe("contained numeric TypedArray stores", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;

	beforeAll(() => {
		writeFileSync(
			fixture,
			kinds
				.map(
					(kind) => `
			function probe${kind}() {
				const values = new ${kind}(8);
				const output = [];
				for (let phase = 0; phase < 5; phase++) {
					for (let index = -2; index < 10; index++) {
						let value = index * 7919.5 - 31;
						if (phase === 1) value = index * 1099511627776 + 0.75;
						if (phase === 2) value = (index - 4) / 0;
						if (phase === 3) value = -(index % 2) * 0;
						if (phase === 4) value = index === 7 ? 254.5 : index + 0.5;
						values[index] = value;
					}
					values[phase + 0.5] = phase;
					values[phase + 20] = phase;
					for (let index = 0; index < values.length; index++) {
						const value = values[index];
						output.push(Object.is(value, -0) ? "-0" : String(value));
					}
				}
				return output;
			}
			console.log("${kind}", JSON.stringify(probe${kind}()));
		`,
				)
				.join("\n"),
		);
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "contained-typed-stores",
			outDir,
			config: resolveBuildConfig({}),
		});
		({ compiled, interpreted } = pair);
		const directKinds = new Set<string>();
		pair.programImage.runtime.functions.forEach((fn, index) => {
			const plan = pair.programImage.native.functions[index]!;
			const stores = fn.instructions.flatMap((instruction, ip) => {
				const native = plan.instructions[ip];
				return instruction.opcode === "STORE_PROPERTY" &&
					native?.kind === "contained-fixed-typed-array-element"
					? [native.elementKind]
					: [];
			});
			if (stores.length === 0) return;
			const emitted = emitCompiledFunction(fn, plan, index, "", false);
			expect(emitted).not.toBeNull();
			expect(emitted!.source).toContain("mal_scalar_store_native_");
			for (const kind of stores) directKinds.add(kind);
		});
		expect([...directKinds].sort()).toEqual(kinds.toSorted());
	});

	it("matches Node for wrapping, fractions, non-finite values, signed zero, and bounds", () => {
		for (const binary of [compiled, interpreted])
			expect(runToStdout(binary)).toBe(expected);
	});

	it("preserves numeric storage across GC stress", () => {
		expect(runToStdout(compiled, { env: { MAL_HOST_GC: "1", ...STRESS_ENV } })).toBe(
			expected,
		);
	});
});
