import { describe, expect, it } from "vitest";
import {
	compileFusions,
	fusionCount,
	sequence,
	traversal,
} from "./helpers/generator-fusion.ts";

/**
 * Many unrelated functions that survive until cross-call transforms, optionally
 * with one of them in the middle publishing an alias of `sequence`.
 */
function largeProgram(functions: number, escapeAt?: number): string {
	const fillers = Array.from(
		{ length: functions },
		(_, index) => `function filler${index}(value) {
			let state = value ^ ${index};
			for (let step = 0; step < 3; step++) state = (state * 31 + ${index} + step) | 0;
			${index === escapeAt ? "const alias = sequence; globalThis.escaped = alias;" : ""}
			return state > ${index} ? state - ${index} : state + ${index} * 2;
		}`,
	);
	return `${fillers.join("\n")}
		const fillers = [${fillers.map((_, index) => `filler${index}`).join(", ")}];
		let mixed = 0;
		for (let index = 0; index < fillers.length; index++) mixed = fillers[index](mixed);
		console.log(mixed);`;
}

// Each case compiles a 600-function program, which takes seconds on CI runners.
const compileTimeout = 60_000;

describe("private generator fusion at program scale", () => {
	it(
		"fuses a private generator in a program larger than a whole-program scan allows",
		() => {
			const { fusions, instructions } = compileFusions(
				sequence,
				traversal,
				largeProgram(600),
				{},
				"main.mjs",
			);
			expect(instructions).toBeGreaterThan(8_192);
			expect(fusions).toBeGreaterThan(0);
		},
		compileTimeout,
	);
	it.each(["main.mjs", "main.cjs"])(
		"keeps the protocol for a generator escaping far from its loops in %s",
		(entry) => {
			expect(fusionCount(sequence, traversal, largeProgram(600, 300), {}, entry)).toBe(0);
		},
		compileTimeout,
	);
});
