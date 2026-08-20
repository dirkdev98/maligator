import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { CoreProgram } from "../src/compiler/core/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToVmDefinition } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerGuardPlan,
	compilerProgramFactsFromConfig,
	joinFacts,
	knownFact,
} from "../src/compiler/shared/compiler-facts.ts";
import type { FactProof } from "../src/compiler/shared/compiler-facts.ts";
import {
	authorityFallback,
	factDependenciesDischarge,
	factDependencyImplies,
	normalizeFactDependencies,
	normalizeFactObligations,
	normalizeFactRequirements,
} from "../src/compiler/shared/fact-implication.ts";

const LOCKED = { kind: "world", fact: "primordials.locked" } as const;
const AUTHORITY = { kind: "world", fact: "authority.closed" } as const;
const SOURCE = { kind: "world", fact: "source.closed" } as const;
const EVAL_DISABLED = { kind: "world", fact: "eval.disabled" } as const;
const WATCHED = { kind: "epoch", family: "watched-methods" } as const;
const SHAPES = { kind: "epoch", family: "object-shapes" } as const;
const BINDINGS = { kind: "epoch", family: "global-bindings" } as const;

describe("fact dependency implication", () => {
	it("implies the weaker world statement in each closure pair", () => {
		expect(factDependencyImplies(SOURCE, EVAL_DISABLED)).toBe(true);
		expect(factDependencyImplies(AUTHORITY, LOCKED)).toBe(true);
		expect(factDependencyImplies(EVAL_DISABLED, SOURCE)).toBe(false);
		expect(factDependencyImplies(LOCKED, AUTHORITY)).toBe(false);
		expect(factDependencyImplies(SOURCE, LOCKED)).toBe(false);
	});

	it("satisfies exactly the epoch families the primordial lock covers", () => {
		for (const family of [
			"primitive-methods",
			"watched-methods",
			"array-elements",
		] as const) {
			expect(factDependencyImplies(LOCKED, { kind: "epoch", family })).toBe(true);
			expect(factDependencyImplies(AUTHORITY, { kind: "epoch", family })).toBe(true);
		}
		expect(factDependencyImplies(LOCKED, BINDINGS)).toBe(false);
		expect(factDependencyImplies(LOCKED, SHAPES)).toBe(false);
		expect(factDependencyImplies(AUTHORITY, SHAPES)).toBe(false);
	});

	it("is reflexive and rejects unrelated dependencies", () => {
		expect(factDependencyImplies(WATCHED, WATCHED)).toBe(true);
		expect(
			factDependencyImplies({ kind: "guard", id: "a" }, { kind: "guard", id: "a" }),
		).toBe(true);
		expect(factDependencyImplies({ kind: "guard", id: "a" }, LOCKED)).toBe(false);
		expect(factDependencyImplies(LOCKED, { kind: "summary", id: "s" })).toBe(false);
	});

	it("only a world dependency discharges a witness", () => {
		expect(factDependenciesDischarge([LOCKED], WATCHED)).toBe(true);
		expect(factDependenciesDischarge([WATCHED], WATCHED)).toBe(false);
		expect(factDependenciesDischarge([LOCKED], SHAPES)).toBe(false);
		expect(factDependenciesDischarge([], LOCKED)).toBe(false);
	});
});

describe("fact dependency normalization", () => {
	it("removes the weaker duplicate and keeps a canonical order", () => {
		expect(normalizeFactDependencies([WATCHED, LOCKED])).toEqual([LOCKED]);
		expect(normalizeFactDependencies([LOCKED, AUTHORITY, WATCHED])).toEqual([AUTHORITY]);
		expect(normalizeFactDependencies([EVAL_DISABLED, SOURCE])).toEqual([SOURCE]);
	});

	it("keeps dependencies the lock does not cover", () => {
		expect(normalizeFactDependencies([LOCKED, SHAPES])).toEqual([SHAPES, LOCKED]);
		expect(normalizeFactDependencies([LOCKED, BINDINGS])).toEqual([BINDINGS, LOCKED]);
		expect(normalizeFactDependencies([LOCKED, { kind: "guard", id: "g" }])).toEqual([
			{ kind: "guard", id: "g" },
			LOCKED,
		]);
	});

	it("deduplicates repeated dependencies deterministically", () => {
		expect(normalizeFactDependencies([WATCHED, WATCHED, LOCKED, LOCKED])).toEqual([
			LOCKED,
		]);
		expect(normalizeFactDependencies([LOCKED, SHAPES])).toEqual(
			normalizeFactDependencies([SHAPES, LOCKED]),
		);
	});
});

