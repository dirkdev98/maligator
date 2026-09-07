import { debugEnabled } from "../../utils.ts";
import type { ModuleGraph, ModuleRecord } from "./module-graph.ts";
import { analyzeFile, debugSemanticProgram } from "./semantic-analysis.ts";
import type { SemanticFile, SemanticProgram } from "./semantic-analysis.ts";

/** Analyze an already-built graph so cache-aware tooling does not parse twice. */
export function runSemanticAnalysisForGraph(graph: ModuleGraph): SemanticProgram {
	const program: SemanticProgram = {
		entrypointPath: graph.entry,
		files: [],
		graph,
	};

	// Host virtual modules (node:* built-ins) carry no user source — the linker
	// binds their exports later — so they are skipped here rather than analyzed.
	const analyzed = new Set<string>();
	for (const modulePath of graph.evaluationOrder) {
		const record = graph.modules.get(modulePath)!;
		if (record.host) {
			continue;
		}
		program.files.push(analyzeModuleRecord(record));
		analyzed.add(modulePath);
	}
	for (const [modulePath, record] of graph.modules) {
		if (record.host || analyzed.has(modulePath)) {
			continue;
		}
		program.files.push(analyzeModuleRecord(record));
	}

	if (debugEnabled) debugSemanticProgram(program);

	return program;
}

/**
 * Build and analyze a SemanticFile from a module-graph record, reusing the
 * record's goal-correct parse.
 */
function analyzeModuleRecord(record: ModuleRecord): SemanticFile {
	const file: SemanticFile = {
		path: record.path,
		contents: record.source,
		type: record.parsed.type,
		strict: record.parsed.strict,
		ast: record.parsed.ast,
		commonjs: record.goal === "cjs",

		scopes: [],
		nodeToScope: new Map(),
		nodeToBinding: new Map(),
		withDynamicNodes: new Set(),
		staticArgumentsAccesses: new Map(),
		lazyArgumentsBindings: new Set(),
		hasDirectEval: new Set(),
		directEvalVariableEnvironments: new Set(),
		directEvalThisBindings: new Map(),
		directEvalNewTargetBindings: new Map(),
	};

	analyzeFile(file);

	return file;
}
