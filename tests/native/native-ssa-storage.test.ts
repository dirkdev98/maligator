import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
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
						env: { ...stress, MAL_HOST_GC: "1" },
						timeoutMs: 60_000,
					}),
				).toBe(expected);
			}
		}
	});
});
