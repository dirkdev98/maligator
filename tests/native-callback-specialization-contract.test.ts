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

describe("callback specialization", () => {
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
