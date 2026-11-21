import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as ts from "typescript-v6-api";
import { describe, expect, it } from "vitest";
import { PLATFORM_MODULES } from "../src/platform/catalog.ts";

function formatDiagnostics(diagnostics: ReadonlyArray<ts.Diagnostic>): string {
	return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
		getCanonicalFileName: (fileName) => fileName,
		getCurrentDirectory: () => process.cwd(),
		getNewLine: () => "\n",
	});
}

describe("@maligator/cli public TypeScript API", () => {
	it("types build configuration, embedded assets, and HTTP serving in a consumer project", () => {
		const project = mkdtempSync(path.join(os.tmpdir(), "maligator-public-types-"));
		try {
			const packageDirectory = path.join(project, "node_modules/@maligator/cli");
			const sourceDirectory = path.join(project, "src");
			mkdirSync(packageDirectory, { recursive: true });
			mkdirSync(sourceDirectory);
			for (const dependency of ["@types/node", "undici-types"]) {
				const target = path.join(project, "node_modules", dependency);
				mkdirSync(path.dirname(target), { recursive: true });
				symlinkSync(
					path.resolve(import.meta.dirname, "../node_modules", dependency),
					target,
				);
			}
			copyFileSync(
				path.resolve(import.meta.dirname, "../src/public-api.d.ts"),
				path.join(packageDirectory, "index.d.ts"),
			);
			for (const declaration of [
				"platform-api.d.ts",
				...PLATFORM_MODULES.map((module) => module.declarationFile),
			]) {
				copyFileSync(
					path.resolve(import.meta.dirname, "../src", declaration),
					path.join(packageDirectory, declaration),
				);
			}
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
	engine: { primordials: "mutable", intl: { enabled: true, features: ["number-format"] } },

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
				`import { embedDirectory, embedFile } from "maligator:assets";
import { serve, serveAsset } from "maligator:http";
import type { Handler, Server, ServeOptions } from "maligator:http";
import type { EmbeddedDirectory, EmbeddedFile, MaterializeOptions } from "maligator:assets";
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
import { file, FileSystemError } from "maligator:fs";
import type { DiskFile, FileStat } from "maligator:fs";
import { createPool, createWorkerUrl, transfer, Worker } from "maligator:workers";
import type { TaskContext, TransferResult } from "maligator:workers";
// @ts-expect-error Internal modules are reserved for platform sources.
import { fetch } from "maligator:internal/fetch";
// @ts-expect-error Internal modules are reserved for platform sources.
import { read } from "maligator:internal/fs";
// @ts-expect-error Internal modules are reserved for platform sources.
import { listen } from "maligator:internal/http";
// @ts-expect-error Internal modules are reserved for platform sources.
import { parentPort } from "maligator:internal/workers";
void [fetch, listen, parentPort, read];

const timeout: NodeJS.Timeout = setTimeout(() => undefined, 20);
timeout.unref();
clearTimeout(+timeout);
const response: Promise<Response> = fetch("https://example.com", { duplex: "half" });
void response;
// @ts-expect-error The server runtime has no browser document.
document.createElement("div");

const settings: DiskFile = file(new URL("file:///etc/settings.json"));
const settingsBytes: Promise<Uint8Array<ArrayBuffer>> = settings.bytes();
const settingsStat: Promise<FileStat> = settings.stat({ followSymlinks: false });
const written: Promise<number> = file("out.bin").write(new Uint8Array(2), { atomic: true });
const copied: Promise<void> = settings.copyTo(file("copy.json"), { overwrite: true });
// @ts-expect-error Appending has no atomic mode.
file("log.txt").append("line", { atomic: true });
// @ts-expect-error Reads are asynchronous, unlike embedded files.
const syncText: string = settings.text();
// @ts-expect-error Handles describe a path; their media type is fixed.
settings.type = "text/plain";
void [settingsBytes, settingsStat, written, copied, syncText];
settings.json().catch((error: unknown) => {
	if (error instanceof FileSystemError) {
		const failure: { code: string; syscall: string; path: string; destination?: string } = error;
		void failure;
	}
});

type Jobs = {
	sum(context: TaskContext, left: number, right: number): number;
	bytes(context: TaskContext): Promise<TransferResult<Uint8Array>>;
	constant: number;
};
const workerEntry = createWorkerUrl<Jobs>("./jobs.ts", import.meta.url);
const pool = createPool(workerEntry, { size: 2, maxQueuedTasks: 8 });
const sum: Promise<number> = pool.run("sum", [1, 2]);
const bytes: Promise<Uint8Array> = pool.run("bytes", []);
const ordered: AsyncIterable<number> = pool.map("sum", [[1, 2], [3, 4]]);
const envelope: TransferResult<Uint8Array> = transfer(new Uint8Array(4), []);
// @ts-expect-error Pool tasks require callable context-first exports.
pool.run("constant", []);
// @ts-expect-error The declared task determines its argument tuple.
pool.run("sum", ["1", 2]);
// @ts-expect-error A transferred result unwraps its value in the returned promise.
const wrongResult: Promise<string> = pool.run("bytes", []);
const worker = new Worker<number, string>(workerEntry);
worker.port.onmessage = (event) => {
	event.data.toUpperCase();
	// @ts-expect-error The receive type controls the event's data.
	event.data.toFixed();
};
worker.port.postMessage(3);
// @ts-expect-error The send side retains its declared message type.
worker.port.postMessage("3");
void [sum, bytes, ordered, envelope, wrongResult];

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

const templates: EmbeddedDirectory = embedDirectory("../templates", {
	include: ["**/*.html"],
	exclude: ["drafts/**"],
	dot: false,
});
const materializeOptions: MaterializeOptions = { baseDirectory: ".cache/application" };
const assetPath: string = templates.materialize(materializeOptions);
const home: EmbeddedFile | undefined = templates.get("home.html");
const logo = embedFile("../logo.png");
const logoBytes: Uint8Array<ArrayBuffer> = logo.bytes();
const logoMeta: [string, number, string, string] = [logo.path, logo.size, logo.digest, logo.type];
// @ts-expect-error Directory patterns do not apply to a file.
embedFile("../logo.png", { include: ["*"] });
const frontend = embedDirectory("../web/dist", {
	build: { command: ["npm", "run", "build"], cwd: "../web" },
	watch: { command: ["npm", "run", "dev"], cwd: "../web", url: "http://127.0.0.1:5173" },
	use: { run: "watch", test: "existing" },
});
// @ts-expect-error A build embeds files, so it cannot use a watcher.
embedDirectory("../web/dist", { use: { build: "watch" } });
// @ts-expect-error Directory patterns are strings.
embedDirectory("../templates", { include: [1] });
// @ts-expect-error The legacy configured-asset global is gone.
mal.assets;
const serveOptions: ServeOptions = {
	hostname: "127.0.0.1",
	port: 3000,
	headersTimeout: 60000,
	requestTimeout: 300000,
	keepAliveTimeout: 5000,
	maxConnections: 1024,
	async fetch(request) {
		return new Response(request.url);
	},
	error: (error) => new Response(String(error), { status: 500 }),
};
const server: Server = serve(serveOptions);
const port: number = server.port;
const closed: Promise<void> = server.close();
const files: Handler = serveAsset(templates, { prefix: "/templates", fallback: "home.html" });
// @ts-expect-error serveAsset takes a declared asset handle.
serveAsset("../templates");
void closed;
console.log(assetPath, home?.text(), logoBytes, logoMeta, frontend, files, port);
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
			const checker = program.getTypeChecker();
			const entry = program.getSourceFile(entryPath)!;
			let poolSymbol: ts.Symbol | undefined;
			const visit = (node: ts.Node): void => {
				if (ts.isImportSpecifier(node) && node.name.text === "createPool") {
					poolSymbol = checker.getAliasedSymbol(checker.getSymbolAtLocation(node.name)!);
				}
				ts.forEachChild(node, visit);
			};
			visit(entry);
			expect(
				ts.displayPartsToString(poolSymbol!.getDocumentationComment(checker)),
			).not.toBe("");
			const tags = poolSymbol!.getJsDocTags(checker);
			expect(ts.displayPartsToString(tags.find((tag) => tag.name === "see")?.text)).toBe(
				"https://maligator.ddv.tools/api/workers#createPool",
			);
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	});
});
