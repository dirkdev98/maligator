import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { analyzeNativeBodyFacts } from "../src/compiler/target/native-body-facts.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(profile = false) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`function retained(factory, collect) {
				const held = factory();
				collect();
				try { collect(); return held.marker; }
				catch (error) { return held; }
			} globalThis.retained = retained;`,
			"/root-continuation.js",
		),
		{ profile },
	);
}

describe("native root publication across ordinary continuations", () => {
	it.each([false, true])(
		"retains a published heap value across a normal try entry with profiling=%s",
		(profile) => {
			const image = compile(profile);
			const fn = image.native.functions[1]!;
			const target = fn.body.instructions.findIndex(
				(op, ip) =>
					op.opcode === "CALL" &&
					fn.body.instructions[ip - 1]?.opcode === "JUMP" &&
					ip > 1,
			);
			expect(fn.storage!.rootPublicationContinuations).toContain(target);
			expect(fn.body.handlers.length).toBeGreaterThan(0);
			const selected = emitCompiledFunction(fn, fn.functionIndex, "", true)!;
			const reset = emitCompiledFunction(
				{ ...fn, storage: { ...fn.storage!, rootPublicationContinuations: [] } },
				fn.functionIndex,
				"",
				true,
			)!;
			const stores = (source: string) =>
				source.match(/__gc_slots\[\d+\] = r\d+;/g)?.length ?? 0;
			const masks = (source: string) => source.match(/MAL_ROOT_MASK\(/g)?.length ?? 0;
			expect(stores(selected.source)).toBeLessThan(stores(reset.source));
			expect(masks(selected.source)).toBeLessThan(masks(reset.source));
			expect(selected.profileDecisions).toEqual(reset.profileDecisions);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
			expect(restored.native.functions[1]!.storage!.rootPublicationContinuations).toEqual(
				fn.storage!.rootPublicationContinuations,
			);
		},
	);

	it("rejects forged continuations into a handler or a multiply owned join", () => {
		const handler = compile().native.functions[1]!;
		const join = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function join(factory, collect, choose) {
					let held;
					if (choose) held = factory(1); else held = factory(2);
					collect(); return held.marker;
				} globalThis.join = join;`,
				"/root-join.js",
			),
		).native.functions[1]!;
		const joinTarget = [...analyzeNativeBodyFacts(join.body).branchSources].find(
			([, sources]) => sources.length > 1,
		)?.[0];
		expect(joinTarget).toBeDefined();
		for (const [fn, target] of [
			[handler, handler.body.handlers[0]!.handlerIp],
			[join, joinTarget!],
		] as const) {
			expect(fn.storage!.rootPublicationContinuations).not.toContain(target);
			expect(() =>
				validateNativeStorage({
					...fn,
					storage: {
						...fn.storage!,
						rootPublicationContinuations: [
							...fn.storage!.rootPublicationContinuations,
							target,
						].sort((a, b) => a - b),
					},
				}),
			).toThrow(/storage plan/);
		}
	});

	it("retains the reset after a polling jump and at resumable entries", () => {
		const original = compile().native.functions[1]!;
		const target = original.storage!.rootPublicationContinuations.find((ip) => ip > 1)!;
		expect(target).toBeDefined();
		const polling = lowerNativeFunctionStorage({
			...original,
			gc: {
				safepoints: [
					...original.gc.safepoints,
					{ ...original.gc.safepoints[0]!, instructionIp: target - 1 },
				].sort((left, right) => left.instructionIp - right.instructionIp),
			},
		});
		expect(polling.storage!.rootPublicationContinuations).not.toContain(target);
		expect(() =>
			validateNativeStorage({ ...polling, storage: original.storage }),
		).toThrow(/storage plan/);
		const extraPredecessor = lowerNativeFunctionStorage({
			...original,
			body: {
				...original.body,
				instructions: original.body.instructions.with(-1, {
					opcode: "JUMP",
					targetIp: target,
				}),
			},
		});
		expect(extraPredecessor.storage!.rootPublicationContinuations).not.toContain(target);
		expect(() =>
			validateNativeStorage({ ...extraPredecessor, storage: original.storage }),
		).toThrow(/storage plan/);
		const resumable = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				"async function retained(value) { await value; return value; } globalThis.retained = retained;",
				"/root-resume.js",
			),
		).native.functions[1]!;
		expect(resumable.storage!.rootPublicationContinuations).toEqual([]);
	});

	it("keeps selected sparse-region ownership across its ordinary entry", () => {
		const fn = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function retained(factory, collect, left, right) {
					const held = factory(); collect();
					try { collect(); return [held, left * right * 3]; }
					catch (error) { return held; }
				} globalThis.retained = retained;`,
				"/root-region.js",
			),
		).native.functions[1]!;
		const region = fn.specializations.find(
			(candidate) => candidate.kind === "numeric-fusion",
		)!;
		expect(region).toBeDefined();
		const entry = region.controlFlow.ordinaryBlockIps.find(
			(ip) => fn.body.instructions[ip - 1]?.opcode === "JUMP" && ip > 1,
		)!;
		expect(entry).toBeDefined();
		expect(region.claimedIps).not.toContain(entry);
		expect(fn.storage!.rootPublicationContinuations).not.toContain(entry);
	});
});
