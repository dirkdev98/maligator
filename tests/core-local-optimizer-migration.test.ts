import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CORE_CONTROL_FLOW_PASSES } from "../src/compiler/core/core-control-flow-passes.ts";
import { CORE_LOCAL_CANONICALIZATION_PASSES } from "../src/compiler/core/core-local-passes.ts";
import {
	CORE_MEMORY_PASSES,
	CORE_MEMORY_SSA_PASSES,
	CORE_PROVENANCE_PASSES,
} from "../src/compiler/core/core-memory-passes.ts";
import type { CoreFunctionPass } from "../src/compiler/core/core-pass.ts";
import { CORE_PROOF_PASSES } from "../src/compiler/core/core-proof-passes.ts";

const MIGRATION_OWNERS = new Set([
	"local opcode rule",
	"local block rule",
	"function CFG transform",
	"function loop transform",
	"function memory transform",
	"program-flow transfer",
	"cross-call transform",
	"late recipe matcher",
	"deleted as redundant",
]);

const DELETED_ALIASES = new Set([
	"post-representation-exact-builtin-calls",
	"post-representation-primitive-coercion-folding",
	"post-representation-dead-instruction-removal",
	"post-memory-tdz-check-folding",
	"post-memory-unreachable-block-removal",
]);

const MIGRATED_NAMES = new Set([
	...DELETED_ALIASES,
	"local-copy-propagation",
	"fold-static-property-keys",
	"local-constant-folding",
	"local-control-folding",
	"local-dead-instruction-elimination",
	"local-value-numbering",
	"typeof-comparison-canonicalization",
]);

const RUNTIME_REGISTRIES: ReadonlyArray<
	readonly [string, ReadonlyArray<CoreFunctionPass>]
> = [
	["CORE_LOCAL_CANONICALIZATION_PASSES", CORE_LOCAL_CANONICALIZATION_PASSES],
	["CORE_PROOF_PASSES", CORE_PROOF_PASSES],
	["CORE_CONTROL_FLOW_PASSES", CORE_CONTROL_FLOW_PASSES],
	["CORE_MEMORY_PASSES", CORE_MEMORY_PASSES],
];

interface MigrationRow {
	readonly name: string;
	readonly registry: string;
	readonly owner: string;
	readonly note: string;
}

function migrationRows(): ReadonlyArray<MigrationRow> {
	const document = readFileSync(
		new URL("../docs/decisions/05-core-local-optimizer.md", import.meta.url),
		"utf8",
	);
	return document.split("\n").flatMap((line): ReadonlyArray<MigrationRow> => {
		const columns = line
			.split("|")
			.slice(1, -1)
			.map((column) => column.trim());
		const name = /^`([^`]+)`$/.exec(columns[0] ?? "")?.[1];
		const registry = /^`([^`]+)`$/.exec(columns[1] ?? "")?.[1];
		return name === undefined || registry === undefined || columns.length !== 4
			? []
			: [
					{
						name,
						registry,
						owner: columns[2]!,
						note: columns[3]!,
					},
				];
	});
}

