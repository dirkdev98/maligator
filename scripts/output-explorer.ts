import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreCompilation } from "../src/compiler/core/core-compilation.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { executeCoreOptimizations } from "../src/compiler/core/core-ir-opt.ts";
import { formatCoreFunction } from "../src/compiler/core/core-ir.ts";
import type { CoreProgram } from "../src/compiler/core/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { OPTIMIZATION_ABLATIONS } from "../src/compiler/shared/compiler-diagnostics.ts";
import {
	conservativeCompilerProgramFacts,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import type {
	ExecutionFunction,
	ExecutionProgram,
} from "../src/compiler/target/execution-ir.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../src/compiler/target/lower-native-program-image.ts";
import {
	serializeRuntimeImage,
	WIRE_MAGIC,
	WIRE_VERSION,
} from "../src/compiler/target/program-image-codec.ts";
import type {
	NativeFunctionPlan,
	ProgramImage,
} from "../src/compiler/target/program-image.ts";
import type {
	BytecodeFunction,
	RuntimeImage,
} from "../src/compiler/target/runtime-image.ts";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUTPUT_ROOT = path.join(ROOT, ".cache", "output-explorer");
const TEMPLATE_PATH = path.join(ROOT, "scripts", "output-explorer-page.html");
const PACKAGE_PATH = path.join(ROOT, "package.json");
const MASCOT_PATH = path.join(ROOT, "website", "mascot.webp");

interface Trail {
	readonly title: string;
	readonly explanation: string;
	readonly queries: Partial<Record<ViewId, string>>;
}

interface Sample {
	readonly id: string;
	readonly group: string;
	readonly title: string;
	readonly summary: string;
	readonly source: string;
	readonly trails: ReadonlyArray<Trail>;
}

type StageId = "preCore" | "optimizedCore" | "target" | "malw" | "c";
type ViewId = "source" | StageId;
type ModeId = "ablated" | "full";

const SAMPLES: ReadonlyArray<Sample> = [
	{
		id: "constants",
		group: "Data",
		title: "Constants & strings",
		summary:
			"Integer and floating immediates, UTF-16 strings, BigInts, booleans, null, and undefined.",
		source: `const integer = 42;
const floating = 3.5;
const text = "café 🐊";
const huge = 0x123456789abcdef0123456789n;
globalThis.constants = [integer, floating, text, huge, true, null, undefined];`,
		trails: [
			{
				title: "String pool",
				explanation:
					"Strings are interned as UTF-16 code-unit arrays, then referenced by pool index from VM instructions and C tables.",
				queries: {
					source: '"café 🐊"',
					preCore: "createString",
					optimizedCore: "createString",
					target: "createString",
					malw: "CREATE_STRING",
					c: "_code_units",
				},
			},
			{
				title: "BigInt pool",
				explanation:
					"BigInt literals use a separate 128-bit constant pool: low 64 bits followed by high 64 bits in MALW.",
				queries: {
					source: "0x123456789abcdef0123456789n",
					preCore: "createBigint",
					optimizedCore: "createBigint",
					target: "createBigint",
					malw: "CREATE_BIGINT",
					c: "mal_bigints",
				},
			},
		],
	},
	{
		id: "constant-folding",
		group: "Optimization",
		title: "Folding & dead code",
		summary:
			"A deliberately reducible expression and unreachable branch expose what disappears before either backend.",
		source: `function answer(flag) {
	const folded = (6 * 7) + (8 - 8);
	if (flag && false) return 999;
	return folded + 1;
}
globalThis.answer = answer(true);`,
		trails: [
			{
				title: "Arithmetic folding",
				explanation:
					"Compare the raw binary operations with the optimized constant and its final VM/C representation.",
				queries: {
					source: "(6 * 7)",
					preCore: "binary",
					optimizedCore: "createNumber",
					malw: "CREATE_NUMBER",
					c: "4.3e+1",
				},
			},
		],
	},
	{
		id: "control-flow",
		group: "Control",
		title: "Branches & loops",
		summary:
			"SSA block edges become allocated jumps, bytecode instruction pointers, and native labels.",
		source: `function sum(limit) {
	let total = 0;
	for (let index = 0; index < limit; index++) {
		total += index % 2 === 0 ? index : -index;
	}
	return total;
}
globalThis.total = sum(8);`,
		trails: [
			{
				title: "Control-flow edges",
				explanation:
					"Core names SSA blocks and edge arguments; the runtime terminal resolves them into instruction-pointer jumps.",
				queries: {
					source: "for (let index",
					preCore: "branch",
					optimizedCore: "branch",
					target: "jumpIf",
					malw: "JUMP_IF",
					c: "goto L",
				},
			},
		],
	},
	{
		id: "closures",
		group: "Functions",
		title: "Closures & captures",
		summary:
			"Nested function identity, captured cells, environment creation, and calls through a returned closure.",
		source: `function makeCounter(start) {
	let value = start;
	return function increment(step) {
		value += step;
		return value;
	};
}
const counter = makeCounter(10);
globalThis.count = counter(2) + counter(3);`,
		trails: [
			{
				title: "Captured cell",
				explanation:
					"The source binding becomes an environment slot; loads and stores survive only where the closure cannot be scalarized.",
				queries: {
					source: "value += step",
					preCore: "Captured",
					optimizedCore: "Captured",
					target: "Captured",
					malw: "CAPTURED",
					c: "captured",
				},
			},
		],
	},
	{
		id: "objects",
		group: "Data",
		title: "Objects & shapes",
		summary:
			"A contained object literal shows slot forwarding, scalar replacement, and the generic shaped-object fallback.",
		source: `function update(value) {
	const point = { x: value, y: value + 1 };
	point.x = point.x + point.y;
	return point.x;
}
globalThis.point = update(4);`,
		trails: [
			{
				title: "Scalar replacement",
				explanation:
					"The raw Core graph creates a shaped object. Full optimization forwards its exact own slots and jointly erases the contained identity and final store.",
				queries: {
					source: "point.x",
					preCore: "createObjectShaped",
					optimizedCore: "binary",
					target: '"operator": "+"',
					malw: "BINARY",
					c: "MAL_BIN_ADD",
				},
			},
		],
	},
	{
		id: "arrays",
		group: "Data",
		title: "Arrays & iteration",
		summary:
			"Array construction, indexed stores, length access, and iterator protocol lowering.",
		source: `function collect(values) {
	const doubled = [];
	for (const value of values) doubled.push(value * 2);
	return doubled.length;
}
globalThis.length = collect([1, 2, 3]);`,
		trails: [
			{
				title: "Iteration protocol",
				explanation:
					"A for-of begins as iterator operations; optimized output may replace parts only when its proof and fallback obligations are satisfied.",
				queries: {
					source: "for (const value",
					preCore: "Iterator",
					optimizedCore: "Iterator",
					target: "iterator",
					malw: "ITERATOR",
					c: "iterator",
				},
			},
		],
	},
	{
		id: "builtins",
		group: "Calls",
		title: "Calls & builtins",
		summary:
			"Ordinary calls beside recognized Math and String operations reveal generic, guarded, and direct lowering choices.",
		source: `function normalize(text, value) {
	const trimmed = text.trim();
	return trimmed + ":" + Math.floor(Math.abs(value));
}
globalThis.label = normalize("  score  ", -4.8);`,
		trails: [
			{
				title: "Builtin recognition",
				explanation:
					"Core owns the semantic proof; target metadata records whether the final output can use a direct or guarded builtin operation.",
				queries: {
					source: "Math.floor",
					preCore: "call",
					optimizedCore: "call",
					target: "guardedBuiltinCall",
					malw: "guardedMathCall",
					c: "builtin_math",
				},
			},
		],
	},
	{
		id: "exceptions",
		group: "Control",
		title: "Exceptions & finally",
		summary:
			"Abrupt completion crosses a catch and finally region, producing handlers and explicit completion flow.",
		source: `function guarded(value) {
	try {
		if (value < 0) throw new RangeError("negative");
		return value * 2;
	} catch (error) {
		return error.name;
	} finally {
		globalThis.cleaned = true;
	}
}
globalThis.result = guarded(-1);`,
		trails: [
			{
				title: "Handler table",
				explanation:
					"Core exception edges become TRY/CATCH instructions plus a compact runtime handler range table.",
				queries: {
					source: "try",
					preCore: "handler",
					optimizedCore: "handler",
					target: "try",
					malw: "handlers",
					c: "handler",
				},
			},
		],
	},
	{
		id: "classes",
		group: "Functions",
		title: "Classes & construction",
		summary:
			"Constructor metadata, private state, method functions, and new-target construction.",
		source: `class Box {
	#value;
	constructor(value) { this.#value = value; }
	read() { return this.#value; }
}
globalThis.boxed = new Box(7).read();`,
		trails: [
			{
				title: "Construction contract",
				explanation:
					"Class and constructor flags live on function records; construction and private access remain explicit operations.",
				queries: {
					source: "new Box",
					preCore: "construct",
					optimizedCore: "construct",
					target: "construct",
					malw: "CONSTRUCT",
					c: "mal_vm_construct_direct",
				},
			},
		],
	},
	{
		id: "async",
		group: "Suspension",
		title: "Async & await",
		summary:
			"An async function exposes coroutine function metadata, suspension points, and resumable native lowering.",
		source: `async function addLater(value) {
	const next = await Promise.resolve(value + 1);
	return next * 2;
}
globalThis.pending = addLater(20);`,
		trails: [
			{
				title: "Await suspension",
				explanation:
					"Await is preserved as a resumable operation; the function kind selects coroutine state handling in both terminals.",
				queries: {
					source: "await",
					preCore: "await",
					optimizedCore: "await",
					target: "await",
					malw: "AWAIT",
					c: "mal_vm_op_await_compiled",
				},
			},
		],
	},
	{
		id: "generators",
		group: "Suspension",
		title: "Generators & yield",
		summary:
			"Generator initialization, yields, resume state, and iterator-facing function metadata.",
		source: `function* sequence(limit) {
	for (let index = 0; index < limit; index++) yield index * index;
	return limit;
}
globalThis.iterator = sequence(3);`,
		trails: [
			{
				title: "Yield suspension",
				explanation:
					"Yield becomes an explicit bytecode suspension point and a resumable C state-machine boundary.",
				queries: {
					source: "yield",
					preCore: "yield",
					optimizedCore: "yield",
					target: "yield",
					malw: "YIELD",
					c: "mal_vm_op_yield_compiled",
				},
			},
		],
	},
];

function decodeString(units: ReadonlyArray<number>): string {
	return String.fromCharCode(...units);
}

function stableValue(value: unknown): unknown {
	if (typeof value === "bigint") return `${value}n`;
	if (value instanceof Map) {
		return [...value.entries()]
			.map(([key, entry]) => [stableValue(key), stableValue(entry)])
			.sort(([left], [right]) => String(left).localeCompare(String(right)));
	}
	if (value instanceof Set) {
		return [...value]
			.map(stableValue)
			.sort((left, right) => String(left).localeCompare(String(right)));
	}
	if (Array.isArray(value)) return value.map(stableValue);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, stableValue(entry)]),
		);
	}
	return value;
}

