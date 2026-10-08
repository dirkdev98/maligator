import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import { vmExceptionHandlerTargets } from "../../src/compiler/target/runtime-image.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("compact native shadow roots", () => {
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-native-root-storage-"));
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/native-root-storage.js",
			name: "native-root-storage",
			mainFile: HOST_MAIN,
			outDir,
		});
		({ compiled, interpreted } = pair);
		const kernel = pair.programImage.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "compactRoots",
		)!;
		expect(kernel).toBeDefined();
		expect(kernel.storage!.rootSlotCount).toBeLessThan(
			kernel.storage!.rootRegisters.length,
		);
		expect(emitCompiledFunction(kernel, kernel.functionIndex, "", false)).not.toBeNull();
		const continuation = pair.programImage.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "continuationRoots",
		)!;
		const handlerTargets = vmExceptionHandlerTargets(
			continuation.body.instructions.length,
			continuation.body.handlers,
		);
		expect(
			emitCompiledFunction(continuation, continuation.functionIndex, "", false),
		).not.toBeNull();
		expect(
			continuation.storage!.rootPublicationContinuations.some(
				(ip) => handlerTargets[ip] !== undefined,
			),
		).toBe(true);
		const selected = new Set<string>();
		for (const fn of pair.programImage.native.functions) {
			const name = String.fromCharCode(
				...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			);
			if (name !== "transportedRelease") continue;
			expect(emitCompiledFunction(fn, fn.functionIndex, "", false)).not.toBeNull();
			for (const variant of [
				fn.storage!,
				...fn.directEntries.map((entry) => entry.storage!),
			]) {
				for (const plan of variant.callTransports) {
					const op = fn.body.instructions[plan.instructionIp]!;
					if (
						op.opcode === "CALL" &&
						variant.privateCallResultIps.includes(plan.instructionIp) &&
						variant.privateRegisters.includes(op.dst)
					)
						selected.add(name);
				}
			}
		}
		expect(selected).toEqual(new Set(["transportedRelease"]));
	}, 600_000);

	it.each(["compiled", "interpreted"])(
		"preserves private call results, exceptions, and disjoint lifetimes when %s",
		(backend) => {
			const binary = backend === "compiled" ? compiled : interpreted;
			for (const mode of [{}, STRESS_ENV])
				assertExactLines(runToStdout(binary, { env: { MAL_HOST_GC: "1", ...mode } }), [
					"native-root-storage PASS",
				]);
		},
	);
});
