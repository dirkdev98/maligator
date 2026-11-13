import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";

function compile(
	source: string,
	primordials: "locked" | "mutable" = "locked",
): ProgramImage {
	const dir = mkdtempSync(path.join(os.tmpdir(), "mal-function-prototype-call-"));
	try {
		const file = path.join(dir, "entry.mjs");
		writeFileSync(file, source);
		return compileEntrypoint(file, {
			buildConfig: resolveBuildConfig({ engine: { primordials } }),
		});
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

const appliedSource = `
function calculate(prefix, value) {
	return prefix + value + this.offset;
}
function sumAppliedCalls() {
	const calculator = { offset: 11 };
	let sum = 0;
	for (let round = 0; round < 1000; round++) sum += calculate.apply(calculator, [5, round]);
	return sum;
}
console.log(sumAppliedCalls());
`;

/** The instructions of each compiled function that loads the named realm intrinsic. */
function intrinsicCheckCallers(
	source: string,
	intrinsic: string,
	primordials: "locked" | "mutable",
) {
	const loads = (
		instruction: ProgramImage["runtime"]["functions"][number]["instructions"][number],
	) => instruction.opcode === "LOAD_INTRINSIC" && instruction.intrinsic === intrinsic;
	return compile(source, primordials)
		.native.functions.filter((fn) => fn.body.instructions.some(loads))
		.map((fn) => ({
			checks: fn.body.instructions.filter(loads).length,
			opcodes: fn.body.instructions.map((instruction) => instruction.opcode),
		}));
}

describe("Function.prototype.call, apply and bind sites", () => {
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

	it.each(["locked", "mutable"] as const)(
		"inline a bound function's target behind one check of the loaded bind with %s primordials",
		(primordials) => {
			const callers = intrinsicCheckCallers(
				boundSource,
				"__functionPrototypeBind",
				primordials,
			);
			expect(callers).toHaveLength(1);
			expect(callers[0]!.checks).toBe(1);
			expect(callers[0]!.opcodes).toContain("LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT");
		},
	);

	it.each(["locked", "mutable"] as const)(
		"inline an applied target with the array literal's elements behind a check of the loaded apply with %s primordials",
		(primordials) => {
			const callers = intrinsicCheckCallers(
				appliedSource,
				"__functionPrototypeApply",
				primordials,
			);
			expect(callers).toHaveLength(1);
			expect(callers[0]!.checks).toBe(1);
			expect(callers[0]!.opcodes).toContain("LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT");
		},
	);
});