describe("Core local optimizer migration matrix", () => {
	it("owns every registered pass name exactly once", () => {
		const runtimeEntries = RUNTIME_REGISTRIES.flatMap(([registry, passes]) =>
			passes.map((pass) => [pass.name, registry] as const),
		);
		const runtimeByName = new Map(runtimeEntries);
		const rows = migrationRows();
		const matrixByName = new Map(rows.map((row) => [row.name, row]));

		expect(runtimeEntries).toHaveLength(37);
		expect(runtimeByName.size).toBe(runtimeEntries.length);
		expect(rows).toHaveLength(49);
		expect(matrixByName.size).toBe(rows.length);
		expect([...runtimeByName.keys()].sort()).toEqual(
			[...matrixByName.keys()].filter((name) => !MIGRATED_NAMES.has(name)).sort(),
		);

		for (const row of rows) {
			if (!MIGRATED_NAMES.has(row.name)) {
				expect(row.registry).toBe(runtimeByName.get(row.name));
			}
			expect(MIGRATION_OWNERS.has(row.owner)).toBe(true);
			expect(row.owner).not.toMatch(/temporary|legacy/);
		}
		expect(matrixByName.get("local-copy-propagation")?.owner).toBe("local opcode rule");
		expect(matrixByName.get("local-dead-instruction-elimination")?.owner).toBe(
			"deleted as redundant",
		);
	});

	it("partitions provenance and MemorySSA without changing production pass order", () => {
		const provenance = new Set(CORE_PROVENANCE_PASSES);
		const memory = new Set(CORE_MEMORY_SSA_PASSES);

		expect([...provenance].some((pass) => memory.has(pass))).toBe(false);
		expect(new Set([...provenance, ...memory])).toEqual(new Set(CORE_MEMORY_PASSES));
		expect(CORE_MEMORY_SSA_PASSES.map(({ name }) => name)).toEqual([
			"forward-exact-memory-loads",
		]);
	});

	it("records all five finalization aliases for deletion", () => {
		const rows = migrationRows();
		const aliases = rows.filter(({ name }) => DELETED_ALIASES.has(name));

		expect(aliases.map(({ name }) => name).sort()).toEqual([...DELETED_ALIASES].sort());
		for (const alias of aliases) {
			expect(alias.registry).toBe("CORE_LOCAL_FINALIZATION_PASSES");
			expect(alias.owner).toBe("deleted as redundant");
			expect(alias.note).toMatch(/^Alias of /);
		}
	});

	it("deletes the finalization alias registry from production", () => {
		const localPasses = readFileSync(
			new URL("../src/compiler/core/core-local-passes.ts", import.meta.url),
			"utf8",
		);
		const optimizer = readFileSync(
			new URL("../src/compiler/core/optimize.ts", import.meta.url),
			"utf8",
		);

		expect(localPasses).not.toMatch(/CORE_LOCAL_FINALIZATION_PASSES|name: "post-/);
		expect(optimizer).not.toMatch(/CORE_LOCAL_FINALIZATION_PASSES/);
	});

	it("keeps the analysis-free local engine outside analysis and loop modules", () => {
		const source = readFileSync(
			new URL("../src/compiler/core/core-local-optimizer.ts", import.meta.url),
			"utf8",
		);

		expect(source).not.toMatch(/core-analysis-manager|core-ir-loops/);
		expect(source).not.toMatch(/JSON\.stringify|Map<string>/);
	});

	it("has no generic function-pass scope or multi-function scheduler", () => {
		const passSource = readFileSync(
			new URL("../src/compiler/core/core-pass.ts", import.meta.url),
			"utf8",
		);
		const schedulerSource = readFileSync(
			new URL("../src/compiler/core/core-pass-manager.ts", import.meta.url),
			"utf8",
		);

		expect(passSource).not.toMatch(/CorePassScope|readonly scope:/);
		expect(schedulerSource).toMatch(/class CoreFunctionPassScheduler/);
		expect(schedulerSource).not.toMatch(/scope: "(?:scc|program)"|functionIds|sccs/);
	});

	it("uses numeric identities for optimizer queue membership", () => {
		const source = readFileSync(
			new URL("../src/compiler/core/core-pass-manager.ts", import.meta.url),
			"utf8",
		);

		expect(source).not.toMatch(/Set<string>|Map<string>|local:function|key: string/);
		expect(source).toMatch(/const queued = new Uint8Array/);
		expect(source).not.toMatch(/new Set<number>\(\)/);
	});

	it("uses definition identity and numeric slots for analysis caching", () => {
		const source = readFileSync(
			new URL("../src/compiler/core/core-analysis-manager.ts", import.meta.url),
			"utf8",
		);

		expect(source).toMatch(/#cache = new WeakMap/);
		expect(source).not.toMatch(/cacheKey|#scopeKey/);
	});

	it("reuses pass contexts across work items", () => {
		const source = readFileSync(
			new URL("../src/compiler/core/core-pass-manager.ts", import.meta.url),
			"utf8",
		);

		expect(source).toMatch(/#passContexts = new WeakMap/);
		expect(source).not.toMatch(/corePassContext\(/);
	});
});
