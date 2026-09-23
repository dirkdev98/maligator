import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import { coreValueId } from "../src/compiler/core/core-ir.ts";
import {
	captureCoreModule,
	decodeCoreModule,
	encodeCoreModule,
	importCoreModule,
} from "../src/compiler/core/core-module-artifact.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_VALUE_KIND_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { runSemanticAnalysisForGraph } from "../src/compiler/frontend/analyze-module-graph.ts";
import { buildModuleGraph } from "../src/compiler/frontend/module-graph.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { collectSourceFunctionOrigins } from "../src/compiler/frontend/source-function-origins.ts";
import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NUMBER,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	loadOrCompileCoreModule,
	reconstructCanonicalCoreModule,
} from "../src/core-module-cache.ts";
import { pgoOptimizationInput } from "../src/pgo-artifact.ts";
import type { MergedPgoProfile } from "../src/pgo-artifact.ts";
import { SourceProfileIdentities } from "../src/source-profile-identity.ts";
import { appendLeaf, programAnalysisContext } from "./helpers/core-program-analysis.ts";

const source =
	"let n = 1; export function add(x) { n += x + (2 * 3); return n; } export function read() { return n; }";
const directories: Array<string> = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function options() {
	const directory = mkdtempSync(path.join(os.tmpdir(), "core-module-"));
	directories.push(directory);
	return {
		source,
		sourcePath: "/first/pilot.mjs",
		moduleKey: "package:pilot",
		cacheDirectory: directory,
	};
}
it("loads completed optimized Core without construction or optimizer work in another checkout", () => {
	const input = options();
	const cold = loadOrCompileCoreModule(input);
	if (cold.status !== "ready") throw new Error(cold.reason);
	expect(cold.cache).toBe("miss");
	expect(cold.work).toEqual({ constructedFunctions: 3, optimizedFunctions: 3 });
	const operations = (artifact: typeof cold.canonical) =>
		artifact.functions.flatMap((fn) => fn.blocks.flatMap((block) => block.operations));
	expect(operations(cold.canonical).filter((op) => op.opcode === "binary")).toHaveLength(
		3,
	);
	expect(operations(cold.optimized).filter((op) => op.opcode === "binary")).toHaveLength(
		2,
	);
	const warm = loadOrCompileCoreModule({
		...input,
		sourcePath: "/second/pilot.mjs",
		onWork() {
			throw new Error("Warm cache repeated compiler work");
		},
	});
	expect(warm).toMatchObject({
		status: "ready",
		cache: "hit",
		work: { constructedFunctions: 0, optimizedFunctions: 0 },
	});
	if (warm.status !== "ready") throw new Error(warm.reason);
	const destination = new CoreProgram(coreOpcodeRegistry, {
		globalCount: 7,
		stringConstants: [[120], [121]],
		sourcePositions: [{ line: 99, column: 3 }],
	});
	appendLeaf(destination);
	const imported = importCoreModule(destination, warm.optimized, "/second/pilot.mjs");
	expect(imported.initializer).toBe(1);
	expect(imported.exports.get("add")).toBe(8);
	expect(destination.globalCount).toBe(10);
	expect(destination.function(imported.functions[1]!).metadata.sourcePath).toBe(
		"/second/pilot.mjs",
	);
	const second = importCoreModule(destination, warm.optimized, "/third/pilot.mjs");
	expect(second.exports.get("add")).toBe(11);
	expect(destination.globalCount).toBe(13);
	verifyCoreProgram(destination, { stage: "pre-target" });
});

