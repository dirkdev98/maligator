import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config-values.ts";
import { compileBuildFrontend } from "../src/build-frontend-cache.ts";
import { parseCliArgs } from "../src/cli.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { deserializeRuntimeImage } from "../src/compiler/target/program-image-codec.ts";
import { executionTarget, resolveExecution } from "../src/platform/execution.ts";

const config = resolveBuildConfig({ engine: { regexp: false } });
const command = parseCliArgs(["run"]);
if (command.kind !== "run") throw new Error("Expected run command");
const context = (compiled: boolean) =>
	resolveExecution(command, config, {
		compiled,
		optimization: "development",
		target: executionTarget("aarch64-apple-darwin"),
	});

it.each([false, true])(
	"keys whole images and dependency fragments by execution, relocatable=%s",
	(relocatable) => {
		const root = mkdtempSync(path.join(os.tmpdir(), "mal-platform-cache-"));
		try {
			const dependency = path.join(root, "node_modules/platform-library");
			mkdirSync(dependency, { recursive: true });
			writeFileSync(
				path.join(dependency, "package.json"),
				'{"type":"module","exports":"./index.mjs"}',
			);
			writeFileSync(
				path.join(dependency, "index.mjs"),
				'export { execution } from "maligator:process";',
			);
			const entrypoint = path.join(root, "entry.mjs");
			writeFileSync(
				entrypoint,
				'import { execution } from "platform-library"; globalThis.snapshot = execution;',
			);
			const options = {
				entrypoint,
				config,
				stripTypes: stripCompactTypes,
				stripperIdentity: "platform-cache-test",
				cacheDirectory: path.join(root, "cache"),
				optimization: "development" as const,
				relocatable,
			};
			for (const compiled of [false, true]) {
				const execution = context(compiled);
				const first = compileBuildFrontend({ ...options, execution });
				const second = compileBuildFrontend({ ...options, execution });
				expect(first.cache).toBe("miss");
				expect(second.cache).toBe("hit");
				if (relocatable) expect(first.wires?.length).toBeGreaterThan(1);
				const exports = (first.wires ?? [first.wire]).flatMap((wire) =>
					deserializeRuntimeImage(wire).hostInstalls.flatMap(
						(install) => install.exports,
					),
				);
				expect(
					exports
						.filter((entry) => entry.name === "execution")
						.map((entry) => entry.constant),
				).toEqual([execution]);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
