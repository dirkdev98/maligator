import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import type { CoreCompilationContext } from "../src/compiler/core/core-compilation.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import {
	coreFactClaimImplies,
	normalizeCoreFactClaims,
} from "../src/compiler/core/core-ir-fact-implication.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { CORE_OWN_DATA_CELL_FACT } from "../src/compiler/core/core-ir-provenance.ts";
import type {
	CoreBlockId,
	CoreFact,
	CoreFactClaim,
	CoreFactId,
	CoreFactObligation,
	CoreFunctionId,
	CoreInstructionEffects,
	CoreInstructionId,
	CoreValueId,
} from "../src/compiler/core/core-ir.ts";
import { CORE_NO_EFFECTS, coreValueId } from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CorePassManager } from "../src/compiler/core/core-pass-manager.ts";
import { CORE_PROOF_PASSES } from "../src/compiler/core/core-proof-passes.ts";
import type { CoreFunctionStore } from "../src/compiler/core/core-store.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { conservativeCompilerProgramFacts } from "../src/compiler/shared/compiler-facts.ts";
import {
	inspectCoreBlockParameters,
	inspectCoreTerminatorPayload,
	inspectCoreValueDefinition,
} from "./helpers/core-inspection.ts";

const context: CoreCompilationContext = {
	facts: conservativeCompilerProgramFacts(),
	data: {
		entrypointPath: "core-fact-implication.js",
		moduleEvaluationOrder: ["core-fact-implication.js"],
		sourceFiles: [{ path: "core-fact-implication.js", contents: "" }],
		cjsModuleFunctionIndices: [],
		hostInstallCandidates: [],
		singleAssignmentGlobalSlots: [],
		singleAssignmentCapturedSlots: [],
		retainedHostInstallers: [],
	},
};

function runProofs(program: CoreProgram): void {
	const report = new CoreOptimizationReportBuilder(program);
	const analyses = new CoreAnalysisManager(program, context, report);
	new CorePassManager(program, context, analyses, report, {
		verification: "per-pass",
	}).runStage("proofs", CORE_PROOF_PASSES);
}

function fn(program: CoreProgram, functionId: CoreFunctionId): CoreFunctionStore {
	return program.function(functionId);
}

function guardBlocks(owner: CoreFunctionStore): ReadonlyArray<CoreBlockId> {
	return [...owner.blockIds()].filter(
		(block) =>
			inspectCoreTerminatorPayload(owner, owner.blockTerminator(block)).kind === "guard",
	);
}

function facts(owner: CoreFunctionStore): ReadonlyArray<CoreFact> {
	return [...owner.factIds()].map((fact) => owner.fact(fact));
}

function identityClaim(
	subject: CoreValueId,
	identities: ReadonlyArray<string>,
): CoreFactClaim {
	return { kind: "identity", subject, identities };
}

function rangeClaim(
	subject: CoreValueId,
	bounds: Partial<Omit<Extract<CoreFactClaim, { kind: "range" }>, "kind" | "subject">>,
): CoreFactClaim {
	return {
		kind: "range",
		subject,
		minimum: null,
		maximum: null,
		integer: false,
		mayBeNaN: false,
		mayBeNegativeZero: false,
		...bounds,
	};
}

function setReturns(
	builder: CoreFunctionBuilder,
	blocks: ReadonlyArray<CoreBlockId>,
	value: CoreValueId,
): void {
	for (const block of blocks) builder.setTerminator(block, { kind: "return", value });
}

