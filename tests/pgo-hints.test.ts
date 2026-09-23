import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileBuildFrontend } from "../src/build-frontend-cache.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import type { CorePgoHints } from "../src/compiler/core/core-pgo.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import { serializeCompilerArtifact } from "../src/compiler/target/compiler-artifact-codec.ts";
import { pgoOptimizationInput } from "../src/pgo-artifact.ts";
import type { MergedPgoProfile } from "../src/pgo-artifact.ts";
import { SourceProfileIdentities } from "../src/source-profile-identity.ts";

function construct(source: string) {
	return lowerSemanticProgramToCore(
		analyzeSourceAndRunSemanticAnalysis(source, "/project/input.js"),
		{ sourceOrigins: {} },
	);
}
function profile(core: ReturnType<typeof construct>): MergedPgoProfile {
	const identities = new SourceProfileIdentities();
	return {
		schema: 2,
		semantics: 2,
		semanticKey: "a".repeat(64),
		digest: "b".repeat(64),
		overflow: false,
		runs: [],
		coverage: {
			unknownFunctions: 0,
			unknownCalls: 0,
			uninstrumentedCalls: 0,
			observedZeroFunctions: 0,
			observedZeroCalls: 0,
			incompleteTargetCalls: 0,
		},
		functions: [...core.program.functionIds()].flatMap((id) => {
			const identity = identities.functionIdentity(
				core.program.function(id).metadata.sourceOrigin,
			);
			return "reason" in identity
				? []
				: [{ origin: identity.origin, revision: identity.revision, count: "5" }];
		}),
		calls: (core.context.data.sourceCallSites ?? []).flatMap((site) => {
			const identity = identities.callIdentity(site);
			return identity.status === "known" ? [{ key: identity.key, count: "7" }] : [];
		}),
		targets: [],
		targetUnknownCalls: [],
	};
}
it("matches exact revisions and leaves generator bodies and copied calls unknown", () => {
	const source =
		"function f(cb) { return cb(1); } function* g() { yield 2; } globalThis.f=f; globalThis.g=g;";
	const core = construct(source);
	const input = pgoOptimizationInput(profile(core), { collectQueryCoverage: true });
	const hints = input.bind(core);
	expect(hints.queryCoverage?.().functions.positive).toBe(0);
	const f = [...core.program.functionIds()].find(
		(id) => core.program.function(id).parameterCount === 1,
	)!;
	const fn = core.program.function(f);
	const call = [...fn.instructionIds()].find(
		(id) =>
			fn.instructionKind(id) === "operation" && fn.instructionOpcodeName(id) === "call",
	)!;
	expect(hints.functionEntries(f)).toBe(5);
	expect(hints.functionEntries(f)).toBe(5);
	expect(hints.callAttempts(f, call)).toBe(7);
	expect(hints.callAttempts(f, call)).toBe(7);
	const generator = [...core.program.functionIds()].find(
		(id) => core.program.function(id).isGenerator,
	)!;
	expect(hints.functionEntries(generator)).toBeUndefined();
	const changed = construct(source.replace("cb(1)", "cb(2)"));
	const changedHints = input.bind(changed);
	expect(changedHints.functionEntries(f)).toBeUndefined();
	expect(changedHints.queryCoverage?.().functions.unmatchedRevision).toBe(1);
	const clone = new CoreFunctionBuilder(core.program, { metadata: fn.metadata });
	const block = clone.createBlock();
	const value = clone.appendInstruction(block, "createUndefined", [])[0]!;
	clone.appendInstruction(block, "call", [value, value], {
		attributes: fn.instructionAttributes(call),
	});
	const copied = clone.bodyInstructionIds(block)[1]!;
	clone.setTerminator(block, { kind: "return", value });
	const id = clone.finish(block).function;
	expect(hints.functionEntries(id)).toBeUndefined();
	expect(hints.callAttempts(id, copied)).toBeUndefined();
	const editor = CoreEditor.open(core.program, generator);
	const first = core.program.function(generator).entry;
	const copiedValue = editor.appendInstruction(first, "createUndefined", []).outputs[0]!;
	const inserted = editor.appendInstruction(first, "call", [copiedValue, copiedValue], {
		attributes: fn.instructionAttributes(call),
	});
	editor.commit();
	expect(hints.callAttempts(generator, inserted.instruction)).toBeUndefined();
	expect(hints.queryCoverage?.()).toMatchObject({
		functions: { positive: 1, unsupportedBody: 1, missingOrigin: 1 },
		calls: { positive: 1, ownerMismatch: 2 },
	});
});
it("uses only complete guard matches for exact target identities", () => {
	const source =
		"function a() { return 1; } function b(x) { return x; } function use(f, x) { return f(x); } globalThis.use = use;";
	const core = construct(source);
	const ids = [...core.program.functionIds()];
	const named = (name: string) =>
		ids.find((id) => {
			const index = core.program.function(id).metadata.nameStringIndex;
			return (
				String.fromCodePoint(...(core.program.stringConstants[index] ?? [])) === name
			);
		})!;
	const a = named("a");
	const b = named("b");
	const use = named("use");
	const fn = core.program.function(use);
	const call = [...fn.instructionIds()].find(
		(id) =>
			fn.instructionKind(id) === "operation" && fn.instructionOpcodeName(id) === "call",
	)!;
	const identities = new SourceProfileIdentities();
	const site =
		core.context.data.sourceCallSites![
			fn.instructionAttributes(call).sourceCall as number
		]!;
	const sourceIdentity = identities.callIdentity(site);
	const targetIdentity = identities.functionIdentity(
		core.program.function(a).metadata.sourceOrigin,
	);
	if (sourceIdentity.status !== "known" || targetIdentity.status !== "known")
		throw new Error("Expected exact source identities");
	const merged = profile(core);
	merged.targets = [
		{
			key: sourceIdentity.key,
			origin: targetIdentity.origin,
			revision: targetIdentity.revision,
			count: "3",
		},
	];
	const hints = pgoOptimizationInput(merged).bind(core);
	expect(hints.guardedCallHits?.(use, call, [a])).toBe(3);
	expect(hints.guardedCallHits?.(use, call, [b])).toBe(0);
	expect(hints.guardedCallHits?.(use, call, [a, b, a])).toBe(3);
	const mixedRevisions = {
		...merged,
		functions: [
			...merged.functions,
			{
				origin: targetIdentity.origin,
				revision: "f".repeat(64),
				count: "0",
			},
		],
	};
	expect(
		pgoOptimizationInput(mixedRevisions).bind(core).guardedCallHits?.(use, call, [a]),
	).toBeUndefined();
	const clone = new CoreFunctionBuilder(core.program, {
		metadata: core.program.function(a).metadata,
	});
	const block = clone.createBlock();
	const result = clone.appendInstruction(block, "createUndefined", [])[0]!;
	clone.setTerminator(block, { kind: "return", value: result });
	clone.finish(block);
	expect(hints.guardedCallHits?.(use, call, [a])).toBeUndefined();
	const duplicateCalls = construct(source);
	const duplicateHints = pgoOptimizationInput(merged).bind(duplicateCalls);
	expect(duplicateHints.guardedCallHits?.(use, call, [a])).toBe(3);
	const editor = CoreEditor.open(duplicateCalls.program, use);
	const value = editor.appendInstruction(fn.entry, "createUndefined", []).outputs[0]!;
	const copiedCall = editor.appendInstruction(fn.entry, "call", [value, value], {
		attributes: fn.instructionAttributes(call),
	});
	editor.commit();
	expect(duplicateHints.guardedCallHits?.(use, call, [a])).toBeUndefined();
	const remove = CoreEditor.open(duplicateCalls.program, use);
	remove.removeInstruction(copiedCall.instruction);
	remove.commit();
	expect(duplicateHints.guardedCallHits?.(use, call, [a])).toBe(3);
	const copiedOwner = new CoreFunctionBuilder(duplicateCalls.program, {
		metadata: duplicateCalls.program.function(use).metadata,
	});
	const copiedBlock = copiedOwner.createBlock();
	const copiedValue = copiedOwner.appendInstruction(
		copiedBlock,
		"createUndefined",
		[],
	)[0]!;
	copiedOwner.appendInstruction(copiedBlock, "call", [copiedValue, copiedValue], {
		attributes: fn.instructionAttributes(call),
	});
	copiedOwner.setTerminator(copiedBlock, { kind: "return", value: copiedValue });
	copiedOwner.finish(copiedBlock);
	expect(duplicateHints.guardedCallHits?.(use, call, [a])).toBeUndefined();
	merged.targetUnknownCalls = [sourceIdentity.key];
	expect(
		pgoOptimizationInput(merged).bind(core).guardedCallHits?.(use, call, [a]),
	).toBeUndefined();
});
it("reports only requested PGO matches through the optimizer callback", () => {
	const source = "const f = x => x + 1; globalThis.result = f(2);";
	const semantic = analyzeSourceAndRunSemanticAnalysis(source, "/project/input.js");
	const merged = profile(construct(source));
	const input = pgoOptimizationInput(merged, {
		collectQueryCoverage: true,
	});
	let queriedFunctions = 0;
	const diagnostic = compileSemanticProgramToProgramImage(semantic, {
		pgo: input,
		afterCoreOptimization(_program, _context, report) {
			const coverage = report.pgoQueries;
			expect(coverage).toBeDefined();
			queriedFunctions = Object.values(coverage!.functions).reduce(
				(sum, count) => sum + count,
				0,
			);
		},
	});
	expect(queriedFunctions).toBeGreaterThan(0);
	const regular = compileSemanticProgramToProgramImage(semantic, {
		pgo: pgoOptimizationInput(merged),
		afterCoreOptimization(_program, _context, report) {
			expect(report.pgoQueries).toBeUndefined();
		},
	});
	expect(serializeCompilerArtifact(diagnostic)).toEqual(
		serializeCompilerArtifact(regular),
	);
});
it("retains the missing-origin outcome when an unknown call is queried again", () => {
	const source = "function f(cb) { return cb(1); } globalThis.f = f;";
	const core = construct(source);
	const id = [...core.program.functionIds()].find(
		(candidate) => core.program.function(candidate).parameterCount === 1,
	)!;
	const fn = core.program.function(id);
	const call = [...fn.instructionIds()].find(
		(instruction) => fn.instructionOpcodeName(instruction) === "call",
	)!;
	const siteId = fn.instructionAttributes(call).sourceCall;
	if (typeof siteId !== "number") throw new Error("Expected original call site");
	const sites = [...core.context.data.sourceCallSites!];
	sites[siteId] = { ...sites[siteId]!, start: undefined };
	const input = pgoOptimizationInput(profile(core), { collectQueryCoverage: true });
	const hints = input.bind({
		...core,
		context: { ...core.context, data: { ...core.context.data, sourceCallSites: sites } },
	});
	expect(hints.callAttempts(id, call)).toBeUndefined();
	expect(hints.callAttempts(id, call)).toBeUndefined();
	expect(hints.queryCoverage?.().calls).toMatchObject({
		missingOrigin: 1,
		unmatchedProfile: 0,
	});
});
it("preserves original call heat through a verified builtin rewrite", () => {
	const source = "function f(value) { return Object.keys(value); } globalThis.f=f;";
	const semantic = analyzeSourceAndRunSemanticAnalysis(source, "/project/input.js");
	const input = pgoOptimizationInput(profile(construct(source)));
	let hints: CorePgoHints | undefined;
	let found = false;
	compileSemanticProgramToProgramImage(semantic, {
		facts: compilerProgramFactsFromConfig(
			resolveBuildConfig({ engine: { primordials: "locked" } }),
		),
		pgo: {
			...input,
			bind(core) {
				return (hints = input.bind(core));
			},
		},
		afterCoreOptimization(program) {
			for (const id of program.functionIds()) {
				const fn = program.function(id);
				for (const instruction of fn.instructionIds())
					if (
						fn.instructionKind(instruction) === "operation" &&
						fn.instructionOpcodeName(instruction) === "callKnown" &&
						fn.instructionAttributes(instruction).sourceCall !== undefined
					) {
						found = true;
						expect(hints!.callAttempts(id, instruction)).toBe(7);
					}
			}
		},
	});
	expect(found).toBe(true);
});
it("keys the frontend cache by profile content and scheduling policy", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pgo-cache-"));
	try {
		const entrypoint = path.join(root, "input.mjs");
		writeFileSync(entrypoint, "export function f(x) { return x + 1; }");
		const input = pgoOptimizationInput(
			profile(construct("function f(x) { return x + 1; } globalThis.f=f;")),
		);
		const options = {
			entrypoint,
			config: resolveBuildConfig({}),
			cacheDirectory: path.join(root, "cache"),
			stripperIdentity: "none",
			stripTypes: (source: string) => source,
			pgo: input,
		};
		expect(compileBuildFrontend(options).cache).toBe("miss");
		expect(compileBuildFrontend({ ...options, pgo: { ...input } }).cache).toBe("hit");
		expect(
			compileBuildFrontend({ ...options, pgo: { ...input, digest: "c".repeat(64) } })
				.cache,
		).toBe("miss");
		expect(
			compileBuildFrontend({ ...options, pgo: { ...input, policy: "different-policy" } })
				.cache,
		).toBe("miss");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
