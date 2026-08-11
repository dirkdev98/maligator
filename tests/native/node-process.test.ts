import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	STRESS_ENV,
} from "../../src/test-harness.ts";

// Acceptance coverage for the statically-retained native `process` global. Builds
// the fixture ONCE (node surface on, so the linker retains the global-property
// installer and the manifest names mal_host_install_process),
// then runs it under different OS argv / environments to assert forwarding,
// enumeration, cwd, and exit status. Runs on the host entry (HOST_MAIN), which
// threads its own argc/argv into the installer.

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-process-"));
const FIXTURE = "tests/local/node-process.mts";

interface Run {
	status: number | null;
	stdout: string;
	stderr: string;
	lines: Array<string>;
}

function run(
	bin: string,
	args: Array<string>,
	options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Run {
	const result = spawnSync(bin, args, {
		encoding: "utf-8",
		timeout: 20000,
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
	});
	const stdout = result.stdout;
	const lines = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return { status: result.status, stdout, stderr: result.stderr, lines };
}

/** The single-space-delimited payload of the first `<prefix> …` line, if any. */
function field(lines: Array<string>, prefix: string): string | undefined {
	const line = lines.find((candidate) => candidate.startsWith(`${prefix} `));
	return line === undefined ? undefined : line.slice(prefix.length + 1);
}

/** The forwarded argv, indexed by the position the fixture printed. */
function argvItems(lines: Array<string>): Array<string | undefined> {
	const items: Array<string | undefined> = [];
	for (const line of lines) {
		const match = line.match(/^ARGV (\d+) (.*)$/);
		if (match) {
			items[Number(match[1])] = match[2];
		}
	}
	return items;
}

describe("native process global", () => {
	let bin: string;
	let yamlBin: string;
	beforeAll(() => {
		bin = buildNativeBinary({
			fixture: FIXTURE,
			name: "node-process",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		yamlBin = buildNativeBinary({
			fixture: "tests/local/node-process-yaml.cjs",
			name: "node-process-yaml",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
	}, 300_000);

	it("forwards OS argv with the compiled source entry", () => {
		const r = run(bin, ["alpha", "beta gamma"], { env: { NODE_PROCESS_MARKER: "m" } });
		expect(r.status).toBe(0);
		const argv = argvItems(r.lines);
		expect(field(r.lines, "ARGV_LEN")).toBe("4");
		expect(argv[0]).toBeTruthy(); // OS argv0 (the invoked binary path)
		expect(argv[1]).toBe(path.resolve(FIXTURE));
		expect(argv[2]).toBe("alpha");
		expect(argv[3]).toBe("beta gamma");
	});

	it("exposes env as an enumerable snapshot (read / keys / spread)", () => {
		const r = run(bin, [], { env: { NODE_PROCESS_MARKER: "hello-world" } });
		expect(r.status).toBe(0);
		expect(field(r.lines, "ENV_READ")).toBe("hello-world");
		expect(field(r.lines, "ENV_HAS_MARKER")).toBe("true");
		expect(field(r.lines, "ENV_SPREAD_READ")).toBe("hello-world");
		const keysLen = Number(field(r.lines, "ENV_KEYS_LEN"));
		expect(keysLen).toBeGreaterThan(0);
		// A spread of the snapshot preserves every enumerable own key.
		expect(field(r.lines, "ENV_SPREAD_KEYS_LEN")).toBe(String(keysLen));
	});

	it("reports the current working directory from cwd()", () => {
		const dir = realpathSync(outDir);
		const r = run(bin, [], { cwd: outDir, env: { NODE_PROCESS_MARKER: "m" } });
		expect(r.status).toBe(0);
		expect(field(r.lines, "CWD")).toBe(dir);
	});

	it("publishes emitWarning through the shared module/global object", () => {
		const r = run(bin, [], {
			env: { NODE_PROCESS_MARKER: "m", NODE_PROCESS_WARN: "1" },
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("module-warning");
		assertResultPass(r.stdout);
	});

	it("loads YAML through its bare process dependency", () => {
		const r = run(yamlBin, [], { env: { NODE_PROCESS_MARKER: "m" } });
		expect(r.status).toBe(0);
		assertResultPass(r.stdout);
	});

	it("exits with the status passed to process.exit(code)", () => {
		const r = run(bin, [], {
			env: { NODE_PROCESS_MARKER: "m", NODE_PROCESS_EXIT: "3" },
		});
		expect(r.status).toBe(3);
		// exit() runs after the markers, so the structural RESULT line still made it out.
		expect(r.stdout).toContain("RESULT ");
	});

	it("treats process.exit(0) as a clean zero status", () => {
		const r = run(bin, [], {
			env: { NODE_PROCESS_MARKER: "m", NODE_PROCESS_EXIT: "0" },
		});
		expect(r.status).toBe(0);
	});

	it.each(["default", "undefined"])(
		"treats process.exit(%s) as a clean zero status",
		(exitRequest) => {
			const r = run(bin, [], {
				env: { NODE_PROCESS_MARKER: "m", NODE_PROCESS_EXIT: exitRequest },
			});
			expect(r.status).toBe(0);
		},
	);

	it.each([
		["9007199254740991", 255],
		["-9007199254740991", 1],
	])("accepts safe-integer boundary %s", (exitRequest, expectedStatus) => {
		const r = run(bin, [], {
			env: { NODE_PROCESS_MARKER: "m", NODE_PROCESS_EXIT: exitRequest },
		});
		expect(r.status).toBe(expectedStatus);
	});

	it("throws for invalid exit codes and continues running", () => {
		const r = run(bin, [], { env: { NODE_PROCESS_MARKER: "m" } });
		expect(r.status).toBe(0);
		expect(field(r.lines, "EXIT_INVALID_CONTINUED")).toBe("true");
		assertResultPass(r.stdout);
	});

	it("passes the structural self-checks", () => {
		const r = run(bin, [], { env: { NODE_PROCESS_MARKER: "m" } });
		assertResultPass(r.stdout);
	});

	it("passes under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		const r = run(bin, [], { env: { ...STRESS_ENV, NODE_PROCESS_MARKER: "m" } });
		assertResultPass(r.stdout);
	});
});
