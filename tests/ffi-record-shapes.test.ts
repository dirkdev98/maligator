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
it("binds const-member results regardless of earlier rejected inputs", () => {
	const directory = project("ffi-const-results");
	const result = cli(directory, "inspect", "const_values", "--json");
	expect(result.status, result.stderr || result.stdout).toBe(0);
	const report = JSON.parse(result.stdout) as {
		functions: Array<{ name: string; status: string }>;
	};
	for (const name of [
		"a_make",
		"z_make_before",
		"immutable_visit",
		"immutable_notify",
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
	"a_take_before",
	"z_take",
	"immutable_out",
	"immutable_inout",
	"immutable_array",
	"immutable_callback_result",
	"immutable_token_array",
])("keeps const-member initialization out of the %s input path", (name) => {
	const directory = project("ffi-const-results");
	const result = cli(directory, "inspect", "const_values", "--json");
	expect(result.status, result.stderr || result.stdout).toBe(0);
	const report = JSON.parse(result.stdout) as {
		functions: Array<{ name: string; status: string; gaps?: Array<{ reason: string }> }>;
	};
	const entry = report.functions.find((fn) => fn.name === name);
	expect(entry?.status).toBe("needs-facts");
	expect(entry?.gaps?.some((gap) => gap.reason.includes("const members"))).toBe(true);
});
it("preserves anonymous field declarations when the project moves", () => {
	const first = project(),
		second = project();
	const sdk = declarations(first);
	expect(declarations(second)).toBe(sdk);
	expect(sdk).not.toContain(first);
	expect(sdk).not.toContain(second);
});
it.each([false, true])(
	"maps const anonymous inputs through copied handles %s",
	(handles) => {
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
			expect(entry?.status).toBe(handles ? "bound" : "needs-facts");
			if (handles) continue;
			expect(
				entry?.gaps?.some((gap) =>
					gap.reason.includes("const members cannot be copied by value"),
				),
			).toBe(true);
		}
	},
);
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