it("relocates batched private names to the cached class evaluator's captured slots", () => {
	const input = {
		...options(),
		source: `
			export function makeClass() {
				return class {
					#first = 1;
					#second = 2;
					read() { return this.#first + this.#second; }
					static owns(value) { return #first in value; }
				};
			}
		`,
	};
	const cold = loadOrCompileCoreModule(input);
	if (cold.status !== "ready") throw new Error(cold.reason);
	const warm = loadOrCompileCoreModule({
		...input,
		sourcePath: "/second/private.mjs",
		onWork() {
			throw new Error("Warm class import repeated Core work");
		},
	});
	if (warm.status !== "ready") throw new Error(warm.reason);
	expect(warm.cache).toBe("hit");
	const artifact = decodeCoreModule(encodeCoreModule(warm.optimized));
	const owner = artifact.functions.findIndex((fn) =>
		fn.blocks.some((block) =>
			block.operations.some((operation) => operation.opcode === "createPrivateNames"),
		),
	);
	expect(owner).toBeGreaterThanOrEqual(0);
	const destination = new CoreProgram(coreOpcodeRegistry);
	appendLeaf(destination);
	const imported = importCoreModule(destination, artifact, "/second/private.mjs");
	const classEvaluator = destination.function(imported.functions[owner]!);
	const privateNames = [...classEvaluator.blockIds()]
		.flatMap((block) => [...classEvaluator.bodyInstructionIds(block)])
		.find(
			(instruction) =>
				classEvaluator.instructionOpcodeName(instruction) === "createPrivateNames",
		)!;
	const attributes = classEvaluator.instructionAttributes(privateNames);
	expect(attributes.functionIndex).toBe(classEvaluator.id);
	expect(attributes.capturedIndices).toEqual(
		artifact.functions[owner]!.blocks.flatMap((block) => block.operations).find(
			(operation) => operation.opcode === "createPrivateNames",
		)!.attributes.capturedIndices,
	);
	verifyCoreProgram(destination, { stage: "pre-target" });
	const invalid = structuredClone(artifact);
	const operation = invalid.functions[owner]!.blocks.flatMap(
		(block) => block.operations,
	).find((candidate) => candidate.opcode === "createPrivateNames")!;
	operation.attributes = {
		...operation.attributes,
		capturedIndices: [invalid.functions[owner]!.metadata.capturedCount],
	};
	expect(() => decodeCoreModule(encodeCoreModule(invalid))).toThrow(
		"Invalid Core module index",
	);
	const wrongOwner = structuredClone(artifact);
	const wrongOperation = wrongOwner.functions[owner]!.blocks.flatMap(
		(block) => block.operations,
	).find((candidate) => candidate.opcode === "createPrivateNames")!;
	wrongOperation.attributes = {
		...wrongOperation.attributes,
		functionIndex: (owner + 1) % wrongOwner.functions.length,
	};
	expect(() => decodeCoreModule(encodeCoreModule(wrongOwner))).toThrow(
		"Private name owner mismatch",
	);
});
it("captures only optimized Core for selection and reconstructs canonical explicitly", () => {
	const input = options();
	const full = loadOrCompileCoreModule(input);
	if (full.status !== "ready") throw new Error(full.reason);
	const selected = { ...input, capturePolicy: "optimized-only" as const };
	const cold = loadOrCompileCoreModule(selected);
	if (cold.status !== "ready") throw new Error(cold.reason);
	expect(cold.cache).toBe("miss");
	expect(cold.key).not.toBe(full.key);
	expect(encodeCoreModule(cold.optimized)).toBe(encodeCoreModule(full.optimized));
	const directory = path.join(input.cacheDirectory, cold.key);
	const receipt = JSON.parse(
		readFileSync(path.join(directory, "manifest.json"), "utf8"),
	) as { canonicalDigest: string | null; optimizedDigest: string };
	expect(receipt.canonicalDigest).toBeNull();
	expect(readdirSync(directory).sort()).toEqual(
		[`${receipt.optimizedDigest}.json`, "manifest.json"].sort(),
	);
	const warm = loadOrCompileCoreModule({
		...selected,
		onWork() {
			throw new Error("Canonical access repeated compiler work");
		},
	});
	if (warm.status !== "ready") throw new Error(warm.reason);
	expect(warm.cache).toBe("hit");
	expect(() => cold.canonical).toThrow();
	expect(() => warm.canonical).toThrow();
	loadOrCompileCoreModule({ ...selected, source: `${source}\nvoid 0;` });
	expect(() =>
		reconstructCanonicalCoreModule({ ...input, source: `${source}\nvoid 0;` }, cold.key),
	).toThrow("input mismatch");
	loadOrCompileCoreModule({
		...selected,
		parsed: { result: parseModule(source), producer: "other-stripper" },
	});
	expect(() =>
		reconstructCanonicalCoreModule(
			{
				...input,
				parsed: { result: parseModule(source), producer: "other-stripper" },
			},
			cold.key,
		),
	).toThrow("input mismatch");
	const canonical = reconstructCanonicalCoreModule(input, cold.key);
	expect(encodeCoreModule(canonical)).toBe(encodeCoreModule(full.canonical));
	const loadedWarm = warm.canonical;
	const loadedCold = cold.canonical;
	expect(encodeCoreModule(loadedWarm)).toBe(encodeCoreModule(canonical));
	expect(encodeCoreModule(loadedCold)).toBe(encodeCoreModule(canonical));
	writeFileSync(path.join(directory, "manifest.json"), "partial");
	const rebuilt = loadOrCompileCoreModule(selected);
	expect(rebuilt).toMatchObject({ status: "ready", cache: "miss" });
	if (rebuilt.status !== "ready") throw new Error(rebuilt.reason);
	expect(encodeCoreModule(rebuilt.canonical)).toBe(encodeCoreModule(canonical));
	const descriptor = JSON.parse(
		readFileSync(path.join(directory, "canonical.json"), "utf8"),
	) as { digest: string };
	rmSync(path.join(directory, `${descriptor.digest}.json`));
	expect(warm.canonical).toBe(loadedWarm);
	expect(cold.canonical).toBe(loadedCold);
	const afterRemoval = loadOrCompileCoreModule(selected);
	if (afterRemoval.status !== "ready") throw new Error(afterRemoval.reason);
	expect(() => afterRemoval.canonical).toThrow();
});
it("keeps optimized Core usable when canonical reconstruction cannot publish", () => {
	const input = { ...options(), capturePolicy: "optimized-only" as const };
	const cold = loadOrCompileCoreModule(input);
	if (cold.status !== "ready") throw new Error(cold.reason);
	const directory = path.join(input.cacheDirectory, cold.key);
	mkdirSync(path.join(directory, "canonical.json"));
	const reconstructed = reconstructCanonicalCoreModule(input, cold.key);
	expect(reconstructed.functions).toHaveLength(cold.optimized.functions.length);
	const warm = loadOrCompileCoreModule(input);
	if (warm.status !== "ready") throw new Error(warm.reason);
	expect(warm.cache).toBe("hit");
	expect(encodeCoreModule(warm.optimized)).toBe(encodeCoreModule(cold.optimized));
	expect(() => warm.canonical).toThrow();
});
it("imports a cold optimized capture from its validated storage", () => {
	const input = options();
	const cold = loadOrCompileCoreModule(input);
	if (cold.status !== "ready") throw new Error(cold.reason);
	expect(cold.cache).toBe("miss");
	expect(Reflect.set(cold.optimized.exports[0]!, "slot", 999)).toBe(false);
	const finish = vi.spyOn(CoreFunctionBuilder.prototype, "finish");
	const destination = new CoreProgram(coreOpcodeRegistry);
	const imported = importCoreModule(destination, cold.optimized, input.sourcePath);
	expect(finish).not.toHaveBeenCalled();
	expect(imported.exports.get("add")).toBe(1);
	verifyCoreProgram(destination, { stage: "pre-target" });
	const copy = structuredClone(cold.optimized);
	copy.exports[0]!.slot = 999;
	const before = destination.functionCapacity;
	expect(() => importCoreModule(destination, copy, input.sourcePath)).toThrow();
	expect(destination.functionCapacity).toBe(before);
});
it("snapshots caller-owned export and assignment inputs before retaining a capture", () => {
	const input = options();
	const semantic = runSemanticAnalysisForGraph(
		buildModuleGraph(input.sourcePath, {
			entrySource: input.source,
			entryGoal: "module",
			stripTypes: (source) => source,
		}),
	);
	const core = lowerSemanticProgramToCore(semantic, {
		captureModuleExports: true,
	});
	const exports = (core.context.data.moduleExports ?? []).map(({ name, slot }) => ({
		name,
		slot,
	}));
	const slots = [...(core.context.data.singleAssignmentGlobalSlots ?? [])];
	const artifact = captureCoreModule(
		core.program,
		exports,
		[...core.program.functionIds()][0]!,
		{ ...core.context.data, singleAssignmentGlobalSlots: slots },
		{ retainPreparedImport: true },
	);
	const expected = artifact.exports.map(({ name, slot }) => ({ name, slot }));
	exports[0]!.slot = 999;
	slots.push(999);
	expect(artifact.exports).toEqual(expected);
	expect(artifact.singleAssignmentGlobalSlots).not.toContain(999);
	const destination = new CoreProgram(coreOpcodeRegistry);
	importCoreModule(destination, artifact, input.sourcePath);
	verifyCoreProgram(destination, { stage: "pre-target" });
});
it("rebinds cached function and call heat for each import and rejects cross-owner calls", () => {
	const input = {
		...options(),
		source:
			"export function apply(fn, value) { return fn(value); } export function other(fn, value) { return fn(value); }",
	};
	const cold = loadOrCompileCoreModule(input);
	if (cold.status !== "ready") throw new Error(cold.reason);
	const warm = loadOrCompileCoreModule(input);
	if (warm.status !== "ready") throw new Error(warm.reason);
	expect(warm.cache).toBe("hit");
	expect(warm.optimized.calls).toHaveLength(2);
	const semantic = runSemanticAnalysisForGraph(
		buildModuleGraph(input.sourcePath, {
			entrySource: input.source,
			entryGoal: "module",
			stripTypes: (source) => source,
		}),
	);
	const sourceOptions = {
		moduleKeys: new Map([[input.sourcePath, input.moduleKey]]),
	};
	const baseline = lowerSemanticProgramToCore(semantic, {
		sourceOrigins: sourceOptions,
	});
	const identities = new SourceProfileIdentities();
	const baselineFunction = [...baseline.program.functionIds()].find(
		(id) => baseline.program.function(id).metadata.sourceOrigin?.status === "captured",
	)!;
	const functionIdentity = identities.functionIdentity(
		baseline.program.function(baselineFunction).metadata.sourceOrigin,
	);
	if ("reason" in functionIdentity) throw new Error(functionIdentity.reason);
	const baselineSite = baseline.context.data.sourceCallSites!.find(
		(site) => site.owner?.status === "captured" && site.lowered,
	)!;
	const callIdentity = identities.callIdentity(baselineSite);
	if (callIdentity.status !== "known") throw new Error(callIdentity.reason);
	const profile: MergedPgoProfile = {
		schema: 3,
		semantics: 2,
		semanticKey: "a".repeat(64),
		digest: "b".repeat(64),
		overflow: false,
		runs: [],
		cpuCaptures: [],
		cpuFunctions: [],
		coverage: {
			unknownFunctions: 0,
			unknownCalls: 0,
			uninstrumentedCalls: 0,
			observedZeroFunctions: 0,
			observedZeroCalls: 0,
			incompleteTargetCalls: 0,
		},
		functions: [
			{
				origin: functionIdentity.origin,
				revision: functionIdentity.revision,
				count: "23",
			},
		],
		calls: [{ key: callIdentity.key, count: "17" }],
		targets: [],
		targetUnknownCalls: [],
	};
	const origins = collectSourceFunctionOrigins(semantic, sourceOptions);
	const prefix = Array.from({ length: 7 }, () => ({
		...baselineSite,
		owner: undefined,
	}));
	const relocatedOrigins = {
		...origins,
		callAt(...args: Parameters<typeof origins.callAt>) {
			const id = origins.callAt(...args);
			return id === undefined ? undefined : prefix.length + id;
		},
	};
	const destination = new CoreProgram(coreOpcodeRegistry);
	appendLeaf(destination);
	const file = semantic.files[0]!;
	const first = importCoreModule(destination, cold.optimized, input.sourcePath, {
		origins: relocatedOrigins,
		file,
	});
	const second = importCoreModule(destination, warm.optimized, input.sourcePath, {
		origins: relocatedOrigins,
		file,
	});
	const sites = [...prefix, ...origins.callSites()];
	const hints = pgoOptimizationInput(profile).bind({
		...baseline,
		program: destination,
		context: {
			...baseline.context,
			data: { ...baseline.context.data, sourceCallSites: sites },
		},
	});
	for (const imported of [first, second]) {
		const fn = destination.function(imported.functions[1]!);
		expect(hints.functionEntries(fn.id)).toBe(23);
		const call = [...fn.instructionIds()].find(
			(id) =>
				fn.instructionKind(id) === "operation" && fn.instructionOpcodeName(id) === "call",
		)!;
		expect(fn.instructionAttributes(call).sourceCall).toBe(7);
		expect(hints.callAttempts(fn.id, call)).toBe(17);
	}
	const noProfile = importCoreModule(destination, warm.optimized, input.sourcePath);
	const plain = destination.function(noProfile.functions[1]!);
	expect(plain.metadata.sourceOrigin).toBeUndefined();
	const plainCall = [...plain.instructionIds()].find(
		(id) =>
			plain.instructionKind(id) === "operation" &&
			plain.instructionOpcodeName(id) === "call",
	)!;
	expect(plain.instructionAttributes(plainCall).sourceCall).toBeUndefined();
	const corrupt = JSON.parse(encodeCoreModule(warm.optimized)) as typeof warm.optimized;
	corrupt.calls[0]!.owner = 2;
	expect(() => decodeCoreModule(JSON.stringify(corrupt))).toThrow("call owner");
});
it("misses after source or recipe changes and repairs a corrupt entry before import", () => {
	const input = options();
	const initial = loadOrCompileCoreModule(input);
	if (initial.status !== "ready") throw new Error(initial.reason);
	writeFileSync(path.join(input.cacheDirectory, initial.key, "manifest.json"), "partial");
	expect(loadOrCompileCoreModule(input)).toMatchObject({
		status: "ready",
		cache: "miss",
	});
	expect(
		loadOrCompileCoreModule({
			...input,
			source: source.replace("n = 1", "n = 2"),
		}),
	).toMatchObject({ status: "ready", cache: "miss" });
	expect(loadOrCompileCoreModule({ ...input, maxWorkItems: 90_000 })).toMatchObject({
		status: "ready",
		cache: "miss",
	});
});
it("loads only the selected payload and memoizes canonical validation on demand", () => {
	const input = options();
	const cold = loadOrCompileCoreModule(input);
	if (cold.status !== "ready") throw new Error(cold.reason);
	const directory = path.join(input.cacheDirectory, cold.key);
	const receipt = JSON.parse(
		readFileSync(path.join(directory, "manifest.json"), "utf8"),
	) as { canonicalDigest: string; optimizedDigest: string };
	const canonicalFile = path.join(directory, `${receipt.canonicalDigest}.json`);
	const canonicalBytes = readFileSync(canonicalFile, "utf8");
	rmSync(canonicalFile);
	const warm = loadOrCompileCoreModule({
		...input,
		onWork() {
			throw new Error("Repeated compiler work");
		},
	});
	if (warm.status !== "ready") throw new Error(warm.reason);
	expect(warm.cache).toBe("hit");
	expect(() => warm.canonical).toThrow();
	writeFileSync(canonicalFile, "corrupt");
	expect(() => warm.canonical).toThrow("digest mismatch");
	writeFileSync(canonicalFile, canonicalBytes);
	const canonical = warm.canonical;
	expect(encodeCoreModule(canonical)).toBe(encodeCoreModule(cold.canonical));
	rmSync(canonicalFile);
	expect(warm.canonical).toBe(canonical);
	const program = new CoreProgram(coreOpcodeRegistry);
	importCoreModule(program, warm.optimized, input.sourcePath);
	verifyCoreProgram(program, { stage: "pre-target" });
});
it("repairs corrupt selected payloads and rejects paths outside the cache entry", () => {
	const input = options();
	const cold = loadOrCompileCoreModule(input);
	if (cold.status !== "ready") throw new Error(cold.reason);
	const directory = path.join(input.cacheDirectory, cold.key);
	const manifest = path.join(directory, "manifest.json");
	const receipt = JSON.parse(readFileSync(manifest, "utf8")) as {
		canonicalDigest: string;
		optimizedDigest: string;
	};
	const optimizedFile = path.join(directory, `${receipt.optimizedDigest}.json`);
	for (const corruption of ["payload", "path"] as const) {
		if (corruption === "payload") writeFileSync(optimizedFile, "partial");
		else
			writeFileSync(
				manifest,
				JSON.stringify({ ...receipt, optimizedDigest: "../outside" }),
			);
		const repaired = loadOrCompileCoreModule(input);
		expect(repaired).toMatchObject({ status: "ready", cache: "miss" });
		const warm = loadOrCompileCoreModule(input);
		expect(warm).toMatchObject({ status: "ready", cache: "hit" });
		if (warm.status !== "ready") throw new Error(warm.reason);
		expect(encodeCoreModule(warm.optimized)).toBe(encodeCoreModule(cold.optimized));
	}
	expect(readdirSync(directory).some((file) => file.includes(".tmp-"))).toBe(false);
});
it("keeps a cold result usable without publishing an incomplete manifest", () => {
	const input = options();
	const cold = loadOrCompileCoreModule(input);
	if (cold.status !== "ready") throw new Error(cold.reason);
	const directory = path.join(input.cacheDirectory, cold.key);
	const manifest = path.join(directory, "manifest.json");
	const receipt = JSON.parse(readFileSync(manifest, "utf8")) as {
		canonicalDigest: string;
		optimizedDigest: string;
	};
	const optimizedFile = path.join(directory, `${receipt.optimizedDigest}.json`);
	rmSync(manifest);
	rmSync(optimizedFile);
	mkdirSync(optimizedFile);
	expect(loadOrCompileCoreModule(input)).toMatchObject({
		status: "ready",
		cache: "miss",
	});
	expect(existsSync(manifest)).toBe(false);
	expect(readdirSync(directory).some((file) => file.includes(".tmp-"))).toBe(false);
	rmSync(optimizedFile, { recursive: true });
	expect(loadOrCompileCoreModule(input)).toMatchObject({
		status: "ready",
		cache: "miss",
	});
	expect(loadOrCompileCoreModule(input)).toMatchObject({
		status: "ready",
		cache: "hit",
	});
});
it("decodes already available operands without temporary use lists", () => {
	const cold = loadOrCompileCoreModule({
		...options(),
		source: "export function add(x) { return x + 1; }",
	});
	if (cold.status !== "ready") throw new Error(cold.reason);
	const encoded = encodeCoreModule(cold.optimized);
	const replaced = vi.spyOn(CoreEditor.prototype, "replaceOperands");
	const decoded = decodeCoreModule(encoded);
	expect(replaced).not.toHaveBeenCalled();
	const program = new CoreProgram(coreOpcodeRegistry);
	importCoreModule(program, decoded, "/straight.mjs");
	for (const id of program.functionIds()) {
		const fn = program.function(id);
		expect(fn.instructionCapacity).toBe([...fn.instructionIds()].length);
	}
	verifyCoreProgram(program, { stage: "pre-target" });
});
it("resolves forward operands across reordered blocks and rejects unresolved or cyclic uses", () => {
	const cold = loadOrCompileCoreModule({
		...options(),
		source:
			"export function choose(x) { const y = x + 1; if (x) return y * 2; return y; }",
	});
	if (cold.status !== "ready") throw new Error(cold.reason);
	const reordered = structuredClone(cold.canonical);
	for (const fn of reordered.functions) fn.blocks = [...fn.blocks].reverse();
	const replaced = vi.spyOn(CoreEditor.prototype, "replaceOperands");
	const decoded = decodeCoreModule(encodeCoreModule(reordered));
	expect(replaced).toHaveBeenCalled();
	const destination = new CoreProgram(coreOpcodeRegistry);
	importCoreModule(destination, decoded, "/reordered.mjs");
	verifyCoreProgram(destination, { stage: "pre-target" });
	for (const kind of ["missing", "cycle"] as const) {
		const bad = structuredClone(reordered);
		const operation = bad.functions
			.flatMap((fn) => fn.blocks.flatMap((block) => block.operations))
			.find((op) => op.opcode === "binary")!;
		operation.inputs = [
			kind === "missing" ? coreValueId(999_999) : operation.outputs[0]!,
			...operation.inputs.slice(1),
		];
		const before = destination.functionCapacity;
		expect(() => importCoreModule(destination, bad, "/invalid.mjs")).toThrow();
		expect(destination.functionCapacity).toBe(before);
	}
});
it.each([
	"import { x } from './missing.mjs'; export { x };",
	"export function* f() { yield 1; }",
	"export function f() { for (let x = 0; x < 2; x++) (() => x)(); }",
	"export async function f() { return 1; }",
])("declines unsupported boundaries: %s", (text) => {
	expect(loadOrCompileCoreModule({ ...options(), source: text })).toMatchObject({
		status: "unsupported",
	});
});
it("preserves special numbers and rejects an invalid relocation before destination mutation", () => {
	const result = loadOrCompileCoreModule({
		...options(),
		source:
			"export function negativeZero() { return -0; } export function numbers() { return [0/0, 1/0, -1/0]; }",
	});
	if (result.status !== "ready") throw new Error(result.reason);
	const decoded = decodeCoreModule(encodeCoreModule(result.optimized));
	expect(() =>
		decodeCoreModule(
			encodeCoreModule(result.optimized).replace('"$number":"-0"', '"$number":["-0"]'),
		),
	).toThrow();
	expect(Reflect.set(decoded.exports[0]!, "slot", 1000)).toBe(false);
	expect(Reflect.set(decoded.functions[0]!.metadata, "capturedCount", 1000)).toBe(false);
	expect(
		decoded.functions
			.flatMap((fn) => fn.blocks.flatMap((block) => block.operations))
			.some(
				(op) =>
					["createNumber", "createF64"].includes(op.opcode) &&
					Object.is(op.attributes.value, -0),
			),
	).toBe(true);
	const numbers = decoded.functions
		.flatMap((fn) => fn.blocks.flatMap((block) => block.operations))
		.filter((op) => ["createNumber", "createF64"].includes(op.opcode))
		.map((op) => op.attributes.value);
	for (const number of [NaN, Infinity, -Infinity])
		expect(numbers.some((value) => Object.is(value, number))).toBe(true);
	const bad = structuredClone(decoded);
	bad.exports = [{ name: "bad", slot: 1000 }];
	const destination = new CoreProgram(coreOpcodeRegistry, { globalCount: 4 });
	appendLeaf(destination);
	expect(() => importCoreModule(destination, bad, "/pilot.mjs")).toThrow();
	expect(destination.globalCount).toBe(4);
	expect([...destination.functionIds()]).toHaveLength(1);
});