function stableJson(value: unknown): string {
	return JSON.stringify(stableValue(value), null, 2);
}

function formatConstantPools(program: CoreProgram): string {
	const strings = program.stringConstants.map(
		(units, index) =>
			`  [${index}] ${JSON.stringify(decodeString(units))} · UTF-16 ${units
				.map((unit) => `0x${unit.toString(16).padStart(4, "0")}`)
				.join(" ")}`,
	);
	const bigints = program.bigintConstants.map((value, index) => `  [${index}] ${value}n`);
	return [
		`CoreProgram · ${program.functions.length} functions · ${program.globalCount} globals`,
		"",
		`stringConstants (${strings.length})`,
		...(strings.length === 0 ? ["  (empty)"] : strings),
		"",
		`bigintConstants (${bigints.length})`,
		...(bigints.length === 0 ? ["  (empty)"] : bigints),
		"",
		`literalTemplateData (${program.literalTemplateData.length} words)`,
		`  ${program.literalTemplateData.join(" ") || "(empty)"}`,
	].join("\n");
}

function formatCore(program: CoreProgram): string {
	return [
		formatConstantPools(program),
		"",
		...program.functions.map((fn) => formatCoreFunction(fn)),
	].join("\n");
}

function functionName(image: RuntimeImage, fn: BytecodeFunction): string {
	return decodeString(image.stringConstants[fn.nameStringIndex] ?? []) || "<anonymous>";
}

