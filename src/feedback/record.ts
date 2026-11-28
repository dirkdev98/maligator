import { existsSync, readFileSync, rmSync } from "node:fs";
import type { ESTree } from "meriyah";
import { runSemanticAnalysisForGraph } from "../compiler/frontend/analyze-module-graph.ts";
import { forEachEstreeChild } from "../compiler/frontend/estree-traversal.ts";
import { linkModules } from "../compiler/frontend/linker.ts";
import type { ModuleGraph } from "../compiler/frontend/module-graph.ts";
import type { SemanticFile } from "../compiler/frontend/semantic-analysis.ts";
import { collectSourceFunctionOrigins } from "../compiler/frontend/source-function-origins.ts";
import type { SourceFunctionOrigins } from "../compiler/frontend/source-function-origins.ts";
import { getPrimordialCatalog } from "../compiler/shared/primordial-catalog-data.ts";
import {
	feedbackCallSites,
	feedbackFunctionSources,
	feedbackPropertySites,
} from "../compiler/target/feedback-site-table.ts";
import type {
	FeedbackFunctionSource,
	FeedbackPropertySite,
	FeedbackSourcePosition,
} from "../compiler/target/feedback-site-table.ts";
import { deserializeRuntimeImage } from "../compiler/target/program-image-codec.ts";
import { SourceProfileIdentities } from "../source-profile-identity.ts";
import { feedbackPropertyValue, parseFeedbackDump } from "./dump.ts";
import type { FeedbackDumpTargets, FeedbackSiteValue, FeedbackTargets } from "./dump.ts";
import { combineSiteValues, writeFeedbackUnit } from "./feedback-file.ts";
import { feedbackModuleKey } from "./project.ts";

export interface FeedbackRecording {
	/** The raw dump the runtime wrote under MAL_FEEDBACK_CAPTURE. */
	readonly dumpPath: string;
	/** The development images the runner spliced, in splice order. */
	readonly wires: ReadonlyArray<string>;
	readonly unit: string;
	readonly output: string;
	/** The directory module keys and unit names are relative to; see `feedbackProjectRoot`. */
	readonly root: string;
	/** The module graph whose records the images were compiled from. */
	readonly sources: () => ModuleGraph;
	/** Records compiled from transformed source, whose offsets no other build shares. */
	readonly transformed?: ReadonlySet<string>;
}

export interface FeedbackRecordingSummary {
	readonly functions: number;
	readonly sites: number;
}

type SourceFunction =
	| ESTree.FunctionDeclaration
	| ESTree.FunctionExpression
	| ESTree.ArrowFunctionExpression;

interface SourceIndex {
	readonly file: SemanticFile;
	readonly origins: SourceFunctionOrigins;
	readonly lineStarts: ReadonlyArray<number>;
	/** Function nodes by source span, outermost first, with their enclosing function. */
	readonly functions: ReadonlyArray<SourceFunctionSpan>;
}

interface SourceFunctionSpan {
	readonly node: SourceFunction;
	readonly start: number;
	readonly end: number;
	/** The enclosing function node, or the program for a module body's function. */
	readonly parent: ESTree.Node;
}

// Matches the line terminators of the parser's `loc` lines, which source positions use.
function lineStarts(contents: string): Array<number> {
	const starts = [0];
	for (let index = 0; index < contents.length; index++) {
		const code = contents.charCodeAt(index);
		if (code === 13 && contents.charCodeAt(index + 1) === 10) index++;
		if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029)
			starts.push(index + 1);
	}
	return starts;
}

function offsetOf(
	starts: ReadonlyArray<number>,
	position: { line: number; column: number } | undefined,
): number | undefined {
	if (position === undefined) return undefined;
	const line = starts[position.line - 1];
	return line === undefined ? undefined : line + position.column;
}

function indexFile(file: SemanticFile, origins: SourceFunctionOrigins): SourceIndex {
	const starts = lineStarts(file.contents);
	const functions: Array<SourceFunctionSpan> = [];
	const visit = (node: ESTree.Node, parent: ESTree.Node) => {
		let owner = parent;
		if (
			node.type === "FunctionDeclaration" ||
			node.type === "FunctionExpression" ||
			node.type === "ArrowFunctionExpression"
		) {
			const start = offsetOf(starts, node.loc?.start);
			const end = offsetOf(starts, node.loc?.end);
			if (start !== undefined && end !== undefined)
				functions.push({ node, start, end, parent });
			owner = node;
		}
		forEachEstreeChild(node, (child) => visit(child, owner));
	};
	visit(file.ast, file.ast);
	return { file, origins, lineStarts: starts, functions };
}

