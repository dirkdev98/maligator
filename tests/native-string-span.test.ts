import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { vmRegionActions } from "../src/compiler/target/program-image.ts";
import type {
	ProgramImage,
	VmStringSpanRegion,
} from "../src/compiler/target/program-image.ts";

function compile(
	body: string,
	primordials: "locked" | "mutable" = "mutable",
): ProgramImage {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.inspect = function(value, start, end, escape, observer) { ${body} };`,
			"/string-span.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
	);
}
function spans(image: ProgramImage): Array<VmStringSpanRegion> {
	return image.native.functions.flatMap((fn) =>
		fn.specializations.filter((region) => region.kind === "string-span"),
	);
}
const branching = `const part = value.slice(start, end); const length = part.length;
 if (part === "ab") { if (escape) return part; return length; }
 if (escape) return observer(part);
 return Number(part) + length;`;

describe("composable string spans", () => {
	it.each(["mutable", "locked"] as const)(
		"compares dynamic inputs without coercing them under %s primordials",
		(mode) => {
			for (const expression of ["part===observer", "observer!==part"]) {
				const image = compile(
					`const part=value.slice(start,end);if(escape)return part;return ${expression};`,
					mode,
				);
				const region = spans(image)[0]!;
				expect(region.consumers.map((c) => c.kind)).toEqual(
					expect.arrayContaining(["equal", "materialize"]),
				);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			}
		},
	);
	it.each(["mutable", "locked"] as const)(
		"composes substr bounds and reverse search under %s primordials",
		(mode) => {
			for (const args of ["", "start", "start,end"]) {
				const image = compile(
					`const part=value.substr(${args}); const found=part.lastIndexOf("a",start); observer();
 if(escape)return part; return [found,part.lastIndexOf(),part.length,part.charAt(0),Number(part),part==="ab"];`,
					mode,
				);
				const region = spans(image)[0]!;
				expect(region.rangeOperation).toBe("substr");
				expect(region.consumers.map((c) => c.kind)).toEqual(
					expect.arrayContaining([
						"lastIndexOfCall",
						"length",
						"charAtCall",
						"number",
						"equal",
						"materialize",
					]),
				);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			}
		},
	);
	it("rejects a forged reverse consumer and substr producer", () => {
		const image = compile(
			'const part=value.substr(start,end);return part.lastIndexOf("a");',
		);
		const owner = image.native.functions.find((fn) =>
			fn.specializations.some((r) => r.kind === "string-span"),
		)!;
		for (const forge of ["producer", "consumer"]) {
			const specializations = owner.specializations.map((r) =>
				r.kind !== "string-span"
					? r
					: forge === "producer"
						? { ...r, rangeOperation: "substring" as const }
						: {
								...r,
								consumers: r.consumers.map((c) =>
									c.kind === "lastIndexOfCall"
										? { ...c, kind: "indexOfCall" as const }
										: c,
								),
							},
			);
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.map((fn) =>
							fn !== owner
								? fn
								: {
										...fn,
										specializations,
										regionActions: vmRegionActions(specializations),
									},
						),
					},
				}),
			).toThrow(/string-span/i);
		}
	});
	it.each(["mutable", "locked"] as const)(
		"ignores dead inline observations while retaining live observers and rejecting mixed-result merges under %s primordials",
		(mode) => {
			for (const escape of ["false", "escape"]) {
				for (const observation of ["part", "globalThis.observe(part)"]) {
					const source = `function project(source, escape) {
 const part=source.slice(1,-1);
 const a=part.indexOf('a'), b=part.includes('a'), c=part.startsWith('a'), d=part.endsWith('a');
 if(escape)return ${observation}; return [a,b,c,d,part.length];
} globalThis.inspect=function inspect(value,escape){return project(value,${escape});};`;
					const image = compileSemanticProgramToProgramImage(
						analyzeSourceAndRunSemanticAnalysis(
							source,
							"/span-inline-escape.mjs",
							parseModule(source),
						),
						{
							facts: compilerProgramFactsFromConfig(
								resolveBuildConfig({ engine: { primordials: mode } }),
							),
						},
					);
					const caller = image.native.functions.find(
						(fn) =>
							String.fromCharCode(
								...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
							) === "inspect",
					)!;
					const regions = caller.specializations.filter(
						(region) => region.kind === "string-span",
					);
					expect(regions.length).toBe(
						escape === "false" || observation !== "part" ? 1 : 0,
					);
					if (escape === "false")
						expect(regions[0]!.consumers.map((consumer) => consumer.kind)).toEqual(
							expect.arrayContaining([
								"indexOfCall",
								"includesCall",
								"startsWithCall",
								"endsWithCall",
								"length",
							]),
						);
					if (escape !== "false" && observation !== "part")
						expect(regions[0]!.consumers.some((c) => c.kind === "materialize")).toBe(
							true,
						);
					expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
						image,
					);
				}
			}
		},
	);
	it.each(["mutable", "locked"] as const)(
		"composes code points with both range producers under %s primordials",
		(mode) => {
			for (const operation of ["slice", "substring"]) {
				const image = compile(
					`const part=value.${operation}(start,end); observer();
 if(escape)return part; return [part.codePointAt(0),part.codePointAt(),part.charCodeAt(1),part.length,Number(part)];`,
					mode,
				);
				const [region] = spans(image);
				expect(region).toBeDefined();
				expect(region!.consumers.map((consumer) => consumer.kind)).toEqual(
					expect.arrayContaining([
						"codePointAtCall",
						"charCodeAtCall",
						"length",
						"number",
						"materialize",
					]),
				);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			}
		},
	);

	it.each(["mutable", "locked"] as const)(
		"shares substring bounds with the span consumers under %s primordials",
		(mode) => {
			const image = compile(branching.replace(".slice(", ".substring("), mode);
			expect(spans(image)).toHaveLength(1);
			expect(spans(image)[0]!.rangeOperation).toBe("substring");
			expect(spans(image)[0]!.consumers.map((consumer) => consumer.kind)).toEqual(
				expect.arrayContaining(["length", "equal", "number", "materialize"]),
			);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);
	it.each(["", "start", "start, end"])(
		"selects substring character consumers with arguments (%s)",
		(args) => {
			const image = compile(`const part=value.substring(${args}); observer();
 return part.charCodeAt(escape)+part.length;`);
			expect(spans(image)).toHaveLength(1);
			expect(spans(image)[0]!.rangeOperation).toBe("substring");
			expect(spans(image)[0]!.consumers.map((consumer) => consumer.kind)).toContain(
				"charCodeAtCall",
			);
		},
	);
	it.each(["slice", "substring"] as const)(
		"rejects a forged range operation for a %s producer",
		(operation) => {
			const image = compile(
				`const part=value.${operation}(start,end);return part.length;`,
			);
			const owner = image.native.functions[1]!;
			expect(spans(image)).toHaveLength(1);
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...owner,
							specializations: owner.specializations.map((region) =>
								region.kind === "string-span"
									? {
											...region,
											rangeOperation: operation === "slice" ? "substring" : "slice",
										}
									: region,
							),
						}),
					},
				}),
			).toThrow(/string-span/i);
		},
	);

	it.each(["mutable", "locked"] as const)(
		"retains undefined in code-point result storage under %s primordials",
		(mode) => {
			const image = compile(
				"const part=value.substring(start,end); const point=part.codePointAt(escape); return [point===undefined,point,part.length];",
				mode,
			);
			const region = spans(image)[0]!;
			const native = image.native.functions.find((fn) =>
				fn.specializations.includes(region),
			)!;
			const call =
				native.body.instructions[
					region.consumers.find((c) => c.kind === "codePointAtCall")!.ip
				]!;
			if (call.opcode !== "CALL" && call.opcode !== "CALL_KNOWN")
				throw new Error("Missing code-point call");
			expect(native.registerRepresentations[call.dst]).toBe("boxed");
		},
	);
	it.each(["mutable", "locked"] as const)(
		"keeps character-code consumers inside the span under %s primordials",
		(mode) => {
			const image = compile(
				"const part=value.slice(start,end); observer(); return part.charCodeAt(escape)+part.length;",
				mode,
			);
			expect(spans(image)).toHaveLength(1);
			expect(spans(image)[0]!.consumers.map((value) => value.kind)).toContain(
				"charCodeAtCall",
			);
			expect(spans(image)[0]!.consumers.map((value) => value.kind)).not.toContain(
				"materialize",
			);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);
	it.each(["mutable", "locked"] as const)(
		"retains projections and branch materialization with %s methods",
		(primordials) => {
			const image = compile(branching, primordials);
			expect(spans(image)).toHaveLength(1);
			expect(
				spans(image)[0]!
					.consumers.map((consumer) => consumer.kind)
					.sort(),
			).toEqual(["equal", "length", "materialize", "materialize", "number"]);
			expect(
				spans(deserializeCompilerArtifact(serializeCompilerArtifact(image))),
			).toEqual(spans(image));
		},
	);
	it("retains the span across an effect and rechecks the numeric consumer identity", () => {
		const image = compile(
			`const part = value.slice(start, end); observer(); return part.length + Number(part);`,
		);
		expect(spans(image)).toHaveLength(1);
		expect(
			spans(image)[0]!
				.consumers.map((consumer) => consumer.kind)
				.sort(),
		).toEqual(["length", "number"]);
	});
	it("rejects mixed span and ordinary values at a join", () => {
		expect(
			spans(
				compile(
					`let part = value.slice(start, end); if (escape) part = "ordinary"; return part.length;`,
				),
			),
		).toHaveLength(0);
	});
	it("retains index coercion when the substring is its own character position", () => {
		const image = compile(
			"const part=value.slice(start,end); return part.charCodeAt(part)+part.length;",
		);
		expect(spans(image)).toHaveLength(0);
	});
	it("rejects a forged artifact that omits an escaping observer", () => {
		const image = compile(branching);
		const index = image.native.functions.findIndex((fn) =>
			fn.specializations.some((region) => region.kind === "string-span"),
		);
		const owner = image.native.functions[index]!;
		const specializations = owner.specializations.map((region) => {
			if (region.kind !== "string-span") return region;
			const omitted = region.consumers.find(
				(consumer) => consumer.kind === "materialize",
			)!;
			return {
				...region,
				consumers: region.consumers.filter((consumer) => consumer !== omitted),
				claimedIps: region.claimedIps.filter((ip) => ip !== omitted.ip),
				cost: { ...region.cost, metadataOperations: region.cost.metadataOperations - 1 },
			};
		});
		const forged = {
			...image,
			native: {
				...image.native,
				functions: image.native.functions.with(index, {
					...owner,
					specializations,
					regionActions: vmRegionActions(specializations),
				}),
			},
		};
		expect(() => serializeCompilerArtifact(forged)).toThrow(/string-span/);
	});
	it.each([
		["charCodeAtProperty", "charCodeAtCall"],
		["charCodeAtCall", "charCodeAtProperty"],
		["length", "charCodeAtProperty"],
		["number", "charCodeAtCall"],
		["charCodeAtProperty", "codePointAtProperty"],
		["charCodeAtCall", "codePointAtCall"],
	] as const)("rejects a %s consumer forged as %s", (original, kind) => {
		const image = compile(
			"const part=value.slice(start,end); return part.charCodeAt(escape)+part.length+Number(part);",
		);
		const index = image.native.functions.findIndex((fn) =>
			fn.specializations.some((region) => region.kind === "string-span"),
		);
		const owner = image.native.functions[index]!;
		const region = spans(image)[0]!;
		expect(region.consumers.some((consumer) => consumer.kind === original)).toBe(true);
		const specializations = owner.specializations.map((candidate) =>
			candidate !== region
				? candidate
				: {
						...region,
						consumers: region.consumers.map((consumer) =>
							consumer.kind === original ? { ...consumer, kind } : consumer,
						),
					},
		);
		expect(() =>
			serializeCompilerArtifact({
				...image,
				native: {
					...image.native,
					functions: image.native.functions.with(index, {
						...owner,
						specializations,
						regionActions: vmRegionActions(specializations),
					}),
				},
			}),
		).toThrow(/string-span/);
	});
});

describe("string-valued span character consumers", () => {
	it.each(["mutable", "locked"] as const)(
		"retains charAt and at results under %s primordials",
		(mode) => {
			for (const method of ["charAt", "at"] as const)
				for (const operation of ["slice", "substring"] as const) {
					const image = compile(
						`const kept=observer(); const part=value.${operation}(start,end); const character=part.${method}(escape); observer(); return [kept,character,character===undefined,part.length];`,
						mode,
					);
					const native = image.native.functions[1]!;
					const region = spans(image)[0]!;
					expect(region).toBeDefined();
					const consumer = region.consumers.find(
						(value) => value.kind === `${method}Call`,
					)!;
					expect(consumer).toBeDefined();
					const call = native.body.instructions[consumer.ip]!;
					expect(call.opcode).toMatch(/^CALL/);
					if (call.opcode !== "CALL" && call.opcode !== "CALL_KNOWN")
						throw new Error("character call missing");
					const retained = native.body.instructions.find((op) => op.opcode === "CALL")!;
					if (retained.opcode !== "CALL") throw new Error("retained call missing");
					const point = native.gc.safepoints.find(
						(point) => point.instructionIp === consumer.ip,
					)!;
					expect(point.incomingRootRegisters).toContain(retained.dst);
					expect(point.outgoingRootRegisters).toContain(call.dst);
					expect(native.storage!.rootRegisters).toContain(call.dst);
					if (method === "at")
						expect(native.registerRepresentations[call.dst]).toBe("boxed");
					expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
						image,
					);
				}
		},
	);
	it.each(["charAt", "at"] as const)(
		"preserves the rooted result of known %s calls",
		(method) => {
			const image = compile(
				`const kept=observer();const part="x😀z".substring(start,end);const character=part.${method}(escape);observer();return [kept,character,character===undefined,part.length];`,
				"locked",
			);
			const native = image.native.functions[1]!;
			const region = spans(image)[0]!;
			const consumer = region.consumers.find(
				(consumer) => consumer.kind === `${method}Call`,
			)!;
			const call = native.body.instructions[consumer.ip]!;
			expect(call.opcode).toBe("CALL_KNOWN");
			if (call.opcode !== "CALL_KNOWN") throw new Error("known character call missing");
			expect(native.registerRepresentations[call.dst]).toBe(
				method === "charAt" ? "string" : "boxed",
			);
			expect(
				native.gc.safepoints.find((point) => point.instructionIp === consumer.ip)!
					.outgoingRootRegisters,
			).toContain(call.dst);
			expect(native.storage!.privateCallResultIps).not.toContain(consumer.ip);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);
	it.each(["charAt", "at"] as const)(
		"rejects a forged %s character operation",
		(method) => {
			const image = compile(
				`const part=value.slice(start,end);return [part.${method}(escape),part.length];`,
			);
			const native = image.native.functions[1]!;
			const region = spans(image)[0]!;
			const forged = {
				...region,
				consumers: region.consumers.map((consumer) =>
					consumer.kind === `${method}Call`
						? { ...consumer, kind: "codePointAtCall" as const }
						: consumer,
				),
			};
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							specializations: native.specializations.map((entry) =>
								entry === region ? forged : entry,
							),
						}),
					},
				}),
			).toThrow(/string-span|stale/);
		},
	);
});

describe("bounded string span searches", () => {
	it.each(["mutable", "locked"] as const)(
		"shares search consumers across range producers under %s primordials",
		(mode) => {
			for (const operation of ["slice", "substring"])
				for (const method of ["indexOf", "includes", "startsWith", "endsWith"]) {
					const image = compile(
						`const part=value.${operation}(start,end);observer();if(escape)return part;return part.${method}("😀",start);`,
						mode,
					);
					const region = spans(image)[0]!;
					expect(region).toBeDefined();
					expect(region.consumers.map((c) => c.kind)).toContain(`${method}Call`);
					expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
						image,
					);
				}
		},
	);
	it("retains argument evaluation and declines virtual aliases used as search operands", () => {
		for (const args of ["observer(),start", '"a",observer()', "", '"a",undefined']) {
			const image = compile(
				`const part=value.slice(start,end);return part.includes(${args});`,
			);
			expect(spans(image)[0]!.consumers.some((c) => c.kind === "includesCall")).toBe(
				true,
			);
		}
		for (const args of ["part,0", '"a",part', '"a",0,observer()']) {
			const image = compile(
				`const part=value.slice(start,end);return part.includes(${args})+part.length;`,
			);
			expect(
				spans(image)
					.flatMap((region) => region.consumers)
					.some((c) => c.kind === "includesCall"),
			).toBe(false);
		}
	});
	it("rejects a forged search method contract", () => {
		const image = compile(
			'const part=value.slice(start,end);return part.startsWith("a",0);',
		);
		const fn = image.native.functions[1]!;
		const region = spans(image)[0]!;
		expect(region.consumers.some((c) => c.kind === "startsWithCall")).toBe(true);
		const forged = {
			...region,
			consumers: region.consumers.map((c) =>
				c.kind === "startsWithCall" ? { ...c, kind: "endsWithCall" as const } : c,
			),
		};
		expect(() =>
			serializeCompilerArtifact({
				...image,
				native: {
					...image.native,
					functions: image.native.functions.with(1, {
						...fn,
						specializations: fn.specializations.map((r) => (r === region ? forged : r)),
					}),
				},
			}),
		).toThrow();
	});
});

describe("trim range producers", () => {
	it.each(["mutable", "locked"] as const)(
		"shares trim bounds and consumers under %s primordials",
		(mode) => {
			for (const method of ["trim", "trimStart", "trimEnd", "trimLeft", "trimRight"])
				for (const args of [
					"",
					"start",
					"start, end",
					"start, end, observer(), observer()",
				]) {
					const image = compile(
						`const part=value.${method}(${args});observer();if(escape)return part;return [part.length,part==='12',Number(part),part.charAt(0),part.at(-1),part.codePointAt(0),part.startsWith('1')];`,
						mode,
					);
					expect(spans(image)).toHaveLength(1);
					expect(spans(image)[0]!.rangeOperation).toBe(method);
					expect(spans(image)[0]!.consumers.map((consumer) => consumer.kind)).toEqual(
						expect.arrayContaining([
							"length",
							"equal",
							"number",
							"charAtCall",
							"atCall",
							"codePointAtCall",
							"startsWithCall",
							"materialize",
						]),
					);
					expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
						image,
					);
				}
		},
	);
	it.each(["slice", "substring", "substr"])(
		"retains the bounded argument contract for %s",
		(method) => {
			const image = compile(
				`const part=value.${method}(start,end,observer());return part.length;`,
			);
			expect(spans(image)).toHaveLength(0);
		},
	);

	it.each(["trimStart", "trimLeft"])("rejects a forged %s direction", (method) => {
		const image = compile(`const part=value.${method}();return part.length;`);
		const fn = image.native.functions.find((fn) =>
			fn.specializations.some((region) => region.kind === "string-span"),
		)!;
		const region = fn.specializations.find((region) => region.kind === "string-span")!;
		expect(() =>
			serializeCompilerArtifact({
				...image,
				native: {
					...image.native,
					functions: image.native.functions.map((candidate) =>
						candidate === fn
							? {
									...fn,
									specializations: fn.specializations.map((candidate) =>
										candidate === region
											? { ...region, rangeOperation: "trimEnd" as const }
											: candidate,
									),
								}
							: candidate,
					),
				},
			}),
		).toThrow(/string-span/);
	});
});

describe("inlined string observers", () => {
	it.each(["slice(1,-1)", "trim()"])(
		"materializes before the original ToString for %s",
		(operation) => {
			const image = compile(
				`const part=value.${operation};const description=\`value:\${part}\`;return [part.length,description];`,
			);
			const region = spans(image)[0]!;
			expect(region).toBeDefined();
			const fn = image.native.functions.find((fn) =>
				fn.specializations.includes(region),
			)!;
			expect(
				region.consumers.some((consumer) => {
					const instruction = fn.body.instructions[consumer.ip];
					return (
						consumer.kind === "materialize" &&
						instruction?.opcode === "UNARY" &&
						instruction.operator === "tostring"
					);
				}),
			).toBe(true);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);
});
