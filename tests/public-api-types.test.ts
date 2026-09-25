import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as ts from "typescript-v6-api";
import { describe, expect, it } from "vitest";

function formatDiagnostics(diagnostics: ReadonlyArray<ts.Diagnostic>): string {
	return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
		getCanonicalFileName: (fileName) => fileName,
		getCurrentDirectory: () => process.cwd(),
		getNewLine: () => "\n",
	});
}

describe("@maligator/cli public TypeScript API", () => {
	it("types build configuration, assets, and Mal.serve in a consumer project", () => {
		const project = mkdtempSync(path.join(os.tmpdir(), "maligator-public-types-"));
		const packageDirectory = path.join(project, "node_modules/@maligator/cli");
		const sourceDirectory = path.join(project, "src");
		mkdirSync(packageDirectory, { recursive: true });
		mkdirSync(sourceDirectory);
		copyFileSync(
			path.resolve(import.meta.dirname, "../src/public-api.d.ts"),
			path.join(packageDirectory, "index.d.ts"),
		);
		copyFileSync(
			path.resolve(import.meta.dirname, "../src/test-api.d.ts"),
			path.join(packageDirectory, "test-api.d.ts"),
		);
		copyFileSync(
			path.resolve(import.meta.dirname, "../src/platform-api.d.ts"),
			path.join(packageDirectory, "platform-api.d.ts"),
		);
		copyFileSync(
			path.resolve(import.meta.dirname, "../src/process-api.d.ts"),
			path.join(packageDirectory, "process-api.d.ts"),
		);
		copyFileSync(
			path.resolve(import.meta.dirname, "../npm/cli/index.js"),
			path.join(packageDirectory, "index.js"),
		);
		writeFileSync(
			path.join(packageDirectory, "package.json"),
			JSON.stringify({
				name: "@maligator/cli",
				version: "0.1.0-alpha.2",
				type: "module",
				types: "./index.d.ts",
				exports: {
					".": {
						types: "./index.d.ts",
						import: "./index.js",
					},
				},
			}),
		);
		writeFileSync(
			path.join(project, "package.json"),
			JSON.stringify({ name: "consumer", private: true, type: "module" }),
		);
		const configPath = path.join(project, "maligator.build.ts");
		writeFileSync(
			configPath,
			`import { defineBuild } from "@maligator/cli";

export default defineBuild({
	entry: "src/index.ts",
	assets: {
		templates: { type: "directory", path: "templates", include: ["**/*.html"] },
	},
	engine: { primordials: "mutable", intl: { enabled: true, features: ["number-format"] } },
	surface: { webPlatform: true, maligator: true },
});

defineBuild({
	engine: {
		intl: {
			features: [
				// @ts-expect-error Unsupported Intl services must be rejected.
				"not-an-intl-service",
			],
		},
	},
});

defineBuild({
	engine: {
		// @ts-expect-error Primordial policy is a closed public union.
		primordials: "frozen",
	},
});
`,
		);
		const entryPath = path.join(sourceDirectory, "index.ts");
		writeFileSync(
			entryPath,
			`import type {
	MaligatorMaterializeOptions,
	MaligatorServeOptions,
	MaligatorServer,
} from "@maligator/cli";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "maligator:test";
import { execution } from "maligator:process";

const command: "build" | "run" | "dev" | "test" = execution.command;
const compiled: boolean = execution.compiled;
if (execution.command === "test") {
	const repeat: number = execution.options.repeat;
	const seed: number | null = execution.options.shuffleSeed;
	void [repeat, seed];
} else {
	// @ts-expect-error Test options exist only for the test command.
	execution.options.repeat;
}
// @ts-expect-error Execution snapshots are deeply readonly.
execution.config.engine.intl.features.push("collator");
// @ts-expect-error Runtime process arguments are not preparation constants.
execution.argv;
void [command, compiled];

describe("public types", () => {
	beforeAll(() => undefined);
	beforeEach(async () => Promise.resolve());
	afterEach(() => undefined);
	afterAll(async () => Promise.resolve());
	test("supports matchers", async () => {
		expect({ answer: 42 }).toMatchObject({ answer: expect.any(Number) });
		expect(["router", 42]).toEqual([
			expect.stringMatching(/^route/),
			expect.anything(),
		]);
		expect({ answer: 42, nested: true }).toEqual(
			expect.objectContaining({ answer: 42 }),
		);
		expect([1, 2, 3]).toEqual(expect.arrayContaining([2, 1]));
		expect(undefined).not.toBeDefined();
		await expect(Promise.resolve(42)).resolves.toBe(42);
		await expect(Promise.reject(new Error("expected"))).rejects.toThrow("expected");
	});
	test.skip("skipped", () => undefined);
	test.todo("future");
	test.each([
		[1, 2, 3],
		[2, 3, 5],
	] as const)("adds row %#", (left, right, total) => {
		expect(left + right).toBe(total);
	});
});

describe.skip("skipped suite", () => undefined);
describe.only("focused suite", () => {
	test.only("focused test", () => undefined);
});

const materializeOptions: MaligatorMaterializeOptions = {
	baseDirectory: ".cache/application",
};
const assetPath: string = mal.assets.materialize("templates", materializeOptions);
const globalAssetPath: string = globalThis.mal.assets.materialize("templates");
const serveOptions: MaligatorServeOptions = {
	hostname: "127.0.0.1",
	port: 3000,
	async fetch(request) {
		return new Response(request.url);
	},
};
const server: MaligatorServer = Mal.serve(serveOptions);
const port: number = server.port;
console.log(assetPath, globalAssetPath, port);
`,
		);

		const program = ts.createProgram({
			rootNames: [configPath, entryPath],
			options: {
				strict: true,
				noEmit: true,
				target: ts.ScriptTarget.ESNext,
				module: ts.ModuleKind.NodeNext,
				moduleResolution: ts.ModuleResolutionKind.NodeNext,
				lib: ["lib.esnext.d.ts"],
			},
		});
		const diagnostics = ts.getPreEmitDiagnostics(program);
		expect(formatDiagnostics(diagnostics)).toBe("");
	});
});