function replaceFactsWithEffectClaims(
	program: CoreProgram,
	functionId: CoreFunctionId,
	factIds: ReadonlyArray<CoreFactId>,
	instruction: CoreInstructionId,
	effects: CoreInstructionEffects,
	refinementProof: CoreFactId,
): void {
	const owner = fn(program, functionId);
	const editor = CoreEditor.open(program, functionId);
	const remapped = new Map<CoreFactId, CoreFactId>();
	for (const factId of [...factIds].sort((left, right) => left - right)) {
		const current = owner.fact(factId);
		const replacement = editor.addFact({
			kind: current.kind,
			value: current.value,
			claims: [...current.claims, { kind: "effect", instruction, effects }],
			validity: current.validity,
			obligations: current.obligations,
			origin: current.origin,
		});
		remapped.set(factId, replacement);
	}
	for (const block of owner.blockIds()) {
		const payload = inspectCoreTerminatorPayload(owner, owner.blockTerminator(block));
		if (payload.kind !== "guard") continue;
		const fact = remapped.get(payload.fact);
		if (fact !== undefined) editor.replaceTerminator(block, { ...payload, fact });
	}
	editor.setInstructionEffectRefinement(instruction, {
		effects,
		proof: remapped.get(refinementProof)!,
	});
	for (const factId of factIds) editor.removeFact(factId);
	editor.commit();
}

