import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { writeFileAtomically } from "../atomic-file.ts";
import type {
	FeedbackPropertyValue,
	FeedbackShape,
	FeedbackSiteValue,
	FeedbackTargets,
} from "./dump.ts";

export const FEEDBACK_FORMAT = "maligator-feedback-v1";
const MAX_SHAPES = 4;
const MAX_TARGETS = 4;

type FeedbackEntry = { units: Array<number> } & FeedbackSiteValue;

interface FeedbackFunction {
	module: string;
	revision: string;
	start: number;
	sites: Record<string, Array<FeedbackEntry>>;
}

interface FeedbackFile {
	format: string;
	units: Array<string>;
	functions: Record<string, FeedbackFunction>;
}

/** One unit's recording of a source function, keyed by its origin hash. */
export interface RecordedFunction {
	readonly module: string;
	readonly revision: string;
	readonly start: number;
	/** Site key (`<offset>:<op>:<key>`) to the value the unit observed. */
	readonly sites: ReadonlyMap<string, FeedbackSiteValue>;
}

function shapeText(shape: FeedbackShape): string {
	return JSON.stringify(shape);
}

function sortedShapes(shapes: Iterable<FeedbackShape>): Array<FeedbackShape> {
	return [...shapes].sort((left, right) => {
		const a = shapeText(left);
		const b = shapeText(right);
		return a < b ? -1 : a > b ? 1 : 0;
	});
}

/** A value's receiver part, absent for a `call` site's value. */
export function feedbackPropertyPart(
	value: FeedbackSiteValue,
): FeedbackPropertyValue | undefined {
	if ("megamorphic" in value) return { megamorphic: true };
	if ("dictionary" in value) return { dictionary: true };
	if ("mode" in value)
		return {
			mode: value.mode,
			...(value.shapes === undefined ? {} : { shapes: value.shapes }),
			...(value.kind === undefined ? {} : { kind: value.kind }),
		};
	if ("shapes" in value && value.shapes !== undefined)
		return {
			shapes: value.shapes,
			...(value.kind === undefined ? {} : { kind: value.kind }),
		};
	return undefined;
}

export function feedbackTargetPart(value: FeedbackSiteValue): FeedbackTargets {
	if (value.targetsMegamorphic === true) return { targetsMegamorphic: true };
	return value.targets === undefined ? {} : { targets: value.targets };
}

/** Targets union; more than four distinct names are megamorphic. */
export function combineTargets(
	left: FeedbackTargets,
	right: FeedbackTargets,
): FeedbackTargets {
	if (left.targetsMegamorphic === true || right.targetsMegamorphic === true)
		return { targetsMegamorphic: true };
	const names = new Set([...(left.targets ?? []), ...(right.targets ?? [])]);
	if (names.size > MAX_TARGETS) return { targetsMegamorphic: true };
	return names.size === 0 ? {} : { targets: [...names].sort() };
}

/**
 * Combine what several caches saw for one source site, as a reader combines
 * units: the same mode and receiver kind union their shapes up to four; anything
 * else that differs, a dictionary among them, is megamorphic. Targets combine
 * separately, by union.
 */
export function combineSiteValues(
	left: FeedbackSiteValue,
	right: FeedbackSiteValue,
): FeedbackSiteValue {
	const targets = combineTargets(feedbackTargetPart(left), feedbackTargetPart(right));
	const leftProperty = feedbackPropertyPart(left);
	const rightProperty = feedbackPropertyPart(right);
	if (leftProperty === undefined || rightProperty === undefined) {
		const property = leftProperty ?? rightProperty;
		return property === undefined ? targets : { ...property, ...targets };
	}
	return { ...combinePropertyValues(leftProperty, rightProperty), ...targets };
}

function combinePropertyValues(
	left: FeedbackPropertyValue,
	right: FeedbackPropertyValue,
): FeedbackPropertyValue {
	if ("megamorphic" in left || "megamorphic" in right) return { megamorphic: true };
	if ("dictionary" in left || "dictionary" in right)
		return "dictionary" in left && "dictionary" in right ? left : { megamorphic: true };
	const mode = "mode" in left ? left.mode : undefined;
	if (mode !== ("mode" in right ? right.mode : undefined) || left.kind !== right.kind)
		return { megamorphic: true };
	const shapes = new Map<string, FeedbackShape>();
	for (const shape of [...(left.shapes ?? []), ...(right.shapes ?? [])])
		shapes.set(shapeText(shape), shape);
	if (shapes.size > MAX_SHAPES) return { megamorphic: true };
	const kind = left.kind === undefined ? {} : { kind: left.kind };
	if (mode === undefined) return { shapes: [...shapes.values()], ...kind };
	return {
		mode,
		...(shapes.size === 0 ? {} : { shapes: [...shapes.values()] }),
		...kind,
	};
}

function propertyEntry(
	value: FeedbackPropertyValue | undefined,
): FeedbackPropertyValue | Record<never, never> {
	if (value === undefined) return {};
	if ("megamorphic" in value) return { megamorphic: true };
	if ("dictionary" in value) return { dictionary: true };
	const kind = value.kind === undefined ? {} : { kind: value.kind };
	if (!("mode" in value)) return { ...kind, shapes: sortedShapes(value.shapes) };
	return {
		...kind,
		mode: value.mode,
		...(value.shapes === undefined ? {} : { shapes: sortedShapes(value.shapes) }),
	};
}

