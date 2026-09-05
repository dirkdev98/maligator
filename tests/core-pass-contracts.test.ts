import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CORE_CONTROL_FLOW_PASSES } from "../src/compiler/core/core-control-flow-passes.ts";
import { CORE_LOCAL_CANONICALIZATION_PASSES } from "../src/compiler/core/core-local-passes.ts";
import {
	CORE_MEMORY_PASSES,
	CORE_MEMORY_SSA_PASSES,
	CORE_PROVENANCE_PASSES,
} from "../src/compiler/core/core-memory-passes.ts";
import { CORE_PROOF_PASSES } from "../src/compiler/core/core-proof-passes.ts";

describe("Core pass contracts", () => {
	it("assigns a unique name to every registered function pass", () => {
		const names = [
			...CORE_LOCAL_CANONICALIZATION_PASSES,
			...CORE_PROOF_PASSES,
			...CORE_CONTROL_FLOW_PASSES,
			...CORE_MEMORY_PASSES,
		].map((pass) => pass.name);

		expect(new Set(names).size).toBe(names.length);
	});

	it("partitions memory passes between provenance and MemorySSA", () => {
		const provenance = new Set(CORE_PROVENANCE_PASSES);
		const memory = new Set(CORE_MEMORY_SSA_PASSES);

		expect([...provenance].some((pass) => memory.has(pass))).toBe(false);
		expect(new Set([...provenance, ...memory])).toEqual(new Set(CORE_MEMORY_PASSES));
	});

	it("keeps the local engine independent of analysis and loop modules", () => {
		const source = readFileSync(
			new URL("../src/compiler/core/core-local-optimizer.ts", import.meta.url),
			"utf8",
		);

		expect(source).not.toMatch(/core-analysis-manager|core-ir-loops/);
	});
});
