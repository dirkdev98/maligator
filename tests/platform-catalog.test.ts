import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config-values.ts";
import { parseCliArgs } from "../src/cli.ts";
import { lookupPlatformModule, validatePlatformValue } from "../src/platform/catalog.ts";
import {
	executionData,
	executionIdentity,
	executionTarget,
	resolveExecution,
} from "../src/platform/execution.ts";
import {
	generatePlatformDeclarations,
	generatePlatformReference,
} from "../src/platform/generate.ts";

const plan = {
	compiled: true,
	optimization: "full" as const,
	target: executionTarget("aarch64-apple-darwin"),
};

function command(args: Array<string>) {
	const result = parseCliArgs(args);
	if (
		result.kind !== "build" &&
		result.kind !== "run" &&
		result.kind !== "dev" &&
		result.kind !== "test"
	)
		throw new Error("Expected application command");
	return result;
}

describe("platform execution catalog", () => {
	it("keeps profiling independent of explicit production intent", () => {
		const config = resolveBuildConfig({});
		const profiled = resolveExecution(command(["build", "--profile"]), config, plan);
		expect(profiled.production).toBe(false);
		expect(profiled.options.profile).toBe("sampling");
		expect(
			resolveExecution(command(["build", "--production", "--profile"]), config, plan)
				.production,
		).toBe(true);
		expect(
			resolveExecution(command(["dev", "--profile=compiler"]), config, plan),
		).toMatchObject({
			command: "dev",
			production: false,
			compiled: true,
			options: { profile: "compiler" },
		});
	});

	it("snapshots configuration without freezing caller-owned state", () => {
		const config = resolveBuildConfig({ modules: { aliases: { source: "original" } } });
		const snapshot = resolveExecution(command(["run"]), config, {
			...plan,
			compiled: false,
		});
		config.modules.aliases.source = "changed";
		expect(snapshot.config.modules.aliases.source).toBe("original");
		expect(Object.isFrozen(snapshot.config.engine.intl.features)).toBe(true);
		expect(Object.isFrozen(snapshot.config.modules.aliases)).toBe(true);
		expect(Reflect.set(snapshot, "compiled", true)).toBe(false);
		expect(snapshot.compiled).toBe(false);
	});

	it("normalizes test defaults and requires one selected shuffle seed", () => {
		const config = resolveBuildConfig({});
		expect(resolveExecution(command(["test"]), config, plan).options).toEqual({
			profile: "none",
			nameFilter: null,
			repeat: 1,
			bail: false,
			timeoutMs: 5000,
			shuffleSeed: null,
		});
		expect(() => resolveExecution(command(["test", "--shuffle"]), config, plan)).toThrow(
			"shuffle seed",
		);
		const snapshot = resolveExecution(
			command(["test", "--shuffle", "--repeat", "2", "--bail"]),
			config,
			plan,
			42,
		);
		expect(snapshot.options).toMatchObject({ shuffleSeed: 42, repeat: 2, bail: true });
	});

	it("keys contexts by semantic inputs rather than config insertion order or argv", () => {
		const first = resolveExecution(
			command(["run", "--", "one"]),
			resolveBuildConfig({ modules: { aliases: { a: "x", b: "y" } } }),
			plan,
		);
		const reordered = resolveExecution(
			command(["run", "--", "two"]),
			resolveBuildConfig({ modules: { aliases: { b: "y", a: "x" } } }),
			plan,
		);
		expect(executionIdentity(first)).toBe(executionIdentity(reordered));
		expect(executionIdentity({ ...first, compiled: false })).not.toBe(
			executionIdentity(first),
		);
		expect(
			executionIdentity({
				...first,
				target: executionTarget("x86_64-unknown-linux-gnu"),
			}),
		).not.toBe(executionIdentity(first));
	});

	it("validates provider values against the documented schema", () => {
		const platform = lookupPlatformModule("maligator:process")!;
		const snapshot = resolveExecution(command(["test"]), resolveBuildConfig({}), plan);
		expect(
			validatePlatformValue(platform, platform.exports[0]!.type, executionData(snapshot)),
		).toBe(true);
		expect(
			validatePlatformValue(platform, platform.exports[0]!.type, {
				...snapshot,
				command: "doctor",
			}),
		).toBe(false);
		expect(
			validatePlatformValue(platform, platform.exports[0]!.type, {
				...snapshot,
				options: {},
			}),
		).toBe(false);
	});

	it("generates declarations and HTML from the same public contracts", () => {
		const platform = lookupPlatformModule("maligator:process")!;
		const declarations = generatePlatformDeclarations(platform);
		const reference = generatePlatformReference(platform);
		expect(declarations).toContain('declare module "maligator:process"');
		expect(declarations).toContain("export const execution: Execution;");
		expect(reference).toContain("nameFilter");
		expect(reference).toContain('&lt;reference types="@maligator/cli" /&gt;');
	});
});
