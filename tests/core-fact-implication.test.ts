import { describe, expect, it } from "vitest";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import {
	coreFactClaimImplies,
	normalizeCoreFactClaims,
} from "../src/compiler/core/core-ir-fact-implication.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { executeCoreOptimizations } from "../src/compiler/core/core-ir-opt.ts";
import { CORE_OWN_DATA_CELL_FACT } from "../src/compiler/core/core-ir-provenance.ts";
import type {
	CoreFact,
	CoreFactClaim,
	CoreFactId,
	CoreFactObligation,
	CoreFunction,
	CoreInstructionEffects,
	CoreProgram,
	CoreValueId,
} from "../src/compiler/core/core-ir.ts";
import {
	CORE_NO_EFFECTS,
	CoreFunctionBuilder,
	coreFactId,
	coreInstructionId,
	coreValueId,
} from "../src/compiler/core/core-ir.ts";

function program(fn: CoreFunction): CoreProgram {
	return {
		functions: [fn],
		stringConstants: [[]],
		bigintConstants: [],
		literalTemplateData: [],
		sourcePositions: [],
		globalCount: 0,
	};
}

function optimize(fn: CoreFunction): CoreFunction {
	return executeCoreOptimizations(program(fn), { verification: "per-pass" }).program
		.functions[0]!;
}

