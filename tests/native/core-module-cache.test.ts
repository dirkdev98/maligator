import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect, it } from "vitest";
import { CoreAnalysisManager } from "../../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../../src/compiler/core/core-builder.ts";
import { coreOpcodeRegistry } from "../../src/compiler/core/core-ir-opcodes.ts";
import { buildCoreOptimizationPlan } from "../../src/compiler/core/core-ir-region-selection.ts";
import { verifyCoreOptimizationPlan } from "../../src/compiler/core/core-ir-region-validity.ts";
import type { CoreValueId } from "../../src/compiler/core/core-ir.ts";
import { importCoreModule } from "../../src/compiler/core/core-module-artifact.ts";
import { CoreOptimizationReportBuilder } from "../../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_SUMMARIES_ANALYSIS } from "../../src/compiler/core/core-program-flow-analysis.ts";
import { CoreProgram } from "../../src/compiler/core/core-store.ts";
import { lowerCoreCompilationToExecution } from "../../src/compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../../src/compiler/target/lower-native-program-image.ts";
import { loadOrCompileCoreModule } from "../../src/core-module-cache.ts";
import { buildNativeProgramImage } from "../../src/test-harness.ts";
import { programAnalysisContext } from "../helpers/core-program-analysis.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "core-module-native-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
it("executes relocated cold and warm modules with independent private state", () => {
	const options = {
		source:
			"let n = 1; export function add(x) { n += x + (2 * 3); return n; } export function read() { return n; }",
		sourcePath: "/first/pilot.mjs",
		moduleKey: "pilot",
		cacheDirectory: directory,
	};
	const cold = loadOrCompileCoreModule(options);
	const warm = loadOrCompileCoreModule({
		...options,
		sourcePath: "/second/pilot.mjs",
		onWork() {
			throw new Error("Unexpected warm work");
		},
	});
	if (cold.status !== "ready" || warm.status !== "ready")
		throw new Error("Pilot did not compile");
	const program = new CoreProgram(coreOpcodeRegistry, {
		globalCount: 5,
		stringConstants: [
			[99],
			[..."console"].map((c) => c.charCodeAt(0)),
			[..."log"].map((c) => c.charCodeAt(0)),
		],
		sourcePositions: [{ line: 90, column: 1 }],
	});
	const driver = new CoreFunctionBuilder(program);
	const entry = driver.createBlock();
	const modules = [cold.canonical, cold.optimized, warm.optimized].map((artifact) =>
		importCoreModule(program, artifact, "/relocated/pilot.mjs"),
	);
	const undef = driver.appendInstruction(entry, "createUndefined", [])[0]!;
	const number = (value: number) =>
		driver.appendInstruction(entry, "createNumber", [], { attributes: { value } })[0]!;
	const call = (callee: CoreValueId, args: Array<CoreValueId> = []) =>
		driver.appendInstruction(entry, "call", [callee, undef, ...args])[0]!;
	for (const module of modules)
		call(
			driver.appendInstruction(entry, "createFunction", [], {
				attributes: { functionIndex: module.initializer },
			})[0]!,
		);
	const exportCall = (
		imported: (typeof modules)[number],
		name: string,
		args: Array<CoreValueId> = [],
	) =>
		call(
			driver.appendInstruction(entry, "loadGlobal", [], {
				attributes: { index: imported.exports.get(name)! },
			})[0]!,
			args,
		);
	const results = modules.map((module) => exportCall(module, "add", [number(2)]));
	exportCall(modules[0]!, "add", [number(10)]);
	results.push(...modules.map((module) => exportCall(module, "read")));
	const console = driver.appendInstruction(entry, "loadGlobalProperty", [], {
		attributes: { nameStringIndex: 1 },
	})[0]!;
	const log = driver.appendInstruction(entry, "loadPropertyStatic", [console], {
		attributes: { stringIndex: 2 },
	})[0]!;
	driver.appendInstruction(entry, "call", [log, console, ...results]);
	driver.setTerminator(entry, { kind: "return", value: undef });
	driver.finish(entry);
	const context = programAnalysisContext(false);
	const analyses = new CoreAnalysisManager(
		program,
		context,
		new CoreOptimizationReportBuilder(program),
	);
	const summaries = analyses.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" });
	const plan = buildCoreOptimizationPlan(
		program,
		analyses,
		summaries,
		[...program.functionIds()],
		{ context, discoverCandidates: false },
	);
	const sealed = program.seal();
	const verified = verifyCoreOptimizationPlan(sealed, plan, context);
	const image = lowerExecutionToProgramImage(
		lowerCoreCompilationToExecution({ program: sealed, context, plan: verified }),
	);
	const binary = buildNativeProgramImage(image, {
		name: "relocated-core",
		outDir: directory,
		compiled: true,
		evalEnabled: false,
		realmsEnabled: false,
		intlEnabled: false,
		temporalEnabled: false,
		regexpEnabled: false,
		webPlatformEnabled: false,
	});
	const result = spawnSync(binary, [], { encoding: "utf8" });
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
	expect(result.stdout.trim()).toBe("9 9 9 25 9 9");
}, 120_000);
