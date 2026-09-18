import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const RUNTIME_GAP_CATALOG = path.join(
	REPOSITORY_ROOT,
	"bench/runtime-gap/catalog.json",
);

export type RuntimeGapCategory =
	| "statements-operators"
	| "api-builtins"
	| "language-features"
	| "object-array-representation"
	| "allocation-gc"
	| "memory-layout-usage"
	| "host-apis"
	| "compiler-algorithms"
	| "unattributed-execution";

export interface RuntimeGapCaseDescriptor {
	readonly id: string;
	readonly group: "primitive" | "runtime" | "algorithm";
	readonly suite: "runtime" | "compiler";
	readonly owner: string;
	readonly category: RuntimeGapCategory;
	readonly mechanisms: ReadonlyArray<string>;
	readonly inputShape: string;
	readonly unit: string;
	readonly sourceSeam: string;
	readonly fixture: string;
	readonly controls: ReadonlyArray<string>;
}

export interface RuntimeGapCatalog {
	readonly path: string;
	readonly presets: Readonly<Record<"quick" | "survey", ReadonlyArray<string>>>;
	readonly cases: ReadonlyArray<
		RuntimeGapCaseDescriptor & { readonly fixturePath: string }
	>;
}

const CATEGORIES: ReadonlySet<string> = new Set<RuntimeGapCategory>([
	"statements-operators",
	"api-builtins",
	"language-features",
	"object-array-representation",
	"allocation-gc",
	"memory-layout-usage",
	"host-apis",
	"compiler-algorithms",
	"unattributed-execution",
]);

function names(value: unknown, label: string): ReadonlyArray<string> {
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(item))
	) {
		throw new Error(`${label} must contain case IDs`);
	}
	if (new Set(value).size !== value.length)
		throw new Error(`${label} contains duplicates`);
	return value as ReadonlyArray<string>;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Readonly<Record<string, unknown>>;
}

function descriptor(value: unknown): RuntimeGapCaseDescriptor {
	const candidate = record(value, "runtime-gap case");
	const mechanisms = names(candidate.mechanisms, "runtime-gap mechanisms");
	const controls = names(candidate.controls, "runtime-gap controls");
	if (
		typeof candidate.id !== "string" ||
		!/^[a-z0-9][a-z0-9-]*$/.test(candidate.id) ||
		(candidate.group !== "primitive" &&
			candidate.group !== "runtime" &&
			candidate.group !== "algorithm") ||
		(candidate.suite !== "runtime" && candidate.suite !== "compiler") ||
		typeof candidate.owner !== "string" ||
		typeof candidate.category !== "string" ||
		!CATEGORIES.has(candidate.category) ||
		typeof candidate.inputShape !== "string" ||
		typeof candidate.unit !== "string" ||
		typeof candidate.sourceSeam !== "string" ||
		typeof candidate.fixture !== "string"
	) {
		throw new Error("runtime-gap catalog contains an invalid case");
	}
	return {
		id: candidate.id,
		group: candidate.group,
		suite: candidate.suite,
		owner: candidate.owner,
		category: candidate.category as RuntimeGapCategory,
		mechanisms,
		inputShape: candidate.inputShape,
		unit: candidate.unit,
		sourceSeam: candidate.sourceSeam,
		fixture: candidate.fixture,
		controls,
	};
}

export function loadRuntimeGapCatalog(file = RUNTIME_GAP_CATALOG): RuntimeGapCatalog {
	const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
	const catalog = record(parsed, "runtime-gap catalog");
	if (catalog.schema !== 1 || !Array.isArray(catalog.cases)) {
		throw new Error("runtime-gap catalog schema is not supported");
	}
	const presets = record(catalog.presets, "runtime-gap presets");
	const quick = names(presets.quick, "quick preset");
	const survey = names(presets.survey, "survey preset");
	const seen = new Set<string>();
	const directory = path.dirname(file);
	const cases = catalog.cases.map((value) => {
		const caseDescriptor = descriptor(value);
		if (seen.has(caseDescriptor.id)) {
			throw new Error(`runtime-gap catalog repeats case: ${caseDescriptor.id}`);
		}
		seen.add(caseDescriptor.id);
		const fixturePath = path.resolve(directory, caseDescriptor.fixture);
		if (!fixturePath.startsWith(`${directory}${path.sep}`)) {
			throw new Error(
				`runtime-gap fixture escapes its catalog: ${caseDescriptor.fixture}`,
			);
		}
		return { ...caseDescriptor, fixturePath };
	});
	for (const id of [...quick, ...survey]) {
		if (!seen.has(id)) throw new Error(`runtime-gap preset names unknown case: ${id}`);
	}
	for (const descriptor of cases) {
		for (const control of descriptor.controls) {
			if (!seen.has(control)) {
				throw new Error(`${descriptor.id} names unknown control: ${control}`);
			}
		}
	}
	return { path: file, presets: { quick, survey }, cases };
}
