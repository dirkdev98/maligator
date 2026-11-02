import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { FfiCheckReport } from "../src/ffi/check.ts";

const repo = resolve(import.meta.dirname, "..");
const temporary: Array<string> = [];
function project(fixture = "ffi-record-shapes"): string {
	const directory = mkdtempSync(join(tmpdir(), "mal-ffi-record-shapes-contract-"));
	temporary.push(directory);
	cpSync(join(repo, "tests/fixtures", fixture), directory, { recursive: true });
	return directory;
}
function cli(directory: string, ...args: Array<string>) {
	return spawnSync(process.execPath, [join(repo, "src/index.ts"), "ffi", ...args], {
		cwd: directory,
		encoding: "utf8",
		timeout: 30000,
	});
}
function declarations(directory: string): string {
	const result = cli(directory, "types");
	expect(result.status, result.stderr || result.stdout).toBe(0);
	return readFileSync(join(directory, "maligator-ffi.d.ts"), "utf8");
}
afterEach(() => {
	for (const directory of temporary.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
it("binds const-member inputs and results in declaration order", () => {
	const directory = project("ffi-const-results");
	const result = cli(directory, "inspect", "const_values", "--json");
	expect(result.status, result.stderr || result.stdout).toBe(0);
	const report = JSON.parse(result.stdout) as {
		functions: Array<{ name: string; status: string }>;
	};
	for (const name of [
		"a_make",
		"a_take_before",
		"z_take",
		"immutable_bits_take",
		"immutable_out",
		"immutable_inout",
		"immutable_token_out",
		"immutable_array",
		"immutable_token_array",
		"immutable_array_out",
		"immutable_pair_out",
		"immutable_pair_inout",
		"immutable_pair_many",
		"immutable_numbers_out",
		"immutable_grid_out",
		"immutable_grid_inout",
		"immutable_choice_int",
		"immutable_choice_take_int",
		"immutable_choice_record",
		"immutable_choice_take_record",
		"immutable_choice_array",
		"immutable_choice_take_array",
		"immutable_choice_out",
		"immutable_choice_inout",
		"immutable_choice_sum",
		"immutable_envelope_take",
		"z_make_before",
		"immutable_visit",
		"immutable_notify",
		"immutable_callback_result",
		"immutable_callback_check",
		"immutable_callback_parallel",
		"immutable_choice_callback",
		"immutable_token_make",
		"immutable_token_borrow",
		"immutable_token_visit",
		"immutable_token_consume",
		"immutable_token_destroy",
		"immutable_token_with_callback",
	])
		expect(report.functions.find((fn) => fn.name === name)?.status).toBe("bound");
});
it.each([
	["immutable_token_inout", "duplicate ownership"],
	["immutable_token_array_out", "element ownership"],
])("rejects unsafe resource or array storage through %s", (name, reason) => {
	const directory = project("ffi-const-results");
	const result = cli(directory, "inspect", "const_values", "--json");
	expect(result.status, result.stderr || result.stdout).toBe(0);
	const report = JSON.parse(result.stdout) as {
		functions: Array<{ name: string; status: string; gaps?: Array<{ reason: string }> }>;
	};
	const entry = report.functions.find((fn) => fn.name === name);
	expect(entry?.status).toBe("needs-facts");
	expect(entry?.gaps?.some((gap) => gap.reason.includes(reason))).toBe(true);
});
it.each([
	["tagged_overlap", "outside union storage"],
	["tagged_promoted_overlap", "outside union storage"],
])("rejects unsupported const tagged storage through %s", (name, reason) => {
	const directory = project("ffi-const-tagged");
	const result = cli(directory, "inspect", "const_tagged", "--json");
	expect(result.status, result.stderr || result.stdout).toBe(0);
	const report = JSON.parse(result.stdout) as {
		functions: Array<{ name: string; status: string; gaps?: Array<{ reason: string }> }>;
	};
	const entry = report.functions.find((fn) => fn.name === name);
	expect(entry?.status).toBe("needs-facts");
	expect(entry?.gaps?.some((gap) => gap.reason.includes(reason))).toBe(true);
});
it("preserves anonymous field declarations when the project moves", () => {
	const first = project(),
		second = project();
	const sdk = declarations(first);
	expect(declarations(second)).toBe(sdk);
	expect(sdk).not.toContain(first);
	expect(sdk).not.toContain(second);
});
it.each([false, true])("maps const anonymous inputs with a handle fact %s", (handles) => {
	const directory = project();
	if (handles)
		writeFileSync(
			join(directory, "records.ffi.ts"),
			`export default ${JSON.stringify({
				headers: ["records.h"],
				find: [{ includeDirs: ["."], sources: ["records.c"] }],
				types: {
					ConstShapePacket: { handle: {} },
					ConstPromotedPacket: { handle: {} },
				},
			})};\n`,
		);
	const inspected = cli(directory, "inspect", "records", "--json");
	expect(inspected.status, inspected.stderr || inspected.stdout).toBe(0);
	const report = JSON.parse(inspected.stdout) as {
		functions: Array<{
			name: string;
			status: string;
			gaps?: Array<{ reason: string }>;
		}>;
	};
	for (const name of ["shapes_const_copy", "shapes_const_promoted"]) {
		const entry = report.functions.find((candidate) => candidate.name === name);
		expect(entry?.status).toBe("bound");
	}
});
it("detects anonymous member ABI changes that preserve the JavaScript types", () => {
	const directory = project();
	const accepted = cli(directory, "check", "--update", "--json");
	expect(accepted.status, accepted.stderr || accepted.stdout).toBe(0);
	const sdk = declarations(directory);
	const header = join(directory, "records.h");
	writeFileSync(
		header,
		readFileSync(header, "utf8").replace("int code;", "double code;"),
	);
	expect(declarations(directory)).toBe(sdk);
	const checked = cli(directory, "check", "--json");
	expect(checked.status, checked.stderr || checked.stdout).toBe(1);
	const report = JSON.parse(checked.stdout) as FfiCheckReport;
	expect(
		report.libraries[0]?.changes.some(
			(change) => change.path.includes("detail") && change.kind === "changed",
		),
	).toBe(true);
});
