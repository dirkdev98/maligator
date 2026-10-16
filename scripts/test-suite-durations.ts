import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";

const usage = `usage: node scripts/test-suite-durations.ts [--jobs REGEX] RUN_LOG...

Rebuilds tests/test-suite-durations.json from \`gh run view RUN_ID --log\` output.
Only jobs whose name matches --jobs (default: ^Linux) contribute; a file seen in
several jobs keeps its longest duration. The table only balances CI shards.`;

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
	console.log(usage);
	process.exit(args.length === 0 ? 1 : 0);
}
let jobs = /^Linux/;
const logs: Array<string> = [];
for (let index = 0; index < args.length; index++) {
	if (args[index] === "--jobs") {
		jobs = new RegExp(args[++index] ?? "");
		continue;
	}
	logs.push(args[index]!);
}

// Vitest prints `✓ native tests/native/x.test.ts (3 tests) 1234ms` per file.
const fileLine = /[✓×]\s+(?:\w+\s+)?(tests\/\S+\.test\.ts) \([^)]*\)\s+(\d+)ms/;
// Downloaded logs can also carry the caret-escaped rendering of colour codes.
const caretColour = /\^\[\[[0-9;]*m/g;
const seconds = new Map<string, number>();
for (const log of logs) {
	for (const line of readFileSync(log, "utf8").split("\n")) {
		const [job, , message] = line.split("\t", 3);
		if (job === undefined || message === undefined || !jobs.test(job)) continue;
		const match = fileLine.exec(
			stripVTControlCharacters(message).replace(caretColour, ""),
		);
		if (match === null) continue;
		const value = Math.round(Number(match[2]) / 100) / 10;
		seconds.set(match[1]!, Math.max(seconds.get(match[1]!) ?? 0, value));
	}
}
if (seconds.size === 0)
	throw new Error("no Vitest file durations found in the given logs");
const output = path.resolve(import.meta.dirname, "../tests/test-suite-durations.json");
writeFileSync(
	output,
	`${JSON.stringify(
		{
			schema: 1,
			seconds: Object.fromEntries([...seconds].sort(([a], [b]) => (a < b ? -1 : 1))),
		},
		null,
		"\t",
	)}\n`,
);
console.log(`[test-suite-durations] ${seconds.size} files: ${output}`);