function sourcePosition(
	image: RuntimeImage,
	fn: BytecodeFunction,
	instructionIndex: number,
): string {
	const positionId = fn.positions[instructionIndex];
	if (positionId === undefined || positionId < 0) return "-";
	const position = image.sourcePositions[positionId];
	if (position === undefined) return `position ${positionId}`;
	const file = image.files[fn.fileIndex] ?? image.entrypointPath;
	return `${file}:${position.line}:${position.column + 1}`;
}

function formatRuntimeImage(image: RuntimeImage): string {
	const lines = [
		`MALW decoded RuntimeImage · ${image.functions.length} functions · ${image.globalCount} globals`,
		`entrypoint ${image.entrypointPath}`,
		"",
		"stringConstants · length-prefixed UTF-16 code units",
	];
	for (const [index, units] of image.stringConstants.entries()) {
		lines.push(
			`  [${index}] ${JSON.stringify(decodeString(units))}`,
			`      units ${units.map((unit) => unit.toString(16).padStart(4, "0")).join(" ") || "(empty)"}`,
		);
	}
	lines.push("", "bigintConstants · signed 128-bit values (low u64, high u64)");
	const mask = (1n << 64n) - 1n;
	for (const [index, value] of image.bigintConstants.entries()) {
		lines.push(
			`  [${index}] ${value}n · lo 0x${(value & mask).toString(16).padStart(16, "0")} · hi 0x${((value >> 64n) & mask).toString(16).padStart(16, "0")}`,
		);
	}
	if (image.bigintConstants.length === 0) lines.push("  (empty)");
	lines.push(
		"",
		`literalTemplateData (${image.literalTemplateData.length} u32 words)`,
		`  ${image.literalTemplateData.join(" ") || "(empty)"}`,
		"",
	);
	for (const [functionIndex, fn] of image.functions.entries()) {
		lines.push(
			`function ${functionIndex} ${JSON.stringify(functionName(image, fn))}`,
			`  kind ${fn.isAsync && fn.isGenerator ? "async-generator" : fn.isAsync ? "async" : fn.isGenerator ? "generator" : "normal"} · params ${fn.parameterCount} · registers ${fn.registerCount} · captures ${fn.capturedCount}`,
			`  strict ${fn.strict} · arguments ${fn.needsArguments} · handlers ${fn.handlers.length} · safepoints ${fn.gcSafepoints?.length ?? 0}`,
		);
		for (const [instructionIndex, instruction] of fn.instructions.entries()) {
			lines.push(
				`  ${String(instructionIndex).padStart(4, "0")}  ${instruction.opcode.padEnd(38)} ${stableJson(
					instruction,
				)
					.replace(/^\{\n|\n\}$/g, "")
					.replace(/\n/g, " ")
					.replace(/\s+/g, " ")
					.trim()}  @ ${sourcePosition(image, fn, instructionIndex)}`,
			);
		}
		if (fn.gcSafepoints !== undefined && fn.gcSafepoints.length > 0) {
			lines.push(
				"  gcSafepoints",
				...fn.gcSafepoints.map((entry) => `    ${stableJson(entry).replace(/\n/g, " ")}`),
			);
		}
		if (fn.handlers.length > 0) {
			lines.push(
				"  handlers",
				...fn.handlers.map((entry) => `    ${stableJson(entry).replace(/\n/g, " ")}`),
			);
		}
		lines.push("");
	}
	lines.push(
		"precompiledLiteralShapes",
		stableJson(image.precompiledLiteralShapes),
		"hostInstalls",
		stableJson(image.hostInstalls),
	);
	return lines.join("\n");
}

