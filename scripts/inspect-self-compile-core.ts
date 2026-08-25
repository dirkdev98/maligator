import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CoreInstruction, CoreProgram } from "../src/compiler/core/core-ir.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { analyzeEntrypoint } from "../src/compiler/pipeline/compile-program-common.ts";
import {
	prepareSelfCompileSource,
	SELF_COMPILE_CONFIG,
} from "./self-compile-workload.ts";

interface ArrayStackSite {
	readonly operation: "Array.prototype.push" | "Array.prototype.pop";
	readonly lowering: "exact" | "guarded";
	readonly sourcePath: string;
	readonly line: number;
	readonly column: number;
}

function attributeObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
}

function arrayStackOperation(
	instruction: CoreInstruction,
): ArrayStackSite["operation"] | undefined {
	const operation =
		instruction.opcode === "callBuiltin"
			? instruction.attributes.operation
			: attributeObject(instruction.attributes.knownBuiltinCall)?.operation;
	return operation === "Array.prototype.push" || operation === "Array.prototype.pop"
		? operation
		: undefined;
}

const root = mkdtempSync(path.join(os.tmpdir(), "mal-inspect-self-compile-core-"));
try {
	const sourceRoot = path.join(root, "source");
	const fullTarget = prepareSelfCompileSource(sourceRoot);
	const target = process.argv.includes("--full")
		? fullTarget
		: path.join(sourceRoot, "src/compiler/core/core-ir-shape-provenance.ts");
	const phases: Record<string, number> = {};
	const runPhase = <T>(phase: string, run: () => T): T => {
		const startedAt = performance.now();
		const result = run();
		phases[phase] = (phases[phase] ?? 0) + performance.now() - startedAt;
		return result;
	};
	const { semantic, facts } = analyzeEntrypoint(
		target,
		{
			buildConfig: SELF_COMPILE_CONFIG,
			stripTypes: (source) => source,
		},
		runPhase,
	);
	let optimized: CoreProgram | undefined;
	compileSemanticProgramToProgramImage(semantic, {
		facts,
		runPhase,
		afterCoreOptimization(program) {
			optimized = program;
		},
	});
	if (optimized === undefined) throw new Error("Core optimization produced no program");

	const sites: Array<ArrayStackSite> = [];
	for (const fn of optimized.functions) {
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const operation = arrayStackOperation(instruction);
				if (operation === undefined || instruction.sourcePosition === undefined) continue;
				const position = optimized.sourcePositions[instruction.sourcePosition];
				if (position === undefined) continue;
				const owner =
					position.inlinedFunctionIndex === undefined
						? fn
						: optimized.functions.find(
								(candidate) => candidate.functionIndex === position.inlinedFunctionIndex,
							);
				if (owner === undefined) continue;
				sites.push({
					operation,
					lowering: instruction.opcode === "callBuiltin" ? "exact" : "guarded",
					sourcePath: path.relative(sourceRoot, owner.metadata.sourcePath),
					line: position.line,
					column: position.column,
				});
			}
		}
	}
	sites.sort(
		(left, right) =>
			left.sourcePath.localeCompare(right.sourcePath) ||
			left.line - right.line ||
			left.column - right.column ||
			left.operation.localeCompare(right.operation),
	);
	const grouped = new Map<
		string,
		{ exactPush: number; exactPop: number; guardedPush: number; guardedPop: number }
	>();
	for (const site of sites) {
		const counts = grouped.get(site.sourcePath) ?? {
			exactPush: 0,
			exactPop: 0,
			guardedPush: 0,
			guardedPop: 0,
		};
		const field =
			site.lowering === "exact"
				? site.operation === "Array.prototype.push"
					? "exactPush"
					: "exactPop"
				: site.operation === "Array.prototype.push"
					? "guardedPush"
					: "guardedPop";
		counts[field]++;
		grouped.set(site.sourcePath, counts);
	}
	const filterIndex = process.argv.indexOf("--filter");
	const filter = filterIndex < 0 ? undefined : process.argv[filterIndex + 1];
	if (filterIndex >= 0 && filter === undefined) {
		throw new Error("--filter requires a source-path substring");
	}
	const selectedSites =
		filter === undefined
			? sites.filter(({ lowering }) => lowering === "exact")
			: sites.filter(({ sourcePath }) => sourcePath.includes(filter));
	console.log(
		JSON.stringify(
			{
				workload: process.argv.includes("--full") ? "full" : "quick",
				phases,
				counts: {
					exact: sites.filter(({ lowering }) => lowering === "exact").length,
					guarded: sites.filter(({ lowering }) => lowering === "guarded").length,
				},
				bySource: [...grouped].map(([sourcePath, counts]) => ({
					sourcePath,
					...counts,
				})),
				...(filter === undefined
					? { exactSites: selectedSites }
					: { sites: selectedSites }),
			},
			undefined,
			2,
		),
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
