import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { attachCoreCompilerSiteFacts } from "../src/compiler/core/compiler-site-facts.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import type { CoreOptimizationPlan } from "../src/compiler/core/core-ir-regions.ts";
import type { CoreOptimizationReport } from "../src/compiler/core/core-optimization-report.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	emitProgramImage,
	emitProgramTranslationUnits,
} from "../src/compiler/target/emit-program-image.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../src/compiler/target/lower-native-program-image.ts";
import { matchProfileSites } from "../src/compiler/target/profile-metadata.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";
import { validateRuntimeImageMetadata } from "../src/compiler/target/runtime-image.ts";
import { prepareProfile } from "../src/profile-artifact.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

interface OptimizationSidecar {
	readonly coreOptimizationReport: CoreOptimizationReport;
	readonly coreOptimizationPlan: CoreOptimizationPlan;
}

const optimizationSidecars = new WeakMap<ProgramImage, OptimizationSidecar>();

function compile(source: string) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"/project/src/profile-fixture.js",
		parseScript(source, { strict: true }),
	);
	let optimization: OptimizationSidecar | undefined;
	const definition = compileSemanticProgramToProgramImage(semantic, {
		facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
		profile: true,
		coreInstrumentation: "full",
		afterCoreOptimization(_program, _context, report, plan) {
			optimization = {
				coreOptimizationReport: report,
				coreOptimizationPlan: plan,
			};
		},
	});
	if (optimization === undefined) {
		throw new Error("profile compilation lost its Core optimization sidecar");
	}
	optimizationSidecars.set(definition, optimization);
	return definition;
}

function optimization(definition: ProgramImage): OptimizationSidecar {
	const sidecar = optimizationSidecars.get(definition);
	if (sidecar === undefined) throw new Error("missing profile optimization sidecar");
	return sidecar;
}

test("ordinary compilation skips profile-only metadata", () => {
	const source = `function hot(object, key) { return object[key]; }`;
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"/project/src/ordinary-fixture.js",
		parseScript(source, { strict: true }),
	);
	const definition = compileSemanticProgramToProgramImage(semantic);

	expect(definition.diagnostics.profileSites).toBeUndefined();
	expect(definition.diagnostics.profileRemarks).toBeUndefined();
	expect(definition.diagnostics).not.toHaveProperty("coreOptimizationReport");
	expect(definition.diagnostics).not.toHaveProperty("coreOptimizationPlan");
});

test("profile sites keep logical identity across unrelated line insertions", () => {
	const source = `function hot(object, key) { return object[key]; }\nhot(globalThis, "x");`;
	const shifted = compile(`\n\n${source}`);
	const original = compile(source);
	const originalSite = original.diagnostics.profileSites!.find(
		(site) => site.operation === "property",
	)!;
	const shiftedSite = shifted.diagnostics.profileSites!.find(
		(site) => site.operation === "property",
	)!;

	expect(shiftedSite.line).toBe(originalSite.line + 2);
	expect(shiftedSite.logicalId).toBe(originalSite.logicalId);
	const matches = matchProfileSites(
		original.diagnostics.profileSites!,
		shifted.diagnostics.profileSites!,
	);
	expect(matches.logical).toBeGreaterThan(0);
	expect(matches.coverage).toBeGreaterThan(0.9);
});