/**
 * Analyze and link the whole program as a build does before it captures source
 * origins, so imported bindings resolve to their exporters and the identities
 * recorded here are the ones a build of the same sources computes.
 */
function indexProgram(
	graph: ModuleGraph,
	root: string,
): {
	origins: SourceFunctionOrigins;
	files: ReadonlyMap<string, SemanticFile>;
} {
	const semantic = runSemanticAnalysisForGraph(graph);
	linkModules(semantic);
	const moduleKeys = new Map(
		semantic.files.map((file) => [file.path, feedbackModuleKey(root, file.path)]),
	);
	return {
		origins: collectSourceFunctionOrigins(semantic, { moduleKeys }),
		files: new Map(semantic.files.map((file) => [file.path, file])),
	};
}

/**
 * The innermost function containing `offset`: the last enclosing span in
 * pre-order. `ownCode` reads the position as a function's own code, which never
 * starts where a nested function starts: an instruction positioned there creates
 * the nested function, as `() => () => 1` does.
 */
function enclosingFunction(index: SourceIndex, offset: number, ownCode = false) {
	let found: SourceIndex["functions"][number] | undefined;
	for (const candidate of index.functions) {
		if (candidate.start > offset) break;
		if (offset < candidate.end && !(ownCode && candidate.start === offset))
			found = candidate;
	}
	return found;
}

/**
 * Translate a runtime dump into `unit`'s entries of the feedback file. Sites are
 * attributed to the innermost source function by their position, so caches of
 * inlined copies merge into their callee's sites. Functions without a known
 * source identity are skipped.
 */
