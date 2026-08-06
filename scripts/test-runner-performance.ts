import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const requestedBinary = process.argv[2];
if (requestedBinary === undefined) {
	throw new Error("usage: node scripts/test-runner-performance.ts <maligator-binary>");
}
const binary = path.resolve(requestedBinary);
if (!existsSync(binary)) throw new Error(`maligator binary does not exist: ${binary}`);

const root = mkdtempSync(path.join(os.tmpdir(), "maligator-test-performance-"));
const suite = path.join(root, "suite");
mkdirSync(suite, { recursive: true });

function write(relativePath: string, source: string): void {
	writeFileSync(path.join(suite, relativePath), source);
}

function smallTest(index: number, revision: number): string {
	return `import { expect, test } from "maligator:test";
import { shared, sharedInitializationCount } from "./shared.ts";

test("small ${index}", () => {
\texpect(shared(${index})).toBe(${index + 1});
\texpect(sharedInitializationCount).toBe(1);
});
// revision ${revision}
`;
}

function run(label: string, selections: Array<string>): void {
	const output = execFileSync(binary, ["test", ...selections], {
		cwd: suite,
		encoding: "utf-8",
		env: process.env,
	});
	process.stdout.write(`\n=== ${label} ===\n${output.trim()}\n`);
}

try {
	write("package.json", `{"type":"module"}\n`);
	write(
		"shared.ts",
		`const prior = Number(Reflect.get(globalThis, "__maligatorSharedInitCount") ?? 0);
export const sharedInitializationCount = prior + 1;
Reflect.set(globalThis, "__maligatorSharedInitCount", sharedInitializationCount);
export const shared = (value: number): number => value + 1;
`,
	);
	for (let index = 0; index < 20; index++) {
		write(`small-${String(index).padStart(2, "0")}.test.ts`, smallTest(index, 0));
	}
	const asyncTests = Array.from(
		{ length: 40 },
		(_, index) => `test("async ${index}", async () => {
\tawait expect(Promise.resolve(${index})).resolves.toBe(${index});
});`,
	).join("\n");
	write(
		"async-heavy.test.ts",
		`import { expect, test } from "maligator:test";

${asyncTests}
`,
	);

	run("cold all files", ["."]);
	run("warm unchanged", ["."]);

	write("small-00.test.ts", smallTest(0, 1));
	run("one changed test file", ["small-00.test.ts"]);

	write(
		"shared.ts",
		`const prior = Number(Reflect.get(globalThis, "__maligatorSharedInitCount") ?? 0);
export const sharedInitializationCount = prior + 1;
Reflect.set(globalThis, "__maligatorSharedInitCount", sharedInitializationCount);
export const shared = (value: number): number => value + 1;
// dependency revision 1
`,
	);
	run("changed shared dependency", ["."]);
	run("warm async-heavy", ["async-heavy.test.ts"]);
} finally {
	rmSync(root, { recursive: true, force: true });
}
