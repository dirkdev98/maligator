import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDerivationFromConfig, resolveBuildConfig } from "../../src/build-config.ts";
import {
	BuildCompilationSession,
	compileBuildFrontend,
} from "../../src/build-frontend-cache.ts";
import type { CompiledBuildFrontend } from "../../src/build-frontend-cache.ts";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
import { buildDevelopmentRunner } from "../../src/local-build.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "mal-development-assets-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const tree = path.join(root, "tree");
const entry = path.join(root, "entry.mjs");

describe("maligator:assets outside a build", () => {
	let frontend: CompiledBuildFrontend;
	let runner: string;

	beforeAll(() => {
		mkdirSync(path.join(tree, "empty"), { recursive: true });
		writeFileSync(path.join(tree, "keep.txt"), "keep");
		writeFileSync(path.join(tree, "empty/ignored.bin"), "renamed");
		writeFileSync(
			entry,
			`import { embedDirectory, embedFile } from "maligator:assets";
const content = embedDirectory("./tree", { include: ["**/*.txt"] });
const keep = embedFile("./tree/keep.txt");
const listing = content.files().map((file) => file.path + ":" + file.text()).join("|");
let missing = "present";
try { embedFile("./tree/missing.txt").text(); } catch (error) { missing = error.message; }
console.log([listing, keep.size, keep.materialize(), content.materialize(), missing].join("\\n"));
`,
		);
		const config = resolveBuildConfig({
			engine: { realms: false, intl: { enabled: false } },
		});
		const session = new BuildCompilationSession();
		const cacheDirectory = path.join(root, "cache");
		session.useCacheDirectory(cacheDirectory);
		frontend = compileBuildFrontend({
			entrypoint: entry,
			config,
			stripTypes: stripCompactTypes,
			stripperIdentity: "development-assets-test",
			cacheDirectory,
			session,
			optimization: "development",
			relocatable: true,
		});
		const derivation = buildDerivationFromConfig(config);
		runner = buildDevelopmentRunner(
			resolveNativeBuildContext({ features: derivation.features }),
			false,
			derivation.cacheSuffix,
		).binaryPath;
	});

	function observe(): Array<string> {
		const result = spawnSync(
			runner,
			[
				"--maligator-internal-run-wires",
				String(frontend.runtimeArtifacts.length),
				entry,
				...frontend.runtimeArtifacts.map((artifact) => artifact.path),
			],
			{ encoding: "utf8" },
		);
		expect(result.status, result.stderr).toBe(0);
		return result.stdout.trim().split("\n");
	}

	it("reads the declared files in place, with no snapshot", () => {
		const [listing, size, file, directory, missing] = observe();
		expect(listing).toBe("keep.txt:keep");
		expect(size).toBe("4");
		expect(file).toBe(path.join(tree, "keep.txt"));
		expect(directory).toBe(tree);
		expect(missing).toMatch(/cannot read '.*missing\.txt'/);
	});

	it("sees edits and membership changes without compiling again", () => {
		writeFileSync(path.join(tree, "keep.txt"), "edited");
		writeFileSync(path.join(tree, "empty/added.txt"), "added");
		expect(observe().slice(0, 2)).toEqual(["empty/added.txt:added|keep.txt:edited", "6"]);
		renameSync(
			path.join(tree, "empty/ignored.bin"),
			path.join(tree, "empty/renamed.txt"),
		);
		rmSync(path.join(tree, "empty/added.txt"));
		mkdirSync(path.join(tree, "new"));
		writeFileSync(path.join(tree, "new/child.txt"), "child");
		expect(observe()[0]).toBe(
			"empty/renamed.txt:renamed|keep.txt:edited|new/child.txt:child",
		);
	});
});