it("does not alias distinct UTF-16 sources in persistent identities", () => {
	const input = options();
	const first = loadOrCompileCoreModule({
		...input,
		source: 'export function text() { return "\ud800"; }',
	});
	const second = loadOrCompileCoreModule({
		...input,
		source: 'export function text() { return "\ud801"; }',
	});
	expect(first).toMatchObject({ status: "ready", cache: "miss" });
	expect(second).toMatchObject({ status: "ready", cache: "miss" });
	if (first.status === "ready" && second.status === "ready")
		expect(first.key).not.toBe(second.key);
});

it("retains independent captured owners and rejects synthetic loop environments before import", () => {
	const input = options();
	const result = loadOrCompileCoreModule({
		...input,
		source:
			"const helper = x => x + 1; export function make(x) { const y = helper(x); return () => y; }",
	});
	if (result.status !== "ready") throw new Error(result.reason);
	expect(result.optimized.singleAssignmentGlobalSlots.length).toBeGreaterThan(0);
	expect(result.optimized.singleAssignmentCapturedSlots.length).toBeGreaterThan(0);
	const destination = new CoreProgram(coreOpcodeRegistry, { globalCount: 5 });
	appendLeaf(destination);
	const imported = importCoreModule(destination, result.optimized, "/moved.mjs");
	expect(imported.singleAssignmentCapturedSlots.every((slot) => slot.owner > 0)).toBe(
		true,
	);
	verifyCoreProgram(destination, { stage: "pre-target" });
	expect(
		loadOrCompileCoreModule({
			...input,
			source:
				"export function make() { let f; for(let i=0;i<1;i++){ const n=i; f=()=>n; } return f; }",
		}),
	).toMatchObject({ status: "unsupported" });
});

