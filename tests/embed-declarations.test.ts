import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { embedDeclarationsOf } from "../src/assets.ts";
import { resolveBuildConfig } from "../src/build-config.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { transformEmbedDeclarations } from "../src/compiler/frontend/embed-declarations.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";

const root = mkdtempSync(path.join(tmpdir(), "mal-embed-declarations-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let fixtures = 0;
function declarationsOf(
	source: string,
	files: Record<string, string> = {},
	aliases: Record<string, string> = {},
) {
	const directory = path.join(root, String(fixtures++));
	mkdirSync(directory, { recursive: true });
	for (const [file, contents] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
		writeFileSync(path.join(directory, file), contents);
	}
	const entry = path.join(directory, "main.mjs");
	writeFileSync(entry, source);
	const image = compileEntrypoint(entry, {
		buildConfig: resolveBuildConfig({ modules: { aliases } }),
		stripTypes: stripCompactTypes,
	});
	return {
		directory,
		declarations: embedDeclarationsOf([image.runtime]).map(({ name, ...declaration }) => {
			expect(name).toMatch(/^[0-9a-f]{32}$/);
			return declaration;
		}),
	};
}

function rejects(source: string, message: RegExp): void {
	expect(() => transformEmbedDeclarations(source, "/project/main.mjs")).toThrow(message);
}

describe("embed declarations", () => {
	it("keeps the lines and columns of code after a declaration", () => {
		const source = [
			'import { embedFile as file, embedDirectory } from "maligator:assets";',
			'const a = file(\n  "./a.txt"\n); const after = 1;',
			'const b = embedDirectory("./dir", { include: ["*.md"] }); const tail = 2;',
		].join("\n");
		const output = transformEmbedDeclarations(source, "/project/main.mjs").split("\n");
		const input = source.split("\n");
		for (const marker of ["const after", "const tail"]) {
			const line = input.findIndex((text) => text.includes(marker));
			expect(output[line]!.indexOf(marker)).toBe(input[line]!.indexOf(marker));
		}
	});

	it("leaves a module without declarations untouched", () => {
		const source = 'import { embedFile } from "maligator:assets";\nexport {};\n';
		expect(transformEmbedDeclarations(source, "/project/main.mjs")).toBe(source);
		const shadowed =
			'import { embedFile } from "maligator:assets";\nfunction f(embedFile) { return embedFile(name); }\n';
		expect(transformEmbedDeclarations(shadowed, "/project/main.mjs")).toBe(shadowed);
	});

	it("rejects uses the build cannot see through", () => {
		const header = 'import { embedFile, embedDirectory } from "maligator:assets";\n';
		rejects(
			`${header}const f = embedFile;`,
			/main\.mjs:2:11: embedFile .* called directly/,
		);
		rejects(`${header}embedFile(name);`, /string literal specifier/);
		rejects(`${header}embedFile(\`./\${name}\`);`, /string literal specifier/);
		rejects(`${header}embedFile("./a", {}, {});`, /at most two arguments/);
		rejects(`${header}embedFile("./a", { include: ["*"] });`, /unknown embedFile option/);
		rejects(`${header}embedDirectory("./d", options);`, /object literal/);
		rejects(`${header}embedDirectory("./d", { include: [pattern] });`, /string literals/);
		rejects(`${header}embedDirectory("./d", { include: [] });`, /at least one pattern/);
		rejects(`${header}embedDirectory("./d", { include: ["../up"] });`, /invalid pattern/);
		rejects(
			`${header}embedDirectory("./d", { recursive: true });`,
			/unknown embedDirectory option/,
		);
		rejects(`${header}embedFile?.("./a");`, /called directly|optionally/);
		rejects(`${header}export { embedFile };`, /called directly/);
		rejects('export { embedFile } from "maligator:assets";', /re-exporting/);
		rejects('const assets = await import("maligator:assets");', /statically/);
		rejects(
			'import * as assets from "maligator:assets";\nconsole.log(assets);',
			/called directly/,
		);
	});

	it("resolves specifiers from the declaring module and through aliases", () => {
		const { directory, declarations } = declarationsOf(
			[
				'import * as assets from "maligator:assets";',
				'import { nested } from "./lib/nested.mjs";',
				'globalThis.result = [assets.embedFile("./a.txt"), nested, assets.embedFile("generated:file"), assets.embedDirectory("pkg/dist", { exclude: ["*.map"], dot: true })];',
			].join("\n"),
			{
				"lib/nested.mjs":
					'import { embedFile } from "maligator:assets";\nexport const nested = embedFile("../b.txt");\n',
				"node_modules/pkg/package.json": "{}",
			},
			{ "generated:file": "/generated/output.bin" },
		);
		expect(declarations).toEqual(
			expect.arrayContaining([
				{ kind: "file", path: path.join(directory, "a.txt") },
				{ kind: "file", path: path.join(directory, "b.txt") },
				{ kind: "file", path: "/generated/output.bin" },
				{
					kind: "directory",
					path: path.join(directory, "node_modules/pkg/dist"),
					exclude: ["*.map"],
					dot: true,
				},
			]),
		);
		expect(declarations).toHaveLength(4);
	});

	it("validates producer commands and the producer each command selects", () => {
		const header = 'import { embedDirectory } from "maligator:assets";\n';
		rejects(
			`${header}embedDirectory("./d", { build: { command: [] } });`,
			/non-empty array/,
		);
		rejects(
			`${header}embedDirectory("./d", { build: { command: ["npm"], shell: true } });`,
			/unknown .* property 'shell'/,
		);
		rejects(
			`${header}embedDirectory("./d", { watch: { command: ["vite"], url: "localhost:5173" } });`,
			/http or https URL/,
		);
		rejects(
			`${header}embedDirectory("./d", { use: { run: "watch" } });`,
			/use\.run' selects 'watch', which the declaration does not define/,
		);
		rejects(
			`${header}embedDirectory("./d", { build: { command: ["make"] }, use: { build: "watch" } });`,
			/use\.build' must be "build", "existing"/,
		);
	});

	it("resolves producer directories and keeps commands to the project's modules", () => {
		const { directory, declarations } = declarationsOf(
			'import { embedDirectory } from "maligator:assets";\nglobalThis.web = embedDirectory("./web/dist", { build: { command: ["npm", "run", "build"], cwd: "./web" }, watch: { command: ["vite"], url: "http://127.0.0.1:5173" }, use: { test: "build" } });\n',
		);
		expect(declarations).toEqual([
			{
				kind: "directory",
				path: path.join(directory, "web/dist"),
				build: { command: ["npm", "run", "build"], cwd: path.join(directory, "web") },
				watch: { command: ["vite"], url: "http://127.0.0.1:5173", cwd: directory },
				use: { test: "build" },
			},
		]);
		expect(() =>
			declarationsOf('import "pkg";\n', {
				"node_modules/pkg/package.json": '{ "type": "module", "main": "index.js" }',
				"node_modules/pkg/index.js":
					'import { embedFile } from "maligator:assets";\nglobalThis.asset = embedFile("./a.txt", { build: { command: ["make"] } });\n',
			}),
		).toThrow(/only the project's own modules may declare build or watch commands/);
	});

	it("keeps producer commands out of a built executable", () => {
		const directory = path.join(root, "emitted");
		mkdirSync(directory, { recursive: true });
		const entry = path.join(directory, "main.mjs");
		writeFileSync(
			entry,
			'import { embedFile } from "maligator:assets";\nglobalThis.asset = embedFile("./generated.txt", { build: { command: ["generate-secret-asset"] } });\n',
		);
		const output = emitProgramImage(
			compileEntrypoint(entry, { stripTypes: stripCompactTypes }),
			{ compiled: false },
		);
		expect(output).toContain(path.join(directory, "generated.txt"));
		expect(output).not.toContain("generate-secret-asset");
	});

	it("installs one handle per distinct declaration the program reaches", () => {
		const { directory, declarations } = declarationsOf(
			[
				'import { embedFile } from "maligator:assets";',
				'globalThis.same = embedFile("./a.txt") === embedFile("./a.txt");',
				'function unused() { return embedFile("./unused.txt"); }',
			].join("\n"),
		);
		expect(declarations).toEqual([{ kind: "file", path: path.join(directory, "a.txt") }]);
	});
});
