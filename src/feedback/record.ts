import { existsSync, readFileSync, rmSync } from "node:fs";
import type { ESTree } from "meriyah";
import { runSemanticAnalysisForGraph } from "../compiler/frontend/analyze-module-graph.ts";
import { forEachEstreeChild } from "../compiler/frontend/estree-traversal.ts";
import type { ModuleGraph, ModuleRecord } from "../compiler/frontend/module-graph.ts";
import type { SemanticFile } from "../compiler/frontend/semantic-analysis.ts";
import { collectSourceFunctionOrigins } from "../compiler/frontend/source-function-origins.ts";
import type { SourceFunctionOrigins } from "../compiler/frontend/source-function-origins.ts";
import { feedbackPropertySites } from "../compiler/target/feedback-site-table.ts";
import type { FeedbackPropertySite } from "../compiler/target/feedback-site-table.ts";
import { deserializeRuntimeImage } from "../compiler/target/program-image-codec.ts";
import { SourceProfileIdentities } from "../source-profile-identity.ts";
import { parseFeedbackDump } from "./dump.ts";
import type { FeedbackSiteValue } from "./dump.ts";
import { combineSiteValues, writeFeedbackUnit } from "./feedback-file.ts";

export interface FeedbackRecording {
	/** The raw dump the runtime wrote under MAL_FEEDBACK_CAPTURE. */
	readonly dumpPath: string;
	/** The development images the runner spliced, in splice order. */
	readonly wires: ReadonlyArray<string>;
	readonly unit: string;
	readonly output: string;
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
	/** Function nodes by source span, outermost first. */
	readonly functions: ReadonlyArray<{ node: SourceFunction; start: number; end: number }>;
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

function indexSource(graph: ModuleGraph, record: ModuleRecord): SourceIndex {
	const semantic = runSemanticAnalysisForGraph({
		...graph,
		modules: new Map([[record.path, record]]),
		evaluationOrder: [record.path],
	});
	const file = semantic.files[0]!;
	const starts = lineStarts(file.contents);
	const functions: Array<{ node: SourceFunction; start: number; end: number }> = [];
	const visit = (node: ESTree.Node) => {
		if (
			node.type === "FunctionDeclaration" ||
			node.type === "FunctionExpression" ||
			node.type === "ArrowFunctionExpression"
		) {
			const start = offsetOf(starts, node.loc?.start);
			const end = offsetOf(starts, node.loc?.end);
			if (start !== undefined && end !== undefined) functions.push({ node, start, end });
		}
		forEachEstreeChild(node, visit);
	};
	visit(file.ast);
	return {
		file,
		origins: collectSourceFunctionOrigins(semantic, {}),
		lineStarts: starts,
		functions,
	};
}

/** The innermost function containing `offset`: the last enclosing span in pre-order. */
function enclosingFunction(index: SourceIndex, offset: number) {
	let found: SourceIndex["functions"][number] | undefined;
	for (const candidate of index.functions) {
		if (candidate.start > offset) break;
		if (offset < candidate.end) found = candidate;
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
	const icCounts: Array<number> = [];
	for (const image of images) {
		sitesByFunction.push(...feedbackPropertySites(image));
		for (const fn of image.functions) icCounts.push(fn.propertyIcCount);
	}

	let graph: ModuleGraph | undefined;
	const indices = new Map<string, SourceIndex | undefined>();
	const sourceIndex = (file: string): SourceIndex | undefined => {
		if (indices.has(file)) return indices.get(file);
		graph ??= recording.sources();
		const record = graph.modules.get(file);
		const index =
			record === undefined ||
			record.host !== undefined ||
			record.external !== undefined ||
			record.loadError !== undefined ||
			// Toolchain modules such as the test runtime never reach an application build.
			record.virtual === true ||
			recording.transformed?.has(file) === true
				? undefined
				: indexSource(graph, record);
		indices.set(file, index);
		return index;
	};

	const identities = new SourceProfileIdentities();
	const functions = new Map<
		string,
		{
			module: string;
			revision: string;
			start: number;
			sites: Map<string, FeedbackSiteValue>;
		}
	>();
	for (const recorded of dump.functions) {
		const sites = sitesByFunction[recorded.functionIndex];
		// Functions past the images (eval) or of a different program have no sites here.
		if (
			sites === undefined ||
			icCounts[recorded.functionIndex] !== recorded.propertyIcCount
		)
			continue;
		for (const [icIndex, value] of recorded.sites) {
			const site = sites.get(icIndex);
			if (site === undefined) continue;
			const index = sourceIndex(site.file);
			if (index === undefined) continue;
			const offset = offsetOf(index.lineStarts, site);
			if (offset === undefined) continue;
			const enclosing = enclosingFunction(index, offset);
			if (enclosing === undefined) continue;
			const origin = index.origins.get(index.file, enclosing.node);
			const identity = identities.functionIdentity(origin);
			if (identity.status !== "known" || origin?.status !== "captured") continue;
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
			const siteKey = `${offset - origin.start}:${site.op}:${site.key}`;
			const previous = fn.sites.get(siteKey);
			fn.sites.set(
				siteKey,
				previous === undefined ? value : combineSiteValues(previous, value),
			);
		}
	}

	writeFeedbackUnit(recording.output, recording.unit, functions);
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
