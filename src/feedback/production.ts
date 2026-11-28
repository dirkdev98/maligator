import { readFileSync } from "node:fs";
import type { ESTree } from "meriyah";
import { coreFeedbackPositionKey } from "../compiler/core/core-feedback.ts";
import type {
	CoreFeedback,
	CoreFeedbackProjection,
	CoreFeedbackSource,
} from "../compiler/core/core-feedback.ts";
import { forEachEstreeChild } from "../compiler/frontend/estree-traversal.ts";
import type {
	SemanticFile,
	SemanticProgram,
} from "../compiler/frontend/semantic-analysis.ts";
import { collectSourceFunctionOrigins } from "../compiler/frontend/source-function-origins.ts";
import {
	hashCanonicalProfileJson,
	SourceProfileIdentities,
} from "../source-profile-identity.ts";
import type { FeedbackShape, FeedbackSiteValue, FeedbackTargets } from "./dump.ts";
import {
	combineSiteValues,
	FEEDBACK_FORMAT,
	feedbackPropertyPart,
} from "./feedback-file.ts";
import { feedbackModuleKey } from "./project.ts";

const MAX_SHAPES = 4;
const MAX_TARGETS = 4;
const SHA256 = /^[0-9a-f]{64}$/;
const TARGET = /^(?:builtin:.+|fn:[0-9a-f]{64}:[0-9a-f]{64})$/s;
const SITE_KEY = /^(0|[1-9]\d*):([a-z][a-z-]*):(.+)$/s;
const FLAGS = /^w?e?c?a?$/;
// Ops a production build attaches; recorded ops it can't use yet stay out of the
// projection, so recording them changes no build identity.
const APPLIED_OPS: ReadonlySet<string> = new Set(["get", "set"]);

export class FeedbackFileError extends Error {
	constructor(file: string, location: string, message: string) {
		super(`${file}: ${location === "" ? "" : `${location}: `}${message}`);
		Object.defineProperty(this, "name", {
			value: "FeedbackFileError",
			configurable: true,
		});
	}
}

interface FeedbackFunctionEntry {
	readonly revision: string;
	/** Applied site key to its value combined over every unit. */
	readonly sites: ReadonlyMap<string, FeedbackSiteValue>;
}

type Reader = (location: string, message: string) => never;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readShape(value: unknown, location: string, fail: Reader): FeedbackShape {
	if (!Array.isArray(value)) fail(location, "a shape is a list of keys");
	return value.map((key: unknown, index): string | readonly [string, string] => {
		if (typeof key === "string") return key;
		if (
			Array.isArray(key) &&
			key.length === 2 &&
			typeof key[0] === "string" &&
			typeof key[1] === "string" &&
			FLAGS.test(key[1])
		)
			return [key[0], key[1]];
		return fail(`${location}[${index}]`, "a key is a name or [name, flags]");
	});
}

function readShapes(
	value: unknown,
	location: string,
	fail: Reader,
): ReadonlyArray<FeedbackShape> {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SHAPES)
		fail(location, `shapes lists 1 to ${MAX_SHAPES} shapes`);
	return value.map((shape, index) => readShape(shape, `${location}[${index}]`, fail));
}

function readTargets(
	entry: Record<string, unknown>,
	location: string,
	fail: Reader,
): FeedbackTargets {
	if (entry.targetsMegamorphic !== undefined) {
		if (entry.targetsMegamorphic !== true) fail(location, "targetsMegamorphic is true");
		if (entry.targets !== undefined)
			fail(location, "an entry holds targets or targetsMegamorphic, not both");
		return { targetsMegamorphic: true };
	}
	const targets = entry.targets;
	if (targets === undefined) return {};
	if (
		!Array.isArray(targets) ||
		targets.length === 0 ||
		targets.length > MAX_TARGETS ||
		!targets.every((name) => typeof name === "string" && TARGET.test(name))
	)
		fail(
			`${location}.targets`,
			`lists 1 to ${MAX_TARGETS} builtin:<id> or fn:<origin>:<revision> names`,
		);
	return { targets: [...new Set(targets as Array<string>)].sort() };
}

/** A `call` site's entry: the callees alone. */
function readCallValue(
	entry: Record<string, unknown>,
	location: string,
	fail: Reader,
): FeedbackSiteValue {
	for (const field of ["shapes", "mode", "kind", "megamorphic", "dictionary"])
		if (entry[field] !== undefined) fail(location, `a call entry has no ${field}`);
	const targets = readTargets(entry, location, fail);
	if (targets.targets === undefined && targets.targetsMegamorphic === undefined)
		fail(location, "a call entry holds targets or targetsMegamorphic");
	return targets;
}

function readValue(
	entry: Record<string, unknown>,
	location: string,
	fail: Reader,
): FeedbackSiteValue {
	return {
		...readPropertyValue(entry, location, fail),
		...readTargets(entry, location, fail),
	};
}

