import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import {
	coreCalleeTargetsCallability,
	coreCalleeTargetsFunction,
} from "../src/compiler/core/core-callee-targets.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { coreInstructionId } from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_CALL_GRAPH_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function flow(source: string) {
	const path = "/record-targets.mjs";
	const facts = withProgramClosure(
		compilerProgramFactsFromConfig(
			resolveBuildConfig({
				engine: { primordials: "locked", eval: false, realms: false },
			}),
		),
		programClosureCertificate({ kind: "whole-program", entry: path }, [], []),
	);
	const text = `function first(){}function second(){}${source}globalThis.read=read;`;
	const { program, context } = lowerSemanticProgramToCore(
		analyzeSourceAndRunSemanticAnalysis(text, path, parseModule(text)),
		{ facts },
	);
	const manager = new CoreAnalysisManager(
		program,
		context,
		new CoreOptimizationReportBuilder(program),
	);
	const named = (name: string) => coreFunctionNamed(program, name)!;
	const graph = () => manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
	return {
		program,
		context,
		manager,
		named,
		graph,
		targets: () => graph().returnTargets(named("read").id),
	};
}

describe("callee targets in returned own fields", () => {
	it.each([
		"function make(){return {callback:first};}function read(){return make().callback;}",
		"function make(){return {callback:first};}function forward(){return make();}function read(){return forward().callback;}",
		"function make(count){if(count>0)return make(count-1);return {callback:first};}function read(count){return make(count).callback;}",
		"function make(){return {callback:first};}function forward(){return {callback:make().callback};}function read(){return forward().callback;}",
		"function make(){return {callback:first};}function read(flag){const factory=flag?make:17;return factory().callback;}",
	])("transports finite identities through %s", (source) => {
		const out = flow(source);
		expect(out.targets()).toEqual(coreCalleeTargetsFunction(out.named("first").id));
	});

	it.each([
		[
			"function make(){const record={callback:first};record.callback=second;return record;}function read(){return make().callback;}",
			["second"],
		],
		[
			"function make(){return {callback:first};}function read(){const record=make();record.callback=second;return record.callback;}",
			["second"],
		],
		[
			"function make(){return {callback:first};}function read(flag){const record=make();if(flag)record.callback=second;return record.callback;}",
			["first", "second"],
		],
		[
			"function make(){return {callback:first};}function read(again){const record=make();let result;do{result=record.callback;record.callback=second;}while(again());return result;}",
			["first", "second"],
		],
	] as const)("joins reaching writer identities in %s", (source, names) => {
		const out = flow(source);
		expect(out.targets().functions).toEqual(
			names.map((name) => out.named(name).id).sort((a, b) => a - b),
		);
		expect(coreCalleeTargetsCallability(out.targets())).toBe(true);
	});

	it("wakes callers when field targets change within an unchanged object result", () => {
		const out = flow(
			"function make(count){if(count>0)return make(count-1);return {callback:first};}function read(count){return make(count).callback;}",
		);
		const fn = out.named("make");
		const before = out.graph().returnTargets(fn.id);
		expect(out.targets()).toEqual(coreCalleeTargetsFunction(out.named("first").id));
		const allocation = coreOperations(fn).find(
			(op) => op.opcode === "createObjectShaped",
		)!;
		const definition = coreInstructionId(
			fn.kernel.valueDefinitionOwner(allocation.inputs[0]!),
		);
		const opcode = fn.instructionOpcodeName(definition),
			attributes = fn.instructionAttributes(definition);
		const unknown = CoreEditor.open(out.program, fn.id);
		unknown.replaceInstruction(definition, "createNumber", [], {
			attributes: { value: 17 },
		});
		unknown.commit();
		expect(out.graph().returnTargets(fn.id)).toEqual(before);
		expect(coreCalleeTargetsCallability(out.targets())).toBe(false);
		const restore = CoreEditor.open(out.program, fn.id);
		restore.replaceInstruction(definition, opcode, [], { attributes });
		restore.commit();
		expect(out.targets()).toEqual(coreCalleeTargetsFunction(out.named("first").id));
		const fresh = new CoreAnalysisManager(
			out.program,
			out.context,
			new CoreOptimizationReportBuilder(out.program),
		).get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(out.targets()).toEqual(fresh.returnTargets(out.named("read").id));
	});

	it.each([
		"function make(flag){return {callback:flag?first:17};}function read(flag){return make(flag).callback;}",
		"function make(visit){const record={callback:first};visit(record);return record;}function read(visit){return make(visit).callback;}",
		"function make(){return new Proxy({callback:first},{});}function read(){return make().callback;}",
		"function make(){return {get callback(){return first;}};}function read(){return make().callback;}",
		"function make(flag){return flag?{callback:first}:{other:first};}function read(flag){return make(flag).callback;}",
		"function* make(){return {callback:first};}function read(){return make().callback;}",
		"async function make(){return {callback:first};}function read(){return make().callback;}",
	])("withholds callable certainty for %s", (source) => {
		expect(coreCalleeTargetsCallability(flow(source).targets())).toBeUndefined();
	});
});

describe("returned field observations through native lowering", () => {
	it.each(["function", "function*", "async function", "async function*"])(
		"preserves callable fields and factory effects across %s",
		(declaration) => {
			const suspend =
				(declaration.includes("*") ? "yield value;" : "") +
				(declaration.startsWith("async") ? "await 0;" : "");
			const out = inspectStaticValueFunction(
				`const make=function make(visit){for(let i=0;i<3;i++)visit();return {callback:Number.isFinite};};${declaration} compute(visit){const value=make(visit).callback;${suspend}return typeof value==='function'?17:11;}globalThis.compute=compute;`,
				"compute",
				{ realms: false },
			);
			expect(
				out.core.some((op) => op.opcode === "createNumber" && op.attributes.value === 11),
			).toBe(false);
			expect(out.fn.instructions.some((op) => op.opcode === "CALL")).toBe(true);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(out.image));
			expect(emitProgramImage(restored)).toBe(emitProgramImage(out.image));
		},
	);
});
