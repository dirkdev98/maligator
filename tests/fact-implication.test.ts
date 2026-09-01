import { describe, expect, it } from "vitest";
import {
	compilerGuardPlan,
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
