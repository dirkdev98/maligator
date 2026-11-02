import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { FfiCheckReport } from "../src/ffi/check.ts";

const repo = resolve(import.meta.dirname, "..");
const temporary: Array<string> = [];
function project(facts?: Record<string, unknown>): string {
	const directory = mkdtempSync(join(tmpdir(), "mal-ffi-union-values-contract-"));
	temporary.push(directory);
	cpSync(join(repo, "tests/fixtures/ffi-union-values"), directory, { recursive: true });
	if (facts !== undefined)
		writeFileSync(
			join(directory, "unions.ffi.ts"),
			`export default ${JSON.stringify({ headers: ["unions.h"], find: [{ includeDirs: ["."], sources: ["unions.c"] }], ...facts })};\n`,
		);
	return directory;
}
function cli(directory: string, ...args: Array<string>) {
	return spawnSync(process.execPath, [join(repo, "src/index.ts"), "ffi", ...args], {
		cwd: directory,
		encoding: "utf8",
		timeout: 30000,
	});
}
function sdk(directory: string): string {
	const result = cli(directory, "types");
	expect(result.status, result.stderr || result.stdout).toBe(0);
	return readFileSync(join(directory, "maligator-ffi.d.ts"), "utf8");
}
afterEach(() => {
	for (const directory of temporary.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
it("exposes the selected member and preserves per-value overrides", () => {
	const inspected = cli(project(), "inspect", "unions", "--json");
	expect(inspected.status, inspected.stderr || inspected.stdout).toBe(0);
	const report = JSON.parse(inspected.stdout) as {
		types: Array<{ name: string; ts: string; fields: Array<{ name: string }> }>;
		functions: Array<{ name: string; ts: string }>;
	};
	expect(report.types.find((type) => type.name === "Scalar")).toMatchObject({
		ts: "number",
		fields: [{ name: "integer" }],
	});
	expect(report.functions.find((fn) => fn.name === "scalar_wide")?.ts).toBe(
		"(value: bigint) => bigint",
	);
});
it("detects inactive member ABI changes without changing the JavaScript type", () => {
	const directory = project();
	const accepted = cli(directory, "check", "--update", "--json");
	expect(accepted.status, accepted.stderr || accepted.stdout).toBe(0);
	const before = sdk(directory);
	const file = join(directory, "unions.h");
	writeFileSync(
		file,
		readFileSync(file, "utf8").replace("const void *hidden;", "long double hidden;"),
	);
	expect(sdk(directory)).toBe(before);
	const checked = cli(directory, "check", "--json");
	expect(checked.status, checked.stderr || checked.stdout).toBe(1);
	const report = JSON.parse(checked.stdout) as FfiCheckReport;
	expect(
		report.libraries[0]?.changes.some(
			(change) =>
				change.path === "declarations.union Scalar.fields" && change.kind === "changed",
		),
	).toBe(true);
});
it.each([
	[{ types: { Scalar: { shape: { member: "missing" } } } }, "no member 'missing'"],
	[{ types: { Scalar: { shape: { member: "point.x" } } } }, "shape.member"],
	[
		{
			functions: {
				scalar_number: { params: { value: { shape: { member: "integer" } } } },
			},
		},
		"shape applies to union",
	],
	[
		{
			functions: {
				scalar_visit: {
					params: {
						visit: {
							callback: { returns: { shape: { member: "point" }, lifetime: "call" } },
						},
					},
				},
			},
		},
		"callback.returns.lifetime",
	],
])("rejects invalid union facts %j", (facts, diagnostic) => {
	const inspected = cli(project(facts), "inspect", "unions", "--json");
	expect(inspected.status).toBe(1);
	expect(inspected.stderr).toContain(diagnostic);
});
it.each(["resources_transform", "resources_record_transform"])(
	"rejects resource-bearing callback results through %s",
	(name) => {
		const inspected = cli(
			project({
				types: {
					Resource: { handle: {} },
					ResourcePayload: { shape: { member: "resources" } },
				},
				functions: { [name]: { params: { visit: { callback: {} } } } },
			}),
			"inspect",
			"unions",
			"--json",
		);
		expect(inspected.status, inspected.stderr || inspected.stdout).toBe(0);
		const report = JSON.parse(inspected.stdout) as {
			functions: Array<{
				name: string;
				status: string;
				gaps?: Array<{ reason: string }>;
			}>;
		};
		const fn = report.functions.find((fn) => fn.name === name);
		expect(fn?.status).toBe("needs-facts");
		expect(
			fn?.gaps?.some((gap) =>
				gap.reason.includes("compound callback results containing handles"),
			),
		).toBe(true);
	},
);
it.each(["resources_keep", "resource_close"])(
	"rejects queued resource copies through %s",
	(name) => {
		const callback =
			name === "resources_keep"
				? { data: "data", release: "release", queued: true }
				: { data: "data", closes: "key" };
		const inspected = cli(
			project({
				types: {
					Resource: { handle: {} },
					ResourcePayload: { shape: { member: "resources" } },
					Closer: { handle: {} },
				},
				functions: {
					[name]: {
						params: { [name === "resources_keep" ? "visit" : "done"]: { callback } },
					},
				},
			}),
			"inspect",
			"unions",
			"--json",
		);
		expect(inspected.status).toBe(1);
		expect(inspected.stderr).toContain(
			"resource-bearing values require a waiting callback",
		);
	},
);
it.each(["resources_result", "resources_record_result"])(
	"requires resource ownership for %s",
	(name) => {
		const inspected = cli(
			project({
				types: {
					Resource: { handle: {} },
					ResourcePayload: { shape: { member: "resources" } },
				},
			}),
			"inspect",
			"unions",
			"--json",
		);
		expect(inspected.status, inspected.stderr || inspected.stdout).toBe(0);
		const report = JSON.parse(inspected.stdout) as {
			functions: Array<{
				name: string;
				status: string;
				gaps?: Array<{ reason: string }>;
			}>;
		};
		const fn = report.functions.find((fn) => fn.name === name);
		expect(fn?.status).toBe("needs-facts");
		expect(
			fn?.gaps?.some((gap) =>
				gap.reason.includes(
					"resource-bearing value results require a pointer result interface",
				),
			),
		).toBe(true);
	},
);