test("profile metadata gives instructions dense sites and structured remarks", () => {
	const definition = compile(
		`function hot(object, key) { object.fixed = {}; return object[key]; } hot(globalThis, "x");`,
	);
	emitProgramImage(definition);
	const sites = definition.diagnostics.profileSites!;
	const remarks = definition.diagnostics.profileRemarks!;

	expect(sites.length).toBeGreaterThan(0);
	const report = optimization(definition).coreOptimizationReport;
	expect(report.stages.length).toBeGreaterThan(0);
	expect(report.passes.every(({ runs, workItems }) => runs > 0 && workItems > 0)).toBe(
		true,
	);
	expect(report.output.instructions).toBeLessThan(report.input.instructions);
	expect(optimization(definition).coreOptimizationPlan.version.key).toMatch(/^p:/);
	expect(sites.map((site) => site.id)).toEqual(sites.map((_, index) => index));
	expect(
		definition.runtime.functions
			.flatMap((fn) => fn.profileSiteIds ?? [])
			.every((id) => id < sites.length),
	).toBe(true);
	expect(remarks).toContainEqual(
		expect.objectContaining({
			phase: "native-backend",
			operation: "property",
			code: "property.native",
			outcome: "applied",
		}),
	);
	expect(
		remarks.find(
			(remark) =>
				remark.operation === "property" && remark.details?.opcode === "LOAD_PROPERTY",
		),
	).toBeDefined();
	expect(remarks).toContainEqual(
		expect.objectContaining({ operation: "allocation", code: "allocation.heap" }),
	);
});

