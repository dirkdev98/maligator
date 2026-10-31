import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import { getPrimordialCatalog } from "../src/compiler/shared/primordial-catalog-data.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";

function compile(source: string): ProgramImage {
	const dir = mkdtempSync(path.join(os.tmpdir(), "mal-function-prototype-call-"));
	try {
		const file = path.join(dir, "entry.mjs");
		writeFileSync(file, source);
		return compileEntrypoint(file, { buildConfig: resolveBuildConfig({}) });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const shimSource = `
globalThis.prepare?.();
var createShim = (name, getImplementation) => (object, ...rest) => {
	const implementation = getImplementation.call(object) ?? object[name];
	return implementation.apply(object, rest);
};
function relativeAt(index) {
	return this[index < 0 ? this.length + index : index];
}
var at = createShim("at", function () {
	if (Array.isArray(this)) return relativeAt;
});
var upper = createShim("toUpperCase", function () {
	if (typeof this === "string") return String.prototype.toUpperCase;
});
const values = globalThis.values ?? [1, 2, 3];
let sum = 0;
for (let round = 0; round < 1000; round++) sum += at(values, -1 - (round % 3));
console.log(sum, upper("text"));
`;

const boundSource = `
function calculate(prefix, value) {
	return prefix + value + this.offset;
}
function sumBoundCalls() {
	const calculator = { offset: 11, calculate };
	const bound = calculator.calculate.bind(calculator, 5);
	let sum = 0;
	for (let round = 0; round < 1000; round++) sum += bound(round);
	return sum;
}
console.log(sumBoundCalls());
`;

describe("Function.prototype.call and bind sites", () => {
	it("inline each factory call's own callback behind a check of the loaded call", () => {
		const image = compile(shimSource);
		const shims = image.native.functions.filter((fn) =>
			fn.body.instructions.some(
				(instruction) =>
					instruction.opcode === "LOAD_INTRINSIC" &&
					instruction.intrinsic === "__functionPrototypeCall",
			),
		);
		const checks = (fn: (typeof shims)[number]) => {
			const text = JSON.stringify(fn.body.instructions);
			return [text.includes('"Array.isArray"'), text.includes('"expected":"string"')];
		};
		expect(shims.filter((fn) => checks(fn).join() === "true,false")).toHaveLength(1);
		expect(
			shims.filter((fn) => checks(fn).join() === "false,true").length,
		).toBeGreaterThan(0);
	});

	it("inline a bound function's target behind one check of the loaded bind", () => {
		const bind = getPrimordialCatalog().nodes.findIndex(
			(node) => node[0] === "Function.prototype.bind",
		);
		const callers = compile(boundSource).native.functions.filter((fn) =>
			fn.body.instructions.some(
				(instruction) =>
					instruction.opcode === "LOAD_PRIMORDIAL" && instruction.nodeIndex === bind,
			),
		);
		expect(callers).toHaveLength(1);
		const opcodes = callers[0]!.body.instructions.map(
			(instruction) => instruction.opcode,
		);
		expect(opcodes.filter((opcode) => opcode === "LOAD_PRIMORDIAL")).toHaveLength(1);
		expect(opcodes).toContain("LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT");
	});
});
