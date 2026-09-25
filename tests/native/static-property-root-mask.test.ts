import { beforeAll, describe, expect, it } from "vitest";
import { nativePrivateRootRegisters } from "../../src/compiler/target/lower-native-root-publication.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/static-property-root-mask.js";
const hostGc = { MAL_HOST_GC: "1" };
const expected = ["static-property-root-mask PASS"];
const publicationKernels = [
	{
		name: "retainThroughNumberCoercion",
		boundary: "BINARY",
		probe: "mal_vm_binary_op",
		properties: ["value"],
		firstBoundaryOnly: true,
	},
	{
		name: "retainThroughStringCoercion",
		boundary: "BINARY",
		probe: "mal_vm_binary_op",
		properties: ["value"],
		firstBoundaryOnly: true,
	},
	{
		name: "retainThroughThrowingCoercion",
		boundary: "BINARY",
		probe: "mal_vm_binary_op",
		properties: ["value"],
		firstBoundaryOnly: true,
	},
	{
		name: "retainThroughArrayTraversal",
		boundary: "ITERATOR_STEP",
		probe: "mal_vm_iterator_try_dense_array_cursor_step",
		properties: ["value"],
	},
	{
		name: "retainThroughThrowingArrayTraversal",
		boundary: "ITERATOR_STEP",
		probe: "mal_vm_iterator_try_dense_array_cursor_step",
		properties: ["value"],
	},
	{
		name: "retainThroughSetter",
		boundary: "STORE_PROPERTY_STATIC",
		probe: "mal_vm_object_try_store_static",
		properties: ["value", "receiver"],
	},
	{
		name: "retainThroughThrowingSetter",
		boundary: "STORE_PROPERTY_STATIC",
		probe: "mal_vm_object_try_store_static",
		properties: ["value", "receiver"],
	},
];
const verificationEnv = {
	...hostGc,
	// The fixture already collects at each reentrant edge under sanitizers.
	...(process.env.MAL_ASAN === "1" || process.env.MAL_UBSAN === "1"
		? { MAL_GC_VERIFY: "1" }
		: STRESS_ENV),
};

describe("native static-property root-mask publication", () => {
	let binary: string;
	let interpreted: string;
	let genericStaticSafepointLoadCount = 0;
	let wideRootCount = 0;
	const publicationContracts = new Map<
		string,
		{
			source: string;
			retainedRegisters: Array<number>;
			privateRegisters: ReadonlySet<number>;
			boundaryIncomingRoots: Array<ReadonlyArray<number>>;
		}
	>();

	beforeAll(() => {
		const result = buildBackendPairFromOneProgramImage({
			fixture,
			name: "static-property-root-mask",
		});
		binary = result.compiled;
		interpreted = result.interpreted;
		const wideFunctionIndex = result.programImage.runtime.functions.findIndex(
			(fn) =>
				String.fromCharCode(
					...(result.programImage.runtime.stringConstants[fn.nameStringIndex] ?? []),
				) === "retainWideValues",
		);
		expect(wideFunctionIndex).toBeGreaterThanOrEqual(0);
		wideRootCount = Math.max(
			...result.programImage.native.functions[wideFunctionIndex]!.gc.safepoints.map(
				(safepoint) => safepoint.rootRegisters.length,
			),
		);
		genericStaticSafepointLoadCount = result.programImage.runtime.functions.reduce(
			(count, fn, functionIndex) => {
				const native = result.programImage.native.functions[functionIndex]!;
				const operationSafepoints = new Set(
					native.gc.safepoints
						.filter((safepoint) => safepoint.kind === "operation")
						.map((safepoint) => safepoint.instructionIp),
				);
				return (
					count +
					fn.instructions.filter(
						(instruction, ip) =>
							instruction.opcode === "LOAD_PROPERTY_STATIC" &&
							native.instructions[ip] === undefined &&
							operationSafepoints.has(ip),
					).length
				);
			},
			0,
		);
		for (const [index, fn] of result.programImage.runtime.functions.entries()) {
			const stringConstant = (stringIndex: number) =>
				String.fromCharCode(
					...(result.programImage.runtime.stringConstants[stringIndex] ?? []),
				);
			const name = stringConstant(fn.nameStringIndex);
			const kernel = publicationKernels.find((kernel) => kernel.name === name);
			if (!kernel) continue;
			const retainedRegisters = kernel.properties.map((property) => {
				const load = fn.instructions.find(
					(instruction) =>
						instruction.opcode === "LOAD_PROPERTY_STATIC" &&
						stringConstant(instruction.stringIndex) === property,
				);
				if (load?.opcode !== "LOAD_PROPERTY_STATIC") {
					throw new Error(`${name} has no preceding heap-valued ${property} load`);
				}
				return load.dst;
			});
			const native = result.programImage.native.functions[index]!;
			const frameRegisters = new Set(
				native.gc.safepoints.flatMap((safepoint) => safepoint.rootRegisters),
			);
			const privateRegisters = nativePrivateRootRegisters(fn, native, frameRegisters);
			publicationContracts.set(name, {
				source: emitCompiledFunction(fn, native, index, "", false)?.source ?? "",
				retainedRegisters,
				privateRegisters,
				boundaryIncomingRoots: native.gc.safepoints
					.filter(
						(safepoint) =>
							fn.instructions[safepoint.instructionIp]?.opcode === kernel.boundary,
					)
					.slice(0, "firstBoundaryOnly" in kernel ? 1 : undefined)
					.map((safepoint) => safepoint.incomingRootRegisters ?? []),
			});
		}
	}, 600_000);

	it.each(publicationKernels)(
		"retains private preceding roots at the audited boundary in $name",
		({ name, probe }) => {
			const contract = publicationContracts.get(name);
			expect(contract).toBeDefined();
			expect(contract!.source).toContain(`${probe}(`);
			expect(contract!.boundaryIncomingRoots.length).toBeGreaterThan(0);
			for (const register of contract!.retainedRegisters) {
				expect(contract!.privateRegisters.has(register)).toBe(true);
				expect(contract!.source).toContain(
					`#define r${register} (__private_r${register})`,
				);
				for (const roots of contract!.boundaryIncomingRoots) {
					expect(roots).toContain(register);
				}
			}
		},
	);

	it("preserves own, inherited, watched, Proxy, and getter load paths", () => {
		expect(genericStaticSafepointLoadCount).toBeGreaterThanOrEqual(2);
		expect(wideRootCount).toBeGreaterThanOrEqual(70);
		assertExactLines(runToStdout(binary, { env: hostGc }), expected);
	});

	it("republishes live roots at the real safepoint after a cache hit", () => {
		assertExactLines(runToStdout(binary, { env: verificationEnv }), expected);
	});

	it("preserves collecting getter, Proxy, mutation, and catch semantics when interpreted", () => {
		assertExactLines(runToStdout(interpreted, { env: hostGc }), expected);
	});

	it("preserves heap-valued load results and wide root sets with interpreted GC verification", () => {
		assertExactLines(runToStdout(interpreted, { env: verificationEnv }), expected);
	});
});
