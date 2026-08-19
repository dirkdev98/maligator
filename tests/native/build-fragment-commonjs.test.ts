import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { buildDerivationFromConfig } from "../../src/build-config.ts";
import { compileBuildFrontend } from "../../src/build-frontend-cache.ts";
import { stripCompactTypes } from "../../src/compact-type-strip.ts";
import { buildDevelopmentRunner } from "../../src/local-build.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";

const roots: Array<string> = [];

afterAll(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(file: string, source: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, source);
}

describe("relocatable build CommonJS boundary", () => {
	it("preserves named properties through a CommonJS forwarding entry", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "mal-build-cjs-fragment-"));
		roots.push(root);
		const packageRoot = path.join(root, "node_modules/forwarded-commonjs");
		const entrypoint = path.join(root, "entry.mjs");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(
			path.join(packageRoot, "package.json"),
			`{"type":"commonjs","exports":"./index.cjs"}\n`,
		);
		write(
			path.join(packageRoot, "index.cjs"),
			`module.exports = require("./impl.cjs");\n`,
		);
		write(
			path.join(packageRoot, "impl.cjs"),
			`function factory() {}\nfactory.Router = function Router() {};\nmodule.exports = factory;\n`,
		);
		write(
			entrypoint,
			`import factory, { Router } from "forwarded-commonjs";\nconsole.log(typeof factory, typeof Router, Router === factory.Router);\n`,
		);

		const config = resolveBuildConfig({
			engine: { realms: false, intl: { enabled: false } },
			surface: { webPlatform: false },
		});
		const frontend = compileBuildFrontend({
			entrypoint,
			config,
			stripTypes: stripCompactTypes,
			stripperIdentity: "build-cjs-fragment-regression",
			cacheDirectory: path.join(root, "cache"),
			optimization: "development",
			relocatable: true,
		});
		expect(frontend.wires).toHaveLength(2);
		const wirePaths = frontend.wires!.map((wire, index) => {
			const wirePath = path.join(root, `${index}.malw`);
			writeFileSync(wirePath, wire);
			return wirePath;
		});

		const derivation = buildDerivationFromConfig(config);
		const runner = buildDevelopmentRunner(
			resolveNativeBuildContext({ features: derivation.features }),
			false,
			derivation.cacheSuffix,
		).binaryPath;
		const result = spawnSync(
			runner,
			[
				"--maligator-internal-run-wires",
				String(wirePaths.length),
				entrypoint,
				...wirePaths,
			],
			{ encoding: "utf-8" },
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe("function function true");
	}, 120_000);
});
