import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
// The child resolves its own cwd through symlinks, so the fixture directory has
// to be compared in its real form.
const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "mal-dev-runner-")));

afterAll(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe("development wire runner", () => {
	it("runs Node host modules and preserves the source entry without generated C", () => {
		const entrypoint = path.join(directory, "entry.mjs");
		const dependencyDirectory = path.join(directory, "node_modules/example-dependency");
		mkdirSync(dependencyDirectory, { recursive: true });
		writeFileSync(
			path.join(dependencyDirectory, "package.json"),
			`{"type":"module","exports":"./index.mjs"}\n`,
		);
		writeFileSync(
			path.join(dependencyDirectory, "index.mjs"),
			"export const answer = 42;\n",
		);
		writeFileSync(
			entrypoint,
			'import process from "node:process";\n' +
				'import { answer } from "example-dependency";\n' +
				"setTimeout(\n" +
				"	() =>\n" +
				"		console.log(\n" +
				"			JSON.stringify({ answer, cwd: process.cwd(), argv: process.argv.slice(1) }),\n" +
				"		),\n" +
				"	1,\n" +
				");\n",
		);
		writeFileSync(
			path.join(directory, "maligator.build.mjs"),
			"export default { surface: { node: true } };\n",
		);

		const result = spawnSync(
			process.execPath,
			[
				path.join(repositoryRoot, "src/index.ts"),
				"run",
				"entry.mjs",
				"--config",
				"maligator.build.mjs",
				"--verbose",
				"--",
				"two words",
				"--flag",
			],
			{
				// The project is the cwd a user would run from; the shared cache is
				// deliberately not isolated so this stays a warm smoke measurement.
				cwd: directory,
				env: process.env,
				encoding: "utf-8",
				timeout: 300_000,
			},
		);

		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			answer: 42,
			cwd: directory,
			argv: [entrypoint, "two words", "--flag"],
		});
		expect(result.stderr).toContain("Execution backend: interpreted development image");
		expect(result.stderr).toContain("Prepare development runtime completed");
		expect(result.stderr).not.toContain("Generate native code");
	}, 300_000);
});
