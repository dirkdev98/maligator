import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildBackendPairFromOneProgramImage,
	resolveHarnessExecutionInvocation,
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
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

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
			nativeStackRoots: "precise",
			config: resolveBuildConfig({}),
		});
		({ compiled, interpreted } = pair);
		const directKinds = new Set<string>();
		const boundedLoadKinds = new Set<string>();
		pair.programImage.native.functions.forEach((plan, index) => {
			// Native plan IPs address the native body, which can diverge from the runtime bytecode.
			for (const [ip, instruction] of plan.body.instructions.entries()) {
				const access = plan.instructions[ip];
				if (
					instruction.opcode === "LOAD_PROPERTY" &&
					access?.kind === "contained-fixed-typed-array-element" &&
					access.inBounds
				) {
					boundedLoadKinds.add(access.elementKind);
					expect(plan.registerRepresentations[instruction.dst]).toBe("number");
				}
			}
			const stores = plan.body.instructions.flatMap((instruction, ip) => {
				const native = plan.instructions[ip];
				return instruction.opcode === "STORE_PROPERTY" &&
					native?.kind === "contained-fixed-typed-array-element"
					? [native.elementKind]
					: [];
			});
			if (stores.length === 0) return;
			const emitted = emitCompiledFunction(plan, index, "", false);
			expect(emitted).not.toBeNull();
			expect(emitted!.source).toContain("mal_scalar_store_native_");
			for (const kind of stores) directKinds.add(kind);
		});
		expect([...directKinds].sort()).toEqual(kinds.toSorted());
		expect([...boundedLoadKinds].sort()).toEqual(kinds.toSorted());
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

describe("contained numeric TypedArrays in fixed storage regions", () => {
	const regionFixture = path.join(outDir, "regions.js");
	// The perf-stats runtime counts admitted region views per element kind.
	const statsViews: Record<string, string> = {
		Int8Array: "i8_views",
		Uint8Array: "u8_views",
		Uint8ClampedArray: "u8c_views",
		Int16Array: "i16_views",
		Uint16Array: "u16_views",
		Int32Array: "i32_views",
		Uint32Array: "u32_views",
		Float32Array: "f32_views",
		Float64Array: "f64_views",
	};
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let expected: string;

	beforeAll(() => {
		writeFileSync(
			regionFixture,
			kinds
				.map(
					(kind) => `
			function region${kind}(seed) {
				const values = new ${kind}(64);
				const weights = new Float64Array(64);
				for (let index = 0; index < values.length; index++) {
					values[index] = seed - index * 7.25;
					weights[index] = values[index] * 0.25 + index;
				}
				let sum = 0;
				for (let index = 0; index < values.length; index++)
					sum += values[index] + Math.trunc(weights[index]);
				return [sum,
					Object.is(values[0], -0) ? "-0" : String(values[0]),
					Object.is(weights[0], -0) ? "-0" : String(weights[0])].join(":");
			}
			console.log("${kind}", region${kind}(255.5), region${kind}(-1e12), region${kind}(4294967296.5));
			console.log("${kind}-rounding", region${kind}(1 + 2 ** -24), region${kind}(3 * 2 ** -150), region${kind}(-0), region${kind}(NaN), region${kind}(Infinity));
		`,
				)
				.join("\n"),
		);
		expected = execFileSync(process.execPath, [regionFixture], { encoding: "utf8" });
		pair = buildBackendPairFromOneProgramImage({
			fixture: regionFixture,
			name: "contained-typed-regions",
			outDir,
			config: resolveBuildConfig({}),
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	});

	it("claims contained accesses of every element kind", () => {
		const regionKinds = new Set<string>();
		for (const plan of pair.programImage.native.functions) {
			const claimed = new Set(
				plan.storage?.numericLoopRegions.flatMap((region) =>
					region.kind === "fixed-numeric" ? region.claimedIps : [],
				),
			);
			for (const [ip, access] of plan.instructions.entries())
				if (access?.kind === "contained-fixed-typed-array-element" && claimed.has(ip))
					regionKinds.add(access.elementKind);
		}
		expect([...regionKinds].sort()).toEqual(kinds.toSorted());
	});

	it("admits contained views of every element kind", () => {
		const invocation = resolveHarnessExecutionInvocation(pair.compiled);
		const run = spawnSync(invocation.executable, invocation.args, {
			encoding: "utf8",
			timeout: 60000,
			env: { ...process.env, MAL_PERF_STATS: "1" },
		});
		expect(run.status, run.stderr).toBe(0);
		const stats = run.stderr.match(/\[perf-typed-array-region-stats\][^\n]*/)?.[0] ?? "";
		for (const kind of kinds) {
			const views = stats.match(new RegExp(`\\b${statsViews[kind]}=(\\d+)`))?.[1];
			expect(Number(views ?? 0), kind).toBeGreaterThan(0);
		}
	});

	it("matches Node for every element kind", () => {
		for (const binary of [pair.compiled, pair.interpreted])
			expect(runToStdout(binary)).toBe(expected);
	});

	it("matches Node across GC stress", () => {
		expect(runToStdout(pair.compiled, { env: { MAL_HOST_GC: "1", ...STRESS_ENV } })).toBe(
			expected,
		);
	});
});
