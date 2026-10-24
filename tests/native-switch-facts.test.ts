import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { boxSwitchLocals } from "./helpers/native-switch-facts.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const textCases = 'case "load":return 0;case "save":return 1;';
const numberCases = "case 0:return 0;case 1:return 1;case 2:return 2;case 9:return 9;";

function dispatch(source: string, profile = false) {
	const out = inspectStaticValueFunction(source, "dispatch", { profile });
	const image = deserializeCompilerArtifact(
		serializeCompilerArtifact(boxSwitchLocals(out.image)),
	);
	const native = image.native.functions[out.native.functionIndex]!;
	const emitted = emitCompiledFunction(
		native,
		native.functionIndex,
		"",
		false,
		"static",
		undefined,
		undefined,
		undefined,
		false,
		undefined,
		image.runtime.stringConstants,
	)!;
	return { native, emitted };
}

describe("switch selector facts across storage and entry boundaries", () => {
	it.each([false, true])(
		"restores every expanded comparison's entry facts with profiling %s",
		(profile) => {
			for (const [expression, kind, cases] of [
				["String(globalThis.input)", COMPILER_VALUE_KIND_STRING, textCases],
				["+globalThis.input", COMPILER_VALUE_KIND_NUMBER, numberCases],
			] as const) {
				const { native } = dispatch(
					`function dispatch(value,g,flag){const selected=flag?value:${kind === COMPILER_VALUE_KIND_STRING ? '"other"' : "0"};g(value,selected);switch(selected){${cases}default:return -1;}}globalThis.dispatch=dispatch;globalThis.result=dispatch(${expression},globalThis.g,!!globalThis.flag);`,
					profile,
				);
				const site = native.literalSwitches![0]!;
				expect(native.directEntries.length).toBeGreaterThan(0);
				for (const entry of native.directEntries) {
					expect(entry.registerRepresentations[site.selector]).toBe("boxed");
					for (let index = 0; index < site.cases.length; index++) {
						const ip = site.instructionIp + index * 3 + 1;
						const facts = entry.instructionFacts?.find(
							(fact) => fact.instructionIp === ip,
						);
						expect(facts).toMatchObject({
							masks: [kind, kind],
							results: [COMPILER_VALUE_KIND_BOOLEAN],
							effectMask: 0,
						});
						if (site.kind === "number") {
							const value = site.cases[index]!.value;
							expect(facts?.inputIntegerRanges?.[1]).toMatchObject({
								minimum: value,
								maximum: value,
							});
						}
					}
				}
			}
		},
	);

	it.each([
		["typeof input", textCases, false, false],
		["flag?String(input):null", textCases, true, false],
		["+input", numberCases, false, true],
		["input|0", numberCases, false, false],
		["input>>>0", numberCases, false, true],
		["input", numberCases, true, true],
	] as const)(
		"uses %s facts independently of boxed storage",
		(expression, cases, typeGuard, boundsGuard) => {
			const { native, emitted } = dispatch(
				`function dispatch(input,g,flag){const selected=${expression};g(input,selected);switch(selected){${cases}default:return -1;}}globalThis.dispatch=dispatch;`,
			);
			const site = native.literalSwitches![0]!;
			expect(native.registerRepresentations[site.selector]).toBe("boxed");
			expect(/if \(!mal_(?:value_is_string|ops_is_number)\(/.test(emitted.source)).toBe(
				typeGuard,
			);
			expect(emitted.source.includes("== trunc(")).toBe(boundsGuard);
		},
	);

	it.each([
		["flag?+input:null", textCases, "mal_value_to_string"],
		["flag?String(input):null", numberCases, "mal_ops_number_as_f64"],
	] as const)(
		"takes the default edge for %s outside the label domain",
		(expression, cases, conversion) => {
			const { emitted } = dispatch(
				`function dispatch(input,g,flag){const selected=${expression};g(input,selected);switch(selected){${cases}default:return -1;}}globalThis.dispatch=dispatch;`,
			);
			expect(emitted.source).not.toContain(conversion);
			expect(emitted.source).not.toContain("__switch_");
		},
	);

	it.each([
		["input&3", 3, false],
		["input>>>0", 4294967295, true],
	] as const)(
		"keeps the proven interval for %s and prunes only impossible labels",
		(expression, maximum, caseNine) => {
			const { native, emitted } = dispatch(
				`function dispatch(input,g){const selected=${expression};g(input,selected);switch(selected){${numberCases}default:return -1;}}globalThis.dispatch=dispatch;`,
			);
			const site = native.literalSwitches![0]!;
			expect(native.facts![site.instructionIp + 1]!.inputIntegerRanges?.[0]).toEqual({
				minimum: 0,
				maximum,
				exactSafeIntegers: true,
				excludesNegativeZero: true,
			});
			expect(emitted.source.includes("case 9:")).toBe(caseNine);
		},
	);

	it("uses selected String facts while retaining the canonical unknown-selector guard", () => {
		const { emitted } = dispatch(
			`function dispatch(value,g,flag){const selected=flag?value:"other";g(value,selected);switch(selected){${textCases}default:return -1;}}globalThis.dispatch=dispatch;globalThis.result=dispatch(String(globalThis.input),globalThis.g,!!globalThis.flag);`,
		);
		expect(emitted.source).toContain("mal_value_is_string");
		expect(emitted.directEntries[0]!.source).not.toContain("mal_value_is_string");
	});
});
