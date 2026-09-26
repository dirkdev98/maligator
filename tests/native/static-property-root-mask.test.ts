import { beforeAll, describe, expect, it } from "vitest";
import {
	nativePrivateCallResultIps,
	nativePrivateRootRegisters,
} from "../../src/compiler/target/lower-native-root-publication.ts";
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
		name: "detachedCallResultAcrossPoll",
		boundary: "CALL",
		probe: "mal_vm_call_cached",
		properties: [],
		firstBoundaryOnly: true,
		resultPrivate: true,
		callResultPrivate: true,
	},
	{
		name: "retainThroughThrowingCall",
		boundary: "CALL",
		probe: "mal_vm_call_cached",
		properties: ["value"],
		firstBoundaryOnly: true,
		resultPrivate: true,
		callResultPrivate: true,
	},
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
	{
		name: "retainThroughIndexLoad",
		boundary: "LOAD_PROPERTY",
		probe: "mal_vm_array_try_get_index",
		properties: ["value", "receiver"],
		resultPrivate: true,
	},
	{
		name: "retainThroughThrowingIndexLoad",
		boundary: "LOAD_PROPERTY",
		probe: "mal_vm_array_try_get_index",
		properties: ["value", "receiver"],
		resultPrivate: true,
	},
	{
		name: "detachedIndexHitAcrossPoll",
		boundary: "LOAD_PROPERTY",
		probe: "mal_vm_array_try_get_index",
		properties: ["value", "receiver"],
		resultPrivate: true,
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
			selectedPrivateCallIps: ReadonlySet<number>;
			boundaryIncomingRoots: Array<ReadonlyArray<number>>;
			boundaryResults: Array<{
				ip: number;
				register: number;
				outgoingRoots: ReadonlyArray<number>;
				nextCallIncomingRoots: ReadonlyArray<number>;
			}>;
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
			const boundarySafepoints = native.gc.safepoints
				.filter(
					(safepoint) =>
						fn.instructions[safepoint.instructionIp]?.opcode === kernel.boundary,
				)
				.slice(0, "firstBoundaryOnly" in kernel ? 1 : undefined);
			publicationContracts.set(name, {
				source: emitCompiledFunction(fn, native, index, "", false)?.source ?? "",
				retainedRegisters,
				privateRegisters,
				selectedPrivateCallIps: nativePrivateCallResultIps(fn, native),
				boundaryIncomingRoots: boundarySafepoints.map(
					(safepoint) => safepoint.incomingRootRegisters ?? [],
				),
				boundaryResults:
					"resultPrivate" in kernel
						? boundarySafepoints.map((safepoint) => {
								const load = fn.instructions[safepoint.instructionIp];
								if (load?.opcode !== "LOAD_PROPERTY" && load?.opcode !== "CALL") {
									throw new Error(`${name} has no indexed load or call result`);
								}
								const nextCall = native.gc.safepoints.find(
									(next) =>
										next.instructionIp > safepoint.instructionIp &&
										fn.instructions[next.instructionIp]?.opcode === "CALL",
								);
								return {
									ip: safepoint.instructionIp,
									register: load.dst,
									outgoingRoots: safepoint.outgoingRootRegisters ?? [],
									nextCallIncomingRoots: nextCall?.incomingRootRegisters ?? [],
								};
							})
						: [],
			});
		}
	}, 600_000);

	it.each(publicationKernels.filter((kernel) => kernel.properties.length > 0))(
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

	it.each(publicationKernels.filter((kernel) => "resultPrivate" in kernel))(
		"retains the private heap result through the next collecting call in $name",
		({ name }) => {
			const contract = publicationContracts.get(name)!;
			expect(contract.boundaryResults.length).toBeGreaterThan(0);
			for (const result of contract.boundaryResults) {
				expect(contract.privateRegisters.has(result.register)).toBe(true);
				expect(contract.source).toContain(
					`#define r${result.register} (__private_r${result.register})`,
				);
				expect(result.outgoingRoots).toContain(result.register);
				expect(result.nextCallIncomingRoots).toContain(result.register);
			}
		},
	);

	it.each(publicationKernels.filter((kernel) => "callResultPrivate" in kernel))(
		"publishes the selected private CALL result before its return poll in $name",
		({ name }) => {
			const contract = publicationContracts.get(name)!;
			expect(contract.boundaryResults).toHaveLength(1);
			const { ip, register } = contract.boundaryResults[0]!;
			expect(contract.selectedPrivateCallIps.has(ip)).toBe(true);
			const callOffset = contract.source.indexOf(
				`MalCompletion call_result_${ip} = mal_vm_call_cached(`,
			);
			expect(callOffset).toBeGreaterThanOrEqual(0);
			// The active macro binding, not the declaration, owns the CALL result storage.
			expect(
				contract.source
					.slice(0, callOffset)
					.match(new RegExp(`#define r${register} [^\\n]+`, "g"))
					?.at(-1),
			).toBe(`#define r${register} (__private_r${register})`);
			const continuation = contract.source.slice(callOffset);
			const throwCheck = continuation.indexOf(
				`if (call_result_${ip}.kind == MAL_COMPLETION_THROW)`,
			);
			const resultAssignment = continuation.indexOf(
				`r${register} = call_result_${ip}.value;`,
			);
			const poll = continuation.indexOf("if (mal_gc_poll)");
			const collection = continuation.indexOf("mal_gc_safepoint(vm);", poll);
			expect(throwCheck).toBeGreaterThan(0);
			expect(resultAssignment).toBeGreaterThan(throwCheck);
			expect(poll).toBeGreaterThan(resultAssignment);
			expect(collection).toBeGreaterThan(poll);
			expect(continuation.slice(poll, collection)).toMatch(
				new RegExp(`__gc_slots\\[\\d+\\] = r${register};`),
			);
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
