import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
} from "../../src/test-harness.ts";

const RETAINED_PER_TYPE = 1000;
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-heap-census-"));
let binary: string;

beforeAll(() => {
	binary = buildNativeBinary({
		fixture: "tests/local/heap-census.js",
		name: "heap-census",
		compiled: true,
		outDir,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

interface CensusLine {
	sample: number;
	moment: string;
	fields: Record<string, string>;
}

function runCensus(env: NodeJS.ProcessEnv): Array<CensusLine> {
	const invocation = resolveHarnessExecutionInvocation(binary);
	const result = spawnSync(invocation.executable, invocation.args, {
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, ...env },
	});
	expect(result.status, result.stderr).toBe(0);
	assertExactLines(result.stdout, [`heap-census PASS ${RETAINED_PER_TYPE * 4}`]);
	return result.stderr
		.split("\n")
		.filter((line) => line.startsWith("[heap-census] "))
		.map((line) => {
			const fields = Object.fromEntries(
				[...line.matchAll(/(\w+)=(\S+)/g)].map((match) => [match[1]!, match[2]!]),
			);
			const kind = line.includes(" total ")
				? "<total>"
				: fields.class === undefined
					? fields.type!
					: "<class>";
			return {
				sample: Number(fields.sample),
				moment: fields.moment!,
				fields: { ...fields, type: kind },
			};
		});
}

function samples(lines: Array<CensusLine>, moment: string): Array<Array<CensusLine>> {
	const bySample = new Map<number, Array<CensusLine>>();
	for (const line of lines.filter((candidate) => candidate.moment === moment)) {
		bySample.set(line.sample, [...(bySample.get(line.sample) ?? []), line]);
	}
	return [...bySample.values()];
}

function expectConsistentSample(sample: Array<CensusLine>): void {
	let managedCount = 0;
	let managedBytes = 0;
	const types = sample.filter((line) => !line.fields.type!.startsWith("<"));
	for (const { fields } of types) {
		let count = 0;
		let bytes = 0;
		for (const entry of (fields.classes ?? "").split(",").filter(Boolean)) {
			const large = entry.match(/^large:(\d+)\/(\d+)$/);
			if (large !== null) {
				count += Number(large[1]);
				bytes += Number(large[2]);
				continue;
			}
			const [cellSize, cells] = entry.split(":").map(Number);
			count += cells!;
			bytes += cellSize! * cells!;
		}
		expect(Number(fields.count), fields.type).toBe(count);
		expect(Number(fields.bytes), fields.type).toBe(bytes);
		if (fields.type !== "raw") {
			managedCount += count;
			managedBytes += bytes;
		}
	}
	const total = sample.find((line) => line.fields.type === "<total>")!.fields;
	expect(Number(total.managed_count)).toBe(managedCount);
	expect(Number(total.managed_bytes)).toBe(managedBytes);
}

it("prints nothing unless the census is requested", () => {
	expect(runCensus({})).toEqual([]);
});

it("counts the live exotic population by type at exit", () => {
	const exit = samples(runCensus({ MAL_HEAP_CENSUS: "1" }), "exit");
	expect(exit).toHaveLength(1);
	expectConsistentSample(exit[0]!);
	const counts = new Map(
		exit[0]!.map(({ fields }) => [fields.type, Number(fields.count)]),
	);
	for (const type of ["map", "set", "date", "promise"])
		expect(counts.get(type), type).toBeGreaterThanOrEqual(RETAINED_PER_TYPE);
});

it("reports a consistent census after every completed major collection", () => {
	const lines = runCensus({
		MAL_HEAP_CENSUS: "1",
		MAL_GC_STRESS: "64",
		MAL_GC_MAJOR_EVERY: "1",
	});
	const majors = samples(lines, "major");
	expect(majors.length).toBeGreaterThan(0);
	for (const sample of majors) expectConsistentSample(sample);
});
