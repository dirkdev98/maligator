import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config-values.ts";
import { parseCliArgs } from "../src/cli.ts";
import { buildModuleGraph } from "../src/compiler/frontend/module-graph.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
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

function compile(source: string, optimization: "development" | "full" = "development") {
	return compileEntrypoint(entry, {
		entrySource: source,
		entryGoal: "module",
		buildConfig: config,
		execution,
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
});