it("records budget-limited attempts without publishing completed bodies and retries a larger recipe", () => {
	const input = options();
	expect(loadOrCompileCoreModule({ ...input, maxWorkItems: 1 })).toMatchObject({
		status: "budget-limited",
	});
	expect(readdirSync(input.cacheDirectory)).toHaveLength(1);
	expect(
		loadOrCompileCoreModule({
			...input,
			maxWorkItems: 1,
			onWork() {
				throw new Error("Repeated incomplete recipe");
			},
		}),
	).toMatchObject({ status: "budget-limited" });
	expect(loadOrCompileCoreModule(input)).toMatchObject({
		status: "ready",
		cache: "miss",
	});
});

it("persists structural cleanup and retains UTF-16 constants across equal branch inputs", () => {
	const input = options();
	const long = `${"x".repeat(150_000)}\ud800`;
	input.source = `export function choose(flag) { let value; if (flag) value = ${JSON.stringify(long)}; else value = ${JSON.stringify(long)}; return value === ${JSON.stringify(long)}; }`;
	const cold = loadOrCompileCoreModule(input);
	if (cold.status !== "ready") throw new Error(cold.reason);
	const blocks = (artifact: typeof cold.canonical) =>
		artifact.functions.reduce((n, fn) => n + fn.blocks.length, 0);
	expect(blocks(cold.optimized)).toBeLessThan(blocks(cold.canonical));
	const warm = loadOrCompileCoreModule(input);
	if (warm.status !== "ready") throw new Error(warm.reason);
	expect(warm.cache).toBe("hit");
	expect(encodeCoreModule(warm.optimized)).toBe(encodeCoreModule(cold.optimized));
	const program = new CoreProgram(coreOpcodeRegistry);
	importCoreModule(program, warm.optimized, input.sourcePath);
	expect(
		program.stringConstants.some(
			(units) => units.length === long.length && units.at(-1) === 0xd800,
		),
	).toBe(true);
	verifyCoreProgram(program, { stage: "pre-target" });
});

