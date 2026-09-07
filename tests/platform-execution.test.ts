import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config-values.ts";
import { parseCliArgs } from "../src/cli.ts";
import type { BuildModuleGraphOptions } from "../src/compiler/frontend/module-graph.ts";
import { buildModuleGraph } from "../src/compiler/frontend/module-graph.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import {
	deserializeRuntimeImage,
	serializeRuntimeImage,
} from "../src/compiler/target/program-image-codec.ts";
import { executionTarget, resolveExecution } from "../src/platform/execution.ts";

const config = resolveBuildConfig({ engine: { regexp: false }, surface: { node: true } });
const parsedCommand = parseCliArgs(["build", "--production"]);
if (parsedCommand.kind !== "build") throw new Error("Expected build command");
const execution = resolveExecution(parsedCommand, config, {
	compiled: true,
	optimization: "full",
	target: executionTarget("aarch64-apple-darwin"),
});
const entry = path.resolve(".cache/platform-execution/entry.mjs");

function compile(
	source: string,
	optimization: "development" | "full" = "development",
	virtualModules?: BuildModuleGraphOptions["virtualModules"],
) {
	return compileEntrypoint(entry, {
		entrySource: source,
		entryGoal: "module",
		buildConfig: config,
		execution,
		virtualModules,
		optimization,
		coreVerification: "per-pass",
	}).runtime;
}

describe("catalog platform constants", () => {
	it("resolves the module without enabling a Maligator or Node surface", () => {
		const graph = buildModuleGraph(entry, {
			entrySource:
				'import { execution } from "maligator:process"; globalThis.context = execution;',
			entryGoal: "module",
			buildConfig: resolveBuildConfig({ surface: { maligator: false, node: false } }),
			execution,
		});
		expect(graph.modules.get("maligator:process")?.host?.constants?.execution).toEqual(
			execution,
		);
	});

	it.each(["development", "full"] as const)(
		"removes dead native imports after specialization in %s",
		(optimization) => {
			const result = compile(
				'import { execution } from "maligator:process"; import { spawn } from "node:child_process"; if (!execution.production) spawn("unused"); globalThis.answer = execution.command;',
				optimization,
			);
			expect(result.hostInstalls).toEqual([]);
			expect(
				result.functions
					.flatMap((fn) => fn.instructions)
					.some((instruction) => instruction.opcode === "LOAD_PROPERTY_STATIC"),
			).toBe(false);
		},
	);

	it("preserves the complete runtime snapshot when it escapes", () => {
		const result = compile(
			'import { execution } from "maligator:process"; globalThis.context = execution;',
		);
		expect(result.hostInstalls).toHaveLength(1);
		expect(result.hostInstalls[0]?.installer).toBe("mal_host_install_maligator_process");
	});

	it.each([
		'import "maligator:process"; globalThis.ok = 1;',
		'if (false) { const { execution } = await import("maligator:process"); globalThis.context = execution; }',
	])("eliminates platform imports without live export reads: %s", (source) => {
		expect(compile(source).hostInstalls).toEqual([]);
	});

	it("folds immutable destructuring and retains reachable effectful calls", () => {
		const result = compile(
			'import { execution as context } from "maligator:process"; import { spawn } from "node:child_process"; const { production } = context; if (production) spawn("retained");',
		);
		expect(result.hostInstalls.map((install) => install.installer)).toEqual([
			"mal_host_install_node_child_process",
		]);
	});

	it("does not treat an unknown property key as a known configuration read", () => {
		const result = compile(
			'import { execution } from "maligator:process"; globalThis.answer = execution[globalThis.key];',
		);
		expect(result.hostInstalls[0]?.installer).toBe("mal_host_install_maligator_process");
	});
	it("carries the escaped snapshot through the portable runtime format", () => {
		const runtime = compile(
			'import { execution } from "maligator:process"; globalThis.context = execution;',
		);
		const restored = deserializeRuntimeImage(serializeRuntimeImage(runtime));
		expect(restored.hostInstalls[0]?.exports[0]?.constant).toEqual(execution);
	});

	it.each(["development", "full"] as const)(
		"drops source module evaluation and native dependencies in %s",
		(optimization) => {
			const virtualModules = new Map([
				[
					"maligator:test",
					{
						source:
							'import { spawn } from "node:child_process"; export function test() { spawn("retained"); }',
						goal: "module" as const,
						platform: true,
					},
				],
			]);
			const dead = compile(
				'import { execution } from "maligator:process"; import { test } from "maligator:test"; if (!execution.production) test(); globalThis.ok = 1;',
				optimization,
				virtualModules,
			);
			expect(dead.hostInstalls).toEqual([]);
			expect(
				dead.functions
					.flatMap((fn) => fn.instructions)
					.some((instruction) => instruction.opcode === "CALL"),
			).toBe(false);
			const live = compile(
				'import { test } from "maligator:test"; test();',
				optimization,
				virtualModules,
			);
			expect(live.hostInstalls.map((install) => install.installer)).toContain(
				"mal_host_install_node_child_process",
			);
		},
	);

	it("preserves export resolution errors in unreachable source-module imports", () => {
		expect(() =>
			compile(
				'import { missing } from "maligator:test"; if (false) missing();',
				"development",
				new Map([
					[
						"maligator:test",
						{ source: "export function test() {}", goal: "module", platform: true },
					],
				]),
			),
		).toThrow("does not export");
	});

	it("specializes aliases across re-exports, namespace reads and switch cases", () => {
		const runtime = compile(
			'import * as ns from "context"; import { spawn } from "node:child_process"; const context = ns.execution; switch (context.command) { case "dev": spawn("dead"); }',
			"full",
			new Map([
				[
					"context",
					{ source: 'export { execution } from "maligator:process";', goal: "module" },
				],
			]),
		);
		expect(runtime.hostInstalls).toEqual([]);
	});

	it("keeps runtime identity comparisons for module namespace objects", () => {
		const runtime = compile(
			'import * as one from "maligator:process"; import * as two from "maligator:process"; globalThis.same = one === two;',
		);
		expect(
			runtime.functions
				.flatMap((fn) => fn.instructions)
				.some(
					(instruction) =>
						instruction.opcode === "BINARY" && instruction.operator === "===",
				),
		).toBe(true);
	});
	it("specializes typeof without a matching user string literal", () => {
		const runtime = compile(
			'import { execution } from "maligator:process"; globalThis.kind = typeof execution;',
		);
		expect(runtime.hostInstalls).toEqual([]);
		expect(
			runtime.stringConstants.map((units) => String.fromCharCode(...units)),
		).toContain("object");
	});
});
