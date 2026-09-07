import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { analyzeEntrypoint } from "../src/compiler/pipeline/compile-program-common.ts";
import { compileExplorer, compileExplorerRequest } from "../src/explorer/api.ts";
import type { ExplorerResponse } from "../src/explorer/api.ts";
import { compileExplorerCore } from "../src/explorer/compiler.ts";
import {
	EXPLORER_LIMITS,
	EXPLORER_SCHEMA,
	explorerBuildConfig,
	normalizeExplorerConfig,
	utf8ByteLength,
} from "../src/explorer/config.ts";
import { SAMPLES } from "../src/explorer/samples.ts";

function request(
	source: string,
	config: unknown = {},
	language: unknown = "javascript",
): ExplorerResponse {
	return JSON.parse(
		compileExplorerRequest(
			JSON.stringify({ schema: EXPLORER_SCHEMA, source, config, language }),
		),
	) as ExplorerResponse;
}

describe("explorer compilation", () => {
	it("compiles every builtin through both lowerings without executing source", () => {
		for (const sample of SAMPLES) {
			const result = compileExplorer(sample.source, sample.config ?? {}, sample.language);
			expect(result.modes.generic.optimizedCore).toBe(result.modes.full.optimizedCore);
			expect(result.modes.full.stats.functions).toBeGreaterThan(0);
			expect(result.modes.full.wire.slice(0, 4)).toEqual([77, 65, 76, 87]);
		}
		expect(request('throw new Error("must not execute"); for (;;) {}').ok).toBe(true);
	});

	it("strips erasable TypeScript before the ordinary compiler and keeps JavaScript strict", () => {
		const source =
			'import type { Point } from "unavailable";\ninterface Shape { x: number }\nconst point = { x: 42 } satisfies Shape;\nglobalThis.answer = point.x;';
		const typed = compileExplorer(source, {}, "typescript");
		expect(typed.language).toBe("typescript");
		expect(typed.strippedSource.split("\n")).toHaveLength(source.split("\n").length);
		expect(typed.strippedSource.indexOf("globalThis.answer")).toBe(
			source.indexOf("globalThis.answer"),
		);
		expect(runInNewContext(`${typed.strippedSource}\nglobalThis.answer`)).toBe(42);
		expect(request(source)).toMatchObject({ ok: false, category: "syntax" });
		for (const invalid of [
			"enum Color { Red }",
			"class Point { constructor(public x: number) {} }",
			'import { value } from "missing"; globalThis.x = value;',
		]) {
			expect(request(invalid, {}, "typescript")).toMatchObject({
				ok: false,
				category: "syntax",
			});
		}
		expect(
			request("const answer: number = 42; globalThis.answer = answer", {}, "typescript")
				.ok,
		).toBe(true);
		expect(request("0", {}, "tsx")).toMatchObject({ ok: false });
	});

	it("uses the ordinary build policies and closure facts for each eval mode", () => {
		for (const evalMode of [true, false, "compile-check"] as const) {
			const source = 'globalThis.answer = eval("40 + 2")';
			const config = normalizeExplorerConfig({ eval: evalMode });
			const ordinary = () =>
				analyzeEntrypoint(
					"output-explorer/snippet.js",
					{
						entrySource: source,
						entryGoal: "module",
						buildConfig: explorerBuildConfig(config),
					},
					(_phase, run) => run(),
				);
			if (evalMode === "compile-check") {
				expect(ordinary).toThrow(/dynamic code is rejected/);
				expect(() => compileExplorerCore(source, config)).toThrow(
					/dynamic code is rejected/,
				);
			} else {
				const actual = compileExplorerCore(source, config).facts;
				const expected = ordinary().facts!;
				expect(actual.world).toEqual(expected.world);
				expect(actual.closure.openings).toEqual(expected.closure.openings);
				expect(actual.closure.sourceClosure.kind).toBe(
					expected.closure.sourceClosure.kind,
				);
			}
		}
	});

	it("gates RegExp and primordial mutations using the selected policy", () => {
		expect(request("globalThis.re = /x/")).toMatchObject({
			ok: false,
			category: "compile",
		});
		expect(request("globalThis.re = /x/", { regexp: true }).ok).toBe(true);
		expect(compileExplorer("Math.abs = () => 1").diagnostics).toContainEqual(
			expect.objectContaining({ code: "primordial.mutation" }),
		);
		expect(
			compileExplorer("Math.abs = () => 1", { primordials: "mutable" }).diagnostics,
		).toEqual([]);
	});

	it("preserves effective feature settings and deterministic output", () => {
		const source = 'globalThis.value = ["café 🐊", Intl, Temporal]';
		const config = {
			intl: true,
			temporal: true,
			realms: true,
			webPlatform: true,
			node: true,
			maligator: true,
		};
		const first = request(source, config);
		expect(first).toMatchObject({
			ok: true,
			result: {
				config,
				world: { ecmaFeatures: { intl: true, temporal: true } },
			},
		});
		expect(request(source, config)).toEqual(first);
	});

	it("reports syntax and unsupported dependencies then accepts a valid module", () => {
		for (const source of [
			"function {",
			'import "x"',
			'import("x")',
			'export * from "x"',
		]) {
			expect(request(source)).toMatchObject({ ok: false, category: "syntax" });
		}
		expect(request("export const answer = 42").ok).toBe(true);
	});

	it("bounds UTF-8 input and rejects malformed configuration and protocol", () => {
		expect(utf8ByteLength("aé🐊\ud800")).toBe(Buffer.byteLength("aé🐊\ud800"));
		expect(request(`"${"🐊".repeat(EXPLORER_LIMITS.sourceBytes / 4)}"`)).toMatchObject({
			ok: false,
			category: "limit",
		});
		expect(request("0", { intl: { enabled: true } })).toMatchObject({
			ok: false,
		});
		expect(request("0", { assets: {} })).toMatchObject({ ok: false });
		expect(JSON.parse(compileExplorerRequest('{"schema":2}'))).toMatchObject({
			ok: false,
		});
	});
});
