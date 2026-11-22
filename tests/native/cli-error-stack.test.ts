import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";

const cli = path.resolve(import.meta.dirname, "../../src/index.ts");

it("formats a package's captured stack in both split run and production build", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "mal-cli-error-stack-"));
	const options = { cwd, encoding: "utf8" as const, timeout: 120_000 };
	try {
		const dependency = path.join(cwd, "node_modules", "stack-fixture");
		mkdirSync(dependency, { recursive: true });
		writeFileSync(
			path.join(dependency, "package.json"),
			JSON.stringify({ name: "stack-fixture", version: "1.0.0", main: "index.cjs" }),
		);
		writeFileSync(
			path.join(dependency, "index.cjs"),
			`exports.formatStack = function () {
	const target = {};
	const limit = Error.stackTraceLimit;
	const prepare = Error.prepareStackTrace;
	Error.stackTraceLimit = 1;
	Error.prepareStackTrace = (value, frames) =>
		value === target ? "captured " + frames.length : "wrong target";
	try {
		Error.captureStackTrace(target);
		return target.stack;
	} finally {
		Error.prepareStackTrace = prepare;
		Error.stackTraceLimit = limit;
	}
};
`,
		);
		writeFileSync(
			path.join(cwd, "app.mjs"),
			'import { formatStack } from "stack-fixture";\nconsole.log(formatStack());\n',
		);
		const config = "maligator.build.mts";
		writeFileSync(path.join(cwd, config), 'export default { entry: "app.mjs" };\n');

		const expected = execFileSync(process.execPath, ["app.mjs"], options);
		expect(expected).toBe("captured 1\n");
		expect(
			execFileSync(process.execPath, [cli, "run", "--config", config], options),
		).toBe(expected);
		const binary = execFileSync(
			process.execPath,
			[cli, "build", "--production", "--config", config],
			options,
		);
		expect(execFileSync(binary.trim(), [], options)).toBe(expected);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}, 300_000);
