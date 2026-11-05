import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { lowerNativeStorage } from "../../src/compiler/target/lower-native-storage.ts";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";
import {
	emitCompiledFunction,
	directCompiledEntryKey,
} from "../../src/compiler/target/render-native-c.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const expected = ["record-result-entries PASS"];

describe("record result entries", () => {
	const outDir = mkdtempSync(join(tmpdir(), "mal-record-results-"));
	let compiled: string;
	let interpreted: string;
	let image: ProgramImage;

	beforeAll(() => {
		({
			compiled,
			interpreted,
			programImage: image,
		} = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/record-result-entries.mjs",
			name: "record-result-entries",
			mainFile: HOST_MAIN,
			// Calls stay exact only without eval; realms keep the callee-realm materializer honest.
			config: resolveBuildConfig({ engine: { realms: true } }),
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
	});

	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	const functionNamed = (name: string) => {
		const fn = image.native.functions.find(
			(candidate) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[candidate.body.nameStringIndex] ?? []),
				) === name,
		);
		if (fn === undefined) throw new Error(`no native function ${name}`);
		return fn;
	};

	it("keeps producer storage for observing parameters in the emitted C ABI", () => {
		const preciseImage = lowerNativeStorage(image, "precise");
		const entries = new Map(
			preciseImage.native.functions.flatMap((fn) =>
				fn.directEntries.map(
					(entry) => [directCompiledEntryKey(fn.functionIndex, entry.id), entry] as const,
				),
			),
		);
		for (const [name, observed, pointers] of [
			["hold", true, 5],
			["stretch", false, 4],
			["updateBundle", false, 4],
			["decodedWeight", false, 5],
		] as const) {
			const fn = preciseImage.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(preciseImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === name,
			)!;
			const entry = fn.directEntries.find((entry) => entry.recordParameters)!;
			const parameter = entry.recordParameters![0]!;
			expect(parameter.observerIps.length > 0).toBe(observed);
			const emitted = emitCompiledFunction(
				fn,
				fn.functionIndex,
				"",
				false,
				"static",
				new Set(),
				[],
				entries,
				false,
				new Set(),
				preciseImage.runtime.stringConstants,
			)!;
			const abi = emitted.directEntries.find((candidate) => candidate.id === entry.id)!
				.recordParameters![0]!;
			expect(abi.representations).toHaveLength(pointers);
			if (name === "hold") {
				const shaped = {
					...entry,
					recordParameters: [{ ...parameter, shapes: [[0, 1, 2]] }],
				};
				const shapedFunction = {
					...fn,
					directEntries: fn.directEntries.map((candidate) =>
						candidate === entry ? shaped : candidate,
					),
				};
				const shapedC = emitCompiledFunction(
					shapedFunction,
					fn.functionIndex,
					"",
					false,
					"static",
					new Set(),
					[],
					entries,
					false,
					new Set(),
					preciseImage.runtime.stringConstants,
				)!.directEntries.find((candidate) => candidate.id === entry.id)!;
				expect(shapedC.recordParameters![0]!.representations).toHaveLength(6);
				expect(shapedC.source).toContain("i32 * rp0_3");
				expect(shapedC.source).not.toContain("if ((*rp0_3)");
				expect(shapedC.source).not.toContain("mal_value_to_i32((*rp0_3))");
				expect(shapedC.source).toContain("mal_vm_materialize_record(vm, (*rp0_5)");
			}
		}
		const decoded = preciseImage.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(preciseImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "decode",
		)!;
		const result = decoded.directEntries.find((entry) => entry.resultFields)!;
		const output = emitCompiledFunction(
			decoded,
			decoded.functionIndex,
			"",
			false,
			"static",
			new Set(),
			[],
			entries,
			false,
			new Set(),
			preciseImage.runtime.stringConstants,
		)!.directEntries.find((entry) => entry.id === result.id)!;
		expect(output.resultFieldRepresentations!.at(-1)).toBe("int32");
		expect(output.source).toContain(`i32 * rf${result.resultFields!.keys.length}`);
		expect(output.source).not.toContain(
			`*rf${result.resultFields!.keys.length} = mal_value_from_i32(`,
		);
	});

	it("returns the fields of out-of-line producers to field-reading callers", () => {
		for (const producer of [
			"scan",
			"describe",
			"classify",
			"depth",
			"terminator",
			"maybeShared",
			"updatedBundle",
			"updatedPair",
			"updatedFromInitializer",
		])
			expect(
				functionNamed(producer).directEntries.some((entry) => entry.resultFields),
				producer,
			).toBe(true);
		const updated = functionNamed("updatedBundle").directEntries.find(
			(entry) => entry.resultFields,
		)!.resultFields!;
		expect(updated.storage.map((field) => field.representation)).toEqual([
			"int32",
			"boolean",
			"string",
		]);
		expect(
			functionNamed("updatedPair").directEntries.find((entry) => entry.resultFields)!
				.resultFields!.allocationIps,
		).toHaveLength(2);
		for (const name of ["observedUpdated", "protectedUpdated"])
			expect(functionNamed(name).directEntries.some((entry) => entry.resultFields)).toBe(
				false,
			);
		const words = functionNamed("wordRecord").directEntries.find(
			(entry) => entry.resultFields,
		)!.resultFields!;
		expect(words.storage.map((field) => field.representation)).toEqual([
			"int32",
			"number",
			"int32",
			"string",
		]);
		expect(
			functionNamed("updateWords").directEntries.find((entry) => entry.recordParameters)!
				.recordParameters![0]!.storage,
		).toEqual(words.storage);
		const bundle = functionNamed("numberBundle").directEntries.find(
			(entry) => entry.resultFields,
		)!.resultFields!;
		expect(bundle.storage.map((field) => field.representation)).toEqual([
			"number",
			"boolean",
			"string",
		]);
		expect(
			functionNamed("updateBundle").directEntries.find((entry) => entry.recordParameters)!
				.recordParameters![0]!.storage,
		).toEqual(bundle.storage);
		expect(
			functionNamed("classify").directEntries.find((entry) => entry.resultFields)!
				.resultFields!.allocationIps,
		).toHaveLength(3);
		for (const caller of [
			"tokenLengths",
			"digitCount",
			"describeAll",
			"guarded",
			"depth",
			"observed",
			"found",
			"rejected",
			"attach",
			"decodeAll",
			"widened",
			"targets",
			"sharedWidths",
		])
			expect(functionNamed(caller).recordCalls?.length ?? 0, caller).toBeGreaterThan(0);
		expect(functionNamed("observed").recordCalls![0]!.observerIps.length).toBeGreaterThan(
			0,
		);
		// A forwarder hands its own caller storage to the producer's record entry, or copies.
		const forwarding = (name: string) =>
			functionNamed(name).directEntries.find((entry) => entry.resultFields?.forwards)!;
		expect(forwarding("nextWord").callOverrides).toHaveLength(1);
		expect(forwarding("trimmed").callOverrides).toBeUndefined();
		// Literals with different keys share one ABI with a shape index after the fields.
		expect(
			functionNamed("decode").directEntries.find((entry) => entry.resultFields)!
				.resultFields!.shapes,
		).toHaveLength(4);
		// Callers that keep the object need the ordinary entry and its fresh allocation.
		expect(functionNamed("retainAll").recordCalls).toBeUndefined();
	});

	it("hands records in caller storage to callees that take them as record parameters", () => {
		const recordParameters = (name: string) =>
			functionNamed(name)
				.directEntries.flatMap((entry) => entry.recordParameters ?? [])
				.map((parameter) => parameter.index);
		for (const callee of ["stretch", "hold", "width", "decodedWeight", "strictWidth"])
			expect(recordParameters(callee), callee).toEqual([0]);
		expect(recordParameters("between")).toEqual([0, 1]);
		// widen takes one record and returns another through the same entry.
		const widen = functionNamed("widen").directEntries.find(
			(entry) => entry.recordParameters !== undefined,
		)!;
		expect(widen.resultFields).toBeDefined();
		expect(
			functionNamed("widened").recordCalls!.some(
				(site) => (site.passes?.length ?? 0) > 0,
			),
		).toBe(true);
		// Object literals handed to record parameters live in their caller's storage.
		expect(recordParameters("shapeOf")).toEqual([1]);
		for (const callee of ["shift", "lengthOf"])
			expect(recordParameters(callee), callee).toEqual([0]);
		for (const caller of ["shapes", "shiftedLengths"])
			expect(functionNamed(caller).recordObjects?.length, caller).toBe(1);
	});

	it("creates a record object only where an observer needs it", () => {
		const result = spawnSync(compiled, [], {
			encoding: "utf8",
			env: { ...process.env, MAL_PERF_STATS: "1" },
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		const counter = (name: string) =>
			Number(new RegExp(`${name}=(\\d+)`).exec(result.stderr)?.[1] ?? -1);
		expect(counter("direct_entry_hits")).toBeGreaterThan(0);
		// Eleven observed tokens, the returned and the thrown token, three handed-on records,
		// two observed union records, sixteen records a callee keeps, which its caller then
		// shares, twenty records pushed in pairs, one rejected context literal, four kept
		// spans, one position charCodeAt coerces and one kept integer record. Other values
		// and records passed to record parameters never create one.
		expect(counter("record_materializations")).toBe(61);
	});

	for (const [backend, binary] of [
		["compiled", () => compiled],
		["interpreted", () => interpreted],
	] as const)
		it(`${backend} keeps record identity, exceptions and heap fields under GC stress`, () => {
			assertExactLines(
				runToStdout(binary(), { env: { MAL_HOST_GC: "1", ...STRESS_ENV } }),
				expected,
			);
		});
});
