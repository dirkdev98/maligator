import type { BuildModuleGraphOptions, ModuleRecord } from "./module-graph.ts";
import { buildModuleGraph } from "./module-graph.ts";
import { analyzeFile, debugSemanticProgram } from "./semantic-analysis.ts";
import type { SemanticFile, SemanticProgram } from "./semantic-analysis.ts";

/**
 * The disk/module-graph-driven front end: build the module graph from an
 * entrypoint (loader/graph phase) and run semantic analysis over every reachable
 * module in evaluation order (dependencies before dependents). A program with no
 * imports is a single-node graph, so this matches analyzing the one file.
 *
 * This lives apart from semantic-analysis.ts on purpose: it value-imports
 * `buildModuleGraph` (→ ts-blank-space → typescript), which is fine on Node but
 * not self-hostable. The string-based `analyzeSourceAndRunSemanticAnalysis` (the
 * eval / self-host entry) stays in semantic-analysis.ts, free of that chain.
 */
export function loadEntrypointAndRunSemanticAnalysis(
	entrypointPath: string,
	options: BuildModuleGraphOptions = {},
): SemanticProgram {
	const graph = buildModuleGraph(entrypointPath, options);

	const program: SemanticProgram = {
		entrypointPath: graph.entry,
		files: [],
		graph,
	};

	for (const modulePath of graph.evaluationOrder) {
		program.files.push(analyzeModuleRecord(graph.modules.get(modulePath)!));
	}

	debugSemanticProgram(program);

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
		hasDirectEval: new Set(),
	};

	analyzeFile(file);

	return file;
}
