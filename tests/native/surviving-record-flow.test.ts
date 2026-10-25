import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { nativeVariantContract } from "../../src/compiler/target/lower-native-storage.ts";
import { nativeControlFlowContract } from "../../src/compiler/target/native-control-flow.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it.each(["mutable", "locked"] as const)(
	"preserves surviving record storage and collecting observers under %s primordials",
	(primordials) => {
		const directory = mkdtempSync(join(tmpdir(), "mal-surviving-record-"));
		try {
			const fixture = "tests/local/surviving-record-flow.mjs";
			const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
				encoding: "utf8",
			});
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `surviving-record-${primordials}`,
				outDir: directory,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: true },
				}),
				nativeStackRoots: "precise",
			});
			const named = (name: string) =>
				pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
			for (const name of [
				"conditionalProducer",
				"liveConsumer",
				"liveObserver",
				"conditionalLiteral",
			]) {
				const fn = named(name),
					entry = fn.directEntries.find(
						(e) => e.parameterRepresentations[1] === "string",
					)!;
				expect(entry, name).toBeDefined();
				const contract = nativeControlFlowContract(
					nativeVariantContract(fn, entry),
					entry.storage!.controlFlow,
				);
				if (name === "conditionalLiteral") {
					expect(fn.recordObjects).toHaveLength(1);
					expect(contract.recordObjects).toEqual([]);
				} else {
					expect(fn.recordCalls).toHaveLength(1);
					if (name === "conditionalProducer") expect(contract.recordCalls).toEqual([]);
					else {
						expect(contract.recordCalls).toHaveLength(1);
						if (name === "liveConsumer")
							expect(contract.recordCalls![0]!.loads.length).toBeLessThan(
								fn.recordCalls![0]!.loads.length,
							);
						else {
							expect(fn.recordCalls![0]!.observerIps.length).toBeGreaterThan(0);
							expect(contract.recordCalls![0]!.observerIps).toEqual([]);
						}
					}
				}
			}
			const parameter = named("parameterConsumer");
			const entry = parameter.directEntries.find(
				(e) => e.recordParameters?.length && e.parameterRepresentations[1] === "string",
			)!;
			expect(entry).toBeDefined();
			const contract = nativeControlFlowContract(
				nativeVariantContract(parameter, entry),
				entry.storage!.controlFlow,
			);
			expect(contract.recordParameterIps!.length).toBeLessThan(
				nativeVariantContract(parameter, entry).recordParameterIps!.length,
			);
			const result = named("conditionalResult");
			const resultEntry = result.directEntries.find(
				(e) => e.resultFields !== undefined && e.parameterRepresentations[1] === "string",
			)!;
			expect(resultEntry).toBeDefined();
			expect(resultEntry.resultFields!.escapes).toBe(true);
			for (const ip of resultEntry.resultFields!.allocationIps)
				expect(resultEntry.storage!.controlFlow!.unreachableIps).toContain(ip);
			const forward = named("conditionalForward");
			const forwardEntry = forward.directEntries.find(
				(e) =>
					e.resultFields?.forwards !== undefined &&
					e.parameterRepresentations[1] === "string",
			)!;
			expect(forwardEntry).toBeDefined();
			const forwardVariant = nativeVariantContract(forward, forwardEntry);
			expect(forwardVariant.recordForwardIps).toHaveLength(1);
			expect(
				nativeControlFlowContract(forwardVariant, forwardEntry.storage!.controlFlow)
					.recordForwardIps,
			).toEqual([]);
			for (const binary of [pair.compiled, pair.interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binary, {
							env: { MAL_HOST_GC: "1", ...stress },
							timeoutMs: 120000,
						}),
					).toBe(expected);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	300000,
);
