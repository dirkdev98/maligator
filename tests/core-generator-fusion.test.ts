import { describe, expect, it } from "vitest";
import {
	fusionCount,
	sequence,
	sequenceExpression,
	traversal,
} from "./helpers/generator-fusion.ts";

function loops(count: number): string {
	return Array.from(
		{ length: count },
		(_, index) =>
			`for (const value of sequence(round + ${index})) checksum += value * ${index + 1};`,
	).join(" ");
}

describe("private generator fusion", () => {
	it("fuses a numeric generator consumed only by for-of", () => {
		expect(fusionCount()).toBeGreaterThan(0);
	});
	it("fuses independent traversals with continue and break", () => {
		expect(
			fusionCount(
				sequence,
				`${traversal} for (const value of sequence(round)) { if (value & 1) continue; checksum += value; if (value > 9) break; }`,
			),
		).toBe(2);
	});
	it.each([
		{
			behavior: "observed callable prototype",
			extra: "console.log(sequence.prototype);",
		},
		{
			behavior: "mutated iterator prototype",
			extra: "sequence.prototype.next = () => ({ done: true });",
		},
		{ behavior: "escaping invocation", extra: "console.log(sequence(3));" },
		{
			behavior: "generator returned by a public callable",
			extra: "globalThis.makeSequence = () => sequence(3);",
		},
	])("keeps the protocol for $behavior", ({ extra }) => {
		expect(fusionCount(sequence, traversal, extra)).toBe(0);
	});
	it("keeps the protocol across realms", () => {
		expect(fusionCount(sequence, traversal, "", { realms: true })).toBe(0);
	});
	it("fuses traversals behind a protocol guard with mutable primordials", () => {
		expect(
			fusionCount(
				sequence,
				`${traversal} for (const value of sequence(round)) { if (value & 1) continue; checksum += value; if (value > 9) break; }`,
				"",
				{ primordials: "mutable" },
			),
		).toBe(2);
	});
	it("fuses while run-time code can only run as global code", () => {
		expect(
			fusionCount(sequence, traversal, 'globalThis.later = Function("return 1");', {
				eval: true,
			}),
		).toBeGreaterThan(0);
	});
	it("keeps the protocol when a direct eval can name the generator", () => {
		expect(fusionCount(sequence, traversal, 'eval("sequence");', { eval: true })).toBe(0);
	});
	it("keeps generator cleanup on early exit", () => {
		expect(
			fusionCount(
				"function* sequence(seed) { try { for (let index = 0; index < 12; index++) yield seed + index; } finally { console.log(seed); } }",
				"for (const value of sequence(round)) { checksum += value; break; }",
			),
		).toBe(0);
	});
	it("keeps coercion in a generator body", () => {
		expect(
			fusionCount(
				sequence,
				"for (const value of sequence({ valueOf() { return round; } })) checksum += value;",
			),
		).toBe(0);
	});
	it("retains state whose initialization can be skipped by completion", () => {
		expect(
			fusionCount(
				"function* sequence(seed) { if (seed < 0) return; const step = seed + 2; for (let index = 0; index < 12; index++) yield step + index; }",
			),
		).toBe(0);
	});
	it("fuses private generators consumed by different callers", () => {
		expect(
			fusionCount(
				sequence,
				traversal,
				"function warm(count) { let checksum = 0; for (let round = 0; round < count; round++) for (const value of sequence(round)) checksum += value; return checksum; } console.log(warm(8));",
			),
		).toBe(2);
	});
});

describe("private generator fusion in CommonJS modules", () => {
	it("fuses a generator that only its module calls", () => {
		expect(fusionCount(sequence, traversal, "", {}, "main.cjs")).toBeGreaterThan(0);
	});
	it.each([
		{ publication: "module.exports.sequence = sequence;" },
		{ publication: "exports.sequence = sequence;" },
		{ publication: "module.exports = { sequence };" },
	])(
		"keeps the protocol for a generator published by $publication",
		({ publication }) => {
			expect(fusionCount(sequence, traversal, publication, {}, "main.cjs")).toBe(0);
		},
	);
	it("keeps the protocol for a generator that escapes through another binding", () => {
		expect(
			fusionCount(
				sequence,
				traversal,
				"const alias = sequence; globalThis.leak = () => alias;",
				{},
				"main.cjs",
			),
		).toBe(0);
	});
});

describe("private generator fusion in one caller", () => {
	it.each([3, 4])("fuses all %i generator loops of one function", (count) => {
		expect(fusionCount(sequence, loops(count))).toBe(count);
		expect(fusionCount(sequence, loops(count), "", {}, "main.cjs")).toBe(count);
	});
	it.each(["main.mjs", "main.cjs"])(
		"keeps the protocol for a generator published after its loops run in %s",
		(entry) => {
			expect(
				fusionCount(
					sequence,
					traversal,
					"Promise.resolve().then(() => { globalThis.later = sequence; });",
					{},
					entry,
				),
			).toBe(0);
		},
	);
});

describe("private generator expressions in const bindings", () => {
	it.each(["main.mjs", "main.cjs"])("fuses an initialized binding in %s", (entry) => {
		expect(fusionCount(sequenceExpression, traversal, "", {}, entry)).toBe(1);
	});
	it.each(["main.mjs", "main.cjs"])(
		"fuses a binding a call can read in its dead zone in %s",
		(entry) => {
			expect(
				fusionCount(
					"",
					traversal,
					`try { if (globalThis.early) hot(1); } catch {} ${sequenceExpression}`,
					{},
					entry,
				),
			).toBe(1);
		},
	);
});
