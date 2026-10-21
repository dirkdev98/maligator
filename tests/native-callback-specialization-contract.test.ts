import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";

function compile(source: string): ProgramImage {
	const dir = mkdtempSync(path.join(os.tmpdir(), "mal-callback-specialization-"));
	try {
		const file = path.join(dir, "entry.mjs");
		writeFileSync(file, source);
		return compileEntrypoint(file, { buildConfig: resolveBuildConfig({}) });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function functionsNamed(image: ProgramImage, name: string): ReadonlyArray<number> {
	return image.runtime.functions.flatMap((fn, index) =>
		String.fromCharCode(...(image.runtime.stringConstants[fn.nameStringIndex] ?? [])) ===
		name
			? [index]
			: [],
	);
}

const source = `
function each(values, f) {
	let total = 0;
	for (let index = 0; index < values.length; index++) total += f(values[index], index);
	return total;
}
function weight(value, index) {
	return value * (index + 1) + (value > 3 ? 1 : 0);
}
function shift(value, index) {
	return value - index + (value < 0 ? 2 : 0);
}
const values = globalThis.values ?? [1, 5, 9];
console.log(each(values, weight), each(values, shift), each(values, weight));
`;

const omittedSource = `
function some(array, predicate) {
	if (array !== undefined) {
		if (predicate !== undefined) {
			for (let index = 0; index < array.length; index++) if (predicate(array[index])) return true;
		} else {
			return array.length > 0;
		}
	}
	return false;
}
function find(values, key, select) {
	if (!some(values)) return -1;
	for (let index = 0; index < values.length; index++) if (select(values[index]) === key) return index;
	return -1;
}
function id(value) {
	return value.id;
}
const values = (globalThis.values ?? [1, 2, 3]).map((id) => ({ id }));
let found = 0;
for (let round = 0; round < 1000; round++) found += find(values, round % 4, id);
console.log(found, some(values, (value) => value.id > 2));
`;

describe("callback specialization", () => {
	it("folds a helper's omitted argument inside a clone so the helper inlines", () => {
		const image = compile(omittedSource);
		const calls = (index: number) =>
			image.native.functions[index]!.body.instructions.filter(
				(instruction) => instruction.opcode === "CALL",
			).length;
		const clones = functionsNamed(image, "find").filter(
			(index) => index > functionsNamed(image, "find")[0]!,
		);
		expect(clones.length).toBeGreaterThan(0);
		expect(clones.map(calls)).toContain(0);
	});

	it("gives a helper one clone per distinct callback it repeats", () => {
		const image = compile(source);
		expect(functionsNamed(image, "each").length).toBe(3);
	});

	it("leaves no dispatching call in a clone", () => {
		const image = compile(source);
		const dispatching = (index: number) => {
			const native = image.native.functions[index]!;
			return native.body.instructions.filter((instruction, ip) => {
				const plan = native.instructions[ip];
				return (
					instruction.opcode === "CALL" &&
					(plan?.kind !== "call" || plan.directFunctionIndex === undefined)
				);
			}).length;
		};
		const counts = functionsNamed(image, "each").map(dispatching);
		expect(counts.filter((count) => count === 0).length).toBe(2);
	});
});