it("does not publish a partial structural recipe when its edit budget is exhausted", () => {
	const input = {
		...options(),
		source:
			"export function pick(flag, x) { let value; if(flag) value = x; else value = x; return value; }",
		maxEdits: 1,
	};
	expect(loadOrCompileCoreModule(input)).toMatchObject({
		status: "budget-limited",
	});
	const entries = readdirSync(input.cacheDirectory);
	expect(entries).toHaveLength(1);
	expect(readdirSync(path.join(input.cacheDirectory, entries[0]!))).toEqual([
		"manifest.json",
	]);
	expect(
		loadOrCompileCoreModule({
			...input,
			onWork() {
				throw new Error("Repeated bounded recipe");
			},
		}),
	).toMatchObject({ status: "budget-limited" });
	expect(loadOrCompileCoreModule({ ...input, maxEdits: 100_000 })).toMatchObject({
		status: "ready",
		cache: "miss",
	});
});

it("continues compilation when the optional cache cannot publish", () => {
	const input = options();
	const file = path.join(input.cacheDirectory, "not-a-directory");
	writeFileSync(file, "occupied");
	expect(loadOrCompileCoreModule({ ...input, cacheDirectory: file })).toMatchObject({
		status: "ready",
		cache: "miss",
	});
});

it("relocates literal pools, exception edges and string switches before importing boxed Core", () => {
	const result = loadOrCompileCoreModule({
		...options(),
		source: `
			export function literal() { return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, "nine", 10n, { key: -0 }]; }
			export function choose(key, callback) {
				try { switch (key) { case "a": return callback(1); case "b": return callback(2); default: return 3; } }
				catch (error) { return key + error; }
			}
			export class Derived extends Error { constructor(text) { super(text); } get detail() { return literal(); } }
		`,
	});
	if (result.status !== "ready") throw new Error(result.reason);
	const artifact = decodeCoreModule(encodeCoreModule(result.optimized));
	expect(artifact.literalTemplates.length).toBeGreaterThan(0);
	expect(artifact.bigints).toContain("10");
	expect(artifact.functions.some((fn) => fn.metadata.isDerivedConstructor)).toBe(true);
	const blocks = artifact.functions.flatMap((fn) => fn.blocks);
	expect(blocks.some((block) => block.handler !== undefined)).toBe(true);
	expect(blocks.some((block) => block.terminator.kind === "switch")).toBe(true);
	const numeric = structuredClone(artifact);
	const switchBlock = numeric.functions
		.flatMap((fn) => fn.blocks)
		.find((block) => block.terminator.kind === "switch")!;
	if (switchBlock.terminator.kind !== "switch") throw new Error("Missing switch");
	const edge = switchBlock.terminator.cases[0]!.edge;
	switchBlock.terminator = {
		...switchBlock.terminator,
		cases: [-0, NaN, Infinity, -Infinity].map((value) => ({
			value: { kind: "number", value },
			edge,
		})),
	};
	const decodedSwitch = decodeCoreModule(encodeCoreModule(numeric))
		.functions.flatMap((fn) => fn.blocks)
		.find((block) => block.terminator.kind === "switch")!.terminator;
	if (decodedSwitch.kind !== "switch") throw new Error("Missing decoded switch");
	expect(decodedSwitch.cases.map((item) => item.value)).toEqual(
		[-0, NaN, Infinity, -Infinity].map((value) => ({ kind: "number", value })),
	);
	const destination = new CoreProgram(coreOpcodeRegistry, {
		globalCount: 3,
		stringConstants: [[120]],
		bigintConstants: [99n],
		literalTemplateData: [8, 1, 6, 0],
	});
	appendLeaf(destination);
	importCoreModule(destination, artifact, "/shifted.mjs");
	importCoreModule(destination, artifact, "/second.mjs");
	verifyCoreProgram(destination, { stage: "pre-target" });
	expect(destination.bigintConstants).toEqual([99n, 10n, 10n]);
	const corruptions = [
		(bad: typeof artifact) => {
			bad.literalTemplates = [8, 2, 5, 0];
		},
		(bad: typeof artifact) => {
			bad.literalTemplates = [5, bad.strings.length];
		},
		(bad: typeof artifact) => {
			bad.bigints = ["01"];
		},
		(bad: typeof artifact) => {
			const block = bad.functions
				.flatMap((fn) => fn.blocks)
				.find((b) => b.handler !== undefined)!;
			block.handler = { block: 999_999 as typeof block.id, arguments: [] };
		},
		(bad: typeof artifact) => {
			const block = bad.functions
				.flatMap((fn) => fn.blocks)
				.find((b) => b.terminator.kind === "switch")!;
			const term = block.terminator;
			if (term.kind === "switch")
				block.terminator = {
					...term,
					cases: [
						{
							value: { kind: "string", index: bad.strings.length },
							edge: term.default,
						},
					],
				};
		},
		(bad: typeof artifact) => {
			const op = bad.functions
				.flatMap((fn) => fn.blocks.flatMap((block) => block.operations))
				.find((op) => op.opcode === "instantiateLiteralTemplate")!;
			op.attributes = { templateOffset: 1 };
		},
		(bad: typeof artifact) => {
			const op = bad.functions
				.flatMap((fn) => fn.blocks.flatMap((block) => block.operations))
				.find((op) => op.opcode === "defineAccessor")!;
			op.attributes = { kind: ["set"], enumerable: false };
		},
	];
	for (const corrupt of corruptions) {
		const bad = structuredClone(artifact);
		corrupt(bad);
		const functions = destination.functionCapacity;
		const globals = destination.globalCount;
		const versions = destination.versions;
		const revision = destination.programFlowRevision;
		const pools = [
			destination.stringConstants,
			destination.bigintConstants,
			destination.literalTemplateData,
			destination.sourcePositions,
		];
		expect(() => importCoreModule(destination, bad, "/corrupt.mjs")).toThrow();
		expect(destination.functionCapacity).toBe(functions);
		expect(destination.globalCount).toBe(globals);
		expect(destination.versions).toEqual(versions);
		expect(destination.programFlowRevision).toBe(revision);
		[
			destination.stringConstants,
			destination.bigintConstants,
			destination.literalTemplateData,
			destination.sourcePositions,
		].forEach((pool, i) => expect(pool).toBe(pools[i]));
	}
});

