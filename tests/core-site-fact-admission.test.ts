import { deepStrictEqual, equal, ok } from "node:assert";
import { describe, it } from "vitest";
import { attachCoreCompilerSiteFacts } from "../src/compiler/core/compiler-site-facts.ts";
import type { CoreCompilation } from "../src/compiler/core/core-compilation.ts";

function fixture() {
	const immutable = { marker: "immutable-binding" };
	const rows = [
		{ opcode: "move", attributes: {} },
		{ opcode: "binary", attributes: { operator: "+" } },
		{ opcode: "createObject", attributes: {} },
		{ opcode: "createObjectShaped", attributes: { keyStringIndices: [0] } },
		{ opcode: "loadIntrinsic", attributes: { intrinsic: "Math" } },
		{ opcode: "call", attributes: {} },
		{
			opcode: "call",
			attributes: { knownBuiltinCall: { identity: "builtin", semantics: "pure" } },
		},
		{ opcode: "call", attributes: { knownBuiltinCall: {} } },
		{ opcode: "loadGlobalProperty", attributes: { nameStringIndex: 0 } },
		{ opcode: "createArray", attributes: {} },
	];
	const fn = {
		id: 0,
		metadata: { sourcePath: "/source with spaces.js" },
		blockIds: () => [0],
		bodyInstructionIds: () => rows.map((_, index) => index),
		instructionOpcodeName: (instruction: number) => rows[instruction]!.opcode,
		instructionAttributes: (instruction: number) => rows[instruction]!.attributes,
		instructionSourcePosition: () => 0,
	};
	const compilation = {
		program: {
			functionIds: () => [0],
			function: () => fn,
			hasFunction: (id: number) => id === 0,
			sourcePositions: [{ line: 2, column: 4 }],
			stringConstants: [[77, 97, 116, 104]],
		},
		context: { facts: { immutableGlobalBindings: new Map([["Math", immutable]]) } },
		plan: {
			recipes: { count: 0 },
			directEntries: [{ function: 1, callSites: [{ caller: 0, instruction: 5 }] }],
		},
	} as unknown as CoreCompilation;
	return { compilation, immutable, rows };
}

describe("Residual site-fact admission", () => {
	it("keeps every fact-bearing category and omits ordinary arithmetic", () => {
		const { compilation, immutable } = fixture();
		const result = attachCoreCompilerSiteFacts(compilation);
		const sites = result.context.facts.sites;
		deepStrictEqual(
			[...sites.keys()],
			[
				"0:0:2:createObject",
				"0:0:3:createObjectShaped",
				"0:0:4:loadIntrinsic",
				"0:0:5:call",
				"0:0:6:call",
				"0:0:8:loadGlobalProperty",
				"0:0:9:createArray",
			],
		);
		equal(sites.get("0:0:4:loadIntrinsic")!.immutableBinding, immutable);
		equal(sites.get("0:0:8:loadGlobalProperty")!.immutableBinding, immutable);
		ok(sites.get("0:0:2:createObject")!.shape);
		ok(sites.get("0:0:3:createObjectShaped")!.representation);
		ok(sites.get("0:0:5:call")!.callTargets);
		ok(sites.get("0:0:6:call")!.builtinIdentity);
		for (const site of sites.values()) {
			equal(site.functionId, `${encodeURIComponent("/source with spaces.js")}#0`);
			ok(site.sourceSite);
		}
		equal(result.program, compilation.program);
	});

	it("does not reuse fact admission between independent invocations", () => {
		const f = fixture();
		equal(attachCoreCompilerSiteFacts(f.compilation).context.facts.sites.size, 7);
		f.rows[0]!.opcode = "createObject";
		equal(attachCoreCompilerSiteFacts(f.compilation).context.facts.sites.size, 8);
	});
});
