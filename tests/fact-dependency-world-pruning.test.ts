import { deepStrictEqual, equal } from "node:assert";
import { describe, it } from "vitest";
import {
	factDependencyEquals,
	factDependencyImplies,
	factDependencyKey,
	normalizeFactDependencies,
} from "../src/compiler/shared/fact-implication.ts";
import type { FactDependency } from "../src/compiler/shared/fact-implication.ts";

function reference(dependencies: Array<FactDependency>): Array<FactDependency> {
	const unique: Array<FactDependency> = [];
	for (const dependency of dependencies) {
		if (!unique.some((candidate) => factDependencyEquals(candidate, dependency))) {
			unique.push(dependency);
		}
	}
	return unique
		.filter(
			(dependency, index) =>
				!unique.some(
					(candidate, other) =>
						other !== index && factDependencyImplies(candidate, dependency),
				),
		)
		.sort((left, right) =>
			factDependencyKey(left).localeCompare(factDependencyKey(right)),
		);
}

describe("World-pruned proof dependencies", () => {
	it("preserves the world, mutable-epoch and guard implication boundaries", () => {
		const dependencies: Array<FactDependency> = [
			{ kind: "world", fact: "authority.closed" },
			{ kind: "world", fact: "primordials.locked" },
			{ kind: "world", fact: "source.closed" },
			{ kind: "world", fact: "eval.disabled" },
			{ kind: "epoch", family: "array-elements" },
			{ kind: "epoch", family: "object-shapes" },
			{ kind: "epoch", family: "global-bindings" },
			{ kind: "guard", id: "world:authority.closed" },
			{ kind: "summary", id: "world:authority.closed" },
		];
		deepStrictEqual(normalizeFactDependencies(dependencies), reference(dependencies));
		equal(normalizeFactDependencies(dependencies).length, 6);
	});

	it("keeps first representatives and stable locale-equal ordering", () => {
		const first: FactDependency = { kind: "guard", id: "é" };
		const second: FactDependency = { kind: "guard", id: "e\u0301" };
		const result = normalizeFactDependencies([first, second, { ...first }]);
		deepStrictEqual(result, reference([first, second]));
		equal(
			result.find((entry) => factDependencyEquals(entry, first)),
			first,
		);
	});

	it("matches pairwise implication for 1000 deterministic dependency sets", () => {
		const vocabulary: Array<FactDependency> = [
			...(
				[
					"primordials.locked",
					"authority.closed",
					"source.closed",
					"eval.disabled",
					"realms.disabled",
					"regexp.enabled",
					"temporal.enabled",
					"intl.enabled",
				] as const
			).map((fact) => ({ kind: "world" as const, fact })),
			...(
				[
					"primitive-methods",
					"watched-methods",
					"array-elements",
					"global-bindings",
					"object-shapes",
				] as const
			).map((family) => ({ kind: "epoch" as const, family })),
			...Array.from({ length: 30 }, (_, index) => ({
				kind: "guard" as const,
				id: `g:${index}`,
			})),
			...Array.from({ length: 30 }, (_, index) => ({
				kind: "summary" as const,
				id: `s:${index}`,
			})),
		];
		let seed = 512;
		const random = (limit: number) => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed % limit;
		};
		for (let trial = 0; trial < 1000; trial++) {
			const dependencies = Array.from({ length: random(60) }, () => ({
				...vocabulary[random(vocabulary.length)]!,
			}));
			const expected = reference(dependencies);
			const result = normalizeFactDependencies(dependencies);
			deepStrictEqual(result, expected);
			for (let index = 0; index < result.length; index++) {
				equal(result[index], expected[index]);
			}
		}
	});
});