function guardBlocks(fn: CoreFunction): ReadonlyArray<CoreFunction["blocks"][number]> {
	return fn.blocks.filter(({ terminator }) => terminator.kind === "guard");
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

/** Graph shape of a function, for invariants that must survive re-optimization. */
function graphShape(fn: CoreFunction): string {
	return JSON.stringify({
		entry: fn.entry,
		blocks: fn.blocks,
		values: fn.values,
		facts: fn.facts,
		regions: fn.regions,
	});
}

describe("Core fact implication", () => {
	it("orders finite identity, shape, range, and effect claims by precision", () => {
		const subject = coreValueId(0);
		const instruction = coreInstructionId(0);
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
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const strongSuccess = builder.createBlock();
		const strongFallback = builder.createBlock();
		const weakSuccess = builder.createBlock();
		const weakFallback = builder.createBlock();
		const condition = builder.block(entry).parameters[0]!.value;
		builder.setGuardTerminator(entry, {
			condition,
			success: { block: strongSuccess, arguments: [] },
			fallback: { block: strongFallback, arguments: [] },
			fact: {
				kind: "closed-call-target",
				value: 1,
				claims: [{ kind: "identity", subject: condition, identities: ["function:1"] }],
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
				claims: [
					{
						kind: "identity",
						subject: condition,
						identities: ["function:1", "function:2"],
					},
				],
				origin: "test",
			},
		});
		builder.setTerminator(weakSuccess, { kind: "return", value: condition });
		const [strongMiss] = builder.appendInstruction(strongFallback, "createBoolean", [], {
			attributes: { value: false },
		});
		builder.setTerminator(strongFallback, { kind: "return", value: strongMiss! });
		const [weakMiss] = builder.appendInstruction(weakFallback, "createBoolean", [], {
			attributes: { value: false },
		});
		builder.setTerminator(weakFallback, { kind: "return", value: weakMiss! });

		const optimized = executeCoreOptimizations(program(builder.finish(entry)), {
			verification: "per-pass",
		}).program.functions[0]!;
		expect(
			optimized.blocks.filter(({ terminator }) => terminator.kind === "guard"),
		).toHaveLength(1);
		expect(optimized.facts).toHaveLength(1);
		expect(optimized.facts[0]?.claims).toEqual([
			{ kind: "identity", subject: condition, identities: ["function:1"] },
		]);
	});

	it("does not use a stronger fact from a sibling control-flow path", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 4 });
		const entry = builder.createBlock([{}, {}, {}, {}]);
		const strongEntry = builder.createBlock();
		const weakEntry = builder.createBlock();
		const strongSuccess = builder.createBlock();
		const strongFallback = builder.createBlock();
		const weakSuccess = builder.createBlock();
		const weakFallback = builder.createBlock();
		const [branch, subject, strongCondition, weakCondition] = builder
			.block(entry)
			.parameters.map(({ value }) => value);
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
				claims: [{ kind: "identity", subject: subject!, identities: ["function:1"] }],
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
				claims: [
					{
						kind: "identity",
						subject: subject!,
						identities: ["function:1", "function:2"],
					},
				],
				origin: "test",
			},
		});
		for (const block of [strongSuccess, strongFallback, weakSuccess, weakFallback]) {
			builder.setTerminator(block, { kind: "return", value: subject! });
		}

		const optimized = executeCoreOptimizations(program(builder.finish(entry)), {
			verification: "per-pass",
		}).program.functions[0]!;
		expect(
			optimized.blocks.filter(({ terminator }) => terminator.kind === "guard"),
		).toHaveLength(2);
	});

	it("rewires a weaker effect refinement to a stronger global proof", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const parameter = builder.block(entry).parameters[0]!.value;
		const strong = builder.addFact({
			kind: "strong-effects",
			value: true,
			claims: [],
			validity: { kind: "summary", digest: "strong" },
			obligations: [],
			origin: "test",
		});
		const weak = builder.addFact({
			kind: "weak-effects",
			value: true,
			claims: [],
			validity: { kind: "summary", digest: "weak" },
			obligations: [],
			origin: "test",
		});
		const weakerEffects: CoreInstructionEffects = { ...CORE_NO_EFFECTS, mayGc: true };
		const [result] = builder.appendInstruction(entry, "call", [parameter, parameter], {
			effectRefinement: { effects: weakerEffects, proof: weak },
		});
		builder.setTerminator(entry, { kind: "return", value: result! });
		const built = builder.finish(entry);
		const call = built.blocks[entry]!.instructions[0]!;
		const facts = built.facts.map((fact): CoreFact => {
			if (fact.id === strong) {
				return {
					...fact,
					claims: [{ kind: "effect", instruction: call.id, effects: CORE_NO_EFFECTS }],
				};
			}
			return fact.id === weak
				? {
						...fact,
						claims: [{ kind: "effect", instruction: call.id, effects: weakerEffects }],
					}
				: fact;
		});

		const optimized = executeCoreOptimizations(program({ ...built, facts }), {
			verification: "per-pass",
		}).program.functions[0]!;
		const optimizedCall = optimized.blocks
			.flatMap(({ instructions }) => instructions)
			.find(({ opcode }) => opcode === "call");
		expect(optimizedCall?.effectRefinement?.proof).toBe(strong);
		expect(optimized.facts.map(({ id }) => id)).toEqual([strong]);
	});
	it("does not license a later guard from a proof another path bypasses", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 4 });
		const entry = builder.createBlock([{}, {}, {}, {}]);
		const guarded = builder.createBlock();
		const bypass = builder.createBlock();
		const join = builder.createBlock();
		const strongFallback = builder.createBlock();
		const weakSuccess = builder.createBlock();
		const weakFallback = builder.createBlock();
		const [selector, subject, strongCondition, weakCondition] = builder
			.block(entry)
			.parameters.map(({ value }) => value);
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
		builder.setTerminator(bypass, { kind: "jump", edge: { block: join, arguments: [] } });
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
		for (const block of [strongFallback, weakSuccess, weakFallback]) {
			builder.setTerminator(block, { kind: "return", value: subject! });
		}

		const optimized = optimize(builder.finish(entry));
		expect(guardBlocks(optimized)).toHaveLength(2);
		expect(optimized.facts).toHaveLength(2);
	});

	it("keeps the entry check when two guards prove each other around a back edge", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 2 });
		const entry = builder.createBlock([{}, {}]);
		const header = builder.createBlock();
		const body = builder.createBlock();
		const headerFallback = builder.createBlock();
		const bodyFallback = builder.createBlock();
		const [subject, condition] = builder
			.block(entry)
			.parameters.map(({ value }) => value);
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
		for (const block of [headerFallback, bodyFallback]) {
			builder.setTerminator(block, { kind: "return", value: subject! });
		}

		// The latch re-check is redundant behind the header's success edge; the
		// header check is not, because the first iteration has proven nothing.
		const optimized = optimize(builder.finish(entry));
		const guards = guardBlocks(optimized);
		expect(guards).toHaveLength(1);
		expect(optimized.facts).toHaveLength(1);
		const cfg = buildCoreControlFlow(optimized, coreOpcodeRegistry);
		for (const block of optimized.blocks) {
			if (block.id === optimized.entry) continue;
			expect(cfg.dominates(guards[0]!.id, block.id)).toBe(true);
		}
	});

	it("keeps both guards of a cycle no single success edge dominates", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 3 });
		const entry = builder.createBlock([{}, {}, {}]);
		const first = builder.createBlock();
		const second = builder.createBlock();
		const firstFallback = builder.createBlock();
		const secondFallback = builder.createBlock();
		const [selector, subject, condition] = builder
			.block(entry)
			.parameters.map(({ value }) => value);
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
		for (const block of [firstFallback, secondFallback]) {
			builder.setTerminator(block, { kind: "return", value: subject! });
		}

		const optimized = optimize(builder.finish(entry));
		expect(guardBlocks(optimized)).toHaveLength(2);
		expect(optimized.facts).toHaveLength(2);
	});

	it("never leaves an effect refinement naming a removed fact", () => {
		// Building the inner guard's fact first makes it the one an equal-strength
		// tie-break keeps, so the fold cannot lean on the proof having been rewired
		// onto the surviving fact first.
		const guardedCall = (innerFirst: boolean): CoreFunction => {
			const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
				parameterCount: 2,
			});
			const entry = builder.createBlock([{}, {}]);
			const inner = builder.createBlock();
			const body = builder.createBlock();
			const outerFallback = builder.createBlock();
			const innerFallback = builder.createBlock();
			const [subject, condition] = builder
				.block(entry)
				.parameters.map(({ value }) => value);
			const claims = [identityClaim(subject!, ["function:1"])];
			const outerGuard = (): CoreFactId =>
				builder.setGuardTerminator(entry, {
					condition: condition!,
					success: { block: inner, arguments: [] },
					fallback: { block: outerFallback, arguments: [] },
					fact: { kind: "outer-identity", value: 1, claims, origin: "test" },
				});
			const innerGuard = (): CoreFactId =>
				builder.setGuardTerminator(inner, {
					condition: condition!,
					success: { block: body, arguments: [] },
					fallback: { block: innerFallback, arguments: [] },
					fact: { kind: "inner-identity", value: 1, claims, origin: "test" },
				});
			let proof: CoreFactId;
			if (innerFirst) {
				proof = innerGuard();
				outerGuard();
			} else {
				proof = outerGuard();
				innerGuard();
			}
			const [result] = builder.appendInstruction(body, "call", [subject!, subject!], {
				effectRefinement: { effects: { ...CORE_NO_EFFECTS, mayGc: true }, proof },
			});
			builder.setTerminator(body, { kind: "return", value: result! });
			for (const block of [outerFallback, innerFallback]) {
				builder.setTerminator(block, { kind: "return", value: subject! });
			}
			const built = builder.finish(entry);
			const call = built.blocks[body]!.instructions[0]!;
			return {
				...built,
				facts: built.facts.map(
					(fact): CoreFact => ({
						...fact,
						claims: [
							...fact.claims,
							{ kind: "effect", instruction: call.id, effects: CORE_NO_EFFECTS },
						],
					}),
				),
			};
		};
		const refinementProofs = (fn: CoreFunction): ReadonlyArray<CoreFactId> =>
			fn.blocks.flatMap(({ instructions }) =>
				instructions.flatMap(({ effectRefinement }) =>
					effectRefinement === undefined ? [] : [effectRefinement.proof],
				),
			);

		for (const innerFirst of [false, true]) {
			const optimized = optimize(guardedCall(innerFirst));
			const surviving = new Set(optimized.facts.map(({ id }) => id));
			const proofs = refinementProofs(optimized);
			expect(proofs).toHaveLength(1);
			expect(proofs.every((proof) => surviving.has(proof))).toBe(true);
		}
		// The redundant inner check still goes when no refinement depends on it.
		expect(guardBlocks(optimize(guardedCall(false)))).toHaveLength(1);
		expect(guardBlocks(optimize(guardedCall(true)))).toHaveLength(2);
	});

	it("keeps a guard whose fact still owes a fallback or a materialization", () => {
		const nestedGuards = (
			obligations: ReadonlyArray<Exclude<CoreFactObligation, { kind: "guard" }>>,
		): CoreFunction => {
			const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
				parameterCount: 2,
			});
			const entry = builder.createBlock([{}, {}]);
			const inner = builder.createBlock();
			const body = builder.createBlock();
			const outerFallback = builder.createBlock();
			const innerFallback = builder.createBlock();
			const [subject, condition] = builder
				.block(entry)
				.parameters.map(({ value }) => value);
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
			for (const block of [body, outerFallback, innerFallback]) {
				builder.setTerminator(block, { kind: "return", value: subject! });
			}
			return builder.finish(entry);
		};

		expect(guardBlocks(optimize(nestedGuards([])))).toHaveLength(1);
		expect(
			guardBlocks(optimize(nestedGuards([{ kind: "fallback", id: "generic-call" }]))),
		).toHaveLength(2);
		expect(
			guardBlocks(optimize(nestedGuards([{ kind: "materialize", id: "boxed-copy" }]))),
		).toHaveLength(2);
	});

	it("reaches a fixed point on an already optimized function", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 2 });
		const entry = builder.createBlock([{}, {}]);
		const inner = builder.createBlock();
		const body = builder.createBlock();
		const outerFallback = builder.createBlock();
		const innerFallback = builder.createBlock();
		const [subject, condition] = builder
			.block(entry)
			.parameters.map(({ value }) => value);
		builder.setGuardTerminator(entry, {
			condition: condition!,
			success: { block: inner, arguments: [] },
			fallback: { block: outerFallback, arguments: [] },
			fact: {
				kind: "closed-call-target",
				value: 1,
				// Deliberately unsorted and redundant: the first run has canonicalization
				// to do, the second must have none left.
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
		for (const block of [body, outerFallback, innerFallback]) {
			builder.setTerminator(block, { kind: "return", value: subject! });
		}

		const once = optimize(builder.finish(entry));
		expect(guardBlocks(once)).toHaveLength(1);
		expect(once.facts[0]?.claims).toEqual([identityClaim(subject!, ["function:1"])]);
		expect(graphShape(optimize(once))).toBe(graphShape(once));
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
			// A claim no value satisfies is maximally strong in the ordering, so it
			// must not be usable as a proof of anything.
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
		const rangeGuards = (weak: CoreFactClaim, strong: CoreFactClaim): CoreFunction => {
			const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
				parameterCount: 1,
			});
			const entry = builder.createBlock([{}]);
			const inner = builder.createBlock();
			const body = builder.createBlock();
			const outerFallback = builder.createBlock();
			const innerFallback = builder.createBlock();
			const condition = builder.block(entry).parameters[0]!.value;
			builder.setGuardTerminator(entry, {
				condition,
				success: { block: inner, arguments: [] },
				fallback: { block: outerFallback, arguments: [] },
				fact: { kind: "narrow-range", value: 1, claims: [strong], origin: "test" },
			});
			builder.setGuardTerminator(inner, {
				condition,
				success: { block: body, arguments: [] },
				fallback: { block: innerFallback, arguments: [] },
				fact: { kind: "wide-range", value: 2, claims: [weak], origin: "test" },
			});
			for (const block of [body, outerFallback, innerFallback]) {
				builder.setTerminator(block, { kind: "return", value: condition });
			}
			return builder.finish(entry);
		};
		const subject = coreValueId(0);

		expect(
			guardBlocks(
				optimize(
					rangeGuards(
						rangeClaim(subject, {
							minimum: 0,
							maximum: 10,
							mayBeNaN: true,
							mayBeNegativeZero: true,
						}),
						rangeClaim(subject, { minimum: 1, maximum: 3, integer: true }),
					),
				),
			),
		).toHaveLength(1);
		expect(
			guardBlocks(
				optimize(
					rangeGuards(
						rangeClaim(subject, { minimum: 0, maximum: 10 }),
						rangeClaim(subject, { minimum: 1, maximum: 3, mayBeNaN: true }),
					),
				),
			),
		).toHaveLength(2);
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
		// Canonical form is a function of the claims, not of the order they arrive in.
		expect(normalizeCoreFactClaims([shape(["a", "b"]), shape(["a,b"])])).toEqual(
			normalizeCoreFactClaims([shape(["a,b"]), shape(["a", "b"])]),
		);
	});
	it("keeps a re-proved refinement on the fact its own verifier check selects", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 2 });
		const entry = builder.createBlock([{}, {}]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock();
		const [selector, value] = builder.block(entry).parameters.map(({ value }) => value);
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [value!], {
			attributes: { keyStringIndices: [1] },
		});
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [zero] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 0 },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: selector!,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		builder.appendInstruction(left, "storePropertyStatic", [object!, one!], {
			attributes: { stringIndex: 1 },
		});
		builder.setTerminator(left, { kind: "jump", edge: { block: join, arguments: [] } });
		builder.appendInstruction(right, "storePropertyStatic", [object!, zero!], {
			attributes: { stringIndex: 1 },
		});
		builder.setTerminator(right, { kind: "jump", edge: { block: join, arguments: [] } });
		const [loaded] = builder.appendInstruction(join, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 1 },
		});
		builder.setTerminator(join, { kind: "return", value: loaded! });
		const built = builder.finish(entry);
		const access = built.blocks[left]!.instructions.find(
			({ opcode }) => opcode === "storePropertyStatic",
		)!;
		// A summary fact that bounds the same access more tightly. It must not become
		// the store's proof: the verifier selects its independent containment re-proof
		// by the proof's fact kind, so moving the proof would silence that check.
		const competing: CoreFact = {
			id: coreFactId(built.facts.length),
			kind: "test-tighter-effects",
			value: null,
			claims: [{ kind: "effect", instruction: access.id, effects: CORE_NO_EFFECTS }],
			validity: { kind: "summary", digest: "test-tighter-effects" },
			obligations: [{ kind: "fallback", id: "generic-store" }],
			origin: "test",
		};

		const optimized = executeCoreOptimizations(
			{
				...program({ ...built, facts: [...built.facts, competing] }),
				stringConstants: [[], [102]],
			},
			{ verification: "per-pass" },
		).program.functions[0]!;
		const refined = optimized.blocks
			.flatMap(({ instructions }) => instructions)
			.find(({ id }) => id === access.id);
		expect(refined?.effectRefinement).toBeDefined();
		expect(
			optimized.facts.find(({ id }) => id === refined?.effectRefinement?.proof)?.kind,
		).toBe(CORE_OWN_DATA_CELL_FACT);
	});
	it("does not use a claim about a value the consumer cannot see", () => {
		// A claim carries no program point: it says nothing where its subject is not
		// yet defined, however well the proving guard's success edge dominates.
		const build = (subjectOnSiblingPath: boolean): CoreFunction => {
			const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
				parameterCount: 2,
			});
			const entry = builder.createBlock([{}, {}]);
			const mid = builder.createBlock();
			const left = builder.createBlock();
			const right = builder.createBlock();
			const strongFallback = builder.createBlock();
			const weakSuccess = builder.createBlock();
			const weakFallback = builder.createBlock();
			const [selector, condition] = builder
				.block(entry)
				.parameters.map(({ value }) => value);
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
			for (const block of [strongFallback, weakSuccess, weakFallback]) {
				builder.setTerminator(block, { kind: "return", value: condition! });
			}
			return builder.finish(entry);
		};

		expect(guardBlocks(optimize(build(false)))).toHaveLength(1);
		expect(guardBlocks(optimize(build(true)))).toHaveLength(2);
	});

	it("canonicalizes the claims of a function that carries a single fact", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const success = builder.createBlock();
		const fallback = builder.createBlock();
		const condition = builder.block(entry).parameters[0]!.value;
		builder.setGuardTerminator(entry, {
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
		for (const block of [success, fallback]) {
			builder.setTerminator(block, { kind: "return", value: condition });
		}

		const optimized = optimize(builder.finish(entry));
		expect(optimized.facts).toHaveLength(1);
		expect(optimized.facts[0]?.claims).toEqual([
			identityClaim(condition, ["function:1", "function:2"]),
		]);
	});
});