function formatExecutionFunction(fn: ExecutionFunction): string {
	const lines = [
		`execution function ${fn.functionIndex} · ${fn.sourcePath}`,
		`  params ${fn.parameterCount} · registers ${fn.registerCount} · captures ${fn.capturedCount}`,
		`  representations ${fn.registerRepresentations.map((representation, register) => `%${register}:${representation}`).join(" ")}`,
		`  specializations ${fn.specializations.length} · direct entries ${fn.directEntries.length}`,
	];
	for (const [blockIndex, block] of fn.blocks.entries()) {
		lines.push(`  block ${blockIndex}`);
		for (const instruction of block.instructions) {
			lines.push(
				`    ${stableJson(instruction).replace(/\n/g, " ").replace(/\s+/g, " ")}`,
			);
		}
	}
	lines.push("  parallel copies", stableJson(fn.parallelCopies));
	lines.push("  gc safepoints", stableJson(fn.gc.safepoints));
	return lines.join("\n");
}

function formatNativePlan(fn: NativeFunctionPlan): string {
	return [
		`native plan function ${fn.functionIndex} · ${fn.mode}`,
		`  representations ${fn.registerRepresentations.map((representation, register) => `%${register}:${representation}`).join(" ")}`,
		"  direct entries",
		stableJson(fn.directEntries),
		"  gc safepoints",
		stableJson(fn.gc.safepoints),
		"  instruction decisions (index-preserving; null means generic lowering)",
		...fn.instructions.map(
			(instruction, index) =>
				`    ${String(index).padStart(4, "0")} ${instruction === undefined ? "generic" : stableJson(instruction).replace(/\n/g, " ").replace(/\s+/g, " ")}`,
		),
		"  specializations",
		stableJson(fn.specializations),
	].join("\n");
}