export function recordFeedback(recording: FeedbackRecording): FeedbackRecordingSummary {
	const dump = parseFeedbackDump(new Uint8Array(readFileSync(recording.dumpPath)));
	const images = recording.wires.map((wire) =>
		deserializeRuntimeImage(new Uint8Array(readFileSync(wire))),
	);
	const sitesByFunction: Array<ReadonlyMap<number, FeedbackPropertySite>> = [];
	const callsByFunction: Array<ReadonlyMap<number, FeedbackSourcePosition>> = [];
	const functionSources: Array<FeedbackFunctionSource | undefined> = [];
	const icCounts: Array<number> = [];
	for (const image of images) {
		sitesByFunction.push(...feedbackPropertySites(image));
		callsByFunction.push(...feedbackCallSites(image));
		functionSources.push(...feedbackFunctionSources(image));
		for (const fn of image.functions) icCounts.push(fn.propertyIcCount);
	}
	const catalog = getPrimordialCatalog();

	let graph: ModuleGraph | undefined;
	let program: ReturnType<typeof indexProgram> | undefined;
	const indices = new Map<string, SourceIndex | undefined>();
	const sourceIndex = (modulePath: string): SourceIndex | undefined => {
		if (indices.has(modulePath)) return indices.get(modulePath);
		graph ??= recording.sources();
		program ??= indexProgram(graph, recording.root);
		const file = program.files.get(modulePath);
		const index =
			file === undefined ||
			// Toolchain modules such as the test runtime never reach an application build.
			graph.modules.get(modulePath)?.virtual === true ||
			recording.transformed?.has(modulePath) === true
				? undefined
				: indexFile(file, program.origins);
		indices.set(modulePath, index);
		return index;
	};

	const identities = new SourceProfileIdentities();
	/**
	 * The source function owning `position`, or for a created function the
	 * `created`th function its creator's code nests after the creating position.
	 */
	const locate = (
		position: { file: string; line: number; column: number },
		ownCode: boolean,
		created?: number,
	) => {
		const index = sourceIndex(position.file);
		if (index === undefined) return undefined;
		const offset = offsetOf(index.lineStarts, position);
		if (offset === undefined) return undefined;
		// Sites outside every function belong to the module body.
		const enclosing = enclosingFunction(index, offset, ownCode)?.node ?? index.file.ast;
		const owner =
			created === undefined
				? enclosing
				: index.functions.filter(
						(candidate) => candidate.parent === enclosing && candidate.start >= offset,
					)[created]?.node;
		if (owner === undefined) return undefined;
		const origin = index.origins.get(index.file, owner);
		const identity = identities.functionIdentity(origin);
		if (identity.status !== "known" || origin?.status !== "captured") return undefined;
		return { origin, identity, offset };
	};
	const targetNames = new Map<string, string | undefined>();
	const targetName = (kind: "source" | "primordial", targetIndex: number) => {
		const memo = `${kind}:${targetIndex}`;
		if (targetNames.has(memo)) return targetNames.get(memo);
		let name: string | undefined;
		if (kind === "primordial") {
			// A runtime built from another catalog numbers its nodes differently.
			const node =
				dump.primordialCount === catalog.nodes.length
					? catalog.nodes[targetIndex]
					: undefined;
			name = node === undefined ? undefined : `builtin:${node[0]}`;
		} else {
			const source = functionSources[targetIndex];
			const located =
				source === undefined
					? undefined
					: locate(
							source.position,
							true,
							source.kind === "created" ? source.ordinal : undefined,
						);
			name =
				located === undefined
					? undefined
					: `fn:${located.identity.origin}:${located.identity.revision}`;
		}
		targetNames.set(memo, name);
		return name;
	};
	const namedTargets = (recorded: FeedbackDumpTargets): FeedbackTargets => {
		if (recorded.megamorphic) return { targetsMegamorphic: true };
		const names = new Set<string>();
		for (const target of recorded.targets) {
			const name = targetName(target.kind, target.index);
			// A function without a portable name makes the targets unnameable as a set.
			if (name === undefined) return { targetsMegamorphic: true };
			names.add(name);
		}
		return names.size === 0 ? {} : { targets: [...names].sort() };
	};
	const functions = new Map<
		string,
		{
			module: string;
			revision: string;
			start: number;
			sites: Map<string, FeedbackSiteValue>;
		}
	>();
	const recordSite = (
		position: { file: string; line: number; column: number },
		op: string,
		key: string,
		value: FeedbackSiteValue,
	) => {
		const located = locate(position, false);
		if (located === undefined) return;
		const { origin, identity, offset } = located;
		let fn = functions.get(identity.origin);
		if (fn === undefined) {
			fn = {
				module: origin.source.moduleKey,
				revision: identity.revision,
				start: origin.start,
				sites: new Map(),
			};
			functions.set(identity.origin, fn);
		}
		const siteKey = `${offset - origin.start}:${op}:${key}`;
		const previous = fn.sites.get(siteKey);
		fn.sites.set(
			siteKey,
			previous === undefined ? value : combineSiteValues(previous, value),
		);
	};
	for (const recorded of dump.functions) {
		const sites = sitesByFunction[recorded.functionIndex];
		// Functions past the images (eval) or of a different program have no sites here.
		if (
			sites === undefined ||
			icCounts[recorded.functionIndex] !== recorded.propertyIcCount
		)
			continue;
		for (const [icIndex, observed] of recorded.sites) {
			const site = sites.get(icIndex);
			if (site !== undefined)
				recordSite(site, site.op, site.key, {
					...feedbackPropertyValue(observed),
					...namedTargets(observed.targets),
				});
		}
	}
	for (const call of dump.calls) {
		const site = callsByFunction[call.functionIndex]?.get(call.position);
		const value = namedTargets(call.targets);
		// A site whose calls never reached a function recorded nothing.
		if (site !== undefined && Object.keys(value).length > 0)
			recordSite(site, "call", "*", value);
	}

	writeFeedbackUnit(recording.output, recording.unit, functions, recording.root);
	let siteCount = 0;
	for (const fn of functions.values()) siteCount += fn.sites.size;
	return { functions: functions.size, sites: siteCount };
}

/** A fresh dump path next to the feedback file, removed by `discardFeedbackDump`. */
export function feedbackDumpPath(output: string): string {
	return `${output}.${process.pid}.capture`;
}

export function discardFeedbackDump(dumpPath: string): void {
	if (existsSync(dumpPath)) rmSync(dumpPath, { force: true });
}

/**
 * Translate a finished program's dump into the feedback file and report the
 * outcome on `report`. A program that never published a dump leaves the file as
 * it was. The dump is removed either way.
 */
export function recordFeedbackCapture(
	recording: FeedbackRecording,
	report: (line: string) => void,
): void {
	try {
		if (!existsSync(recording.dumpPath)) {
			report(
				`warning: the program published no feedback; ${recording.output} is unchanged`,
			);
			return;
		}
		const startedAt = Date.now();
		const summary = recordFeedback(recording);
		report(
			`Feedback ${recording.output} · ${recording.unit} · ${summary.functions} functions, ${summary.sites} sites (${Date.now() - startedAt}ms)`,
		);
	} catch (error) {
		report(
			`warning: feedback could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		discardFeedbackDump(recording.dumpPath);
	}
}
