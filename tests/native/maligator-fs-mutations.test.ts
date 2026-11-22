import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

interface WriteOutcome {
	outcomes: Array<string>;
	contents: string;
}

interface Run {
	cwd: string;
	output: {
		direct: WriteOutcome;
		atomic: WriteOutcome;
		dangling: Array<string>;
		collision: string;
		previous: string;
		link: { target: string; resolved: string };
		scratch: Array<string>;
		deletion: Record<string, string>;
	};
}

const root = mkdtempSync(join(tmpdir(), "mal-fs-mutations-"));
const runs: Array<Run> = [];

beforeAll(() => {
	const { compiled, interpreted } = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/maligator-fs-mutations.mjs",
		name: "maligator-fs-mutations",
		outDir: join(root, "out"),
	});
	for (const binary of [compiled, interpreted]) {
		const cwd = mkdtempSync(join(root, "run-"));
		const temporary = join(cwd, "default-parent");
		mkdirSync(temporary);
		const stdout = runToStdout(binary, {
			cwd,
			env: { ...STRESS_ENV, TMPDIR: temporary },
		});
		runs.push({ cwd, output: JSON.parse(stdout) as Run["output"] });
	}
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

it.each(["direct", "atomic"] as const)(
	"publishes one winner in a %s exclusive write",
	(kind) => {
		for (const { output, cwd } of runs) {
			const { outcomes, contents } = output[kind];
			expect(outcomes.toSorted()).toEqual(["EEXIST", contents]);
			expect(contents).toMatch(/^(first|second)$/);
			expect(statSync(join(cwd, `${kind}.txt`)).mode & 0o077).toBe(0);
			expect(readdirSync(cwd).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		}
	},
);

it("checks dangling links for collisions in both exclusive write modes", () => {
	for (const { output, cwd } of runs) {
		expect(output.dangling).toEqual(["EEXIST", "EEXIST"]);
		expect(readlinkSync(join(cwd, "dangling.txt"))).toBe("absent.txt");
		expect(existsSync(join(cwd, "absent.txt"))).toBe(false);
	}
});

it("publishes a directory tree after preserving the previous version on collision", () => {
	for (const { output, cwd } of runs) {
		expect(output.collision).toBe("EEXIST");
		expect(output.previous).toBe("previous version");
		expect(readFileSync(join(cwd, "published/nested/report.txt"), "utf8")).toBe("report");
		expect(existsSync(join(cwd, "staging"))).toBe(false);
	}
});

it("keeps a relative link target and resolves its absolute path", () => {
	for (const { output, cwd } of runs) {
		expect(output.link).toEqual({
			target: "published/./nested/report.txt",
			resolved: realpathSync(join(cwd, "published/nested/report.txt")),
		});
	}
});

it("changes existing permissions on a directory and on the target of a file link", () => {
	for (const { cwd } of runs) {
		expect(statSync(join(cwd, "published")).mode & 0o777).toBe(0o750);
		expect(statSync(join(cwd, "published/nested/report.txt")).mode & 0o777).toBe(0o640);
	}
});

it("creates distinct private temporary directories under the requested or default parent", () => {
	for (const { output, cwd } of runs) {
		expect(new Set(output.scratch).size).toBe(3);
		for (const [index, path] of output.scratch.entries()) {
			const custom = index < 2;
			expect(dirname(path)).toBe(
				realpathSync(join(cwd, custom ? "scratch-parent" : "default-parent")),
			);
			expect(basename(path).startsWith(custom ? "report-" : "maligator-")).toBe(true);
			const stat = statSync(path);
			expect(stat.isDirectory()).toBe(true);
			expect(stat.mode & 0o077).toBe(0);
		}
	}
});

it("ignores missing entries only when requested and still reports a wrong entry kind", () => {
	for (const { output, cwd } of runs) {
		expect(output.deletion).toEqual({
			fileMissing: "success",
			directoryMissing: "success",
			strictFile: "ENOENT",
			strictDirectory: "ENOENT",
			wrongKind: "EISDIR",
		});
		expect(existsSync(join(cwd, "cleanup"))).toBe(false);
	}
});
