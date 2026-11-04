import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { CoreOptimizationReport } from "../src/compiler/core/core-optimization-report.ts";
import type { CoreProgram } from "../src/compiler/core/core-store.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";

function compileFactory(factory: string, body: string, realms = false) {
	const sourcePath = "factory-projection.js";
	let optimized: CoreProgram | undefined;
	let report: CoreOptimizationReport | undefined;
	const source = `
			${factory}
			function hot(count) {
				const retained = [];
				let checksum = 0;
				for (let index = 0; index < count; index++) { ${body} }
				return [checksum, retained];
			}
			console.log(hot(32));`;
	compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(source, sourcePath, parseModule(source)),
		{
			facts: withProgramClosure(
				compilerProgramFactsFromConfig(resolveBuildConfig({ engine: { realms } })),
				programClosureCertificate(
					{ kind: "whole-program", entry: sourcePath },
					[{ kind: "entry-module", module: sourcePath }],
					[],
				),
			),
			coreInstrumentation: "full",
			afterCoreOptimization(program, _context, optimizationReport) {
				optimized = program;
				report = optimizationReport;
			},
		},
	);
	return { fn: coreFunctionNamed(optimized!, "hot")!, report: report! };
}

const factory = `function makeRecord(id, value) {
	return { id, data: { value, previous: value - 1 }, read: () => value + id };
}`;

describe("pure factory projections", () => {
	it("retains the original factory when multiple realms are enabled", () => {
		const { report } = compileFactory(
			factory,
			`
			const record = makeRecord(index, index);
			checksum += record.read();
			if ((index & 7) === 0) retained[index >> 3] = record;
		`,
			true,
		);
		expect(report.transforms.appliedByKind["factory-projection"]).toBe(0);
	});
	it("materializes a returned graph only in the branch that retains it", () => {
		const { fn, report } = compileFactory(
			factory,
			`
			const record = makeRecord(index & 31, index * 2);
			checksum += record.read();
			if ((index & 7) === 0) retained[index >> 3] = record;
		`,
		);
		expect(report.transforms.appliedByKind["factory-projection"]).toBeGreaterThan(0);
		const calls = coreOperations(fn).filter(({ opcode }) => opcode === "call");
		expect(calls).toHaveLength(1);
		expect(
			coreOperations(fn).some(
				({ opcode, block }) => opcode === "storeProperty" && block === calls[0]!.block,
			),
		).toBe(true);
	});

	it("elides a factory whose graph is consumed only by its scalar projection", () => {
		const { fn, report } = compileFactory(
			factory,
			`
			const record = makeRecord(index, index + 1);
			checksum += record.read();
		`,
		);
		expect(report.transforms.appliedByKind["factory-projection"]).toBeGreaterThan(0);
		expect(
			coreOperations(fn).some(
				({ opcode }) => opcode === "call" || opcode === "createFunction",
			),
		).toBe(false);
	});

	it.each([
		{
			behavior: "observable initializers",
			factory: `function makeRecord(id, value) { console.log(value); return { read: () => value + id }; }`,
			argument: "index",
		},
		{
			behavior: "mutable captured cells",
			factory: `function makeRecord(id, value) { return { read: () => ++value + id }; }`,
			argument: "index",
		},
		{
			behavior: "captured writes after closure creation",
			factory: `function makeRecord(id, value) { const record = { read: () => value + id }; value++; return record; }`,
			argument: "index",
		},
		{ behavior: "object coercion", factory, argument: "{ valueOf() { return index; } }" },
		{
			behavior: "BigInt arithmetic",
			factory: `function makeRecord(id, value) { return { read: () => value + id }; }`,
			argument: "BigInt(index)",
		},
		{
			behavior: "receiver observations",
			factory: `function makeRecord(id, value) { return { id, read() { return this.id + value; } }; }`,
			argument: "index",
		},
	])("retains the ordinary calls for $behavior", ({ factory, argument }) => {
		const { report } = compileFactory(
			factory,
			`
			const record = makeRecord(index, ${argument});
			checksum += record.read();
			if ((index & 7) === 0) retained[index >> 3] = record;
		`,
		);
		expect(report.transforms.appliedByKind["factory-projection"]).toBe(0);
	});

	it("retains a factory when its result is mutated before the projected call", () => {
		const { report } = compileFactory(
			factory,
			`
			const record = makeRecord(index, index);
			record.read = () => 17;
			checksum += record.read();
			if ((index & 7) === 0) retained[index >> 3] = record;
		`,
		);
		expect(report.transforms.appliedByKind["factory-projection"]).toBe(0);
	});

	it("keeps one identity when an inner loop observes the same result repeatedly", () => {
		const { report } = compileFactory(
			factory,
			`
			const record = makeRecord(index, index);
			checksum += record.read();
			for (let inner = 0; inner < index; inner++) retained[inner] = record;
		`,
		);
		expect(report.transforms.appliedByKind["factory-projection"]).toBe(0);
	});

	it.each([
		{ behavior: "returns its result", escape: "if (index & 1) return record;" },
		{
			behavior: "carries its result through a join",
			escape: "const selected = index & 1 ? record : null; retained[index] = selected;",
		},
	])("declines a factory that $behavior", ({ escape }) => {
		const { report } = compileFactory(
			factory,
			`
			const record = makeRecord(index, index);
			checksum += record.read();
			${escape}
		`,
		);
		expect(report.transforms.appliedByKind["factory-projection"]).toBe(0);
	});
});