describe("Core fact implication", () => {
	it("orders finite identity, shape, range, and effect claims by precision", () => {
		const subject = coreValueId(0);
		const instruction = 0 as CoreInstructionId;
		const identity = (identities: ReadonlyArray<string>): CoreFactClaim => ({
			kind: "identity",
			subject,
			identities,
		});
		const shape = (shapes: ReadonlyArray<string>): CoreFactClaim => ({
			kind: "shape",
			subject,
			shapes,
		});
		const range = (
			minimum: number,
			maximum: number,
			integer: boolean,
		): CoreFactClaim => ({
			kind: "range",
			subject,
			minimum,
			maximum,
			integer,
			mayBeNaN: false,
			mayBeNegativeZero: false,
		});
		const effects = (mayGc: boolean): CoreFactClaim => ({
			kind: "effect",
			instruction,
			effects: { ...CORE_NO_EFFECTS, mayGc },
		});

		expect(coreFactClaimImplies(identity(["f:1"]), identity(["f:1", "f:2"]))).toBe(true);
		expect(coreFactClaimImplies(shape(["shape:a"]), shape(["shape:a", "shape:b"]))).toBe(
			true,
		);
		expect(coreFactClaimImplies(range(1, 4, true), range(0, 10, false))).toBe(true);
		expect(coreFactClaimImplies(range(0, 10, false), range(1, 4, true))).toBe(false);
		expect(coreFactClaimImplies(effects(false), effects(true))).toBe(true);
		expect(
			normalizeCoreFactClaims([identity(["f:2", "f:1"]), identity(["f:1"])]),
		).toEqual([identity(["f:1"])]);
	});

	it("uses a dominating stronger identity fact to remove a redundant guard", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const strongSuccess = builder.createBlock();
		const strongFallback = builder.createBlock();
		const weakSuccess = builder.createBlock();
		const weakFallback = builder.createBlock();
		const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
		builder.setGuardTerminator(entry, {
			condition,
			success: { block: strongSuccess, arguments: [] },
			fallback: { block: strongFallback, arguments: [] },
			fact: {
				kind: "closed-call-target",
				value: 1,
				claims: [identityClaim(condition, ["function:1"])],
				origin: "test",
			},
		});
		builder.setGuardTerminator(strongSuccess, {
			condition,
			success: { block: weakSuccess, arguments: [] },
			fallback: { block: weakFallback, arguments: [] },
			fact: {
				kind: "bounded-call-target",
				value: [1, 2],
				claims: [identityClaim(condition, ["function:1", "function:2"])],
				origin: "test",
			},
		});
		builder.setTerminator(weakSuccess, { kind: "return", value: condition });
		const [strongMiss] = builder.appendInstruction(strongFallback, "createBoolean", [], {
			attributes: { value: false },
		});
		builder.setTerminator(strongFallback, {
			kind: "return",
			value: strongMiss!,
		});
		const [weakMiss] = builder.appendInstruction(weakFallback, "createBoolean", [], {
			attributes: { value: false },
		});
		builder.setTerminator(weakFallback, { kind: "return", value: weakMiss! });
		const finished = builder.finish(entry);

		runProofs(program);
		const optimized = fn(program, finished.function);
		expect(guardBlocks(optimized)).toHaveLength(1);
		expect(facts(optimized)).toHaveLength(1);
		expect(facts(optimized)[0]?.claims).toEqual([
			identityClaim(condition, ["function:1"]),
		]);
	});

	it("does not use a stronger fact from a sibling control-flow path", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock(Array.from({ length: 4 }, () => ({})));
		const strongEntry = builder.createBlock();
		const weakEntry = builder.createBlock();
		const strongSuccess = builder.createBlock();
		const strongFallback = builder.createBlock();
		const weakSuccess = builder.createBlock();
		const weakFallback = builder.createBlock();
		const [branch, subject, strongCondition, weakCondition] = inspectCoreBlockParameters(
			builder,
			entry,
		).map(({ value }) => value);
		builder.setTerminator(entry, {
			kind: "branch",
			condition: branch!,
			consequent: { block: strongEntry, arguments: [] },
			alternate: { block: weakEntry, arguments: [] },
		});
		builder.setGuardTerminator(strongEntry, {
			condition: strongCondition!,
			success: { block: strongSuccess, arguments: [] },
			fallback: { block: strongFallback, arguments: [] },
			fact: {
				kind: "closed-call-target",
				value: 1,
				claims: [identityClaim(subject!, ["function:1"])],
				origin: "test",
			},
		});
		builder.setGuardTerminator(weakEntry, {
			condition: weakCondition!,
			success: { block: weakSuccess, arguments: [] },
			fallback: { block: weakFallback, arguments: [] },
			fact: {
				kind: "bounded-call-target",
				value: [1, 2],
				claims: [identityClaim(subject!, ["function:1", "function:2"])],
				origin: "test",
			},
		});
		setReturns(
			builder,
			[strongSuccess, strongFallback, weakSuccess, weakFallback],
			subject!,
		);
		const finished = builder.finish(entry);

		runProofs(program);
		expect(guardBlocks(fn(program, finished.function))).toHaveLength(2);
	});

	it("rewires a weaker effect refinement to a stronger global proof", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [result] = builder.appendInstruction(entry, "call", [parameter, parameter]);
		builder.setTerminator(entry, { kind: "return", value: result! });
		const finished = builder.finish(entry);
		const owner = fn(program, finished.function);
		const definition = inspectCoreValueDefinition(owner, result!);
		if (definition.kind !== "instruction") throw new Error("expected call result");
		const weakerEffects: CoreInstructionEffects = {
			...CORE_NO_EFFECTS,
			mayGc: true,
		};
		const editor = CoreEditor.open(program, finished.function);
		const strong = editor.addFact({
			kind: "strong-effects",
			value: true,
			claims: [
				{
					kind: "effect",
					instruction: definition.instruction,
					effects: CORE_NO_EFFECTS,
				},
			],
			validity: { kind: "summary", digest: "strong" },
			obligations: [],
			origin: "test",
		});
		const weak = editor.addFact({
			kind: "weak-effects",
			value: true,
			claims: [
				{
					kind: "effect",
					instruction: definition.instruction,
					effects: weakerEffects,
				},
			],
			validity: { kind: "summary", digest: "weak" },
			obligations: [],
			origin: "test",
		});
		editor.setInstructionEffectRefinement(definition.instruction, {
			effects: weakerEffects,
			proof: weak,
		});
		editor.commit();

		runProofs(program);
		expect(owner.instructionEffectRefinement(definition.instruction)?.proof).toBe(strong);
		expect([...owner.factIds()]).toEqual([strong]);
	});

	it("does not license a later guard from a proof another path bypasses", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock(Array.from({ length: 4 }, () => ({})));
		const guarded = builder.createBlock();
		const bypass = builder.createBlock();
		const join = builder.createBlock();
		const strongFallback = builder.createBlock();
		const weakSuccess = builder.createBlock();
		const weakFallback = builder.createBlock();
		const [selector, subject, strongCondition, weakCondition] =
			inspectCoreBlockParameters(builder, entry).map(({ value }) => value);
		builder.setTerminator(entry, {
			kind: "branch",
			condition: selector!,
			consequent: { block: guarded, arguments: [] },
			alternate: { block: bypass, arguments: [] },
		});
		builder.setGuardTerminator(guarded, {
			condition: strongCondition!,
			success: { block: join, arguments: [] },
			fallback: { block: strongFallback, arguments: [] },
			fact: {
				kind: "closed-call-target",
				value: 1,
				claims: [identityClaim(subject!, ["function:1"])],
				origin: "test",
			},
		});
		builder.setTerminator(bypass, {
			kind: "jump",
			edge: { block: join, arguments: [] },
		});
		builder.setGuardTerminator(join, {
			condition: weakCondition!,
			success: { block: weakSuccess, arguments: [] },
			fallback: { block: weakFallback, arguments: [] },
			fact: {
				kind: "bounded-call-target",
				value: [1, 2],
				claims: [identityClaim(subject!, ["function:1", "function:2"])],
				origin: "test",
			},
		});
		setReturns(builder, [strongFallback, weakSuccess, weakFallback], subject!);
		const finished = builder.finish(entry);

		runProofs(program);
		expect(guardBlocks(fn(program, finished.function))).toHaveLength(2);
		expect(facts(fn(program, finished.function))).toHaveLength(2);
	});

	it("keeps the entry check when two guards prove each other around a back edge", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{}, {}]);
		const header = builder.createBlock();
		const body = builder.createBlock();
		const headerFallback = builder.createBlock();
		const bodyFallback = builder.createBlock();
		const [subject, condition] = inspectCoreBlockParameters(builder, entry).map(
			({ value }) => value,
		);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setGuardTerminator(header, {
			condition: condition!,
			success: { block: body, arguments: [] },
			fallback: { block: headerFallback, arguments: [] },
			fact: {
				kind: "header-identity",
				value: 1,
				claims: [identityClaim(subject!, ["function:1"])],
				origin: "test",
			},
		});
		builder.setGuardTerminator(body, {
			condition: condition!,
			success: { block: header, arguments: [] },
			fallback: { block: bodyFallback, arguments: [] },
			fact: {
				kind: "latch-identity",
				value: 1,
				claims: [identityClaim(subject!, ["function:1"])],
				origin: "test",
			},
		});
		setReturns(builder, [headerFallback, bodyFallback], subject!);
		const finished = builder.finish(entry);

		runProofs(program);
		const owner = fn(program, finished.function);
		const guards = guardBlocks(owner);
		expect(guards).toHaveLength(1);
		expect(facts(owner)).toHaveLength(1);
		const cfg = buildCoreControlFlow(program, finished.function);
		for (const block of owner.blockIds()) {
			if (block === owner.entry || !cfg.reachable.has(block)) continue;
			expect(cfg.dominates(guards[0]!, block)).toBe(true);
		}
	});

	it("keeps both guards of a cycle no single success edge dominates", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{}, {}, {}]);
		const first = builder.createBlock();
		const second = builder.createBlock();
		const firstFallback = builder.createBlock();
		const secondFallback = builder.createBlock();
		const [selector, subject, condition] = inspectCoreBlockParameters(builder, entry).map(
			({ value }) => value,
		);
		builder.setTerminator(entry, {
			kind: "branch",
			condition: selector!,
			consequent: { block: first, arguments: [] },
			alternate: { block: second, arguments: [] },
		});
		builder.setGuardTerminator(first, {
			condition: condition!,
			success: { block: second, arguments: [] },
			fallback: { block: firstFallback, arguments: [] },
			fact: {
				kind: "first-identity",
				value: 1,
				claims: [identityClaim(subject!, ["function:1"])],
				origin: "test",
			},
		});
		builder.setGuardTerminator(second, {
			condition: condition!,
			success: { block: first, arguments: [] },
			fallback: { block: secondFallback, arguments: [] },
			fact: {
				kind: "second-identity",
				value: 1,
				claims: [identityClaim(subject!, ["function:1"])],
				origin: "test",
			},
		});
		setReturns(builder, [firstFallback, secondFallback], subject!);
		const finished = builder.finish(entry);

		runProofs(program);
		expect(guardBlocks(fn(program, finished.function))).toHaveLength(2);
		expect(facts(fn(program, finished.function))).toHaveLength(2);
	});

	it("never leaves an effect refinement naming a removed fact", () => {
		const guardedCall = (innerFirst: boolean) => {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock([{}, {}]);
			const inner = builder.createBlock();
			const body = builder.createBlock();
			const outerFallback = builder.createBlock();
			const innerFallback = builder.createBlock();
			const [subject, condition] = inspectCoreBlockParameters(builder, entry).map(
				({ value }) => value,
			);
			const claims = [identityClaim(subject!, ["function:1"])];
			let outer: CoreFactId;
			let nested: CoreFactId;
			const outerGuard = () =>
				builder.setGuardTerminator(entry, {
					condition: condition!,
					success: { block: inner, arguments: [] },
					fallback: { block: outerFallback, arguments: [] },
					fact: { kind: "outer-identity", value: 1, claims, origin: "test" },
				});
			const innerGuard = () =>
				builder.setGuardTerminator(inner, {
					condition: condition!,
					success: { block: body, arguments: [] },
					fallback: { block: innerFallback, arguments: [] },
					fact: { kind: "inner-identity", value: 1, claims, origin: "test" },
				});
			if (innerFirst) {
				nested = innerGuard();
				outer = outerGuard();
			} else {
				outer = outerGuard();
				nested = innerGuard();
			}
			const [result] = builder.appendInstruction(body, "call", [subject!, subject!]);
			builder.setTerminator(body, { kind: "return", value: result! });
			setReturns(builder, [outerFallback, innerFallback], subject!);
			const finished = builder.finish(entry);
			const owner = fn(program, finished.function);
			const definition = inspectCoreValueDefinition(owner, result!);
			if (definition.kind !== "instruction") throw new Error("expected call result");
			replaceFactsWithEffectClaims(
				program,
				finished.function,
				[outer, nested],
				definition.instruction,
				{ ...CORE_NO_EFFECTS, mayGc: true },
				innerFirst ? nested : outer,
			);
			return { program, functionId: finished.function };
		};

		for (const innerFirst of [false, true]) {
			const built = guardedCall(innerFirst);
			runProofs(built.program);
			const owner = fn(built.program, built.functionId);
			const live = new Set(owner.factIds());
			const proofs = [...owner.instructionIds()].flatMap((instruction) => {
				if (owner.instructionKind(instruction) !== "operation") return [];
				const proof = owner.instructionEffectRefinement(instruction)?.proof;
				return proof === undefined ? [] : [proof];
			});
			expect(proofs).toHaveLength(1);
			expect(proofs.every((proof) => live.has(proof))).toBe(true);
			expect(guardBlocks(owner)).toHaveLength(innerFirst ? 2 : 1);
		}
	});

	it("keeps a guard whose fact still owes a fallback or a materialization", () => {
		const nestedGuards = (
			obligations: ReadonlyArray<Exclude<CoreFactObligation, { kind: "guard" }>>,
		) => {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock([{}, {}]);
			const inner = builder.createBlock();
			const body = builder.createBlock();
			const outerFallback = builder.createBlock();
			const innerFallback = builder.createBlock();
			const [subject, condition] = inspectCoreBlockParameters(builder, entry).map(
				({ value }) => value,
			);
			builder.setGuardTerminator(entry, {
				condition: condition!,
				success: { block: inner, arguments: [] },
				fallback: { block: outerFallback, arguments: [] },
				fact: {
					kind: "closed-call-target",
					value: 1,
					claims: [identityClaim(subject!, ["function:1"])],
					origin: "test",
				},
			});
			builder.setGuardTerminator(inner, {
				condition: condition!,
				success: { block: body, arguments: [] },
				fallback: { block: innerFallback, arguments: [] },
				fact: {
					kind: "bounded-call-target",
					value: [1, 2],
					claims: [identityClaim(subject!, ["function:1", "function:2"])],
					obligations,
					origin: "test",
				},
			});
			setReturns(builder, [body, outerFallback, innerFallback], subject!);
			const finished = builder.finish(entry);
			return { program, functionId: finished.function };
		};

		for (const [obligations, expected] of [
			[[], 1],
			[[{ kind: "fallback", id: "generic-call" }], 2],
			[[{ kind: "materialize", id: "boxed-copy" }], 2],
		] as const) {
			const built = nestedGuards(obligations);
			runProofs(built.program);
			expect(guardBlocks(fn(built.program, built.functionId))).toHaveLength(expected);
		}
	});

	it("leaves canonical facts unchanged when the proof worklist is rerun", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{}, {}]);
		const inner = builder.createBlock();
		const body = builder.createBlock();
		const outerFallback = builder.createBlock();
		const innerFallback = builder.createBlock();
		const [subject, condition] = inspectCoreBlockParameters(builder, entry).map(
			({ value }) => value,
		);
		builder.setGuardTerminator(entry, {
			condition: condition!,
			success: { block: inner, arguments: [] },
			fallback: { block: outerFallback, arguments: [] },
			fact: {
				kind: "closed-call-target",
				value: 1,
				claims: [
					identityClaim(subject!, ["function:2", "function:1"]),
					identityClaim(subject!, ["function:1"]),
				],
				origin: "test",
			},
		});
		builder.setGuardTerminator(inner, {
			condition: condition!,
			success: { block: body, arguments: [] },
			fallback: { block: innerFallback, arguments: [] },
			fact: {
				kind: "bounded-call-target",
				value: [1, 2],
				claims: [identityClaim(subject!, ["function:2", "function:1"])],
				origin: "test",
			},
		});
		setReturns(builder, [body, outerFallback, innerFallback], subject!);
		const finished = builder.finish(entry);
		runProofs(program);
		const owner = fn(program, finished.function);
		const snapshot = JSON.stringify({
			versions: owner.versions,
			facts: facts(owner),
			terminators: [...owner.blockIds()].map((block) =>
				inspectCoreTerminatorPayload(owner, owner.blockTerminator(block)),
			),
		});

		runProofs(program);
		expect(
			JSON.stringify({
				versions: owner.versions,
				facts: facts(owner),
				terminators: [...owner.blockIds()].map((block) =>
					inspectCoreTerminatorPayload(owner, owner.blockTerminator(block)),
				),
			}),
		).toBe(snapshot);
	});

	it("orders range claims by denotation instead of spelling", () => {
		const subject = coreValueId(0);
		const range = (
			bounds: Partial<
				Omit<Extract<CoreFactClaim, { kind: "range" }>, "kind" | "subject">
			>,
		): CoreFactClaim => rangeClaim(subject, bounds);

		for (const [strong, weak] of [
			[range({ minimum: Number.NEGATIVE_INFINITY }), range({ minimum: null })],
			[range({ minimum: null }), range({ minimum: Number.NEGATIVE_INFINITY })],
			[range({ maximum: Number.POSITIVE_INFINITY }), range({ maximum: null })],
			[
				range({ minimum: 0.5, maximum: 3.5, integer: true }),
				range({ minimum: 1, maximum: 3, integer: true }),
			],
			[range({ mayBeNaN: false }), range({ mayBeNaN: true })],
			[range({ mayBeNegativeZero: false }), range({ mayBeNegativeZero: true })],
		] as const) {
			expect(coreFactClaimImplies(strong, weak)).toBe(true);
		}
		for (const [strong, weak] of [
			[range({ mayBeNaN: true }), range({ mayBeNaN: false })],
			[range({ mayBeNegativeZero: true }), range({ mayBeNegativeZero: false })],
			[range({ minimum: 5, maximum: 4 }), range({ minimum: 0, maximum: 10 })],
			[
				range({ minimum: 0.2, maximum: 0.8, integer: true }),
				range({ minimum: 0, maximum: 1, integer: true }),
			],
		] as const) {
			expect(coreFactClaimImplies(strong, weak)).toBe(false);
		}
		expect(
			normalizeCoreFactClaims([
				range({
					minimum: Number.NEGATIVE_INFINITY,
					maximum: 3.5,
					integer: true,
				}),
			]),
		).toEqual([range({ minimum: null, maximum: 3, integer: true })]);
	});

	it("removes a range guard only when the dominating range covers every case", () => {
		const rangeGuards = (weak: CoreFactClaim, strong: CoreFactClaim) => {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock([{}]);
			const inner = builder.createBlock();
			const body = builder.createBlock();
			const outerFallback = builder.createBlock();
			const innerFallback = builder.createBlock();
			const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
			builder.setGuardTerminator(entry, {
				condition,
				success: { block: inner, arguments: [] },
				fallback: { block: outerFallback, arguments: [] },
				fact: {
					kind: "narrow-range",
					value: 1,
					claims: [strong],
					origin: "test",
				},
			});
			builder.setGuardTerminator(inner, {
				condition,
				success: { block: body, arguments: [] },
				fallback: { block: innerFallback, arguments: [] },
				fact: { kind: "wide-range", value: 2, claims: [weak], origin: "test" },
			});
			setReturns(builder, [body, outerFallback, innerFallback], condition);
			const finished = builder.finish(entry);
			return { program, functionId: finished.function };
		};
		const subject = coreValueId(0);
		const covered = rangeGuards(
			rangeClaim(subject, {
				minimum: 0,
				maximum: 10,
				mayBeNaN: true,
				mayBeNegativeZero: true,
			}),
			rangeClaim(subject, { minimum: 1, maximum: 3, integer: true }),
		);
		runProofs(covered.program);
		expect(guardBlocks(fn(covered.program, covered.functionId))).toHaveLength(1);

		const uncovered = rangeGuards(
			rangeClaim(subject, { minimum: 0, maximum: 10 }),
			rangeClaim(subject, { minimum: 1, maximum: 3, mayBeNaN: true }),
		);
		runProofs(uncovered.program);
		expect(guardBlocks(fn(uncovered.program, uncovered.functionId))).toHaveLength(2);
	});

	it("keeps alternatives that spell the separator apart", () => {
		const subject = coreValueId(0);
		const shape = (shapes: ReadonlyArray<string>): CoreFactClaim => ({
			kind: "shape",
			subject,
			shapes,
		});
		expect(normalizeCoreFactClaims([shape(["a,b"]), shape(["a", "b"])])).toHaveLength(2);
		expect(coreFactClaimImplies(shape(["a,b"]), shape(["a", "b"]))).toBe(false);
		expect(normalizeCoreFactClaims([shape(["a", "b"]), shape(["a,b"])])).toEqual(
			normalizeCoreFactClaims([shape(["a,b"]), shape(["a", "b"])]),
		);
	});

	it("keeps a re-proved refinement on the fact its verifier check selects", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{}]);
		const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [result] = builder.appendInstruction(entry, "call", [parameter, parameter]);
		builder.setTerminator(entry, { kind: "return", value: result! });
		const finished = builder.finish(entry);
		const owner = fn(program, finished.function);
		const definition = inspectCoreValueDefinition(owner, result!);
		if (definition.kind !== "instruction") throw new Error("expected call result");
		const editor = CoreEditor.open(program, finished.function);
		const ownProof = editor.addFact({
			kind: CORE_OWN_DATA_CELL_FACT,
			value: null,
			claims: [
				{
					kind: "effect",
					instruction: definition.instruction,
					effects: CORE_NO_EFFECTS,
				},
			],
			validity: { kind: "summary", digest: "contained-allocation:test" },
			obligations: [],
			origin: "local-shape-provenance",
		});
		editor.addFact({
			kind: "test-tighter-effects",
			value: null,
			claims: [
				{
					kind: "effect",
					instruction: definition.instruction,
					effects: CORE_NO_EFFECTS,
				},
			],
			validity: { kind: "summary", digest: "test-tighter-effects" },
			obligations: [],
			origin: "test",
		});
		editor.setInstructionEffectRefinement(definition.instruction, {
			effects: CORE_NO_EFFECTS,
			proof: ownProof,
		});
		editor.commit();

		runProofs(program);
		expect(owner.instructionEffectRefinement(definition.instruction)?.proof).toBe(
			ownProof,
		);
		expect(owner.fact(ownProof).kind).toBe(CORE_OWN_DATA_CELL_FACT);
	});

	it("does not use a claim about a value the consumer cannot see", () => {
		const build = (subjectOnSiblingPath: boolean) => {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock([{}, {}]);
			const mid = builder.createBlock();
			const left = builder.createBlock();
			const right = builder.createBlock();
			const strongFallback = builder.createBlock();
			const weakSuccess = builder.createBlock();
			const weakFallback = builder.createBlock();
			const [selector, condition] = inspectCoreBlockParameters(builder, entry).map(
				({ value }) => value,
			);
			const [subject] = builder.appendInstruction(
				subjectOnSiblingPath ? left : mid,
				"createBoolean",
				[],
				{ attributes: { value: true } },
			);
			builder.setGuardTerminator(entry, {
				condition: condition!,
				success: { block: mid, arguments: [] },
				fallback: { block: strongFallback, arguments: [] },
				fact: {
					kind: "closed-call-target",
					value: 1,
					claims: [identityClaim(subject!, ["function:1"])],
					origin: "test",
				},
			});
			builder.setTerminator(mid, {
				kind: "branch",
				condition: selector!,
				consequent: { block: left, arguments: [] },
				alternate: { block: right, arguments: [] },
			});
			builder.setTerminator(left, { kind: "return", value: subject! });
			builder.setGuardTerminator(right, {
				condition: condition!,
				success: { block: weakSuccess, arguments: [] },
				fallback: { block: weakFallback, arguments: [] },
				fact: {
					kind: "bounded-call-target",
					value: [1, 2],
					claims: [identityClaim(subject!, ["function:1", "function:2"])],
					origin: "test",
				},
			});
			setReturns(builder, [strongFallback, weakSuccess, weakFallback], condition!);
			const finished = builder.finish(entry);
			return { program, functionId: finished.function };
		};

		const visible = build(false);
		runProofs(visible.program);
		expect(guardBlocks(fn(visible.program, visible.functionId))).toHaveLength(1);
		const hidden = build(true);
		runProofs(hidden.program);
		expect(guardBlocks(fn(hidden.program, hidden.functionId))).toHaveLength(2);
	});

	it("canonicalizes the claims of a function that carries a single fact", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{}]);
		const success = builder.createBlock();
		const fallback = builder.createBlock();
		const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const fact = builder.setGuardTerminator(entry, {
			condition,
			success: { block: success, arguments: [] },
			fallback: { block: fallback, arguments: [] },
			fact: {
				kind: "bounded-call-target",
				value: [2, 1],
				claims: [
					identityClaim(condition, ["function:2", "function:1", "function:2"]),
					identityClaim(condition, ["function:1", "function:2"]),
				],
				origin: "test",
			},
		});
		setReturns(builder, [success, fallback], condition);
		const finished = builder.finish(entry);
		const before = fn(program, finished.function).versions;

		runProofs(program);
		const owner = fn(program, finished.function);
		expect(facts(owner)).toHaveLength(1);
		expect(facts(owner)[0]?.id).toBe(fact);
		expect(facts(owner)[0]?.claims).toEqual([
			identityClaim(condition, ["function:1", "function:2"]),
		]);
		expect(owner.versions).toEqual({
			...before,
			facts: before.facts + 1,
			specializationInputs: before.specializationInputs + 1,
		});
	});
});