it("builds decoded stores once and gives each repeated import independent ownership", () => {
	const result = loadOrCompileCoreModule({
		...options(),
		source: "export function value() { return 7; }",
	});
	if (result.status !== "ready") throw new Error(result.reason);
	const destination = new CoreProgram(coreOpcodeRegistry, {
		stringConstants: [[120]],
		sourcePositions: [{ line: 50, column: 2 }],
	});
	const active = new CoreFunctionBuilder(destination);
	const entry = active.createBlock();
	const [value] = active.appendInstruction(entry, "createUndefined", []);
	const other = new CoreProgram(coreOpcodeRegistry, {
		stringConstants: [[121]],
	});
	appendLeaf(other);
	other.finalizeConstructionGeneration();
	const create = vi.spyOn(CoreEditor, "createFunction");
	const artifact = decodeCoreModule(encodeCoreModule(result.optimized));
	const count = artifact.functions.length;
	expect(create).toHaveBeenCalledTimes(count);
	const preparedStores = create.mock.results.map((result) => {
		if (result.type !== "return") throw new Error("Function construction failed");
		return result.value.function;
	});
	const positions = preparedStores.map((fn) =>
		[...fn.instructionIds()].map((id) => [id, fn.instructionSourcePosition(id)] as const),
	);
	const first = importCoreModule(destination, artifact, "/first.mjs");
	expect(create).toHaveBeenCalledTimes(count);
	first.functions.forEach((id, ordinal) => {
		const fn = destination.function(id);
		expect(fn).toBe(preparedStores[ordinal]);
		for (const [instruction, position] of positions[ordinal]!)
			expect(fn.instructionSourcePosition(instruction)).toBe(
				position === undefined ? undefined : position + 1,
			);
	});
	const firstBody = destination.function(first.functions[1]!);
	const number = [...firstBody.blockIds()]
		.flatMap((block) => [...firstBody.bodyInstructionIds(block)])
		.find((id) =>
			["createNumber", "createI32", "createF64"].includes(
				firstBody.instructionOpcodeName(id),
			),
		)!;
	const edit = CoreEditor.open(destination, firstBody.id);
	edit.replaceInstruction(number, "createBoolean", [], {
		attributes: { value: true },
	});
	edit.commit();
	const second = importCoreModule(destination, artifact, "/second.mjs");
	expect(create).toHaveBeenCalledTimes(count * 2);
	const third = importCoreModule(other, artifact, "/third.mjs");
	expect(create).toHaveBeenCalledTimes(count * 3);
	for (const [program, imported] of [
		[destination, second],
		[other, third],
	] as const) {
		const body = program.function(imported.functions[1]!);
		expect(body).not.toBe(firstBody);
		expect(body.generation).toBe(program.generation);
		expect(
			[...body.blockIds()]
				.flatMap((block) => [...body.bodyInstructionIds(block)])
				.some(
					(id) =>
						["createNumber", "createI32", "createF64"].includes(
							body.instructionOpcodeName(id),
						) && body.instructionAttributes(id).value === 7,
				),
		).toBe(true);
	}
	active.setTerminator(entry, { kind: "return", value: value! });
	active.finish(entry);
	verifyCoreProgram(destination, { stage: "pre-target" });
	verifyCoreProgram(other, { stage: "pre-target" });
});