function readPropertyValue(
	entry: Record<string, unknown>,
	location: string,
	fail: Reader,
): FeedbackSiteValue {
	const kind = entry.kind;
	if (kind !== undefined && typeof kind !== "string") fail(location, "kind is a string");
	const kindPart = kind === undefined ? {} : { kind };
	if (entry.megamorphic !== undefined) {
		if (entry.megamorphic !== true) fail(location, "megamorphic is true");
		return { megamorphic: true };
	}
	if (entry.dictionary !== undefined) {
		if (entry.dictionary !== true) fail(location, "dictionary is true");
		return { dictionary: true };
	}
	if (entry.mode !== undefined) {
		if (typeof entry.mode !== "string" || entry.mode === "")
			fail(location, "mode is a name");
		return {
			mode: entry.mode,
			...(entry.shapes === undefined
				? {}
				: { shapes: readShapes(entry.shapes, `${location}.shapes`, fail) }),
			...kindPart,
		};
	}
	if (entry.shapes === undefined)
		fail(location, "an entry holds shapes, a mode, megamorphic or dictionary");
	return {
		shapes: readShapes(entry.shapes, `${location}.shapes`, fail),
		...kindPart,
	};
}

/**
 * Normalized for hashing: shape lists sorted as the writer sorts them, and only
 * the receiver part, which a build applies; targets wait for a consumer, so
 * recording them changes no build identity.
 */
function canonicalValue(site: FeedbackSiteValue): FeedbackSiteValue {
	const value = feedbackPropertyPart(site)!;
	if (!("shapes" in value) || value.shapes === undefined) return value;
	const shapes = value.shapes
		.map((shape) => ({ shape, text: JSON.stringify(shape) }))
		.sort((left, right) => (left.text < right.text ? -1 : left.text > right.text ? 1 : 0))
		.map(({ shape }) => shape);
	return { ...value, shapes };
}

// The line terminators of the parser's `loc` lines, which source positions use.
// The recorder splits lines the same way to turn positions into site offsets.
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

function positionOf(
	starts: ReadonlyArray<number>,
	offset: number,
): { line: number; column: number } {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const middle = (low + high + 1) >> 1;
		if (starts[middle]! <= offset) low = middle;
		else high = middle - 1;
	}
	return { line: low + 1, column: offset - starts[low]! };
}

/** A node the recorder attributes sites to: a function, or the module body around them. */
function ownsSites(node: ESTree.Node): boolean {
	return (
		node.type === "Program" ||
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression" ||
		node.type === "ArrowFunctionExpression"
	);
}

/**
 * A validated maligator-feedback-v1 file, reduced to what a production build
 * applies: per function origin its recorded revision and, per applied site, the
 * value every unit's entries combine to.
 */
export class ProductionFeedback implements CoreFeedbackSource {
	readonly #root: string;
	readonly #functions: ReadonlyMap<string, FeedbackFunctionEntry>;

	private constructor(
		root: string,
		functions: ReadonlyMap<string, FeedbackFunctionEntry>,
	) {
		this.#root = root;
		this.#functions = functions;
	}

