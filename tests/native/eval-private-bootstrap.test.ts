import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/eval-private-bootstrap.cjs";
const cases = ["direct", "indirect", "function", "script"].flatMap((kind) =>
	[
		"plain",
		"sealed",
		"accessor",
		"readonly",
		"clone-accessor",
		"clone-readonly",
		"bare-sealed",
	].map((protection) => ({ kind, protection })),
);
describe("private compiler bootstrap", () => {
	const outDir = mkdtempSync(join(tmpdir(), "mal-eval-private-"));
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	beforeAll(() => {
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "eval-private",
			outDir,
			config: resolveBuildConfig({
				engine: { primordials: "mutable", eval: true, realms: true },
			}),
		});
	});
	it.each(cases)(
		"preserves cold and warm $kind compilation with $protection globals",
		({ kind, protection }) => {
			const selection = {
				EVAL_BOOTSTRAP_KIND: kind,
				EVAL_BOOTSTRAP_PROTECTION: protection,
			};
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, ...selection },
			});
			const sanitized = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
				(key) => process.env[key] === "1",
			);
			for (const binary of [pair.compiled, pair.interpreted])
				for (const env of sanitized ? [{}] : [{}, STRESS_ENV])
					expect(runToStdout(binary, { env: { ...env, ...selection } })).toBe(expected);
		},
	);
});

it.each(["run", "build"])(
	"keeps language engines and host globals used only by eval under %s",
	(command) => {
		const cwd = mkdtempSync(join(tmpdir(), "mal-eval-retention-"));
		const cli = join(import.meta.dirname, "../../src/index.ts");
		const options = { cwd, encoding: "utf8" as const, timeout: 240_000 };
		try {
			writeFileSync(
				join(cwd, "maligator.build.ts"),
				`export default { entry: "entry.mjs", engine: { eval: true } };`,
			);
			const source = `const path = process.getBuiltinModule('node:path');
const name = path === linkedPath ? path.basename('/sample/demo') : '';
[/^demo$/.test(name), Buffer.from('é').length, 'e\\u0301'.normalize()].join(' ');`;
			writeFileSync(
				join(cwd, "entry.mjs"),
				`import path from "node:path"; const linkedPath = path; console.log(eval(${JSON.stringify(source)}));`,
			);
			const output = execFileSync(process.execPath, [cli, command], options);
			const result =
				command === "build" ? execFileSync(output.trim(), [], options) : output;
			expect(result).toBe("true 2 é\n");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	},
	300_000,
);