it("refreshes existing program analyses after attachment and edits to an imported body", () => {
	const result = loadOrCompileCoreModule({
		...options(),
		source: "export function value() { return 7; }",
	});
	if (result.status !== "ready") throw new Error(result.reason);
	const program = new CoreProgram(coreOpcodeRegistry, {
		stringConstants: [[120]],
	});
	appendLeaf(program);
	const context = programAnalysisContext(false);
	const manager = new CoreAnalysisManager(
		program,
		context,
		new CoreOptimizationReportBuilder(program),
	);
	manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" });
	const imported = importCoreModule(
		program,
		decodeCoreModule(encodeCoreModule(result.optimized)),
		"/attached.mjs",
	);
	const id = imported.functions[1]!;
	expect(
		manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" }).kinds.summary(id)
			.returnKind,
	).toBe(COMPILER_VALUE_KIND_NUMBER);
	const fn = program.function(id);
	const number = [...fn.blockIds()]
		.flatMap((block) => [...fn.bodyInstructionIds(block)])
		.find((instruction) =>
			["createNumber", "createI32", "createF64"].includes(
				fn.instructionOpcodeName(instruction),
			),
		)!;
	const edit = CoreEditor.open(program, id);
	edit.replaceInstruction(number, "createBoolean", [], {
		attributes: { value: true },
	});
	edit.commit();
	const refreshed = manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, {
		scope: "program",
	}).kinds;
	expect(refreshed.summary(id).returnKind).toBe(COMPILER_VALUE_KIND_BOOLEAN);
	const fresh = new CoreAnalysisManager(
		program,
		context,
		new CoreOptimizationReportBuilder(program),
	).get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" }).kinds;
	for (const fn of program.functionIds())
		expect(refreshed.summary(fn)).toEqual(fresh.summary(fn));
});

it("accepts long static property names and sparse argument reads without host argument limits", () => {
	const key = "key".repeat(50_000);
	const result = loadOrCompileCoreModule({
		...options(),
		source: `export function f(value) { return { ${JSON.stringify(key)}: value, missing: arguments[1000000] }; }`,
	});
	if (result.status !== "ready") throw new Error(result.reason);
	const artifact = decodeCoreModule(encodeCoreModule(result.optimized));
	const destination = new CoreProgram(coreOpcodeRegistry);
	importCoreModule(destination, artifact, "/long-key.mjs");
	verifyCoreProgram(destination, { stage: "pre-target" });
});
