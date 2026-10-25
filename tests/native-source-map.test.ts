import { describe, expect, it } from "vitest";
import {
	emitProgramImage,
	emitProgramImageWithSourceMap,
} from "../src/compiler/target/emit-program-image.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../src/compiler/target/lower-native-program-image.ts";
import { lowerCoreCompilationToNativeProgram } from "../src/compiler/target/lower-native.ts";
import { nativeInstructionSourceRanges } from "../src/compiler/target/native-source-map.ts";
import {
	compileExplorerCore,
	compileExplorerComparison,
	compileMode,
} from "../src/explorer/compiler.ts";
import { SAMPLES } from "../src/explorer/samples.ts";

function imageFor(source: string) {
	const core = compileExplorerCore(source).result.compilation;
	return lowerExecutionToProgramImage(
		lowerCoreCompilationToExecution(core, { reuseRegisters: true }),
		lowerCoreCompilationToNativeProgram(core),
	);
}

describe("emitted C source mapping", () => {
	it("preserves the ordinary emitted C across native entries, closures and suspension", () => {
		for (const sample of SAMPLES) {
			const core = compileExplorerCore(sample.source, sample.config ?? {});
			const mapped = compileExplorerComparison(core);
			expect(mapped.c, sample.id).toBe(compileMode(core, "full").c);
			for (const range of mapped.mapping.ranges) {
				expect(range.startLine).toBeGreaterThan(0);
				expect(range.endLine).toBeGreaterThanOrEqual(range.startLine);
				expect(range.endLine).toBeLessThanOrEqual(mapped.stats.cLines);
				for (const origin of range.origins)
					expect(origin.line).toBeLessThanOrEqual(sample.source.split("\n").length);
			}
		}
	});

	it("maps both the full and frameless property-read bodies to their return statement", () => {
		const source =
			"function read(value) {\n  return value.name;\n}\nglobalThis.read = read;";
		const result = compileExplorerComparison(compileExplorerCore(source));
		const ranges = result.mapping.ranges.filter((range) =>
			range.origins.some((origin) => origin.line === 2),
		);
		const lines = result.c.split("\n");
		const bodies = ranges.map((range) =>
			lines.slice(range.startLine - 1, range.endLine).join("\n"),
		);
		expect(
			bodies.filter((body) => body.includes("mal_vm_property_try_load_static")),
		).toHaveLength(2);
		for (const body of bodies) {
			expect(body).not.toContain("#pragma");
			expect(body).not.toContain("__full:");
		}
	});

	it("maps a frameless restart to the unsupported call without mapping the pruned tail", () => {
		const source = [
			"function select(flag, value, callback) {",
			"  if (flag) return value.id;",
			"  callback(value);",
			"  return value.id;",
			"}",
			"globalThis.select = select;",
		].join("\n");
		const result = compileExplorerComparison(compileExplorerCore(source));
		const lines = result.c.split("\n");
		const bodies = (line: number) =>
			result.mapping.ranges
				.filter((range) => range.origins.some((origin) => origin.line === line))
				.map((range) => lines.slice(range.startLine - 1, range.endLine).join("\n"));
		expect(bodies(3).some((body) => body.includes("goto __full;"))).toBe(true);
		expect(
			result.mapping.ranges.some(
				(range) =>
					lines
						.slice(range.startLine - 1, range.endLine)
						.join("\n")
						.includes("goto __full;") &&
					range.origins.some((origin) => origin.line === 4),
			),
		).toBe(false);
		expect(bodies(3).some((body) => body.includes("mal_vm_call_cached"))).toBe(true);
		expect(
			bodies(4).filter((body) => body.includes("mal_vm_property_try_load_static")),
		).toHaveLength(1);
	});

	it("maps a jumped-to error constructor as another region of its source line", () => {
		const sample = SAMPLES.find((item) => item.id === "exceptions")!;
		const result = compileExplorerComparison(compileExplorerCore(sample.source));
		const ranges = result.mapping.ranges.filter((range) =>
			range.origins.some((origin) => origin.line === 3),
		);
		expect(ranges.length).toBeGreaterThanOrEqual(2);
		const text = (range: (typeof ranges)[number]) =>
			result.c
				.split("\n")
				.slice(range.startLine - 1, range.endLine)
				.join("\n");
		expect(ranges.some((range) => text(range).includes("range_error_constructor"))).toBe(
			true,
		);
		expect(
			ranges.some(
				(range) => text(range).includes("if (") && text(range).includes("goto"),
			),
		).toBe(true);
	});

	it("attributes a loop increment to the update expression rather than the last body statement", () => {
		const sample = SAMPLES.find((item) => item.id === "control-flow")!;
		const result = compileExplorerComparison(compileExplorerCore(sample.source));
		const lines = result.c.split("\n");
		const increment = result.mapping.ranges.find((range) =>
			lines
				.slice(range.startLine - 1, range.endLine)
				.some((line) => /\+ 1\.0;/.test(line)),
		)!;
		expect(increment).toBeDefined();
		expect(increment.origins).toContainEqual({
			line: 3,
			column: sample.source.split("\n")[2]!.indexOf("index++"),
			inlined: false,
		});
		expect(increment.origins.some((origin) => origin.line === 4)).toBe(false);
	});

	it("retains the contributing source positions of a fused numeric loop", () => {
		const sample = SAMPLES.find((item) => item.id === "control-flow")!;
		const result = compileExplorerComparison(compileExplorerCore(sample.source));
		const lines = result.c.split("\n");
		const region = result.mapping.ranges.find((range) =>
			lines
				.slice(range.startLine - 1, range.endLine)
				.some((line) => line.includes("mal_safe_integer_add")),
		)!;
		expect(region.precision).toBe("region");
		expect(region.origins.some((origin) => origin.line === 4)).toBe(true);
		expect(region.origins).toContainEqual({
			line: 3,
			column: sample.source.split("\n")[2]!.indexOf("index++"),
			inlined: false,
		});
	});

	it("retains exact UTF-16 offsets through emitted prologues and typed leaf siblings", () => {
		const image = imageFor(
			"function square(x) {\nreturn x * x;\n}\nglobalThis.answer = square(12);",
		);
		const mapped = emitProgramImageWithSourceMap(image);
		expect(mapped.source).toBe(emitProgramImage(image));
		for (const range of mapped.ranges) {
			const fn = mapped.functions.find((candidate) => candidate.symbol === range.symbol)!;
			expect(range.start).toBeGreaterThanOrEqual(fn.start);
			expect(range.end).toBeLessThanOrEqual(fn.end);
			const text = mapped.source.slice(range.start, range.end);
			expect(text).not.toContain("#pragma STDC");
			expect(text).not.toContain("static __attribute__");
			expect(text.trim().length).toBeGreaterThan(0);
		}
	});

	it("reports coarse attribution explicitly when native outlining moves the body", () => {
		const image = imageFor(
			`globalThis.run = function run(x) {\n${Array.from({ length: 90 }, (_, i) => `x = x.value${i};`).join("\n")}\nreturn x; };`,
		);
		const options = {
			nativeFunctionSplit: { thresholdCodeUnits: 800, partCodeUnits: 500 },
		};
		const mapped = emitProgramImageWithSourceMap(image, options);
		expect(mapped.source).toBe(emitProgramImage(image, options));
		expect(mapped.ranges.some((range) => range.precision === "function")).toBe(true);
	});

	it("keeps skipped instructions and multiline emission units within their recorded source origins", () => {
		const ranges = nativeInstructionSourceRanges(
			{ positions: [4, 5, 6, -1] } as Parameters<typeof nativeInstructionSourceRanges>[0],
			["scaffolding", "first();\nsecond();", "last();"],
			[1, 2],
			[0, 2],
		);
		expect(
			ranges.map((range) => ({
				text: ["scaffolding", "first();\nsecond();", "last();"]
					.join("\n")
					.slice(range.start, range.end),
				positions: range.positions,
			})),
		).toEqual([
			{ text: "first();\nsecond();", positions: [4, 5] },
			{ text: "last();", positions: [6] },
		]);
	});
});
