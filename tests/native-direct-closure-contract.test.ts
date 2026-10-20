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

describe("native direct closures", () => {
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
