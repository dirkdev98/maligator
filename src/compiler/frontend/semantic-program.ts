import { debugEnabled } from "../../utils.ts";
import type {
	BuildModuleGraphOptions,
	ModuleGraph,
	ModuleRecord,
} from "./module-graph.ts";
import { buildModuleGraph } from "./module-graph.ts";
import { analyzeFile, debugSemanticProgram } from "./semantic-analysis.ts";
import type { SemanticFile, SemanticProgram } from "./semantic-analysis.ts";

/**
 * The disk/module-graph-driven front end: build the module graph from an
 * entrypoint (loader/graph phase) and run semantic analysis over every reachable
 * module in evaluation order (dependencies before dependents). A program with no
 * imports is a single-node graph, so this matches analyzing the one file.
 *
 * This lives apart from semantic-analysis.ts because it value-imports the
 * disk-backed module graph. TypeScript stripping is injected by the caller, so
 * this pipeline is usable by both the Node and native-hosted front ends.
 */
export function loadEntrypointAndRunSemanticAnalysis(
	entrypointPath: string,
	options: BuildModuleGraphOptions = {},
): SemanticProgram {
	const graph = buildModuleGraph(entrypointPath, options);
	return runSemanticAnalysisForGraph(graph);
}

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
		hasDirectEval: new Set(),
		directEvalVariableEnvironments: new Set(),
		directEvalThisBindings: new Map(),
		directEvalNewTargetBindings: new Map(),
	};

	analyzeFile(file);

	return file;
}
