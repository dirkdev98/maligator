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
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";

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

describe("native direct closures", () => {
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
