import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	emitProgramImage,
	emitProgramTranslationUnits,
} from "../src/compiler/target/emit-program-image.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";
import { resolveSplitUnitLinks } from "./helpers/native-relocation.ts";

function compile(source: string): ProgramImage {
	const dir = mkdtempSync(path.join(os.tmpdir(), "mal-direct-closure-"));
	try {
		const file = path.join(dir, "entry.mjs");
		writeFileSync(file, source);
		return compileEntrypoint(file, { buildConfig: resolveBuildConfig({}) });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function functionNamed(image: ProgramImage, name: string): number {
	const index = image.runtime.functions.findIndex(
		(fn) =>
			String.fromCharCode(
				...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
			) === name,
	);
	expect(index).toBeGreaterThan(0);
	return index;
}

const source = `
function check(limit, values) {
	let seen = 0;
	function visit(value) {
		seen++;
		if (value > limit) return visit(value - limit) + 1;
		return value;
	}
	function total() {
		let sum = 0;
		for (const value of values) sum += visit(value);
		return sum;
	}
	function escapes(value) {
		return value + seen;
	}
	return [total(), seen, values.map(escapes).join()].join(":");
}
console.log(check(3, globalThis.values ?? [1, 5, 9]));
`;

const ownerSource = `
function check(limit, values) {
	let calls = 0;
	function step(value) {
		calls++;
		return value > limit ? step(value - limit) + 1 : value;
	}
	function total() {
		let sum = 0;
		for (const value of values) sum += step(value);
		return sum;
	}
	const first = total();
	return [first, step(limit * 2 + 1), calls].join(":");
}
console.log(check(3, globalThis.values ?? [1, 5, 9]));
`;

const escapingSource = `
function check(values, report) {
	const errors = [];
	function reportError(message) {
		errors.push(message);
		return errors.length;
	}
	function forward(value, callback) {
		return callback(\`negative \${value}\`);
	}
	function visit(value) {
		if (value >= 0) return reportError.length + value * 2;
		return report ? forward(value, reportError) : -1;
	}
	function sameTwice() {
		const first = report ? reportError : undefined;
		return first === (report ? reportError : undefined);
	}
	let sum = 0;
	for (const value of values) sum += visit(value);
	if (values.length > 3) reportError("long");
	return [sum, errors.join(), sameTwice()].join(":");
}
console.log(check(globalThis.values ?? [1, -5, 9, 4], true));
`;

const sharedLayoutSource = `
const run = (() => {
	const scale = 3;
	function outer(seed) {
		const offset = seed * 2;
		function checker(limit) {
			const pending = [];
			function down(value) {
				return value <= 0 ? offset + pending.length + scale : down(value - 1) + 1;
			}
			function across(value) {
				return value <= 0 ? offset - pending.length + scale : across(value - 2) + down(1);
			}
			let total = 0;
			for (let index = 0; index < limit; index++) total += down(index) + across(index);
			pending.push(total);
			return total;
		}
		return checker;
	}
	return (rounds) => {
		let sum = 0;
		for (let round = 0; round < rounds; round++) sum += outer(round)(4);
		return sum;
	};
})();
console.log(run(1000));
`;

describe("native direct closures", () => {
	it("restores the closure object when its planned native callee exceeds the C budget", () => {
		const image = compile(
			`function owner(value){function target(input){${"input+=globalThis.salt;".repeat(100)}return input;}return target(value);}globalThis.owner=owner;`,
		);
		const owner = functionNamed(image, "owner");
		const target = functionNamed(image, "target");
		expect(
			image.native.functions[owner]!.instructions.some(
				(plan) => plan?.kind === "direct-closure",
			),
		).toBe(true);
		expect(emitProgramImage(image)).not.toContain(
			`mal_vm_op_create_function(vm, ${target},`,
		);
		const output = resolveSplitUnitLinks(
			image,
			emitProgramTranslationUnits(
				image,
				{},
				{ targetCodeUnits: 20_000, hardMaximumCodeUnits: 20_000 },
			).map((unit) => unit.sourceChunks.join("")),
		).join("\n");
		expect(output).not.toMatch(
			new RegExp(`\\bMalValue mal_compiled_${target}(?:_full)?\\(`),
		);
		expect(output).toContain(`mal_vm_op_create_function(vm, ${target},`);
	});

	it("share one chain test among the closures an activation creates with one layout", () => {
		const image = compile(sharedLayoutSource);
		const down = functionNamed(image, "down");
		const across = functionNamed(image, "across");
		const creates = (body: string, target: number) =>
			body.includes(`mal_vm_closure_chain_has_owners(vm, ${target}, env)`);
		const bodies = emitProgramImage(image)
			.split(/\n(?=__attribute__|static __attribute__)/)
			.filter((body) => creates(body, down) && creates(body, across));
		expect(bodies.length).toBeGreaterThan(0);
		for (const body of bodies)
			expect(body.match(/i8 __closure_chain_\d+ = -1;/g)).toEqual([
				"i8 __closure_chain_0 = -1;",
			]);
	});

	it("create a nested function whose value escapes only where a read lets it escape", () => {
		const original = compile(escapingSource);
		for (const image of [
			original,
			deserializeCompilerArtifact(serializeCompilerArtifact(original)),
		]) {
			const reportError = functionNamed(image, "reportError");
			const output = emitProgramImage(image);
			expect(output).not.toContain(`mal_vm_op_create_function(vm, ${reportError}, env);`);
			expect(output).toMatch(
				new RegExp(
					`mal_vm_op_create_function\\(vm, ${reportError}, __closure_scope_\\d+\\)`,
				),
			);
		}
	});

	it("create no function object for a nested function its owner calls through its binding", () => {
		const image = compile(ownerSource);
		const step = functionNamed(image, "step");
		const output = emitProgramImage(image);
		expect(output).toContain(`mal_compiled_${step}(`);
		expect(output).not.toContain(`mal_vm_op_create_function(vm, ${step},`);
	});

	it("create no function object for a nested function that is only called", () => {
		const original = compile(source);
		for (const image of [
			original,
			deserializeCompilerArtifact(serializeCompilerArtifact(original)),
		]) {
			const visit = functionNamed(image, "visit");
			const escapes = functionNamed(image, "escapes");
			const output = emitProgramImage(image);
			expect(output).toContain(`mal_compiled_${visit}(`);
			expect(output).not.toContain(`mal_vm_op_create_function(vm, ${visit},`);
			expect(output).toContain(`mal_vm_op_create_function(vm, ${escapes},`);
		}
	});
});
