import { deepStrictEqual, equal } from "node:assert";
import { describe, it } from "vitest";
import {
	factObligationEquals,
	factObligationIsDischarged,
	factObligationKey,
	normalizeFactObligations,
} from "../src/compiler/shared/fact-implication.ts";
import type {
	FactDependency,
	FactObligation,
} from "../src/compiler/shared/fact-implication.ts";

function reference(
	obligations: Array<FactObligation>,
	dependencies: Array<FactDependency>,
) {
	const unique: Array<FactObligation> = [];
	for (const obligation of obligations) {
		if (!unique.some((candidate) => factObligationEquals(candidate, obligation))) {
			unique.push(obligation);
		}
	}
	return unique
		.filter((obligation) => !factObligationIsDischarged(obligation, dependencies))
		.sort((left, right) =>
			factObligationKey(left).localeCompare(factObligationKey(right)),
		);
}

describe("Key-bucketed proof obligations", () => {
	it("retains semantically different obligations whose display keys collide", () => {
		const first: FactObligation = {
			kind: "fallback",
			id: "x",
			cause: "authority",
			dischargedBy: { kind: "guard", id: "y:realm:guard:z" },
		};
		const second: FactObligation = {
			kind: "fallback",
			id: "x:authority:guard:y",
			cause: "realm",
			dischargedBy: { kind: "guard", id: "z" },
		};
		equal(factObligationKey(first), factObligationKey(second));
		const result = normalizeFactObligations([first, second, { ...first }], []);
		deepStrictEqual(result, [first, second]);
		equal(result[0], first);
		equal(result[1], second);
	});

	it("does not discharge non-authority duties or unrelated epoch witnesses", () => {
		const duties: Array<FactObligation> = [
			{
				kind: "fallback",
				id: "a",
				cause: "authority",
				dischargedBy: { kind: "epoch", family: "array-elements" },
			},
			{
				kind: "fallback",
				id: "b",
				cause: "realm",
				dischargedBy: { kind: "world", fact: "primordials.locked" },
			},
			{
				kind: "fallback",
				id: "c",
				cause: "authority",
				dischargedBy: { kind: "epoch", family: "object-shapes" },
			},
			{ kind: "materialize", id: "d", cause: "materialization" },
		];
		deepStrictEqual(
			normalizeFactObligations(duties, [{ kind: "world", fact: "primordials.locked" }]),
			duties.slice(1),
		);
	});

	it("matches fieldwise normalization for 1000 deterministic obligation sets", () => {
		let seed = 317;
		const random = (limit: number) => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed % limit;
		};
		const witnesses: Array<FactDependency> = [
			{ kind: "world", fact: "primordials.locked" },
			{ kind: "epoch", family: "object-shapes" },
			{ kind: "guard", id: "a:b" },
		];
		for (let trial = 0; trial < 1000; trial++) {
			const obligations: Array<FactObligation> = Array.from(
				{ length: random(40) },
				() => ({
					kind: "fallback",
					id: ["x", "x:realm", "é", "e\u0301"][random(4)]!,
					cause: random(2) === 0 ? "authority" : "realm",
					...(random(3) === 0 ? {} : { dischargedBy: witnesses[random(3)]! }),
				}),
			);
			const dependencies: Array<FactDependency> =
				random(2) === 0 ? [{ kind: "world", fact: "authority.closed" }] : [];
			const result = normalizeFactObligations(obligations, dependencies);
			const expected = reference(obligations, dependencies);
			deepStrictEqual(result, expected);
			for (let index = 0; index < result.length; index++) {
				equal(result[index], expected[index]);
			}
		}
	});
});
