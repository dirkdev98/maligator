import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import { vmInstructionReadRegisters } from "../../src/compiler/target/runtime-image.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/native-ssa-storage.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-native-ssa-storage-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("independent native SSA storage", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;
	let image: ProgramImage;
	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "native-ssa-storage",
			mainFile: HOST_MAIN,
			config: resolveBuildConfig({ surface: { webPlatform: true } }),
			outDir,
		});
		({ compiled, interpreted, programImage: image } = pair);
	}, 600_000);

	it("preserves scalar arithmetic, loop transport, and suspended heap locals", () => {
		for (const name of [
			"argumentCountResult",
			"restLengthResult",
			"suspendedArgumentCount",
		]) {
			const native = image.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === name,
			)!;
			expect(native).toBeDefined();
			const count = native.body.instructions.find(
				(op) => op.opcode === "LOAD_ARGUMENT_COUNT",
			)!;
			if (count.opcode !== "LOAD_ARGUMENT_COUNT")
				throw new Error("Missing count snapshot");
			expect(native.registerRepresentations[count.dst]).toBe("number");
			expect(native.storage!.rootRegisters).not.toContain(count.dst);
		}
		for (const [name, opcode, representation] of [
			["staticIndexResult", "QUERY_STATIC_DATA", "number"],
			["staticLastIndexResult", "QUERY_STATIC_DATA", "number"],
			["staticIncludesResult", "QUERY_STATIC_DATA", "boolean"],
			["primitiveLengthResult", "LOAD_PROPERTY_STATIC", "number"],
			["preparedCompareResult", "PREPARED_STRING_COMPARE", "number"],
		] as const) {
			const native = image.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === name,
			)!;
			expect(native).toBeDefined();
			const op = native.body.instructions.find((op) => op.opcode === opcode)!;
			if (!("dst" in op)) throw new Error("Missing certified scalar producer");
			expect(native.registerRepresentations[op.dst]).toBe(representation);
			expect(
				emitCompiledFunction(
					native,
					native.functionIndex,
					"",
					false,
					"static",
					new Set(),
					[],
					new Map(),
					false,
					new Set(),
					image.runtime.stringConstants,
				),
			).not.toBeNull();
		}
		const arrayLength = image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "certifiedArrayLengthResult",
		)!;
		const length = arrayLength.body.instructions.find(
			(op) => op.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH",
		)!;
		expect(length).toBeDefined();
		if (length.opcode !== "LOAD_PROPERTY_STATIC_ARRAY_LENGTH")
			throw new Error("Missing certified array length");
		expect(arrayLength.registerRepresentations[length.dst]).toBe("number");
		for (const [name, operation, representation] of [
			["knownNumberResult", "Number", "number"],
			["knownParseResult", "parseInt", "number"],
			["knownCodeResult", "String.prototype.charCodeAt", "number"],
			["cachedCodeResult", "String.prototype.charCodeAt", "number"],
			["knownBooleanResults", "Number.isFinite", "boolean"],
		] as const) {
			const native = image.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === name,
			)!;
			expect(native).toBeDefined();
			const call = native.body.instructions.find(
				(op) => op.opcode === "CALL_KNOWN" && op.operation === operation,
			)!;
			if (call.opcode !== "CALL_KNOWN") throw new Error("Missing known result producer");
			expect(native.registerRepresentations[call.dst]).toBe(representation);
			expect(
				emitCompiledFunction(native, native.functionIndex, "", false),
			).not.toBeNull();
		}
		const immediate = image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "immediateReturnedFields",
		)!;
		expect(immediate).toBeDefined();
		expect(immediate.storage!.directHeapObjectIps).toHaveLength(1);
		expect(immediate.storage!.stackObjects).toEqual([]);
		const immediateOutput = emitCompiledFunction(
			immediate,
			immediate.functionIndex,
			"",
			false,
		)!;
		expect(immediateOutput).not.toBeNull();
		expect(immediateOutput.source).toContain("mal_vm_create_object_shaped(vm,");
		expect(immediateOutput.source).not.toContain("mal_vm_materialize_stack_object");

		const joined = image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "joinedFieldStorage",
		)!;
		expect(joined).toBeDefined();
		expect(
			joined.storage!.stackObjects.some(
				(site) => site.slotRepresentations.join(",") === "number,boxed,string,boolean",
			),
		).toBe(true);

		const boundary = image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "composeBoundaryValues",
		)!;
		expect(boundary).toBeDefined();
		expect(
			boundary.storage!.expressionIps.some((ip) => {
				const op = boundary.body.instructions[ip]!;
				if (!("dst" in op)) return false;
				return boundary.body.instructions
					.slice(ip + 1)
					.some(
						(consumer) =>
							[
								"CALL",
								"CREATE_OBJECT_SHAPED",
								"STORE_PROPERTY_STATIC",
								"STORE_PROPERTY",
							].includes(consumer.opcode) &&
							vmInstructionReadRegisters(consumer).includes(op.dst),
					);
			}),
		).toBe(true);
		expect(
			emitCompiledFunction(boundary, boundary.functionIndex, "", false),
		).not.toBeNull();

		const rotation = image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "rotateScalars",
		)!;
		expect(rotation).toBeDefined();
		const cycleLocals = rotation.storageValues!.flatMap((value, local) =>
			value < 0 ? [local] : [],
		);
		expect(cycleLocals).toHaveLength(1);
		const numericRotation = rotation.directEntries.find((entry) =>
			entry.parameterRepresentations.slice(0, 4).every((rep) => rep === "number"),
		)!;
		expect(numericRotation).toBeDefined();
		expect(numericRotation.registerRepresentations[cycleLocals[0]!]).toBe("number");
		expect(numericRotation.storage!.elidedTdzIps.length).toBeGreaterThan(0);
		expect(rotation.storage!.elidedTdzIps).toEqual([]);
		const flags = image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "rotateFlags",
		)!;
		const booleanFlags = flags.directEntries.find((entry) =>
			entry.parameterRepresentations.slice(0, 2).every((rep) => rep === "boolean"),
		)!;
		expect(booleanFlags.storage!.elidedTdzIps.length).toBeGreaterThan(0);
		const early = image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "readEarly",
		)!;
		expect(early.body.instructions.some((op) => op.opcode === "CREATE_EMPTY")).toBe(true);
		expect(early.storage!.elidedTdzIps).toEqual([]);
		for (const entry of early.directEntries)
			expect(entry.storage!.elidedTdzIps).toEqual([]);
		const projection = image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "projectScalarStorage",
		)!;
		expect(projection.storage!.propertyProjections).toHaveLength(1);
		const scalarProjection = projection.directEntries.find((entry) =>
			entry.parameterRepresentations.slice(1).every((rep) => rep === "number"),
		)!;
		expect(scalarProjection).toBeDefined();
		expect(scalarProjection.storage!.propertyProjections).toHaveLength(1);
		expect(scalarProjection.storage!.elidedTdzIps.length).toBeGreaterThan(0);
		for (const ip of scalarProjection.storage!.elidedTdzIps)
			expect(scalarProjection.storage!.propertyProjections[0]!.claimedIps).not.toContain(
				ip,
			);
		for (const name of ["postProperty", "preProperty", "addProperty", "copyProperty"]) {
			const fn = image.native.functions.find(
				(candidate) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[candidate.body.nameStringIndex] ?? []),
					) === name,
			)!;
			expect(fn.storage!.propertyNumericUpdates).toHaveLength(1);
			expect(emitCompiledFunction(fn, fn.functionIndex, "", false)!.source).toContain(
				"mal_vm_property_numeric_update_commit(",
			);
		}
		for (const name of ["typedStackFields", "typedStackNaN"]) {
			const stackFields = image.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === name,
			)!;
			expect(
				emitCompiledFunction(stackFields, stackFields.functionIndex, "", false),
			).not.toBeNull();
			expect(stackFields.storage!.stackObjects).toHaveLength(1);
			expect(stackFields.storage!.stackObjects[0]!.slotRepresentations).toEqual([
				"number",
				"int32",
				"boolean",
			]);
			if (name === "typedStackFields") {
				const slots = new Map<number, Set<string>>();
				for (const region of stackFields.specializations) {
					if (region.kind !== "stack-object-plan") continue;
					for (const site of region.sites)
						for (const access of site.accesses) {
							const op = stackFields.body.instructions[access.ip]!;
							const kind = op.opcode.startsWith("LOAD_") ? "load" : "store";
							const uses = slots.get(access.slot) ?? new Set();
							uses.add(kind);
							slots.set(access.slot, uses);
						}
				}
				for (const slot of [0, 1, 2])
					expect(slots.get(slot)).toEqual(new Set(["load", "store"]));
			}
		}
		const shapes = image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "shapeBranches",
		)!;
		const mixed = image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "mixedStackFields",
		)!;
		expect(mixed.storage!.stackObjects[0]!.slotRepresentations).toEqual([
			"number",
			"int32",
			"boolean",
			"boxed",
			"boxed",
		]);
		expect(emitCompiledFunction(mixed, mixed.functionIndex, "", false)).not.toBeNull();
		const mixedRegion = mixed.specializations.find(
			(region) => region.kind === "stack-object-plan",
		)!;
		if (mixedRegion.kind !== "stack-object-plan")
			throw new Error("Mixed fixture lacks a stack certificate");
		for (const slot of [3, 4]) {
			const accesses = mixedRegion.sites[0]!.accesses.filter(
				(access) => access.slot === slot,
			);
			expect(
				accesses.some((access) =>
					mixed.body.instructions[access.ip]!.opcode.startsWith("LOAD_"),
				),
			).toBe(true);
			expect(
				accesses.some((access) =>
					mixed.body.instructions[access.ip]!.opcode.startsWith("STORE_"),
				),
			).toBe(true);
		}
		const returned = image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "typedReturnedFields",
		)!;
		const returnRegion = returned.specializations.find(
			(region) => region.kind === "stack-object-plan",
		)!;
		if (returnRegion.kind !== "stack-object-plan")
			throw new Error("Return fixture lacks a stack certificate");
		expect(returnRegion.license.materialization).toBe("on-demand");
		expect(returnRegion.sites[0]!.materializations.length).toBeGreaterThan(0);
		const returnedEntry = returned.directEntries.find(
			(entry) => entry.storage!.stackObjects.length > 0,
		)!;
		expect(returnedEntry).toBeDefined();
		expect(returnedEntry.resultRepresentation).toBe("boxed");
		const emittedReturn = emitCompiledFunction(
			returned,
			returned.functionIndex,
			"",
			false,
		)!;
		expect(
			emittedReturn.directEntries.find(
				(entry) => entry.id === returnedEntry.id && !entry.leaf,
			)!.source,
		).toContain("mal_vm_materialize_stack_object_fields(vm,");
		expect(
			image.native.functions.some((fn) =>
				fn.instructions.some(
					(plan) =>
						plan?.kind === "call" &&
						plan.directEntryId === returnedEntry.id &&
						plan.guardedFunctionIndices?.includes(returned.functionIndex),
				),
			),
		).toBe(true);
		expect(shapes).toBeDefined();
		expect(emitCompiledFunction(shapes, shapes.functionIndex, "", false)).not.toBeNull();
		const portableShapes = image.runtime.functions[
			shapes.functionIndex
		]!.instructions.flatMap((instruction) =>
			instruction.opcode === "CREATE_OBJECT_SHAPED" ? [instruction.shapeCacheIndex] : [],
		);
		const nativeShapes = shapes.body.instructions.flatMap((instruction) =>
			instruction.opcode === "CREATE_OBJECT_SHAPED" ? [instruction.shapeCacheIndex] : [],
		);
		expect(portableShapes).toHaveLength(4);
		expect(nativeShapes).toHaveLength(4);
		expect(nativeShapes).not.toEqual(portableShapes);

		const regions = image.native.functions.flatMap((fn) => fn.specializations);
		expect(regions.some((region) => region.kind === "string-split-cursor")).toBe(true);
		const regexp = regions.find((region) => region.kind === "regexp-iterator-projection");
		if (regexp?.kind !== "regexp-iterator-projection")
			throw new Error("RegExp fixture lacks its certified iterator projection");
		const regexpBody = image.native.functions.find((fn) =>
			fn.specializations.includes(regexp),
		)!.body;
		const branch = regexpBody.instructions[regexp.doneBranchIp]!;
		expect(branch.opcode).toBe("JUMP_IF");
		if (branch.opcode === "JUMP_IF") expect(branch.targetIp).not.toBe(regexp.exitIp);
		expect(
			regions.some(
				(region) =>
					region.kind === "indexed-length-loop" &&
					region.sites.some((site) => site.reverseInduction !== undefined),
			),
		).toBe(true);
		const scalar = image.native.functions.find((fn) =>
			fn.storage?.expressionIps.some((ip) => {
				const op = fn.body.instructions[ip];
				return op?.opcode === "BINARY" && op.operator === "*";
			}),
		);
		expect(scalar).toBeDefined();
		if (scalar === undefined)
			throw new Error("Scalar rounding fixture lacks a native multiplication expression");
		expect(emitCompiledFunction(scalar, scalar.functionIndex, "", false)).not.toBeNull();
		const scheduled = image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "scheduledRegion",
		)!;
		expect(
			scheduled.specializations.some((region) => region.kind === "numeric-fusion"),
		).toBe(true);
		expect(scheduled.body.handlers.length).toBeGreaterThan(0);
		expect(
			emitCompiledFunction(scheduled, scheduled.functionIndex, "", false),
		).not.toBeNull();
		for (const name of ["scalarWithRegion", "scalarWithHandler"]) {
			const composed = image.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === name,
			)!;
			if (name === "scalarWithRegion")
				expect(
					composed.specializations.some((region) => region.kind === "numeric-fusion"),
				).toBe(true);
			else expect(composed.body.handlers.length).toBeGreaterThan(0);
			expect(composed.storage!.expressionIps.length).toBeGreaterThan(0);
			expect(composed.storage!.definitionInitializedRegisters.length).toBeGreaterThan(0);
			expect(
				emitCompiledFunction(composed, composed.functionIndex, "", false),
			).not.toBeNull();
		}
		const leaf = image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "scalarLeaf",
		);
		expect(
			leaf?.directEntries.some(
				(entry) => (entry.storage?.numericLeaf?.expressionIps.length ?? 0) > 0,
			),
		).toBe(true);
		const suspended = image.native.functions.filter((fn) => fn.mode === "resumable");
		const boxedPair = image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "boxedReadPair",
		)!;
		expect(boxedPair.storage!.propertyReadPairs).toHaveLength(1);
		const compact = suspended.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "compactScalarAsync",
		)!;
		expect(compact.storage!.suspension!.slotCount).toBeLessThan(
			compact.body.registerCount,
		);
		expect(compact.registerRepresentations).toContain("number");
		for (const [name, rep] of [
			["compactSpillNumber", "number"],
			["compactSpillInteger", "int32"],
			["compactSpillBoolean", "boolean"],
		]) {
			const spill = suspended.find(
				(fn) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === name,
			)!;
			if (name === "compactSpillNumber") {
				expect(spill.storage!.expressionIps.length).toBeGreaterThan(0);
				expect(spill.storage!.rematerializedConstantIps.length).toBeGreaterThan(0);
			}
			expect(
				spill.storage!.suspension!.points.some((point) =>
					point.registers.some((local) => spill.registerRepresentations[local] === rep),
				),
			).toBe(true);
		}
		const occupant = suspended.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "retainOccupant",
		)!;
		expect(
			occupant.body.instructions.some((op) =>
				["CREATE_OBJECT", "CREATE_OBJECT_SHAPED"].includes(op.opcode),
			),
		).toBe(false);
		const occupantYield = occupant.body.instructions.findIndex(
			(op) => op.opcode === "YIELD",
		);
		expect(
			occupant.storage!.suspension!.points.find(
				(point) => point.instructionIp === occupantYield,
			)!.registers,
		).toContain(0);
		expect(
			occupant.body.instructions
				.slice(occupantYield + 1)
				.flatMap(vmInstructionReadRegisters),
		).not.toContain(0);
		const numericSort = image.native.functions
			.flatMap((fn) => fn.instructions)
			.find((plan) => plan?.kind === "call" && plan.numericSortCallback !== undefined);
		if (numericSort?.kind !== "call" || numericSort.numericSortCallback === undefined)
			throw new Error("Scalar sort fixture lacks its numeric leaf callback selection");
		const sort = image.native.functions[numericSort.numericSortCallback.functionIndex]!;
		const sortLeaf =
			sort.directEntries[numericSort.numericSortCallback.entryId]!.storage!.numericLeaf!;
		expect(sortLeaf.expressionIps.length).toBeGreaterThan(0);
		const sortTargets = new Set(
			sort.body.instructions.flatMap((op) =>
				op.opcode === "JUMP" || op.opcode === "JUMP_IF" ? [op.targetIp] : [],
			),
		);
		expect(sortLeaf.expressionIps.some((ip) => sortTargets.has(ip))).toBe(true);
		expect(suspended.length).toBeGreaterThanOrEqual(2);
		const regionTail = image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "scalarRegionTail",
		)!;
		expect(regionTail).toBeDefined();
		expect(
			regionTail.specializations.some((region) => region.kind === "numeric-fusion"),
		).toBe(true);
		expect(
			regionTail.directEntries.some((entry) => entry.storage!.expressionIps.length > 0),
		).toBe(true);
		for (const fn of suspended) {
			expect(emitCompiledFunction(fn, fn.functionIndex, "", false)).not.toBeNull();
		}
		for (const name of ["wideHolder", "wideAsync"]) {
			const fn = suspended.find(
				(candidate) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[candidate.body.nameStringIndex] ?? []),
					) === name,
			);
			if (fn === undefined) throw new Error(`Fixture lacks resumable ${name}`);
			const vmCount = image.runtime.functions[fn.functionIndex]!.registerCount;
			expect(
				fn.gc.safepoints.some((point) => {
					const op = fn.body.instructions[point.instructionIp];
					return (
						(op?.opcode === "YIELD" || op?.opcode === "AWAIT") &&
						point.rootRegisters.some((local) => local >= vmCount)
					);
				}),
			).toBe(true);
		}
		for (const binary of [compiled, interpreted]) {
			for (const stress of [{}, STRESS_ENV]) {
				expect(
					runToStdout(binary, {
						env: {
							...stress,
							MAL_HOST_GC: "1",
							...(binary === compiled ? { MAL_ALLOC_FAIL_TEST: "1" } : {}),
						},
						timeoutMs: 60_000,
					}),
				).toBe(expected);
			}
		}
	});

	it("restores arguments, captures and this across direct eval and function splices", () => {
		const evalFixture = "tests/local/native-compact-suspension-eval.js";
		const evalExpected = execFileSync(process.execPath, [evalFixture], {
			encoding: "utf8",
		});
		const pair = buildBackendPairFromOneProgramImage({
			fixture: evalFixture,
			name: "native-compact-suspension-eval",
			mainFile: HOST_MAIN,
			config: resolveBuildConfig({
				engine: { eval: true },
				surface: { webPlatform: true },
			}),
			outDir,
		});
		for (const fn of pair.programImage.native.functions.filter(
			(fn) => fn.mode === "resumable",
		))
			expect(emitCompiledFunction(fn, fn.functionIndex, "", false)).not.toBeNull();
		for (const binary of [pair.compiled, pair.interpreted])
			for (const stress of [{}, STRESS_ENV])
				expect(
					runToStdout(binary, {
						env: { ...stress, MAL_HOST_GC: "1" },
						timeoutMs: 60_000,
					}),
				).toBe(evalExpected);
	}, 600_000);
});