describe("obligation discharge", () => {
	it("discharges an authority fallback whose witness the world establishes", () => {
		expect(
			normalizeFactObligations([authorityFallback("generic-call", LOCKED)], [LOCKED]),
		).toEqual([]);
		expect(
			normalizeFactObligations(
				[authorityFallback("generic-operation", WATCHED)],
				[LOCKED],
			),
		).toEqual([]);
	});

	it("retains an authority fallback with no world witness", () => {
		const obligations = [authorityFallback("generic-operation", WATCHED)];
		expect(normalizeFactObligations(obligations, [WATCHED])).toEqual(obligations);
		expect(normalizeFactObligations(obligations, [])).toEqual(obligations);
	});

	it("never discharges a global-bindings or object-shapes epoch under a locked world", () => {
		for (const witness of [BINDINGS, SHAPES]) {
			const obligations = [authorityFallback("generic-operation", witness)];
			expect(normalizeFactObligations(obligations, [LOCKED, witness])).toEqual(
				obligations,
			);
		}
	});

	it("keeps an uncovered authority duty when witnesses share a site identifier", () => {
		expect(
			normalizeFactObligations(
				[
					authorityFallback("generic-operation", WATCHED),
					authorityFallback("generic-operation", SHAPES),
				],
				[LOCKED],
			),
		).toEqual([authorityFallback("generic-operation", SHAPES)]);
	});

	it("retains every semantic and materialization obligation in a locked world", () => {
		const obligations = [
			{ kind: "fallback", id: "callee", cause: "loaded-callee" },
			{ kind: "fallback", id: "receiver", cause: "receiver-identity" },
			{ kind: "fallback", id: "numbers", cause: "value-class" },
			{ kind: "fallback", id: "realm", cause: "realm" },
			{ kind: "fallback", id: "stack", cause: "escape" },
			{ kind: "fallback", id: "args", cause: "arity" },
			{ kind: "fallback", id: "twin", cause: "materialization" },
			{ kind: "fallback", id: "wire", cause: "runtime-contract" },
			{ kind: "materialize", id: "twin", cause: "escape" },
		] as const;
		expect(normalizeFactObligations([...obligations], [AUTHORITY, LOCKED])).toHaveLength(
			obligations.length,
		);
	});

	it("keeps the non-dischargeable duty when two obligations share one identifier", () => {
		expect(
			normalizeFactObligations(
				[
					authorityFallback("generic-call", LOCKED),
					{ kind: "fallback", id: "generic-call", cause: "loaded-callee" },
				],
				[LOCKED],
			),
		).toEqual([{ kind: "fallback", id: "generic-call", cause: "loaded-callee" }]);
	});

	it("tests obligations against the normalized dependency set", () => {
		expect(
			normalizeFactRequirements({
				dependencies: [LOCKED, WATCHED, SHAPES],
				obligations: [
					authorityFallback("watched", WATCHED),
					authorityFallback("shapes", SHAPES),
				],
			}),
		).toEqual({
			dependencies: [SHAPES, LOCKED],
			obligations: [authorityFallback("shapes", SHAPES)],
		});
	});
});

describe("joined proofs and guard plans", () => {
	const proof = (
		dependencies: FactProof["dependencies"],
		obligations: FactProof["obligations"],
	): FactProof => ({
		scope: { kind: "world" },
		dependencies,
		obligations,
		origin: "test",
	});

	it("joins a locked-world branch and a covered-epoch branch to the world proof", () => {
		const join = joinFacts(
			knownFact("value", proof([LOCKED], [])),
			knownFact(
				"value",
				proof([WATCHED], [authorityFallback("generic-operation", WATCHED)]),
			),
		);
		expect(join.fact.kind).toBe("known");
		if (join.fact.kind !== "known") throw new Error("expected a known join");
		expect(join.fact.proof.dependencies).toEqual([LOCKED]);
		expect(join.fact.proof.obligations).toEqual([]);
	});

	it("keeps the uncovered epoch and its fallback across a join", () => {
		const join = joinFacts(
			knownFact("value", proof([LOCKED], [])),
			knownFact(
				"value",
				proof([SHAPES], [authorityFallback("generic-operation", SHAPES)]),
			),
		);
		if (join.fact.kind !== "known") throw new Error("expected a known join");
		expect(join.fact.proof.dependencies).toEqual([SHAPES, LOCKED]);
		expect(join.fact.proof.obligations).toEqual([
			authorityFallback("generic-operation", SHAPES),
		]);
	});

	it("normalizes a guard plan without retiring its added semantic obligations", () => {
		const plan = compilerGuardPlan(
			[
				knownFact("value", proof([LOCKED], [])),
				knownFact(
					"value",
					proof([WATCHED], [authorityFallback("generic-operation", WATCHED)]),
				),
			],
			[{ kind: "fallback", id: "stack-object:1", cause: "escape" }],
		);
		expect(plan).toEqual({
			dependencies: [LOCKED],
			obligations: [{ kind: "fallback", id: "stack-object:1", cause: "escape" }],
		});
	});
});

interface ProbedCall {
	readonly opcode: string;
	readonly operation: string;
	readonly dependencies: ReadonlyArray<unknown>;
	readonly obligations: ReadonlyArray<unknown>;
}

