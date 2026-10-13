import { beforeAll, describe, expect, it } from "vitest";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import { privateRootRegisters } from "../helpers/native-c-source.ts";

const kernels = [
	{ name: "readTaggedFields", fields: ["kind", "left", "right", "value", "label"] },
	{ name: "readEight", fields: ["a", "b", "c", "d", "e", "f", "g", "h"] },
	{ name: "readHandlerBoundary", fields: ["first", "middle", "last", "tail"] },
	...[
		"readThree",
		"readDetachedOwn",
		"readThreeInTry",
		"readMixed",
		"readSameShape",
		"readInheritedMutation",
		"readPrototypeMutation",
		"readAccessorMutation",
		"readStorageMutation",
		"readProxy",
		"readGuardFallback",
		"readInheritedStorageMutation",
		"readPublicOverflowShadow",
	].map((name) => ({ name, fields: ["first", "middle", "last"] })),
];
const expected = ["native-property-read-regions PASS"];
const hostGc = { MAL_HOST_GC: "1" };
const verificationEnv = {
	...hostGc,
	// Reentrant edges force collection even when sanitizer instrumentation is active.
	...(process.env.MAL_ASAN === "1" || process.env.MAL_UBSAN === "1"
		? { MAL_GC_VERIFY: "1" }
		: STRESS_ENV),
};

describe("native property read region continuations", () => {
	let compiled: string;
	let interpreted: string;
	let wideRootCount = 0;
	let wideRegionSource = "";
	const emittedKernels = new Map<
		string,
		{ source: string; admissions: number; loads: number }
	>();

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/native-property-read-regions.js",
			name: "native-property-read-regions",
		});
		({ compiled, interpreted } = pair);
		const image = pair.programImage;
		for (const [index, fn] of image.runtime.functions.entries()) {
			const name = String.fromCharCode(
				...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
			);
			if (name === "readTagged")
				expect(image.native.functions[index]!.storage!.propertyReadRegions).toHaveLength(
					0,
				);
			if (name === "readWideJoin") {
				const native = image.native.functions[index]!;
				wideRootCount = Math.max(
					...native.gc.safepoints.map((point) => point.rootRegisters.length),
				);
				wideRegionSource = emitCompiledFunction(native, index, "", false)?.source ?? "";
			}
			const kernel = kernels.find((kernel) => kernel.name === name);
			if (kernel === undefined) continue;
			const output = emitCompiledFunction(
				image.native.functions[index]!,
				index,
				"",
				false,
			)?.source;
			expect(output).toBeDefined();
			const native = image.native.functions[index]!;
			const plans = native.storage!.propertyReadRegions;
			const plan = plans.find((region) => {
				const fields = region.loads.map(({ ip }) => {
					const load = native.body.instructions[ip]!;
					if (load.opcode !== "LOAD_PROPERTY_STATIC")
						throw new Error("Invalid property region load");
					return String.fromCharCode(...image.runtime.stringConstants[load.stringIndex]!);
				});
				return kernel.fields.every((field) => fields.includes(field));
			});
			expect(plan).toBeDefined();
			expect(plan!.continuation).toBe("remaining-instructions");
			emittedKernels.set(name, {
				source: output!,
				admissions: plans.length,
				loads: plans.reduce((count, region) => count + region.loads.length, 0),
			});
		}
	}, 600_000);

	it.each(kernels)("emits the admitted field reads for $name", ({ name }) => {
		const output = emittedKernels.get(name);
		expect(output).toBeDefined();
		expect(output!.source.match(/mal_vm_property_read_region_begin\(/g)).toHaveLength(
			output!.admissions,
		);
		expect(output!.source.match(/mal_vm_property_read_region_try_load\(/g)).toHaveLength(
			output!.loads,
		);
	});

	it("keeps wide private roots native through a region continuation", () => {
		expect(wideRootCount).toBeGreaterThan(64);
		expect(wideRegionSource).toContain("mal_vm_property_read_region_begin(");
		expect(wideRegionSource).toContain("mal_vm_property_read_region_try_load(");
		const privateWideSlots = new Set(
			[...wideRegionSource.matchAll(/__gc_slots\[(\d+)\] = r(\d+);/g)]
				.filter(
					([, slot, register]) =>
						Number(slot) >= 64 &&
						privateRootRegisters(wideRegionSource).has(Number(register)),
				)
				.map(([, slot]) => Number(slot)),
		);
		expect(privateWideSlots.size).toBeGreaterThan(0);
		expect(
			[...wideRegionSource.matchAll(/__gc_slots\[(\d+)\] = MAL_VALUE_UNDEFINED;/g)].some(
				([, slot]) => privateWideSlots.has(Number(slot)),
			),
		).toBe(true);
	});

	it("preserves first, middle, and final fallback order and the original throw handlers", () => {
		assertExactLines(runToStdout(compiled, { env: hostGc }), expected);
	});

	it("publishes heap-valued prior results before collecting region continuations", () => {
		assertExactLines(runToStdout(compiled, { env: verificationEnv }), expected);
	});

	it("matches the interpreted property and exception semantics", () => {
		assertExactLines(runToStdout(interpreted, { env: hostGc }), expected);
	});

	it("preserves interpreted roots at the same explicit collecting edges", () => {
		assertExactLines(runToStdout(interpreted, { env: verificationEnv }), expected);
	});
});
