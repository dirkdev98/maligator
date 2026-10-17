import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";

const usage = `usage: node scripts/test-suite-durations.ts RUN_LOG...

Rebuilds tests/test-suite-durations.json from GitHub Actions logs, either
\`gh run view RUN_ID --log\` output or per-job logs prefixed with "JOB<TAB>STEP<TAB>".
Jobs named "Linux ..." record the linux table and "macOS ..." the darwin table;
sanitizer jobs record a separate "-sanitizer" table for that platform. Each file and
stage keeps the median of its observations. The tables only balance CI shards; stage
entries weight stages that run without test files.`;

const logs = process.argv.slice(2);
if (logs.length === 0 || logs.includes("-h") || logs.includes("--help")) {
	console.log(usage);
	process.exit(logs.length === 0 ? 1 : 0);
}

const platforms: ReadonlyArray<[RegExp, string]> = [
	[/^Linux\b/, "linux"],
	[/^macOS\b/, "darwin"],
];
// Vitest prints `✓ native tests/native/x.test.ts (3 tests) 1234ms` per file.
const fileLine = /[✓×]\s+(?:\w+\s+)?(tests\/\S+\.test\.ts) \([^)]*\)\s+(\d+)ms/;
// CommandProgress prints `[test-suite] [2/3] NAME · shard 1/2 passed in 8m 28s`.
const stageLine =
	/\[test-suite\] \[\d+\/\d+\] (.+?)(?: · shard \d+\/\d+)? (?:passed in|failed after) (\d+m \d+s|[\d.]+s|\d+ms)$/;
// Downloaded logs can also carry the caret-escaped rendering of colour codes.
const caretColour = /\^\[\[[0-9;]*m/g;

function seconds(duration: string): number {
	const minutes = /^(\d+)m (\d+)s$/.exec(duration);
	if (minutes !== null) return Number(minutes[1]) * 60 + Number(minutes[2]);
	if (duration.endsWith("ms")) return Number(duration.slice(0, -2)) / 1000;
	return Number(duration.slice(0, -1));
}

type Observations = Map<string, Array<number>>;
const tables = new Map<string, { files: Observations; stages: Observations }>();
function observe(table: Observations, name: string, value: number): void {
	table.set(name, [...(table.get(name) ?? []), value]);
}

for (const log of logs) {
	for (const line of readFileSync(log, "utf8").split("\n")) {
		const [job, , raw] = line.split("\t", 3);
		const host = platforms.find(([pattern]) => pattern.test(job ?? ""))?.[1];
		if (host === undefined || raw === undefined) continue;
		const platform = /\bsanitizer\b/.test(job!) ? `${host}-sanitizer` : host;
		const message = stripVTControlCharacters(raw).replace(caretColour, "").trimEnd();
		const table = tables.get(platform) ?? { files: new Map(), stages: new Map() };
		tables.set(platform, table);
		const file = fileLine.exec(message);
		if (file !== null) observe(table.files, file[1]!, Number(file[2]) / 1000);
		const stage = stageLine.exec(message);
		if (stage !== null) observe(table.stages, stage[1]!, seconds(stage[2]!));
	}
}
if (tables.size === 0)
	throw new Error("no Linux or macOS test durations found in the given logs");

function medians(observations: Observations): Record<string, number> {
	return Object.fromEntries(
		[...observations]
			.sort(([left], [right]) => (left < right ? -1 : 1))
			.map(([name, values]) => {
				const sorted = [...values].sort((left, right) => left - right);
				const middle = Math.floor(sorted.length / 2);
				const median =
					sorted.length % 2 === 1
						? sorted[middle]!
						: (sorted[middle - 1]! + sorted[middle]!) / 2;
				return [name, Math.round(median * 10) / 10];
			}),
	);
}

const output = path.resolve(import.meta.dirname, "../tests/test-suite-durations.json");
const document = {
	schema: 3,
	platforms: Object.fromEntries(
		[...tables]
			.sort(([left], [right]) => (left < right ? -1 : 1))
			.map(([platform, table]) => [
				platform,
				{ files: medians(table.files), stages: medians(table.stages) },
			]),
	),
};
writeFileSync(output, `${JSON.stringify(document, null, "\t")}\n`);
for (const [platform, table] of tables) {
	console.log(
		`[test-suite-durations] ${platform}: ${table.files.size} files, ${table.stages.size} stages`,
	);
}
console.log(`[test-suite-durations] ${output}`);