function entryOf(units: Array<number>, value: FeedbackSiteValue): FeedbackEntry {
	const targets = feedbackTargetPart(value);
	return {
		units,
		...propertyEntry(feedbackPropertyPart(value)),
		...(targets.targets === undefined
			? targets
			: { targets: [...targets.targets].sort() }),
	};
}

function valueText(value: FeedbackSiteValue): string {
	return JSON.stringify(entryOf([], value));
}

function valueOf(entry: FeedbackEntry): FeedbackSiteValue {
	const { units: _units, ...value } = entry;
	return value;
}

function readFeedbackFile(file: string): FeedbackFile | undefined {
	if (!existsSync(file)) return undefined;
	const parsed = JSON.parse(readFileSync(file, "utf8")) as FeedbackFile;
	if (parsed.format !== FEEDBACK_FORMAT)
		throw new Error(`${file} is not a ${FEEDBACK_FORMAT} file`);
	return parsed;
}

/** A unit whose source file is gone can never be recorded again. */
function unitStillValid(unit: string, root: string): boolean {
	const separator = unit.indexOf(":");
	const target = unit.slice(separator + 1);
	if (target === "*" || target === "") return true;
	return existsSync(path.resolve(root, target));
}

function sortedRecord<T>(entries: Iterable<[string, T]>): Record<string, T> {
	return Object.fromEntries(
		[...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
	);
}

/**
 * Replace `unit`'s entries in the feedback file with `functions`, keeping every
 * other unit's entries. A function recorded at another revision drops the other
 * units' entries for it: they describe source that no longer exists.
 */
export function writeFeedbackUnit(
	file: string,
	unit: string,
	functions: ReadonlyMap<string, RecordedFunction>,
	root: string,
): void {
	const previous = readFeedbackFile(file);
	const units = new Set(
		(previous?.units ?? []).filter((name) => name !== unit && unitStillValid(name, root)),
	);
	units.add(unit);
	const unitNames = [...units].sort();
	const unitIndex = new Map(unitNames.map((name, index) => [name, index]));

	// site key -> unit name -> value, per function origin
	const merged = new Map<
		string,
		{
			meta: Omit<RecordedFunction, "sites">;
			sites: Map<string, Map<string, FeedbackSiteValue>>;
		}
	>();
	for (const [origin, fn] of Object.entries(previous?.functions ?? {})) {
		const recorded = functions.get(origin);
		if (recorded !== undefined && recorded.revision !== fn.revision) continue;
		const sites = new Map<string, Map<string, FeedbackSiteValue>>();
		for (const [siteKey, entries] of Object.entries(fn.sites)) {
			for (const entry of entries) {
				const value = valueOf(entry);
				for (const index of entry.units) {
					const name = previous!.units[index];
					if (name === undefined || name === unit || !units.has(name)) continue;
					let byUnit = sites.get(siteKey);
					if (byUnit === undefined)
						sites.set(siteKey, (byUnit = new Map<string, FeedbackSiteValue>()));
					byUnit.set(name, value);
				}
			}
		}
		merged.set(origin, {
			meta: { module: fn.module, revision: fn.revision, start: fn.start },
			sites,
		});
	}
	for (const [origin, fn] of functions) {
		let target = merged.get(origin);
		if (target === undefined) {
			target = { meta: fn, sites: new Map() };
			merged.set(origin, target);
		}
		target.meta = { module: fn.module, revision: fn.revision, start: fn.start };
		for (const [siteKey, value] of fn.sites) {
			let byUnit = target.sites.get(siteKey);
			if (byUnit === undefined)
				target.sites.set(siteKey, (byUnit = new Map<string, FeedbackSiteValue>()));
			byUnit.set(unit, value);
		}
	}

	const output: FeedbackFile = {
		format: FEEDBACK_FORMAT,
		units: unitNames,
		functions: sortedRecord(
			[...merged]
				.filter(([, fn]) => fn.sites.size > 0)
				.map(([origin, fn]): [string, FeedbackFunction] => [
					origin,
					{
						module: fn.meta.module,
						revision: fn.meta.revision,
						start: fn.meta.start,
						sites: sortedRecord(
							[...fn.sites].map(([siteKey, byUnit]): [string, Array<FeedbackEntry>] => {
								const groups = new Map<
									string,
									{ units: Array<number>; value: FeedbackSiteValue }
								>();
								for (const [name, value] of byUnit) {
									const key = valueText(value);
									const group = groups.get(key) ?? { units: [], value };
									group.units.push(unitIndex.get(name)!);
									groups.set(key, group);
								}
								return [
									siteKey,
									[...groups.values()]
										.map(({ units: indices, value }) =>
											entryOf(
												indices.sort((left, right) => left - right),
												value,
											),
										)
										.sort((left, right) => left.units[0]! - right.units[0]!),
								];
							}),
						),
					},
				]),
		),
	};
	writeFileAtomically(file, `${JSON.stringify(output, null, 2)}\n`);
}
