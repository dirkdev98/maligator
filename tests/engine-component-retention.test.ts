import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { MaligatorBuildConfig } from "../src/build-config.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import {
	INTL_INSTALLER,
	intlServiceInstaller,
	TEMPORAL_INSTALLER,
} from "../src/compiler/frontend/engine-components.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";

const roots: Array<string> = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ALL_SERVICES = [
	"collator",
	"plural-rules",
	"number-format",
	"date-time-format",
	"list-format",
	"display-names",
	"relative-time-format",
	"segmenter",
	"duration-format",
];
const LOCALE_METHOD_SERVICES = ["collator", "number-format", "date-time-format"];

/** The engine components a whole-program image retains, in manifest order. */
function engineComponents(
	source: string,
	engine: NonNullable<MaligatorBuildConfig["engine"]>,
): Array<string> {
	const root = mkdtempSync(path.join(tmpdir(), "maligator-engine-components-"));
	roots.push(root);
	const entry = path.join(root, "main.mjs");
	writeFileSync(entry, source);
	const image = compileEntrypoint(entry, {
		buildConfig: resolveBuildConfig({ engine }),
		stripTypes: stripCompactTypes,
	});
	return image.runtime.hostInstalls
		.map(({ installer }) => installer)
		.filter(
			(installer) =>
				installer === TEMPORAL_INSTALLER || installer.startsWith(INTL_INSTALLER),
		);
}

const intl = (...services: Array<string>) => [
	INTL_INSTALLER,
	...services.map(intlServiceInstaller),
];
const everything = { temporal: true, intl: { enabled: true } };

describe("engine component retention", () => {
	it("links no component into a program that reaches none", () => {
		expect(engineComponents(`console.log("hello");`, everything)).toEqual([]);
	});

	it.each([
		[`console.log(typeof Intl);`, intl()],
		[`console.log(new Intl.NumberFormat("de").format(1));`, intl("number-format")],
		[`console.log(Intl.getCanonicalLocales("de"));`, intl()],
		[`console.log((1).toLocaleString("de"));`, intl("number-format", "date-time-format")],
		[`console.log(new Date(0).toLocaleDateString("de"));`, intl("date-time-format")],
		[`console.log("a".localeCompare("b", "sv"));`, intl("collator")],
		[
			`const { localeCompare } = String.prototype; console.log(localeCompare.call("a", "b"));`,
			intl("collator"),
		],
		[`console.log("i".toLocaleUpperCase("tr"));`, intl()],
		[`console.log(Temporal.Now.instant());`, [TEMPORAL_INSTALLER]],
		[`console.log(new Date(0).toTemporalInstant());`, [TEMPORAL_INSTALLER]],
	])("retains what %s reaches", (source, expected) => {
		expect(engineComponents(source, everything)).toEqual(expected);
	});

	it.each([
		`const intl = Intl; console.log(intl.Collator);`,
		`console.log(Object.keys(Intl));`,
		`console.log(globalThis.Intl);`,
	])("retains every Intl service once %s hands Intl on", (source) => {
		expect(engineComponents(source, everything)).toEqual(intl(...ALL_SERVICES));
	});

	it("retains the locale methods' services and Temporal for an unknown member key", () => {
		expect(engineComponents(`console.log(value[key]());`, everything)).toEqual([
			TEMPORAL_INSTALLER,
			...intl(...LOCALE_METHOD_SERVICES),
		]);
	});

	it.each([`console.log(globalThis[name]);`, `console.log(Object.keys(globalThis));`])(
		"retains every component once %s reads the global object",
		(source) => {
			expect(engineComponents(source, everything)).toEqual([
				TEMPORAL_INSTALLER,
				...intl(...ALL_SERVICES),
			]);
		},
	);

	it("retains every allowed component for runtime eval", () => {
		expect(
			engineComponents(`console.log("hello");`, { ...everything, eval: true }),
		).toEqual([TEMPORAL_INSTALLER, ...intl(...ALL_SERVICES)]);
	});

	it("honors the policy", () => {
		const source = `console.log(Temporal, Intl.Segmenter, Intl.Collator, "a".localeCompare("b"));`;
		expect(engineComponents(source, {})).toEqual([]);
		expect(
			engineComponents(source, {
				temporal: false,
				intl: { enabled: true, features: ["collator"] },
			}),
		).toEqual(intl("collator"));
	});
});