function optimize(source: string, primordials: "locked" | "mutable"): CoreProgram {
	const semantic = analyzeSourceAndRunSemanticAnalysis(source, "fact-implication.js");
	let optimized: CoreProgram | undefined;
	compileSemanticProgramToVmDefinition(semantic, {
		facts: compilerProgramFactsFromConfig(
			resolveBuildConfig({ engine: { primordials } }),
		),
		afterCoreOptimization(program) {
			optimized = program;
		},
	});
	if (optimized === undefined) throw new Error("optimization produced no program");
	return optimized;
}

function builtinCalls(program: CoreProgram, operation: string): Array<ProbedCall> {
	const calls: Array<ProbedCall> = [];
	for (const fn of program.functions) {
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const call = instruction.attributes.knownBuiltinCall as
					| {
							readonly operation: string;
							readonly identity: {
								readonly kind: string;
								readonly proof?: {
									readonly dependencies: ReadonlyArray<unknown>;
									readonly obligations: ReadonlyArray<unknown>;
								};
							};
					  }
					| undefined;
				if (call?.operation !== operation || call.identity.proof === undefined) continue;
				calls.push({
					opcode: instruction.opcode,
					operation: call.operation,
					dependencies: call.identity.proof.dependencies,
					obligations: call.identity.proof.obligations,
				});
			}
		}
	}
	return calls;
}

function regionLicense(
	program: CoreProgram,
	kind: string,
): {
	readonly guard: {
		readonly dependencies: ReadonlyArray<unknown>;
		readonly obligations: ReadonlyArray<{
			readonly kind: string;
			readonly cause: string;
		}>;
	};
	readonly genericTwin: string;
} {
	for (const fn of program.functions) {
		for (const region of fn.regions) {
			if (region.kind !== kind) continue;
			return region.data.license as never;
		}
	}
	throw new Error(`no ${kind} region was selected`);
}

describe("closed-world obligation causes in Core", () => {
	it("keeps a semantic loaded-callee fallback for an arbitrary receiver in a locked world", () => {
		const calls = builtinCalls(
			optimize("function append(a, v) { a.push(v); return a.length; }", "locked"),
			"Array.prototype.push",
		);
		expect(calls).toEqual([
			{
				opcode: "call",
				operation: "Array.prototype.push",
				dependencies: [LOCKED],
				obligations: [
					expect.objectContaining({ kind: "fallback", cause: "loaded-callee" }),
				],
			},
		]);
	});

	it("keeps both the invalidation and the callee fallback in a mutable world", () => {
		const calls = builtinCalls(
			optimize("function append(a, v) { a.push(v); return a.length; }", "mutable"),
			"Array.prototype.push",
		);
		expect(calls[0]?.dependencies).toEqual([WATCHED]);
		expect(calls[0]?.obligations).toEqual([
			expect.objectContaining({ kind: "fallback", cause: "loaded-callee" }),
			expect.objectContaining({
				kind: "fallback",
				cause: "authority",
				dischargedBy: WATCHED,
			}),
		]);
	});

	it("discharges the authority fallback of an exact primitive-receiver rewrite", () => {
		const calls = builtinCalls(
			optimize('function first() { return "a,b".split(",")[0]; }', "locked"),
			"String.prototype.split",
		);
		expect(calls).toEqual([
			{
				opcode: "callBuiltin",
				operation: "String.prototype.split",
				dependencies: [LOCKED],
				obligations: [],
			},
		]);
	});

	it("discharges the authority fallback of an exact intrinsic-receiver rewrite", () => {
		const calls = builtinCalls(
			optimize('function has(o) { return Object.hasOwn(o, "k"); }', "locked"),
			"Object.hasOwn",
		);
		expect(calls).toEqual([
			{
				opcode: "callBuiltin",
				operation: "Object.hasOwn",
				dependencies: [LOCKED],
				obligations: [],
			},
		]);
	});

	it("proves the current Realm for an exact intrinsic-receiver builtin", () => {
		const calls = builtinCalls(
			optimize("function count(o) { return Object.keys(o).length; }", "locked"),
			"Object.keys",
		);
		expect(calls[0]?.opcode).toBe("callBuiltin");
		expect(calls[0]?.obligations).toEqual([]);
	});

	it("admits a specialized region whose identity proof carries no fallback", () => {
		const license = regionLicense(
			optimize(
				'function project() { const fields = "a;b;c".split(";"); return fields[1] + fields.length; }',
				"locked",
			),
			"string-split-projection",
		);
		expect(license.genericTwin).toBe("retained");
		expect(license.guard.obligations.map(({ kind, cause }) => ({ kind, cause }))).toEqual(
			[
				{ kind: "fallback", cause: "materialization" },
				{ kind: "materialize", cause: "materialization" },
			],
		);
	});

	it("keeps the escape fallback of a stack object plan in a locked world", () => {
		const license = regionLicense(
			optimize(
				`function total(values) {
					let sum = 0;
					for (let index = 0; index < 4; index++) {
						const point = { value: values[index] };
						sum += point.value;
					}
					return sum;
				}`,
				"locked",
			),
			"stack-object-plan",
		);
		expect(license.guard.obligations).toContainEqual(
			expect.objectContaining({ kind: "fallback", cause: "escape" }),
		);
	});
});
