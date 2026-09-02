import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CORE_CONTROL_FLOW_PASSES } from "../src/compiler/core/core-control-flow-passes.ts";
import {
	CORE_LOCAL_CANONICALIZATION_PASSES,
	CORE_LOCAL_FINALIZATION_PASSES,
} from "../src/compiler/core/core-local-passes.ts";
import { CORE_MEMORY_PASSES } from "../src/compiler/core/core-memory-passes.ts";
import type { CorePass } from "../src/compiler/core/core-pass.ts";
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

const RUNTIME_REGISTRIES: ReadonlyArray<readonly [string, ReadonlyArray<CorePass>]> = [
	["CORE_LOCAL_CANONICALIZATION_PASSES", CORE_LOCAL_CANONICALIZATION_PASSES],
	["CORE_LOCAL_FINALIZATION_PASSES", CORE_LOCAL_FINALIZATION_PASSES],
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

		expect(runtimeEntries).toHaveLength(48);
		expect(runtimeByName.size).toBe(runtimeEntries.length);
		expect(rows).toHaveLength(48);
		expect(matrixByName.size).toBe(rows.length);
		expect([...matrixByName.keys()].sort()).toEqual([...runtimeByName.keys()].sort());

		for (const row of rows) {
			expect(row.registry).toBe(runtimeByName.get(row.name));
			expect(MIGRATION_OWNERS.has(row.owner)).toBe(true);
			expect(row.owner).not.toMatch(/temporary|legacy/);
		}
	});

	it("deletes all five finalization aliases", () => {
		const rows = migrationRows();
		const aliases = rows.filter(({ name }) => DELETED_ALIASES.has(name));

		expect(aliases.map(({ name }) => name).sort()).toEqual([...DELETED_ALIASES].sort());
		for (const alias of aliases) {
			expect(alias.registry).toBe("CORE_LOCAL_FINALIZATION_PASSES");
			expect(alias.owner).toBe("deleted as redundant");
			expect(alias.note).toMatch(/^Alias of /);
		}
	});
});