function formatTarget(program: ExecutionProgram, image: ProgramImage): string {
	return [
		"ExecutionProgram · allocated backend-neutral terminal",
		"",
		...program.functions.map(formatExecutionFunction),
		"",
		"NativePlan · native-only decisions consumed by C emission",
		`semantic protectors\n${stableJson(image.native.semanticProtectors)}`,
		...image.native.functions.map(formatNativePlan),
	].join("\n\n");
}

function wireHex(bytes: Uint8Array): string {
	const lines: Array<string> = [];
	for (let offset = 0; offset < bytes.length; offset += 16) {
		const row = bytes.slice(offset, offset + 16);
		const hex = [...row].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
		const ascii = [...row]
			.map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "."))
			.join("");
		lines.push(
			`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  |${ascii.padEnd(16)}|`,
		);
	}
	return lines.join("\n");
}

function summarizeRuntime(image: RuntimeImage, wire: Uint8Array, c: string) {
	return {
		functions: image.functions.length,
		instructions: image.functions.reduce((sum, fn) => sum + fn.instructions.length, 0),
		strings: image.stringConstants.length,
		stringCodeUnits: image.stringConstants.reduce((sum, units) => sum + units.length, 0),
		bigints: image.bigintConstants.length,
		globals: image.globalCount,
		handlers: image.functions.reduce((sum, fn) => sum + fn.handlers.length, 0),
		safepoints: image.functions.reduce(
			(sum, fn) => sum + (fn.gcSafepoints?.length ?? 0),
			0,
		),
		wireBytes: wire.length,
		cCodeUnits: c.length,
		cLines: c.split("\n").length,
	};
}

