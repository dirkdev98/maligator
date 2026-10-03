import { expect, test } from "vitest";
import { planModuleEvaluation } from "../src/compiler/frontend/module-evaluation-plan.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import {
	deserializeRuntimeImage,
	serializeRuntimeImage,
} from "../src/compiler/target/program-image-codec.ts";

test("async evaluation propagates through a static cycle and its parents but not independent modules", () => {
	const plan = planModuleEvaluation([
		{ path: "entry", dependencies: ["a", "sync"], hasAwait: false },
		{ path: "a", dependencies: ["b"], hasAwait: false },
		{ path: "b", dependencies: ["a"], hasAwait: true },
		{ path: "sync", dependencies: [], hasAwait: false },
	]);
	expect([...plan.asynchronous].sort()).toEqual(["a", "b", "entry"]);
});

test.each(["development", "full"] as const)(
	"async module graphs and CommonJS candidates survive %s verification and wire roundtrip",
	(optimization) => {
		const image = compileEntrypoint("tests/fixtures/module-evaluation/entry.mjs", {
			optimization,
			coreVerification: "per-pass",
		});
		const restored = deserializeRuntimeImage(serializeRuntimeImage(image.runtime));
		expect(restored.entrypointPath).toBe(image.runtime.entrypointPath);
		expect(restored.cjsModuleFunctionIndices).toHaveLength(2);
		expect(restored.functions[0]!.isAsync).toBe(true);
	},
);

test.each([
	["rejection-order", true],
	["ancestor-order", true],
	["sync-self", false],
	["deferred-entry", true],
	["for-await-entry", true],
] as const)(
	"%s retains its startup completion contract through Core and wire",
	(fixture, asynchronous) => {
		const image = compileEntrypoint(`tests/fixtures/module-evaluation/${fixture}.mjs`, {
			optimization: "development",
			coreVerification: "per-pass",
		});
		const restored = deserializeRuntimeImage(serializeRuntimeImage(image.runtime));
		expect(restored.functions[0]!.isAsync).toBe(asynchronous);
	},
);
