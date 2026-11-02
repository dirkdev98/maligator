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

function taggedProject(facts?: Record<string, unknown>): string {
	const directory = join(project(), "tagged");
	if (facts !== undefined)
		writeFileSync(
			join(directory, "tagged.ffi.ts"),
			`export default ${JSON.stringify({ headers: ["tagged.h"], find: [{ includeDirs: ["."], sources: ["tagged.c"] }], ...facts })};\n`,
		);
	return directory;
}

it("exposes discriminated union cases with stable declarations after a move", () => {
	const first = taggedProject();
	const second = taggedProject();
	const declarations = sdk(first);
	expect(sdk(second)).toBe(declarations);
	expect(declarations).not.toContain(first);
	const result = cli(first, "inspect", "tagged", "--json");
	expect(result.status, result.stderr || result.stdout).toBe(0);
	const report = JSON.parse(result.stdout) as {
		types: Array<{
			name: string;
			cases?: Array<{ tag: string; selection: Array<string> }>;
		}>;
	};
	expect(report.types.find((type) => type.name === "Tagged")?.cases).toMatchObject([
		{ tag: "11", selection: ["payload.integer"] },
		{ tag: "12", selection: ["payload.point"] },
		{ tag: "13", selection: [] },
	]);
	expect(declarations).toContain("kind: 18446744073709551615n");
});

it("checks private discriminator constants and inactive union ABI", () => {
	const directory = taggedProject();
	const accepted = cli(directory, "check", "--update", "--json");
	expect(accepted.status, accepted.stderr || accepted.stdout).toBe(0);
	const before = sdk(directory);
	const header = join(directory, "tagged.h");
	writeFileSync(
		header,
		readFileSync(header, "utf8").replace("const void *hidden;", "long double hidden;"),
	);
	expect(sdk(directory)).toBe(before);
	const abi = cli(directory, "check", "--json");
	expect(abi.status, abi.stderr || abi.stdout).toBe(1);
	const abiReport = JSON.parse(abi.stdout) as FfiCheckReport;
	expect(
		abiReport.libraries[0]?.changes.some(
			(change) => change.path.startsWith("declarations.") && change.kind === "changed",
		),
	).toBe(true);
	const constants = join(directory, "private-tags.h");
	writeFileSync(
		constants,
		readFileSync(constants, "utf8").replace("PRIVATE_TAG_BASE 10", "PRIVATE_TAG_BASE 20"),
	);
	const changed = cli(directory, "check", "--json");
	expect(changed.status, changed.stderr || changed.stdout).toBe(1);
	const report = JSON.parse(changed.stdout) as FfiCheckReport;
	expect(
		report.libraries[0]?.changes.some((change) =>
			change.path.includes("macro PRIVATE_TAG_BASE"),
		),
	).toBe(true);
	expect(sdk(directory)).toContain("kind: 21");
});

it.each([
	[{ tag: "missing", cases: { "1": [] } }, "no discriminator"],
	[{ tag: "payload", cases: { "1": [] } }, "must be an integer"],
	[{ tag: "kind", cases: { "1": ["serial"] } }, "active union member"],
	[{ tag: "kind", cases: { "1": ["payload.missing"] } }, "active union member"],
	[{ tag: "kind", cases: { "1": ["payload.point.x"] } }, "active union member"],
	[
		{ tag: "kind", cases: { "1": ["payload.integer", "payload.point"] } },
		"conflicting union selections",
	],
	[
		{ tag: "kind", cases: { "1": ["payload.integer", "payload.integer"] } },
		"duplicate selection",
	],
	[
		{ tag: "kind", cases: { PRIVATE_TAG_INTEGER: [], "11": [] } },
		"duplicate discriminator",
	],
	[{ tag: "kind", cases: { "2147483648": [] } }, "does not fit"],
	[{ tag: "kind", cases: { __LINE__: [] } }, "not a known integer constant"],
	[{ tag: "kind", cases: { CONTEXT_ENUM: [] } }, "not a known integer constant"],
	[{ tag: "kind", cases: { FUNCTION_ENUM: [] } }, "not a known integer constant"],
	[{ tag: "kind", cases: { "010": [] } }, "canonical decimal"],
])("rejects invalid tagged shape %j", (shape, diagnostic) => {
	const result = cli(
		taggedProject({ types: { Tagged: { shape } } }),
		"inspect",
		"tagged",
		"--json",
	);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain(diagnostic);
});

it("uses the active macro when a discriminator name shadows an enum", () => {
	const declarations = sdk(
		taggedProject({
			types: {
				Tagged: { shape: { tag: "kind", cases: { SHADOW_ENUM: ["payload.integer"] } } },
			},
		}),
	);
	expect(declarations).toContain("kind: 11");
	expect(declarations).not.toContain("kind: 31");
});

it("retains private case constants used only by callback value overrides", () => {
	const shape = { tag: "kind", cases: { "12": ["payload.point"] } };
	const directory = taggedProject({
		functions: {
			tagged_visit: {
				params: {
					value: { shape },
					visit: {
						callback: {
							params: {
								"1": {
									shape: { tag: "kind", cases: { PRIVATE_TAG_POINT: ["payload.point"] } },
								},
							},
							returns: { shape },
						},
					},
				},
				returns: { shape },
			},
		},
	});
	const result = cli(directory, "inspect", "tagged", "--json");
	expect(result.status, result.stderr || result.stdout).toBe(0);
	const report = JSON.parse(result.stdout) as {
		functions: Array<{ name: string; status: string }>;
	};
	expect(report.functions.find((entry) => entry.name === "tagged_visit")?.status).toBe(
		"bound",
	);
	const accepted = cli(directory, "check", "--update", "--json");
	expect(accepted.status, accepted.stderr || accepted.stdout).toBe(0);
	const header = join(directory, "private-tags.h");
	writeFileSync(
		header,
		readFileSync(header, "utf8").replace("PRIVATE_TAG_BASE 10", "PRIVATE_TAG_BASE 20"),
	);
	const checked = cli(directory, "check", "--json");
	expect(checked.status, checked.stderr || checked.stdout).toBe(1);
	const changed = JSON.parse(checked.stdout) as FfiCheckReport;
	expect(
		changed.libraries[0]?.changes.some((change) =>
			change.path.includes("macro PRIVATE_TAG_BASE"),
		),
	).toBe(true);
});

it.each(["resource_result", "resource_transform", "resource_keep"])(
	"preserves resource safety for tagged values through %s",
	(name) => {
		const directory = taggedProject({
			types: {
				Resource: { handle: {} },
				TaggedResource: {
					shape: {
						tag: "kind",
						cases: { "1": ["payload.items"], "2": ["payload.integer"] },
					},
				},
			},
			functions:
				name === "resource_result"
					? {}
					: {
							[name]: {
								params: {
									visit: {
										callback:
											name === "resource_keep"
												? { data: "data", release: "release", queued: true }
												: {},
									},
								},
							},
						},
		});
		const result = cli(directory, "inspect", "tagged", "--json");
		if (name === "resource_keep") {
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("require a waiting callback");
			return;
		}
		expect(result.status, result.stderr || result.stdout).toBe(0);
		const report = JSON.parse(result.stdout) as {
			functions: Array<{
				name: string;
				status: string;
				gaps?: Array<{ reason: string }>;
			}>;
		};
		const fn = report.functions.find((entry) => entry.name === name);
		expect(fn?.status).toBe("needs-facts");
		expect(fn?.gaps?.some((gap) => gap.reason.includes("pointer result interface"))).toBe(
			true,
		);
	},
);
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
		"shape applies to record",
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