function compileMode(sample: Sample, mode: ModeId) {
	const sourcePath = `output-explorer/${sample.id}.js`;
	const semantic = analyzeSourceAndRunSemanticAnalysis(sample.source, sourcePath);
	const facts = withProgramClosure(
		{
			...conservativeCompilerProgramFacts(),
			compilationMode: mode === "full" ? ("full" as const) : ("development" as const),
		},
		programClosureCertificate(
			{ kind: "whole-program", entry: sourcePath },
			[{ kind: "entry-module", module: sourcePath }],
			[],
		),
	);
	const core = lowerSemanticProgramToCore(semantic, {
		facts,
		collectOptimizationDiagnostics: true,
	});
	const result = executeCoreOptimizations(core.program, {
		context: core.context,
		...(mode === "ablated"
			? { ablations: new Set(OPTIMIZATION_ABLATIONS), maxRounds: 1 }
			: {}),
	});
	if (result.context === undefined) throw new Error("Core optimization lost context");
	const optimized: CoreCompilation = {
		program: result.program,
		context: result.context,
		...(result.targetAnalyses === undefined
			? {}
			: { targetAnalyses: result.targetAnalyses }),
	};
	const execution = lowerCoreCompilationToExecution(optimized, {
		reuseRegisters: mode === "full",
	});
	const image = lowerExecutionToProgramImage(execution, false);
	const wire = serializeRuntimeImage(image.runtime, { debugInfo: true });
	const c = emitProgramImage(image, { compiled: true, debugInfo: true });
	return {
		preCore: formatCore(core.program),
		optimizedCore: formatCore(optimized.program),
		target: formatTarget(execution, image),
		malw: formatRuntimeImage(image.runtime),
		hex: wireHex(wire),
		wire,
		c,
		trace: optimized.context.optimizationTrace ?? [],
		structure: {
			strings: image.runtime.stringConstants.map((units, index) => ({
				index,
				value: decodeString(units),
				units: [...units],
			})),
			bigints: image.runtime.bigintConstants.map((value, index) => ({
				index,
				value: `${value}n`,
			})),
			functions: image.runtime.functions.map((fn, index) => ({
				index,
				name: functionName(image.runtime, fn),
				kind:
					fn.isAsync && fn.isGenerator
						? "async-generator"
						: fn.isAsync
							? "async"
							: fn.isGenerator
								? "generator"
								: "normal",
				parameters: fn.parameterCount,
				registers: fn.registerCount,
				captures: fn.capturedCount,
				instructions: fn.instructions.length,
				handlers: fn.handlers.length,
				safepoints: fn.gcSafepoints?.length ?? 0,
			})),
		},
		stats: summarizeRuntime(image.runtime, wire, c),
	};
}

function stageOutput(result: ReturnType<typeof compileMode>, stage: StageId): string {
	switch (stage) {
		case "preCore":
			return result.preCore;
		case "optimizedCore":
			return result.optimizedCore;
		case "target":
			return result.target;
		case "malw":
			return result.malw;
		case "c":
			return result.c;
	}
}

function validateTrails(
	sample: Sample,
	ablated: ReturnType<typeof compileMode>,
	full: ReturnType<typeof compileMode>,
): void {
	for (const trail of sample.trails) {
		for (const [stage, query] of Object.entries(trail.queries) as Array<
			[ViewId, string]
		>) {
			const outputs =
				stage === "source"
					? [sample.source]
					: stage === "optimizedCore"
						? [ablated.optimizedCore, full.optimizedCore]
						: [stageOutput(full, stage)];
			const present = outputs.every((output) =>
				output.toLowerCase().includes(query.toLowerCase()),
			);
			if (!present) {
				throw new Error(
					`${sample.id}: trail '${trail.title}' cannot find '${query}' in ${stage}`,
				);
			}
		}
	}
}

