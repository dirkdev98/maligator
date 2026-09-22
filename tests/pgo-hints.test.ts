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
		schema: 1,
		semantics: 1,
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
	};
}
it("matches exact revisions and leaves generator bodies and copied calls unknown", () => {
	const source =
		"function f(cb) { return cb(1); } function* g() { yield 2; } globalThis.f=f; globalThis.g=g;";
	const core = construct(source);
	const input = pgoOptimizationInput(profile(core));
	const hints = input.bind(core);
	const f = [...core.program.functionIds()].find(
		(id) => core.program.function(id).parameterCount === 1,
	)!;
	const fn = core.program.function(f);
	const call = [...fn.instructionIds()].find(
		(id) =>
			fn.instructionKind(id) === "operation" && fn.instructionOpcodeName(id) === "call",
	)!;
	expect(hints.functionEntries(f)).toBe(5);
	expect(hints.callAttempts(f, call)).toBe(7);
	const generator = [...core.program.functionIds()].find(
		(id) => core.program.function(id).isGenerator,
	)!;
	expect(hints.functionEntries(generator)).toBeUndefined();
	const changed = construct(source.replace("cb(1)", "cb(2)"));
	expect(input.bind(changed).functionEntries(f)).toBeUndefined();
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
