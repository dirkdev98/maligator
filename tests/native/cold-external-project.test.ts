import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const root = mkdtempSync(path.join(os.tmpdir(), "mal-cold-external-"));
const project = path.join(root, "project");
// A private cache root is what makes this run cold; the shared developer cache
// would otherwise supply the runner, artifacts, and frontend wires.
const cacheDirectory = path.join(root, "cache");

function write(relativePath: string, source: string): void {
	const file = path.join(project, relativePath);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, source);
}

// cwd is the external project so the CLI resolves project-relative selections,
// node_modules, and the build config exactly as it does for a user.
function invoke(args: Array<string>) {
	return spawnSync(
		process.execPath,
		[path.join(repositoryRoot, "src/index.ts"), ...args],
		{
			cwd: project,
			env: { ...process.env, MALIGATOR_CACHE_DIR: cacheDirectory },
			encoding: "utf-8",
			maxBuffer: 32 * 1024 * 1024,
			timeout: 280_000,
		},
	);
}

write(
	"package.json",
	`{"name":"cold-external-project","private":true,"type":"module"}\n`,
);
write("maligator.build.ts", "export default { surface: { node: true } };\n");
write(
	"node_modules/greeting-suffix/package.json",
	`{"type":"module","exports":"./index.mjs"}\n`,
);
write("node_modules/greeting-suffix/index.mjs", 'export const suffix = "!";\n');
write(
	"greeting.ts",
	'import { suffix } from "greeting-suffix";\n\n' +
		"export function greet(who: string): string {\n" +
		"\treturn `Hello, ${who}${suffix}`;\n" +
		"}\n",
);
write(
	"greeting.test.ts",
	'import { expect, test } from "maligator:test";\n' +
		'import { greet } from "./greeting.ts";\n\n' +
		'test("greets through the local package", () => {\n' +
		'\texpect(greet("world")).toBe("Hello, world!");\n' +
		"});\n\n" +
		'test("greets a second name", () => {\n' +
		'\texpect(greet("maligator")).toBe("Hello, maligator!");\n' +
		"});\n",
);
write(
	"main.ts",
	'import { greet } from "./greeting.ts";\n\n' +
		'console.log(greet("external project"));\n',
);

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("cold external project", () => {
	it("discovers and runs tests, then runs the application", () => {
		const tested = invoke(["test", "--config", "maligator.build.ts"]);
		expect(tested.error, String(tested.error)).toBeUndefined();
		expect(tested.status, tested.stderr || tested.stdout).toBe(0);
		expect(tested.stdout).toContain("✓ greeting.test.ts");
		expect(tested.stdout).toMatch(/^2 passed, 0 failed in \d+ms$/m);

		const filtered = invoke([
			"test",
			"--config",
			"maligator.build.ts",
			"--run",
			"greets through the local package",
		]);
		expect(filtered.status, filtered.stderr || filtered.stdout).toBe(0);
		expect(filtered.stdout).toMatch(/^1 passed, 0 failed in \d+ms$/m);

		const ran = invoke(["run", "main.ts", "--config", "maligator.build.ts"]);
		expect(ran.status, ran.stderr || ran.stdout).toBe(0);
		expect(ran.stdout).toBe("Hello, external project!\n");
	}, 300_000);
});