function sha256(content: string | Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function gitOutput(args: ReadonlyArray<string>): string {
	try {
		return execFileSync("git", [...args], { cwd: ROOT, encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

function safeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, "utf8")) as {
	version: string;
};
const commit = gitOutput(["rev-parse", "--short=12", "HEAD"]);
const dirty = gitOutput(["status", "--porcelain"]) !== "";
const snapshotId = safeSegment(
	`${packageJson.version}-${commit}${dirty ? "-dirty" : ""}`,
);
const snapshotRoot = path.join(OUTPUT_ROOT, "artifacts", snapshotId);
rmSync(snapshotRoot, { recursive: true, force: true });
mkdirSync(snapshotRoot, { recursive: true });

const manifestFiles: Array<{ path: string; bytes: number; sha256: string }> = [];
function writeArtifact(relativePath: string, content: string | Uint8Array): string {
	const destination = path.join(snapshotRoot, relativePath);
	mkdirSync(path.dirname(destination), { recursive: true });
	writeFileSync(destination, content);
	const bytes = typeof content === "string" ? Buffer.byteLength(content) : content.length;
	manifestFiles.push({ path: relativePath, bytes, sha256: sha256(content) });
	return path.posix.join("artifacts", snapshotId, relativePath.split(path.sep).join("/"));
}

const samples = SAMPLES.map((sample) => {
	const full = compileMode(sample, "full");
	const ablated = compileMode(sample, "ablated");
	if (full.preCore !== ablated.preCore) {
		throw new Error(`${sample.id}: pre-optimization Core depends on output mode`);
	}
	validateTrails(sample, ablated, full);
	const base = sample.id;
	const sourcePath = writeArtifact(path.join(base, "source.js"), `${sample.source}\n`);
	const preCorePath = writeArtifact(path.join(base, "pre-core.txt"), `${full.preCore}\n`);
	const modeData = Object.fromEntries(
		(["ablated", "full"] as const).map((mode) => {
			const result = mode === "full" ? full : ablated;
			const prefix = path.join(base, mode);
			const artifacts = {
				optimizedCore: writeArtifact(
					path.join(prefix, "optimized-core.txt"),
					`${result.optimizedCore}\n`,
				),
				target: writeArtifact(path.join(prefix, "target.txt"), `${result.target}\n`),
				malwDecoded: writeArtifact(
					path.join(prefix, "malw-decoded.txt"),
					`${result.malw}\n`,
				),
				malwHex: writeArtifact(path.join(prefix, "malw.hex.txt"), `${result.hex}\n`),
				malw: writeArtifact(path.join(prefix, "program.malw"), result.wire),
				c: writeArtifact(path.join(prefix, "program.c"), `${result.c}\n`),
				trace: writeArtifact(
					path.join(prefix, "optimization-trace.json"),
					`${stableJson(result.trace)}\n`,
				),
			};
			return [
				mode,
				{
					label:
						mode === "full"
							? "Full production optimization"
							: "All public groups ablated · one round",
					optimizedCore: result.optimizedCore,
					target: result.target,
					malw: result.malw,
					hex: result.hex,
					c: result.c,
					wireBase64: Buffer.from(result.wire).toString("base64"),
					trace: stableValue(result.trace),
					structure: result.structure,
					stats: result.stats,
					artifacts,
				},
			];
		}),
	);
	return {
		...sample,
		preCore: full.preCore,
		artifacts: { source: sourcePath, preCore: preCorePath },
		modes: modeData,
	};
});

const manifest = {
	schema: 1,
	snapshot: {
		id: snapshotId,
		maligatorVersion: packageJson.version,
		commit,
		dirty,
		wire: {
			magic: `0x${WIRE_MAGIC.toString(16).padStart(8, "0")}`,
			ascii: "MALW",
			version: WIRE_VERSION,
		},
		optimizationModes: {
			ablated: {
				maxRounds: 1,
				ablations: [...OPTIMIZATION_ABLATIONS],
			},
			full: { maxRounds: "compiler default", ablations: [] },
		},
	},
	files: manifestFiles.sort((left, right) => left.path.localeCompare(right.path)),
};
writeFileSync(path.join(snapshotRoot, "manifest.json"), `${stableJson(manifest)}\n`);

const pageData = {
	manifest: { snapshot: manifest.snapshot },
	samples: samples.map((sample) => {
		const ablated = sample.modes.ablated;
		const full = sample.modes.full;
		if (ablated === undefined || full === undefined) {
			throw new Error(`${sample.id}: missing output mode`);
		}
		return {
			id: sample.id,
			group: sample.group,
			title: sample.title,
			summary: sample.summary,
			source: sample.source,
			trails: sample.trails,
			preCore: sample.preCore,
			modes: {
				ablated: { optimizedCore: ablated.optimizedCore },
				full: {
					optimizedCore: full.optimizedCore,
					target: full.target,
					malw: full.malw,
					c: full.c,
				},
			},
		};
	}),
};

const template = readFileSync(TEMPLATE_PATH, "utf8");
const dataMarker = "__MALIGATOR_OUTPUT_EXPLORER_DATA__";
const mascotMarker = "__MALIGATOR_NAV_MASCOT__";
for (const marker of [dataMarker, mascotMarker]) {
	if (!template.includes(marker)) throw new Error(`missing ${marker} in page template`);
}
const html = template
	.replace(dataMarker, JSON.stringify(pageData).replaceAll("</script", "<\\/script"))
	.replace(mascotMarker, readFileSync(MASCOT_PATH).toString("base64"));
mkdirSync(OUTPUT_ROOT, { recursive: true });
writeFileSync(path.join(OUTPUT_ROOT, "index.html"), html);

console.log(path.join(OUTPUT_ROOT, "index.html"));
console.log(path.join(snapshotRoot, "manifest.json"));