	/**
	 * Read `file`, whose module keys are relative to `root` (see
	 * `feedbackProjectRoot`). A file that can't be read or breaks the format
	 * throws `FeedbackFileError`.
	 */
	static read(file: string, root: string): ProductionFeedback {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (error) {
			throw new FeedbackFileError(
				file,
				"",
				`cannot be read (${error instanceof Error ? error.message : String(error)})`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new FeedbackFileError(
				file,
				"",
				`is not JSON (${error instanceof Error ? error.message : String(error)})`,
			);
		}
		return ProductionFeedback.parse(parsed, root, file);
	}

	private static parse(parsed: unknown, root: string, file: string): ProductionFeedback {
		const fail: Reader = (location, message) => {
			throw new FeedbackFileError(file, location, message);
		};
		if (!isRecord(parsed)) fail("", "is not a feedback file");
		if (parsed.format !== FEEDBACK_FORMAT) fail("format", `is not ${FEEDBACK_FORMAT}`);
		const units = parsed.units;
		if (!Array.isArray(units) || !units.every((unit) => typeof unit === "string"))
			fail("units", "is a list of unit names");
		if (!isRecord(parsed.functions)) fail("functions", "is an object of functions");
		const functions = new Map<string, FeedbackFunctionEntry>();
		for (const [origin, fn] of Object.entries(parsed.functions)) {
			const at = `functions.${origin}`;
			if (!SHA256.test(origin)) fail(at, "a function key is an origin hash");
			if (!isRecord(fn)) fail(at, "is an object");
			if (typeof fn.module !== "string") fail(`${at}.module`, "is a module key");
			if (typeof fn.revision !== "string" || !SHA256.test(fn.revision))
				fail(`${at}.revision`, "is a revision hash");
			if (typeof fn.start !== "number" || !Number.isSafeInteger(fn.start) || fn.start < 0)
				fail(`${at}.start`, "is a source offset");
			if (!isRecord(fn.sites)) fail(`${at}.sites`, "is an object of sites");
			const sites = new Map<string, FeedbackSiteValue>();
			for (const [siteKey, entries] of Object.entries(fn.sites)) {
				const siteAt = `${at}.sites.${siteKey}`;
				const parts = SITE_KEY.exec(siteKey);
				if (parts === null) fail(siteAt, "a site key is <offset>:<op>:<key>");
				if (!Array.isArray(entries) || entries.length === 0)
					fail(siteAt, "is a non-empty list of entries");
				const seen = new Set<number>();
				let combined: FeedbackSiteValue | undefined;
				for (const [index, entry] of entries.entries()) {
					const entryAt = `${siteAt}[${index}]`;
					if (!isRecord(entry)) fail(entryAt, "is an object");
					const entryUnits = entry.units;
					if (!Array.isArray(entryUnits) || entryUnits.length === 0)
						fail(`${entryAt}.units`, "is a non-empty list of unit indices");
					for (const unit of entryUnits) {
						if (
							typeof unit !== "number" ||
							!Number.isSafeInteger(unit) ||
							unit < 0 ||
							unit >= units.length
						)
							fail(`${entryAt}.units`, `names no unit: ${String(unit)}`);
						if (seen.has(unit))
							fail(`${entryAt}.units`, `unit ${unit} appears twice at this site`);
						seen.add(unit);
					}
					const value =
						parts[2] === "call"
							? readCallValue(entry, entryAt, fail)
							: readValue(entry, entryAt, fail);
					combined = combined === undefined ? value : combineSiteValues(combined, value);
				}
				if (APPLIED_OPS.has(parts[2]!)) sites.set(siteKey, canonicalValue(combined!));
			}
			functions.set(origin, { revision: fn.revision, sites });
		}
		return new ProductionFeedback(root, functions);
	}

	/**
	 * Name every source function as the recorder does (origins captured with this
	 * file's module keys, the module body included), match the file, and key each
	 * matched site by its source position, where Core instructions find it.
	 */
	resolve(semantic: SemanticProgram): CoreFeedback {
		const origins = collectSourceFunctionOrigins(semantic, {
			moduleKeys: new Map(
				semantic.files.map((file) => [
					file.path,
					feedbackModuleKey(this.#root, file.path),
				]),
			),
		});
		const resolver = new SourceProfileIdentities();
		const identities = new Map<string, string>();
		const located = new Map<string, { file: SemanticFile; start: number }>();
		for (const file of semantic.files) {
			const visit = (node: ESTree.Node) => {
				if (ownsSites(node)) {
					const origin = origins.get(file, node);
					const identity = resolver.functionIdentity(origin);
					if (identity.status === "known" && origin?.status === "captured") {
						identities.set(identity.origin, identity.revision);
						located.set(identity.origin, { file, start: origin.start });
					}
				}
				forEachEstreeChild(node, visit);
			};
			visit(file.ast);
		}
		const projection = this.project(identities);
		const sites = new Map<string, Map<string, FeedbackSiteValue>>();
		const starts = new Map<SemanticFile, Array<number>>();
		let recordedSites = 0;
		for (const [origin, functionSites] of projection.functions) {
			const { file, start } = located.get(origin)!;
			let fileStarts = starts.get(file);
			if (fileStarts === undefined)
				starts.set(file, (fileStarts = lineStarts(file.contents)));
			for (const [siteKey, value] of functionSites) {
				const [, offset, op, key] = SITE_KEY.exec(siteKey)!;
				const { line, column } = positionOf(fileStarts, start + Number(offset));
				const position = coreFeedbackPositionKey(file.path, line, column);
				let byPosition = sites.get(position);
				if (byPosition === undefined)
					sites.set(position, (byPosition = new Map<string, FeedbackSiteValue>()));
				byPosition.set(`${op}:${key}`, value);
				recordedSites++;
			}
		}
		return { projection, identities, sites, recordedSites };
	}

	/**
	 * Match the file against a program's source functions, origin to revision. A
	 * function recorded at another revision is stale and contributes nothing; the
	 * hash covers only the matched, combined sites, so feedback that matches
	 * nothing has none.
	 */
	project(identities: ReadonlyMap<string, string>): CoreFeedbackProjection {
		const functions = new Map<string, ReadonlyMap<string, FeedbackSiteValue>>();
		let matched = 0;
		let stale = 0;
		let absent = 0;
		for (const [origin, fn] of this.#functions) {
			const revision = identities.get(origin);
			if (revision === undefined) absent++;
			else if (revision !== fn.revision) stale++;
			else {
				matched++;
				if (fn.sites.size > 0) functions.set(origin, fn.sites);
			}
		}
		const sorted = [...functions.keys()].sort();
		return {
			hash:
				sorted.length === 0
					? undefined
					: hashCanonicalProfileJson({
							format: FEEDBACK_FORMAT,
							functions: Object.fromEntries(
								sorted.map((origin) => [
									origin,
									Object.fromEntries(functions.get(origin)!),
								]),
							),
						}),
			functions,
			matched,
			stale,
			absent,
		};
	}
}
