import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { buildDerivationFromConfig } from "../../src/build-config.ts";
import { compileBuildFrontend } from "../../src/build-frontend-cache.ts";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
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

/** A project whose CommonJS and ES packages report where they are installed. */
function locatedProject(directory: string): string {
	write(path.join(directory, "package.json"), `{"type":"module"}\n`);
	const commonjs = path.join(directory, "node_modules/located-commonjs");
	write(path.join(commonjs, "package.json"), `{"main":"./index.js"}\n`);
	write(
		path.join(commonjs, "index.js"),
		`const parts = __dirname.split("/");
let missing;
try { require("./missing.js"); } catch (error) { missing = error.message.split("\\n").at(-1); }
module.exports = { dirname: __dirname, filename: __filename, length: __dirname.length, depth: parts.length, missing };
`,
	);
	const esm = path.join(directory, "node_modules/located-esm");
	write(path.join(esm, "package.json"), `{"type":"module","exports":"./index.js"}\n`);
	write(
		path.join(esm, "index.js"),
		`export const url = import.meta.url;\nexport const urlLength = import.meta.url.length;\n`,
	);
	const entrypoint = path.join(directory, "entry.mjs");
	write(
		entrypoint,
		`import commonjs from "located-commonjs";\nimport { url, urlLength } from "located-esm";\nconsole.log(JSON.stringify({ ...commonjs, url, urlLength }));\n`,
	);
	return entrypoint;
}

describe("dependency images across project locations", () => {
	it("runs a dependency image compiled at another location as installed here", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "mal-located-dependencies-"));
		roots.push(root);
		const config = resolveBuildConfig({ surface: { node: true } });
		const derivation = buildDerivationFromConfig(config);
		const runner = buildDevelopmentRunner(
			resolveNativeBuildContext({ features: derivation.features }),
			false,
			derivation.cacheSuffix,
		).binaryPath;
		const run = (project: string) => {
			const entrypoint = locatedProject(path.join(root, project));
			const frontend = compileBuildFrontend({
				entrypoint,
				config,
				stripTypes: stripCompactTypes,
				stripperIdentity: "located-dependency-regression",
				cacheDirectory: path.join(root, "cache"),
				optimization: "development",
				relocatable: true,
				interpreted: true,
			});
			const wirePaths = frontend.runtimeArtifacts.map((artifact) => artifact.path);
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
			return {
				fragments: frontend.fragmentArtifacts,
				output: JSON.parse(result.stdout) as unknown,
			};
		};
		const installedAt = (project: string) => {
			const commonjs = path.join(root, project, "node_modules/located-commonjs");
			const url = pathToFileURL(
				path.join(root, project, "node_modules/located-esm/index.js"),
			).href;
			return {
				dirname: commonjs,
				filename: path.join(commonjs, "index.js"),
				length: commonjs.length,
				depth: commonjs.split("/").length,
				missing: `- ${path.join(commonjs, "index.js")}`,
				url,
				urlLength: url.length,
			};
		};

		const first = run("first");
		const second = run("second-location");

		expect(first.output).toEqual(installedAt("first"));
		expect(second.fragments).toEqual({ hits: 2, misses: 2 });
		expect(second.output).toEqual(installedAt("second-location"));
	}, 120_000);
});
