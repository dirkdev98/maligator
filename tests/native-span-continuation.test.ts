import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import { lowerNativeStorage } from "../src/compiler/target/lower-native-storage.ts";
import { analyzeNativeBodyFacts } from "../src/compiler/target/native-body-facts.ts";
import { selectNativeSpanContinuations } from "../src/compiler/target/native-span-continuation.ts";
import { nativeSpanMethodCall } from "../src/compiler/target/native-string-span.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(body: string, primordials: "mutable" | "locked" = "mutable") {
	return lowerNativeStorage(
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.classify=function(source,escape,observe){${body}};`,
				"/split-span.js",
			),
			{
				facts: compilerProgramFactsFromConfig(
					resolveBuildConfig({ engine: { primordials } }),
				),
			},
		),
		"precise",
	);
}
const body = `const part=source.split('|')[1]; const size=part.length;
 if(part==='if')return size+10; if(escape)return observe(part); return size;`;
describe("span continuations from split projections", () => {
	it.each(["mutable", "locked"] as const)(
		"replaces within retained split, capture and nested ranges under %s primordials",
		(mode) => {
			for (const producer of [
				"source.split('|')[1]",
				"/\\|([^|]*)\\|/.exec(source)[1]",
				"source.slice(1,-1).trim()",
			])
				for (const method of ["replace", "replaceAll"]) {
					const image = compile(
						`const part=${producer};const out=part.${method}(12345678901234567890n, false, observe());if(escape)observe(part);return out;`,
						mode,
					);
					const plans = image.native.functions.flatMap((f) => [
						...f.specializations.filter((p) => p.kind === "string-span"),
						...(f.storage?.spanContinuations ?? []),
					]);
					expect(
						plans.flatMap((p) => p.consumers.map((c) => c.kind)),
						producer,
					).toContain(`${method}Call`);
					expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
						image,
					);
					expect(() => emitProgramImage(image)).not.toThrow();
				}
		},
	);

	it.each(["mutable", "locked"] as const)(
		"concatenates retained split, capture and nested ranges under %s primordials",
		(mode) => {
			for (const producer of [
				"source.split('|')[1]",
				"/\\|([^|]*)\\|/.exec(source)[1]",
				"source.slice(1,-1).trim()",
			]) {
				const image = compile(
					`const part=${producer};const out=part.concat(${Array.from({ length: 30 }, (_, i) => String(i)).join(",")},escape,observe());if(escape)observe(part);return out;`,
					mode,
				);
				const plans = image.native.functions.flatMap((f) => [
					...f.specializations.filter((p) => p.kind === "string-span"),
					...(f.storage?.spanContinuations ?? []),
				]);
				expect(
					plans.flatMap((p) => p.consumers.map((c) => c.kind)),
					producer,
				).toContain("concatCall");
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
				expect(() => emitProgramImage(image)).not.toThrow();
			}
		},
	);

	it.each(["mutable", "locked"] as const)(
		"carries identity children over range, split and capture bounds under %s primordials",
		(mode) => {
			for (const root of [
				"source.slice(1,-1)",
				"source.split('|')[1]",
				"/(.*)/.exec(source)[1]",
			]) {
				const image = compile(
					`const parent=${root};const part=parent.toString(observe(1),observe(2),observe(3));const child=part.valueOf();observe();if(escape)return child;return [child.length,child.at(-1),parent.length];`,
					mode,
				);
				const fn = image.native.functions[1]!;
				const plans = [
					...fn.specializations.filter((p) => p.kind === "string-span"),
					...fn.storage!.spanContinuations,
				];
				expect(plans.map((p) => p.rangeOperation)).toEqual(
					expect.arrayContaining(["toString", "valueOf"]),
				);
				expect(
					plans.filter((p) => p.consumers.some((c) => c.kind === "rangeCall")).length,
				).toBeGreaterThanOrEqual(2);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
				expect(() => emitProgramImage(image)).not.toThrow();
			}
		},
	);
	it("materializes a parent passed as an ignored identity argument", () => {
		const image = compile(
			"const parent=source.split('|')[1];const child=parent.toString(parent);return child.length;",
		);
		const fn = image.native.functions[1]!;
		expect(
			fn.storage!.spanContinuations.some(
				(p) =>
					p.sourceKind === "split" && p.consumers.some((c) => c.kind === "rangeCall"),
			),
		).toBe(false);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});
	it.each(["mutable", "locked"] as const)(
		"retains collation across split, regexp and nested producers under %s primordials",
		(mode) => {
			for (const producer of [
				"source.split('|')[1]",
				"/\\|([^|]*)\\|/.exec(source)[1]",
				"source.slice(1,-1).trim()",
			]) {
				const image = compile(
					`const part=${producer};const a=part.localeCompare('a','en');const b=part.localeCompare(escape,observe(),escape);observe(part);return [a,b];`,
					mode,
				);
				const kinds = image.native.functions.flatMap((fn) => [
					...fn.specializations.flatMap((p) =>
						p.kind === "string-span" ? p.consumers.map((c) => c.kind) : [],
					),
					...(fn.storage?.spanContinuations.flatMap((p) =>
						p.consumers.map((c) => c.kind),
					) ?? []),
				]);
				expect(kinds, producer).toContain("localeCompareCall");

				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
				expect(emitProgramImage(image)).toBeTruthy();
			}
		},
	);

	it("carries prepared builtin authority through split and regexp continuations", () => {
		for (const producer of ["source.split('|')[1]", "/\\|([^|]*)\\|/.exec(source)[1]"]) {
			const image = compile(
				`const part=${producer};return String.prototype.localeCompare.call(part,escape,'en');`,
				"locked",
			);
			const consumers = image.native.functions.flatMap(
				(fn) => fn.storage?.spanContinuations.flatMap((p) => p.consumers) ?? [],
			);
			expect(
				consumers.map((c) => c.kind),
				producer,
			).toContain("localeComparePrepared");
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			expect(emitProgramImage(image)).toBeTruthy();
		}
	});

	it.each(["mutable", "locked"] as const)(
		"resolves locale case for split, regexp and nested ranges under %s primordials",
		(mode) => {
			for (const producer of [
				"source.split('|')[1]",
				"/\\|([^|]*)\\|/.exec(source)[1]",
				"source.slice(1,-1).trim()",
			]) {
				const image = compile(
					`const part=${producer};const a=part.toLocaleLowerCase();const b=part.toLocaleUpperCase(observe(),escape,null,undefined);observe(part);return [a,b];`,
					mode,
				);
				const kinds = image.native.functions.flatMap((fn) => [
					...fn.specializations.flatMap((p) =>
						p.kind === "string-span" ? p.consumers.map((c) => c.kind) : [],
					),
					...(fn.storage?.spanContinuations.flatMap((p) =>
						p.consumers.map((c) => c.kind),
					) ?? []),
				]);
				expect(kinds, producer).toEqual(
					expect.arrayContaining(["toLocaleLowerCaseCall", "toLocaleUpperCaseCall"]),
				);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			}
		},
	);

	it.each(["mutable", "locked"] as const)(
		"checks and repairs split, regexp and nested UTF-16 ranges under %s primordials",
		(mode) => {
			for (const producer of [
				"source.split('|')[1]",
				"/\\|([^|]*)\\|/.exec(source)[1]",
				"source.slice(1,-1).trim()",
			]) {
				const image = compile(
					`const part=${producer};const a=part.isWellFormed(observe());const b=part.toWellFormed(escape,null,undefined);observe(part);return [a,b];`,
					mode,
				);
				const kinds = image.native.functions.flatMap((fn) => [
					...fn.specializations.flatMap((p) =>
						p.kind === "string-span" ? p.consumers.map((c) => c.kind) : [],
					),
					...(fn.storage?.spanContinuations.flatMap((p) =>
						p.consumers.map((c) => c.kind),
					) ?? []),
				]);
				expect(kinds, producer).toEqual(
					expect.arrayContaining(["isWellFormedCall", "toWellFormedCall"]),
				);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			}
		},
	);

	it.each(["mutable", "locked"] as const)(
		"normalizes split, regexp and nested ranges under %s primordials",
		(mode) => {
			for (const producer of [
				"source.split('|')[1]",
				"/\\|([^|]*)\\|/.exec(source)[1]",
				"source.slice(1,-1).trim()",
			]) {
				const image = compile(
					`const part=${producer};const a=part.normalize();const b=part.normalize(observe(),escape,null,undefined);observe(part);return [a,b];`,
					mode,
				);
				const kinds = image.native.functions.flatMap((fn) => [
					...fn.specializations.flatMap((p) =>
						p.kind === "string-span" ? p.consumers.map((c) => c.kind) : [],
					),
					...(fn.storage?.spanContinuations.flatMap((p) =>
						p.consumers.map((c) => c.kind),
					) ?? []),
				]);
				expect(kinds, producer).toEqual(expect.arrayContaining(["normalizeCall"]));
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			}
		},
	);

	it.each(["mutable", "locked"] as const)(
		"converts case of split, regexp and nested ranges under %s primordials",
		(mode) => {
			for (const producer of [
				"source.split('|')[1]",
				"/\\|([^|]*)\\|/.exec(source)[1]",
				"source.slice(1,-1).trim()",
			]) {
				const image = compile(
					`const part=${producer};const a=part.toLowerCase();const b=part.toUpperCase(escape,observe(),null,undefined);observe(part);return [a,b];`,
					mode,
				);
				const kinds = image.native.functions.flatMap((fn) => [
					...fn.specializations.flatMap((p) =>
						p.kind === "string-span" ? p.consumers.map((c) => c.kind) : [],
					),
					...(fn.storage?.spanContinuations.flatMap((p) =>
						p.consumers.map((c) => c.kind),
					) ?? []),
				]);
				expect(kinds, producer).toEqual(
					expect.arrayContaining(["toLowerCaseCall", "toUpperCaseCall"]),
				);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			}
		},
	);

	it.each(["mutable", "locked"] as const)(
		"pads split, regexp and nested ranges under %s primordials",
		(mode) => {
			for (const producer of [
				"source.split('|')[1]",
				"/\\|([^|]*)\\|/.exec(source)[1]",
				"source.slice(1,-1).trim()",
			]) {
				const image = compile(
					`const part=${producer};const a=part.padStart(escape,observe);const b=part.padEnd(escape,observe);observe(part);return [a,b];`,
					mode,
				);
				const kinds = image.native.functions.flatMap((fn) => [
					...fn.specializations.flatMap((p) =>
						p.kind === "string-span" ? p.consumers.map((c) => c.kind) : [],
					),
					...(fn.storage?.spanContinuations.flatMap((p) =>
						p.consumers.map((c) => c.kind),
					) ?? []),
				]);
				expect(kinds, producer).toEqual(
					expect.arrayContaining(["padStartCall", "padEndCall"]),
				);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			}
		},
	);

	it.each(["mutable", "locked"] as const)(
		"repeats split, regexp and nested ranges under %s primordials",
		(mode) => {
			for (const producer of [
				"source.split('|')[1]",
				"/\\|([^|]*)\\|/.exec(source)[1]",
				"source.slice(1,-1).trim()",
			]) {
				const image = compile(
					`const part=${producer};const output=part.repeat(escape);observe(part);return output;`,
					mode,
				);
				const kinds = image.native.functions.flatMap((fn) => [
					...fn.specializations.flatMap((p) =>
						p.kind === "string-span" ? p.consumers.map((c) => c.kind) : [],
					),
					...(fn.storage?.spanContinuations.flatMap((p) =>
						p.consumers.map((c) => c.kind),
					) ?? []),
				]);
				expect(kinds, producer).toContain("repeatCall");
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			}
		},
	);

	it.each(["mutable", "locked"] as const)(
		"classifies numeric strings across range, split and regexp continuations under %s primordials",
		(mode) => {
			for (const producer of [
				"source.split('|')[1]",
				"/\\|([^|]*)\\|/.exec(source)[1]",
				"source.slice(1,-1).trim()",
			]) {
				const image = compile(
					`const part=${producer};if(escape)return observe(part);return [isFinite(part),isNaN(part)];`,
					mode,
				);
				const kinds = image.native.functions.flatMap((fn) => [
					...fn.specializations.flatMap((p) =>
						p.kind === "string-span" ? p.consumers.map((c) => c.kind) : [],
					),
					...(fn.storage?.spanContinuations.flatMap((p) =>
						p.consumers.map((c) => c.kind),
					) ?? []),
				]);
				expect(kinds, producer).toEqual(expect.arrayContaining(["isFinite", "isNaN"]));
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			}
		},
	);

	it("compiles an unrelated large property observation beside a span consumer", () => {
		const key = "x".repeat(150000);
		const image = compile(
			`const part=source.split('|')[1];return [part[${JSON.stringify(key)}],part.length];`,
		);
		const [plan] = image.native.functions[1]!.storage!.spanContinuations;
		expect(plan?.consumers.map((consumer) => consumer.kind)).toEqual([
			"materialize",
			"length",
		]);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});
	it.each(["charCodeAt", "Number", "length"])(
		"materializes an unrelated large %s name without decoding it during discovery",
		(name) => {
			const image = compile(
				"const part=source.split('|')[1];return part.charCodeAt(escape)+Number(part)+part.length;",
			);
			const native = image.native.functions[1]!;
			const index = image.runtime.stringConstants.findIndex(
				(units) => String.fromCharCode(...units) === name,
			);
			expect(index).toBeGreaterThanOrEqual(0);
			const strings = image.runtime.stringConstants.with(
				index,
				Array.from({ length: 150000 }, () => 120),
			);
			const body = analyzeNativeBodyFacts(native.body);
			const plans = selectNativeSpanContinuations(native, body, strings, () => false);
			expect(plans).toHaveLength(1);
			if (name === "charCodeAt") {
				const call = native.storage!.spanContinuations[0]!.consumers.find(
					(consumer) => consumer.kind === "charCodeAtCall",
				)!;
				expect(
					nativeSpanMethodCall(native.body.instructions, call.ip, strings, body),
				).toBeUndefined();
			} else {
				expect(
					plans[0]!.consumers.some((consumer) => consumer.kind === "materialize"),
				).toBe(true);
			}
		},
	);
	it("declines a large unrelated parent range method during nested span discovery", () => {
		const image = compile(
			"const parent=source.slice(1,-1);const child=parent.substring(0,2);return [child.length,parent.length];",
		);
		const native = image.native.functions[1]!;
		expect(native.storage!.spanContinuations).toHaveLength(1);
		const index = image.runtime.stringConstants.findIndex(
			(units) => String.fromCharCode(...units) === "slice",
		);
		expect(index).toBeGreaterThanOrEqual(0);
		const strings = image.runtime.stringConstants.with(
			index,
			Array.from({ length: 150000 }, () => 120),
		);
		expect(
			selectNativeSpanContinuations(
				native,
				analyzeNativeBodyFacts(native.body),
				strings,
				() => false,
			),
		).toEqual([]);
	});
	it.each(["mutable", "locked"] as const)(
		"composes substr and reverse search across every projection under %s primordials",
		(mode) => {
			for (const root of [
				"source.slice(1,-1)",
				"source.split('|')[1]",
				"/(.*)/.exec(source)[1]",
			]) {
				const image = compile(
					`const parent=${root}; const part=parent.substr(1,4);const found=part.lastIndexOf("a",2);
 observe(); if(escape)return part;return [found,parent.length,part.length];`,
					mode,
				);
				const fn = image.native.functions[1]!;
				expect(
					fn.storage!.spanContinuations.some((p) =>
						p.consumers.some((c) => c.kind === "rangeCall"),
					),
				).toBe(true);
				expect(
					fn.specializations.some(
						(p) =>
							p.kind === "string-span" &&
							p.rangeOperation === "substr" &&
							p.consumers.some((c) => c.kind === "lastIndexOfCall"),
					),
				).toBe(true);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
				expect(() => emitProgramImage(image)).not.toThrow();
			}
		},
	);

	it.each(["mutable", "locked"] as const)(
		"composes trim aliases and evaluated ignored arguments under %s primordials",
		(mode) => {
			for (const root of [
				"source.slice(1,-1)",
				"source.split('|')[1]",
				"/(.*)/.exec(source)[1]",
			]) {
				const image = compile(
					`const parent=${root};const part=parent.trimLeft(observe(1),observe(2),observe(3));const child=part.trimRight();observe();if(escape)return child;return [child.length,child.at(-1),parent.length];`,
					mode,
				);
				const fn = image.native.functions[1]!;
				const plans = [
					...fn.specializations.filter((p) => p.kind === "string-span"),
					...fn.storage!.spanContinuations,
				];
				expect(
					plans.map((p) => ("rangeOperation" in p ? p.rangeOperation : undefined)),
				).toEqual(expect.arrayContaining(["trimLeft", "trimRight"]));
				expect(
					plans.filter((p) => p.consumers.some((c) => c.kind === "rangeCall")).length,
				).toBeGreaterThanOrEqual(2);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
				expect(() => emitProgramImage(image)).not.toThrow();
			}
		},
	);

	it.each(["mutable", "locked"] as const)(
		"composes branching consumers under %s primordials",
		(mode) => {
			const image = compile(body, mode),
				native = image.native.functions[1]!;
			expect(native.storage!.spanContinuations).toHaveLength(1);
			expect(
				native.storage!.spanContinuations[0]!.consumers.map((value) => value.kind).sort(),
			).toEqual(["equal", "length", "materialize"]);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			expect(() => emitProgramImage(image, {})).not.toThrow();
		},
	);
	it("composes character access with the original source span", () => {
		const image = compile(
			"const part=source.split('|')[1];if(part.length===2)return part==='if';return part.charCodeAt(0);",
		);
		const plan = image.native.functions[1]!.storage!.spanContinuations[0]!;
		expect(plan.consumers.map((value) => value.kind)).toContain("charCodeAtCall");
		expect(plan.consumers.map((value) => value.kind)).not.toContain("materialize");
		expect(() => emitProgramImage(image, {})).not.toThrow();
	});
	it.each(["mutable", "locked"] as const)(
		"composes numeric and character consumers under %s primordials",
		(mode) => {
			const image = compile(
				"const part=source.split('|')[1]; return part.charCodeAt(escape)+Number(part);",
				mode,
			);
			const plan = image.native.functions[1]!.storage!.spanContinuations[0]!;
			expect(plan.consumers.map((value) => value.kind)).toEqual(
				expect.arrayContaining(["charCodeAtCall", "number"]),
			);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);
	it("uses the locked character chain's identity and retains its coercing fallback admission", () => {
		const image = compile(
			"const part=source.split('|')[1]; return part.charCodeAt(escape)+Number(part);",
			"locked",
		);
		const native = image.native.functions[1]!;
		const chain = native.specializations.find(
			(region) => region.kind === "string-char-code-at-chain",
		)!;
		expect(chain.methodIdentity).toBe("authority-invariant");
		const emitted = emitCompiledFunction(native, 1, "", false)!.source;
		expect(emitted).toContain(
			"mal_builtin_string_span_character(vm, MAL_VALUE_UNDEFINED, true,",
		);
		expect(emitted).toContain(`__string_char_code_at_${chain.callIp}_captured = true;`);
	});
	it("rejects omitted observers and a forged producer lifetime", () => {
		const image = compile(body),
			native = image.native.functions[1]!,
			plan = native.storage!.spanContinuations[0]!;
		for (const forged of [
			{ ...plan, consumers: plan.consumers.slice(0, 1) },
			{ ...plan, sourceCallIp: plan.producerIp },
		]) {
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, spanContinuations: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
		}
	});
	it.each([
		["charCodeAtProperty", "charCodeAtCall"],
		["charCodeAtCall", "charCodeAtProperty"],
		["number", "charCodeAtCall"],
		["charCodeAtProperty", "codePointAtProperty"],
		["charCodeAtCall", "codePointAtCall"],
		["charCodeAtCall", "charAtCall"],
		["charCodeAtCall", "atCall"],
	] as const)("rejects a %s continuation forged as %s", (original, kind) => {
		const image = compile(
			"const part=source.split('|')[1]; return part.charCodeAt(escape)+Number(part);",
		);
		const native = image.native.functions[1]!;
		const plan = native.storage!.spanContinuations[0]!;
		expect(plan.consumers.some((consumer) => consumer.kind === original)).toBe(true);
		expect(() =>
			serializeCompilerArtifact({
				...image,
				native: {
					...image.native,
					functions: image.native.functions.with(1, {
						...native,
						storage: {
							...native.storage!,
							spanContinuations: [
								{
									...plan,
									consumers: plan.consumers.map((consumer) =>
										consumer.kind === original ? { ...consumer, kind } : consumer,
									),
								},
							],
						},
					}),
				},
			}),
		).toThrow(/invalid or stale storage plan/);
	});

	it.each(["escape ? 0 : 1", "observe()"])(
		"retains captured code-point identity across argument evaluation: %s",
		(argument) => {
			const image = compile(
				`const part=source.split('|')[1]; return [part.codePointAt(${argument}),part.length];`,
			);
			const [plan] = image.native.functions[1]!.storage!.spanContinuations;
			expect(plan!.consumers.map((c) => c.kind)).toContain("codePointAtCall");
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);
	it("materializes before an observing store while retaining projected reads", () => {
		const image = compile(
			"const part=source.split('|')[1];observe.saved=part;return part.length;",
		);
		expect(
			image.native.functions[1]!.storage!.spanContinuations[0]!.consumers.map(
				(value) => value.kind,
			),
		).toEqual(["materialize", "length"]);
	});
	it("materializes a split field used as its own character position", () => {
		const image = compile(
			"const part=source.split('|')[1]; return part.charCodeAt(part)+part.length;",
		);
		const plan = image.native.functions[1]!.storage!.spanContinuations[0]!;
		expect(plan.consumers.map((value) => value.kind)).toContain("materialize");
		expect(plan.consumers.map((value) => value.kind)).not.toContain("charCodeAtCall");
		expect(() => serializeCompilerArtifact(image)).not.toThrow();
	});
});

describe("span continuations from regexp captures", () => {
	it.each(["mutable", "locked"] as const)(
		"shares code-point consumers across split and capture spans under %s primordials",
		(mode) => {
			for (const producer of ["source.split('|')[1]", "observe.exec(source)[1]"]) {
				const image = compile(
					`const part=${producer}; if(part===undefined)return -1;
 const point=part.codePointAt(escape); if(point===undefined)return part; return point+part.length+part.charCodeAt(0);`,
					mode,
				);
				const native = image.native.functions[1]!;
				const [plan] = native.storage!.spanContinuations;
				expect(plan).toBeDefined();
				expect(plan!.consumers.map((consumer) => consumer.kind)).toContain(
					"codePointAtCall",
				);
				const emitted = emitCompiledFunction(native, 1, "", false)!.source;
				expect(emitted).toContain("MAL_STRING_CHARACTER_CODE_POINT_AT");
				expect(emitted).toContain("mal_builtin_string_span_character(");
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			}
		},
	);

	const capture = `const match=observe.exec(source); if(match===null)return -1;
 const part=match[1]; if(part===undefined)return 0; const size=part.length;
 if(escape)return part; return part.charCodeAt(0)+Number(part)+size;`;
	it.each(["mutable", "locked"] as const)(
		"composes capture consumers under %s primordials",
		(mode) => {
			const image = compile(capture, mode);
			const native = image.native.functions[1]!;
			expect(native.storage!.spanContinuations).toHaveLength(1);
			const plan = native.storage!.spanContinuations[0]!;
			expect(plan.sourceKind).toBe("regexp");
			expect(plan.consumers.map((consumer) => consumer.kind)).toEqual(
				expect.arrayContaining([
					"equal",
					"length",
					"charCodeAtCall",
					"number",
					"materialize",
				]),
			);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			expect(() => emitProgramImage(image, {})).not.toThrow();
		},
	);
	it("rejects a forged capture source and omitted observer", () => {
		const image = compile(capture);
		const native = image.native.functions[1]!;
		const plan = native.storage!.spanContinuations[0]!;
		for (const forged of [
			{ ...plan, sourceKind: "split" as const },
			{ ...plan, sourceCallIp: plan.producerIp },
			{
				...plan,
				consumers: plan.consumers.filter((consumer) => consumer.kind !== "materialize"),
			},
		]) {
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, spanContinuations: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
		}
	});
	it.each(["mutable", "locked"] as const)(
		"materializes a capture retained across its producer's next execution under %s primordials",
		(mode) => {
			const image = compile(
				`let prior=""; let total=0;
 for(let i=0;i<2;i++) {
 const match=observe.exec(source); if(match===null)return total;
 const part=match[1]; total+=prior.length; prior=part; total+=part.length;
 } return total;`,
				mode,
			);
			const native = image.native.functions[1]!;
			const projection = native.specializations.find(
				(region) => region.kind === "regexp-exec-projection",
			)!;
			expect(projection).toBeDefined();
			expect(projection.loads).toHaveLength(1);
			expect(projection.loads[0]!.consumer).toBeUndefined();
			expect(native.storage!.spanContinuations).toHaveLength(0);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);
	it.each([
		"prior=upper; total+=upper.toLowerCase().length;",
		"const lower=upper.toLowerCase(); prior=lower; total+=lower.length;",
	])("materializes retained case-chain intermediates: %s", (tail) => {
		const image = compile(`let prior=""; let total=0;
 for(let i=0;i<3;i++) {
 const match=observe.exec(source); if(match===null)break;
 const upper=match[1].toUpperCase(); total+=prior.length; ${tail}
 } return total;`);
		const native = image.native.functions[1]!;
		const projection = native.specializations.find(
			(region) => region.kind === "regexp-exec-projection",
		)!;
		expect(projection).toBeDefined();
		expect(projection.loads[0]!.consumer).toBeUndefined();
		expect(() => emitProgramImage(image, {})).not.toThrow();
	});
});

describe("bounded nested range continuations", () => {
	it.each(["mutable", "locked"] as const)(
		"composes relative range bounds under %s primordials",
		(mode) => {
			for (const producer of [
				"source.slice(1,-1)",
				"source.substring(1,9)",
				"source.split('|')[1]",
				"observe.exec(source)[1]",
			]) {
				const image = compile(
					`const parent=${producer}; const child=parent.substring(escape,3); const size=child.length; if(escape)return child; return size+child.codePointAt(0)+parent.length;`,
					mode,
				);
				const native = image.native.functions[1]!;
				const plan = native.storage!.spanContinuations.find((entry) =>
					entry.consumers.some((consumer) => consumer.kind === "rangeCall"),
				);
				expect(plan, producer).toBeDefined();
				expect(plan!.consumers.map((consumer) => consumer.kind)).toContain("length");
				const child = plan!.consumers.find((consumer) => consumer.kind === "rangeCall")!;
				expect(
					native.specializations.find(
						(region) => region.kind === "string-span" && region.callIp === child.ip,
					),
				).toMatchObject({ kind: "string-span", rangeOperation: "substring" });
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			}
		},
	);
	it("rejects forged relative operations and removed parent observers", () => {
		const image = compile(
			"const parent=source.slice(1,-1); const child=parent.substring(escape,3); return child.length+parent.length;",
		);
		const native = image.native.functions[1]!;
		const plan = native.storage!.spanContinuations[0]!;
		expect(plan?.sourceKind).toBe("range");
		for (const forged of [
			{ ...plan, rangeOperation: "substring" as const },
			{ ...plan, sourceKind: "split" as const },
			{
				...plan,
				consumers: plan.consumers.map((consumer) =>
					consumer.kind === "rangeCall"
						? { ...consumer, kind: "materialize" as const }
						: consumer,
				),
			},
			{
				...plan,
				consumers: plan.consumers.map((consumer) =>
					consumer.kind === "rangeCall"
						? { ...consumer, value: consumer.value + 1 }
						: consumer,
				),
			},
			{
				...plan,
				consumers: plan.consumers.filter((consumer) => consumer.kind !== "length"),
			},
		]) {
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, spanContinuations: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
		}
	});
	it("declines mixed branch receivers without losing the certified child", () => {
		const image = compile(
			"const parent=source.slice(1,-1); const chosen=escape?parent:source; const child=chosen.substring(0,2); return child.length;",
		);
		const native = image.native.functions[1]!;
		expect(native.specializations.some((region) => region.kind === "string-span")).toBe(
			true,
		);
		expect(
			native.storage!.spanContinuations.every(
				(plan) => !plan.consumers.some((consumer) => consumer.kind === "rangeCall"),
			),
		).toBe(true);
	});
	it("declines a child bound that observes its virtual parent", () => {
		const image = compile(
			"const parent=source.slice(1,-1); const child=parent.substring(parent,3); return child.length+parent.length;",
		);
		expect(
			image.native.functions[1]!.storage!.spanContinuations.every(
				(plan) => plan.sourceKind !== "range",
			),
		).toBe(true);
	});
	it("declines a capture retained across its next exec before slicing", () => {
		const image = compile(
			`let prior=""; let result=0; for(let i=0;i<3;i++){ const part=observe.exec(source)[1]; const child=prior.slice(1); result+=child.length; prior=part; }return result;`,
		);
		expect(
			image.native.functions[1]!.storage!.spanContinuations.every(
				(plan) => !plan.consumers.some((consumer) => consumer.kind === "rangeCall"),
			),
		).toBe(true);
	});
});

describe("string character continuation results", () => {
	it.each(["mutable", "locked"] as const)(
		"keeps string outputs rooted across projected and nested spans under %s primordials",
		(mode) => {
			for (const producer of [
				"source.split('|')[1]",
				"observe.exec(source)[1]",
				"source.slice(1,-1).substring(0,2)",
			])
				for (const method of ["charAt", "at"] as const) {
					const image = compile(
						`const kept=observe();const part=${producer};${producer.includes(".slice(") ? "" : "if(part===undefined)return kept;"}const character=part.${method}(escape);observe();return [kept,character,part.length];`,
						mode,
					);
					const native = image.native.functions[1]!;
					const consumers = [
						...native.storage!.spanContinuations.flatMap((plan) => plan.consumers),
						...native.specializations.flatMap((region) =>
							region.kind === "string-span" ? region.consumers : [],
						),
					];
					const consumer = consumers.find((value) => value.kind === `${method}Call`)!;
					expect(consumer, producer).toBeDefined();
					const call = native.body.instructions[consumer.ip]!;
					if (call.opcode !== "CALL" && call.opcode !== "CALL_KNOWN")
						throw new Error("character call missing");
					const point = native.gc.safepoints.find(
						(point) => point.instructionIp === consumer.ip,
					)!;
					const retained = native.body.instructions.find(
						(instruction) => instruction.opcode === "CALL",
					)!;
					if (retained.opcode !== "CALL") throw new Error("retained call missing");
					expect(point.incomingRootRegisters).toContain(retained.dst);
					expect(point.outgoingRootRegisters).toContain(call.dst);
					expect(native.storage!.rootRegisters).toContain(call.dst);
					const emitted = emitCompiledFunction(native, 1, "", false)!.source;
					expect(emitted).toContain("mal_builtin_string_span_character(vm,");
					expect(emitted).toContain(
						`MAL_STRING_CHARACTER_${method === "at" ? "AT" : "CHAR_AT"}`,
					);
					expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
						image,
					);
				}
		},
	);
});

describe("bounded bottom-up span composition", () => {
	function chain(depth: number, producer = "source.slice(1,-1)") {
		const producers = Array.from(
			{ length: depth },
			(_, index) =>
				`const p${index}=${index === 0 ? producer : `p${index - 1}.${index % 2 ? "substring(0,8)" : "slice(0,7)"}`};`,
		).join("");
		return `${producers}const result=p${depth - 1}.charAt(0)+p${depth - 1}.at(-1);if(escape)return [result,p0];return result+p0.length;`;
	}
	function depthOf(native: ReturnType<typeof compile>["native"]["functions"][number]) {
		const depths = new Map(
			native.specializations
				.filter((region) => region.kind === "string-span")
				.map((region) => [region.callIp, 1]),
		);
		for (const plan of native.storage!.spanContinuations) {
			const childDepths = plan.consumers
				.filter((consumer) => consumer.kind === "rangeCall")
				.map((consumer) => {
					const child = depths.get(consumer.ip);
					expect(child, "children must precede their admitted parents").toBeDefined();
					return child!;
				});
			depths.set(plan.producerIp, 1 + Math.max(0, ...childDepths));
		}
		return Math.max(0, ...depths.values());
	}
	it.each(["mutable", "locked"] as const)(
		"composes four levels with independent observers under %s primordials",
		(mode) => {
			for (const producer of [
				"source.slice(1,-1)",
				"source.split('|')[1]",
				"observe.exec(source)[1]",
			]) {
				for (const depth of [3, 4]) {
					const image = compile(chain(depth, producer), mode);
					const native = image.native.functions[1]!;
					expect(depthOf(native)).toBe(depth);
					expect(native.storage!.spanContinuations).toHaveLength(depth - 1);
					const root = native.storage!.spanContinuations.at(-1)!;
					expect(root.consumers.map((c) => c.kind)).toEqual(
						expect.arrayContaining(["rangeCall", "length", "materialize"]),
					);
					for (const plan of native.storage!.spanContinuations) {
						for (const consumer of plan.consumers.filter((c) => c.kind === "rangeCall")) {
							const producer = native.body.instructions[consumer.ip]!;
							expect(producer).toMatchObject({ thisValue: consumer.value });
						}
					}
					expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
						image,
					);
					const emitted = emitCompiledFunction(native, 1, "", false)!.source;
					const rangeRoots = [
						...emitted.matchAll(
							/mal_builtin_string_range_span_init\([^\n]+&__gc_slots\[(\d+)\], &__string_span_/g,
						),
					].map((match) => match[1]);
					expect(rangeRoots).toHaveLength(producer.includes("slice") ? depth : depth - 1);
					expect(new Set(rangeRoots).size).toBe(rangeRoots.length);
					expect(() => emitProgramImage(image, {})).not.toThrow();
				}
			}
		},
	);
	it("retains a four-level suffix when a fifth producer exceeds the depth budget", () => {
		const native = compile(chain(5)).native.functions[1]!;
		expect(depthOf(native)).toBe(4);
		expect(native.storage!.spanContinuations).toHaveLength(3);
		const firstCall = native.body.instructions.findIndex(
			(op) => op.opcode === "CALL" || op.opcode === "CALL_KNOWN",
		);
		expect(
			native.storage!.spanContinuations.some((plan) => plan.producerIp === firstCall),
		).toBe(false);
	});
	it("composes both child branches and retains intermediate materializing observers", () => {
		const image = compile(
			`const outer=source.slice(1,-1); const middle=outer.substring(0,8);observe(middle);if(escape){const child=middle.slice(0,4);const leaf=child.substring(0,2);return leaf.length+middle.length;}const child=middle.substring(1,7);const leaf=child.slice(0,2);return leaf.charCodeAt(0)+outer.length;`,
		);
		const native = image.native.functions[1]!;
		expect(depthOf(native)).toBe(4);
		const middle = native.storage!.spanContinuations.find(
			(plan) => plan.consumers.filter((c) => c.kind === "rangeCall").length === 2,
		)!;
		expect(middle).toBeDefined();
		expect(middle.consumers.map((c) => c.kind)).toContain("materialize");
		expect(() => emitProgramImage(image, {})).not.toThrow();
	});
	it("rejects forged middle links and omitted intermediate observers", () => {
		const image = compile(
			`const outer=source.slice(1,-1);const middle=outer.substring(0,8);observe(middle);const leaf=middle.slice(0,2);return leaf.length+outer.length;`,
		);
		const native = image.native.functions[1]!;
		const plans = native.storage!.spanContinuations;
		expect(depthOf(native)).toBe(3);
		for (const mutate of [
			(plan: (typeof plans)[number]) => ({
				...plan,
				consumers: plan.consumers.filter((c) => c.kind !== "materialize"),
			}),
			(plan: (typeof plans)[number]) => ({
				...plan,
				consumers: plan.consumers.map((c) =>
					c.kind === "rangeCall" ? { ...c, ip: plan.producerIp } : c,
				),
			}),
		]) {
			const forged = plans.map(mutate);
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, spanContinuations: forged },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
		}
	});
	it("rejects mixed middle lifetimes and captures retained through another exec", () => {
		for (const source of [
			`const outer=source.slice(1,-1);const middle=outer.substring(0,8);const chosen=escape?middle:source;const leaf=chosen.slice(0,2);return leaf.length;`,
			`let previous="";let result=0;for(let i=0;i<3;i++){const outer=observe.exec(source)[1];const middle=outer.substring(0,8);const leaf=previous.slice(0,2);result+=leaf.length;previous=middle;}return result;`,
		]) {
			const native = compile(source).native.functions[1]!;
			expect(depthOf(native)).toBeLessThan(3);
			expect(() => emitCompiledFunction(native, 1, "", false)).not.toThrow();
		}
	});
});

describe("shared search span continuations", () => {
	it.each(["mutable", "locked"] as const)(
		"retains primitive-needle searches from every producer under %s primordials",
		(mode) => {
			for (const producer of [
				"source.split('|')[1]",
				"/\\|([^|]*)\\|/.exec(source)[1]",
				"source.slice(1,-1).trim()",
			])
				for (const method of [
					"indexOf",
					"lastIndexOf",
					"includes",
					"startsWith",
					"endsWith",
				]) {
					const image = compile(
						`const part=${producer};const result=part.${method}(12345678901234567890n,escape);if(escape)observe(part);return result;`,
						mode,
					);
					const plans = image.native.functions.flatMap((f) => [
						...f.specializations.filter((p) => p.kind === "string-span"),
						...(f.storage?.spanContinuations ?? []),
					]);
					expect(
						plans.flatMap((p) => p.consumers.map((c) => c.kind)),
						producer,
					).toContain(`${method}Call`);
					expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
						image,
					);
					expect(() => emitProgramImage(image)).not.toThrow();
				}
		},
	);

	it.each(["mutable", "locked"] as const)(
		"selects searches after projections and nested ranges under %s primordials",
		(mode) => {
			for (const producer of [
				"source.split('|')[1]",
				"observe.exec(source)[1]",
				"source.slice(1,-1).substring(0,8).slice(0,6).substring(0,4)",
			])
				for (const method of ["indexOf", "includes", "startsWith", "endsWith"]) {
					const image = compile(
						`const part=${producer}; if(escape)return part; return part.${method}('😀',escape);`,
						mode,
					);
					const native = image.native.functions[1]!;
					const consumers = [
						...native.storage!.spanContinuations.flatMap((p) => p.consumers),
						...native.specializations.flatMap((r) =>
							r.kind === "string-span" ? r.consumers : [],
						),
					];
					expect(consumers.some((c) => c.kind === `${method}Call`)).toBe(true);
					expect(emitCompiledFunction(native, 1, "", false)!.source).toContain(
						"mal_builtin_string_span_search(",
					);
					expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
						image,
					);
				}
		},
	);
	it.each(["indexOf", "lastIndexOf"] as const)(
		"rejects a forged %s projection search method",
		(method) => {
			const image = compile(
				`const part=source.split('|')[1];return part.${method}('a',escape);`,
			);
			const native = image.native.functions[1]!;
			const plans = native.storage!.spanContinuations;
			expect(plans[0]!.consumers.some((c) => c.kind === `${method}Call`)).toBe(true);
			const forged = plans.map((p) => ({
				...p,
				consumers: p.consumers.map((c) =>
					c.kind === `${method}Call` ? { ...c, kind: "includesCall" as const } : c,
				),
			}));
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, spanContinuations: forged },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
		},
	);
});

describe("trim producers in shared continuations", () => {
	it.each(["mutable", "locked"] as const)(
		"composes all source families under %s primordials",
		(mode) => {
			for (const source of [
				"source.slice(1,-1)",
				"source.split('|')[1]",
				"/x(.*)z/.exec(source)[1]",
			])
				for (const method of ["trim", "trimStart", "trimEnd"]) {
					const image = compile(
						`const outer=${source};const part=outer.${method}();const child=part.substring(0,3);observe();if(escape)return outer;return [part.length,child.startsWith('1'),child.codePointAt(0)];`,
						mode,
					);
					const native = image.native.functions[1]!;
					const plans = [
						...native.specializations
							.filter((region) => region.kind === "string-span")
							.map((region) => ({
								rangeOperation: region.rangeOperation,
								consumers: region.consumers,
							})),
						...native.storage!.spanContinuations,
					];
					expect(plans.some((plan) => plan.rangeOperation === method)).toBe(true);
					expect(
						native.storage!.spanContinuations.some((plan) =>
							plan.consumers.some((consumer) => consumer.kind === "rangeCall"),
						),
					).toBe(true);
					expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
						image,
					);
					expect(() => emitProgramImage(image)).not.toThrow();
				}
		},
	);
	it("rejects forged trim source metadata", () => {
		const image = compile(
			"const part=source.trim();const child=part.slice(0,2);return child.length+part.length;",
		);
		const native = image.native.functions[1]!,
			plan = native.storage!.spanContinuations.find(
				(plan) => plan.rangeOperation === "trim",
			)!;
		expect(plan).toBeDefined();
		expect(() =>
			serializeCompilerArtifact({
				...image,
				native: {
					...image.native,
					functions: image.native.functions.with(1, {
						...native,
						storage: {
							...native.storage!,
							spanContinuations: native.storage!.spanContinuations.map((candidate) =>
								candidate === plan ? { ...plan, rangeOperation: "trimEnd" } : candidate,
							),
						},
					}),
				},
			}),
		).toThrow();
	});
});

describe("span continuation lifetimes around exception handlers", () => {
	it.each(["mutable", "locked"] as const)(
		"admits completed handlers and disjoint protected branches under %s primordials",
		(mode) => {
			for (const source of [
				`try{observe()}catch(error){observe(error)} const part=source.split('|')[1];if(escape)observe(part);return part.length+part.indexOf('a');`,
				`if(escape){try{observe()}catch(error){return 3}return 4;}const part=source.split('|')[1];return part.length+part.indexOf('a');`,
				`try{observe()}catch(error){observe(error)} const part=/x(.*)z/.exec(source)[1];if(escape)observe(part);return part.length+part.indexOf('a');`,
				`try{observe()}catch(error){observe(error)}const parent=source.slice(1,-1);const part=parent.substring(0,3);if(escape)observe(part);return part.length+parent.length;`,
				`try{observe()}catch(error){const parent=source.slice(1,-1);const part=parent.substring(0,3);observe(part);return part.length+parent.length;}return 0;`,
			]) {
				const image = compile(source, mode);
				const native = image.native.functions[1]!;
				expect(native.body.handlers.length).toBeGreaterThan(0);
				expect(native.storage!.spanContinuations.length).toBeGreaterThan(0);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
				expect(() => emitProgramImage(image)).not.toThrow();
			}
		},
	);
	it("preserves existing Core-owned protected spans without admitting their continuations", () => {
		const image = compile(
			`try{const part=source.slice(1,-1);return part.length;}catch(error){return 0;}`,
		);
		const native = image.native.functions[1]!;
		expect(native.specializations.some((region) => region.kind === "string-span")).toBe(
			true,
		);
		expect(native.storage!.spanContinuations).toEqual([]);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(() => emitProgramImage(image)).not.toThrow();
	});
	it("rejects protected sources and live virtual aliases before any handler consumer", () => {
		const image = compile(
			`const part=source.split('|')[1];observe();return part.length+part.indexOf('a');`,
		);
		const native = image.native.functions[1]!;
		const plan = native.storage!.spanContinuations[0]!;
		const handlerIp = native.body.instructions.findLastIndex(
			(op) => op.opcode === "RETURN",
		);
		const observerIp = native.body.instructions.findIndex(
			(op, ip) =>
				ip > plan.producerIp && op.opcode === "CALL" && op.arguments.length === 0,
		);
		expect(observerIp).toBeGreaterThan(plan.producerIp);
		for (const startIp of [
			plan.sourceCallIp,
			plan.producerIp,
			observerIp,
			plan.consumers[0]!.ip,
		]) {
			const body = {
				...native.body,
				handlers: [{ startIp, endIp: startIp + 1, handlerIp }],
			};
			expect(
				selectNativeSpanContinuations(
					{ ...native, body },
					analyzeNativeBodyFacts(body),
					image.runtime.stringConstants,
					() => false,
				),
			).toEqual([]);
		}
	});
	it("keeps protected throws, catch observations, mixed aliases, and recycled generations generic", () => {
		for (const source of [
			`try{const part=source.split('|')[1];observe();return part.length;}catch(error){return 0;}`,
			`const part=source.split('|')[1];try{observe()}catch(error){return part.length;}return part.length;`,
			`try{observe()}catch(error){observe(error)}const parent=source.slice(1,-1);const chosen=escape?parent:source;const child=chosen.substring(0,2);return child.length;`,
			`try{observe()}catch(error){observe(error)}let previous='';let total=0;for(let i=0;i<3;i++){const part=source.split('|')[1];total+=previous.length;previous=part;}return total;`,
		]) {
			const image = compile(source);
			expect(image.native.functions[1]!.storage!.spanContinuations).toEqual([]);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		}
	});
});