test("profile optimizer data enters only the explicit prepared-profile sidecar", () => {
	const definition = compile(`function hot(value) { return value + 1; }`);
	const directory = mkdtempSync(path.join(tmpdir(), "mal-profile-sidecar-"));
	const binary = path.join(directory, "fixture");
	writeFileSync(binary, "binary");
	try {
		const prepared = prepareProfile(
			binary,
			definition,
			"compiler",
			optimization(definition),
		);
		expect(definition.diagnostics).not.toHaveProperty("coreOptimizationReport");
		expect(definition.diagnostics).not.toHaveProperty("coreOptimizationPlan");
		expect(prepared.coreOptimizationReport?.stages.length).toBeGreaterThan(0);
		expect(prepared.coreOptimizationPlan?.version.key).toMatch(/^p:/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("remaps stable Core function identities in inline chains and fact-flow targets", () => {
	const program = new CoreProgram(coreOpcodeRegistry, {
		stringConstants: [[]],
		sourcePositions: [
			{ line: 1, column: 0 },
			{ line: 2, column: 3, inlinedFunctionIndex: 2, callerPosId: 0 },
		],
	});
	const entry = new CoreFunctionBuilder(program, {
		metadata: { sourcePath: "/entry.js" },
	});
	const entryBlock = entry.createBlock();
	const [callee] = entry.appendInstruction(entryBlock, "createFunction", [], {
		attributes: { functionIndex: 2 },
		sourcePosition: 0,
	});
	const [receiver] = entry.appendInstruction(entryBlock, "createUndefined", [], {
		sourcePosition: 0,
	});
	const [result] = entry.appendInstruction(entryBlock, "call", [callee!, receiver!], {
		sourcePosition: 1,
	});
	entry.setTerminator(entryBlock, { kind: "return", value: result! });
	entry.finish(entryBlock);

	const dead = new CoreFunctionBuilder(program, {
		metadata: { sourcePath: "/dead.js" },
	});
	const deadBlock = dead.createBlock();
	const [deadResult] = dead.appendInstruction(deadBlock, "createUndefined", []);
	dead.setTerminator(deadBlock, { kind: "return", value: deadResult! });
	dead.finish(deadBlock);

	const recursive = new CoreFunctionBuilder(program, {
		metadata: { sourcePath: "/inlined.js" },
	});
	const recursiveBlock = recursive.createBlock();
	const [self] = recursive.appendInstruction(recursiveBlock, "createFunction", [], {
		attributes: { functionIndex: 2 },
	});
	const [selfReceiver] = recursive.appendInstruction(
		recursiveBlock,
		"createUndefined",
		[],
	);
	const [recursiveResult] = recursive.appendInstruction(recursiveBlock, "call", [
		self!,
		selfReceiver!,
	]);
	recursive.setTerminator(recursiveBlock, {
		kind: "return",
		value: recursiveResult!,
	});
	recursive.finish(recursiveBlock);

	const optimized = optimizeCore({ program, context: programAnalysisContext() });
	expect(optimized.compilation.plan.liveFunctions).toEqual([0, 2]);
	const compilation = attachCoreCompilerSiteFacts(optimized.compilation);
	const definition = lowerExecutionToProgramImage(
		lowerCoreCompilationToExecution(compilation),
		true,
	);

	expect(definition.runtime.functionCount).toBe(2);
	expect(program.sourcePositions[1]?.inlinedFunctionIndex).toBe(2);
	expect(definition.runtime.sourcePositions[1]?.inlinedFunctionIndex).toBe(1);
	expect(
		definition.diagnostics.profileSites?.find(({ positionId }) => positionId === 1)
			?.inlineChain,
	).toContainEqual({ functionIndex: 1, positionId: 1 });
	const direct = definition.diagnostics.factFlow?.entries.find(
		({ functions }) => functions.length === 1,
	);
	expect(direct?.functions).toEqual([1]);
	expect(direct?.events).toContainEqual(
		expect.objectContaining({
			phase: "core-to-execution",
			disposition: "consumed",
			targetFunctionIndex: 1,
		}),
	);

	definition.runtime.sourcePositions[1]!.inlinedFunctionIndex = 2;
	expect(() => validateRuntimeImageMetadata(definition.runtime)).toThrow(
		"invalid RuntimeImage inline function 2",
	);
});

test("drops unused inline source rows that name dead Core functions", () => {
	const program = new CoreProgram(coreOpcodeRegistry, {
		stringConstants: [[]],
		sourcePositions: [
			{ line: 1, column: 0 },
			{ line: 2, column: 3, inlinedFunctionIndex: 2, callerPosId: 0 },
		],
	});
	const entry = new CoreFunctionBuilder(program, {
		metadata: { sourcePath: "/entry.js" },
	});
	const entryBlock = entry.createBlock();
	const [result] = entry.appendInstruction(entryBlock, "createUndefined", [], {
		sourcePosition: 0,
	});
	entry.setTerminator(entryBlock, { kind: "return", value: result! });
	entry.finish(entryBlock);

	for (const sourcePath of ["/dead.js", "/unused-inline.js"]) {
		const dead = new CoreFunctionBuilder(program, { metadata: { sourcePath } });
		const block = dead.createBlock();
		const [deadResult] = dead.appendInstruction(block, "createUndefined", []);
		dead.setTerminator(block, { kind: "return", value: deadResult! });
		dead.finish(block);
	}

	const optimized = optimizeCore({ program, context: programAnalysisContext() });
	expect(optimized.compilation.plan.liveFunctions).toEqual([0]);
	const definition = lowerExecutionToProgramImage(
		lowerCoreCompilationToExecution(optimized.compilation),
	);
	expect(definition.runtime.sourcePositions).toEqual([{ line: 1, column: 0 }]);
	expect(definition.runtime.functions[0]?.positions).toContain(0);
});

test("profile remarks describe the residual property path selected by lowering", () => {
	const source = `
		function read(n, touch) {
			const object = { x: n };
			let sum = 0;
			for (let index = 0; index < n; index++) {
				touch(object);
				sum += object.x;
			}
			return sum;
		}
		read(3, () => {});
	`;
	const lowered = lowerSemanticProgramToCore(
		analyzeSourceAndRunSemanticAnalysis(
			source,
			"/project/src/profile-known-own-slot.js",
			parseScript(source, { strict: true }),
		),
	);
	const optimized = optimizeCore(lowered);
	const compilation = attachCoreCompilerSiteFacts(optimized.compilation);
	const definition = lowerExecutionToProgramImage(
		lowerCoreCompilationToExecution(compilation),
		true,
	);
	emitProgramImage(definition, { compiled: true });

	expect(definition.diagnostics.profileRemarks).toContainEqual(
		expect.objectContaining({
			phase: "lowering",
			operation: "property",
			code: "property.dynamic-load",
			outcome: "retained",
		}),
	);
	expect(definition.diagnostics.profileRemarks).toContainEqual(
		expect.objectContaining({
			phase: "native-backend",
			operation: "property",
			code: "property.native",
			outcome: "applied",
		}),
	);
});

test("same-position operations retain distinct optimized instance identities", () => {
	const definition = compile(
		`function hot(object) { object.left = {}; object.right = {}; return object; } hot(globalThis);`,
	);
	const sites = definition.diagnostics.profileSites!.filter(
		(site) => site.operation === "property" || site.operation === "allocation",
	);
	expect(new Set(sites.map((site) => site.id)).size).toBe(sites.length);
	expect(new Set(sites.map((site) => site.instanceId)).size).toBe(sites.length);
	expect(sites.every((site) => site.originId !== "" && site.regionId !== "")).toBe(true);
});

test("every residual allocation, call, property, and boxing site has a remark", () => {
	const definition = compile(`
		function hot(value, escape) {
			const object = { value };
			if (escape) return object;
			array.push(object.value + 1);
			return object.value;
		}
		globalThis.keep = hot;
		globalThis.math = Math;
	`);
	const relevant = definition.diagnostics.profileSites!.filter((site) =>
		["allocation", "call", "property", "boxing"].includes(site.operation),
	);
	const remarked = new Set(
		definition.diagnostics.profileRemarks!.map(({ siteId }) => siteId),
	);
	expect(relevant.length).toBeGreaterThan(0);
	expect(relevant.every(({ id }) => remarked.has(id))).toBe(true);
	expect(definition.diagnostics.profileRemarks).toContainEqual(
		expect.objectContaining({ code: "optimization.applied.known-shape" }),
	);
	expect(optimization(definition).coreOptimizationReport.analyses.length).toBeGreaterThan(
		0,
	);
});

test("profile reports retain applied transformations after an instruction disappears", () => {
	const definition = compile(`
		function outer() { return 1 + 2; }
		globalThis.keep = outer;
	`);
	expect(
		optimization(definition).coreOptimizationReport.passes.find(
			({ pass }) => pass === "local-constant-folding",
		)?.changedItems,
	).toBeGreaterThan(0);
	expect(
		definition.diagnostics.profileSites!.every(
			({ instructionIndex }) => instructionIndex >= 0,
		),
	).toBe(true);
});

test("profile remarks classify closed direct calls as applied compiled calls", () => {
	const definition = compile(`
		function outer(value) {
			function expensive(input) {
				${Array.from({ length: 38 }, () => "input += input;").join("\n")}
				return input;
			}
			return ${Array.from({ length: 9 }, () => "expensive(value)").join(" + ")};
		}
		globalThis.keep = outer;
	`);
	emitProgramTranslationUnits(definition, {}, Number.MAX_SAFE_INTEGER);

	expect(definition.diagnostics.profileRemarks).toContainEqual(
		expect.objectContaining({
			phase: "native-backend",
			operation: "call",
			code: "call.direct-compiled",
			outcome: "applied",
		}),
	);
});

test("profile reports bounded transformation declines without synthetic sites", () => {
	const definition = compile(`
		function outer(value) {
			function expensive(input) {
				${Array.from({ length: 38 }, () => "input += input;").join("\n")}
				return input;
			}
			return ${Array.from({ length: 9 }, () => "expensive(value)").join(" + ")};
		}
		globalThis.keep = outer;
	`);
	const transforms = optimization(definition).coreOptimizationReport.transforms;
	expect(transforms.considered).toBeGreaterThan(0);
	expect(transforms.declined).toBeGreaterThan(0);
	expect(
		definition.diagnostics.profileSites!.every(
			({ instructionIndex }) => instructionIndex >= 0,
		),
	).toBe(true);
});

test("cross-build profile matching reports duplicate structural sites as ambiguous", () => {
	const site = compile(
		`function hot(object, key) { return object[key]; }`,
	).diagnostics.profileSites!.find((candidate) => candidate.operation === "property")!;
	const duplicate = { ...site, id: site.id + 1 };
	const matches = matchProfileSites([site, duplicate], [site, duplicate]);
	expect(matches).toMatchObject({ exact: 0, logical: 0, ambiguous: 2, unmatched: 0 });
});
