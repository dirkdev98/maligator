import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const output = args[args.indexOf("--json-out") + 1]!;
const label = path.basename(output, ".json");
const controlDirectory = JSON.parse(readFileSync("control-path.json", "utf8")) as string;
const control = JSON.parse(
	readFileSync(path.join(controlDirectory, "control.json"), "utf8"),
) as {
	fail?: string;
	hang?: string;
	checksumMismatch?: boolean;
	selfCompileDigestMismatch?: string;
	mutate?: string;
};
appendFileSync(path.join(controlDirectory, "calls.jsonl"), `${JSON.stringify(label)}\n`);
process.stdout.write(`fixture started ${label}\n`);
if (control.mutate === label)
	writeFileSync("changed-during-bench.ts", "export const changed = true;\n");
if (control.fail === label) {
	process.stderr.write("controlled benchmark failure\n");
	process.exit(23);
}
if (control.hang === label) {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		stdio: "ignore",
	});
	writeFileSync(path.join(controlDirectory, "descendant.pid"), String(child.pid));
	await new Promise(() => {});
}
if (args.includes("--checkpoint")) {
	if (args.includes("--self-compile-sample")) {
		throw new Error("ordinary self-compile samples cannot use diagnostic checkpoints");
	}
	const checkpoint = args[args.indexOf("--checkpoint") + 1]!;
	if (!existsSync(checkpoint)) {
		writeFileSync(checkpoint, '{"stage":"prepared"}');
		process.exit(0);
	}
}
const base = label.endsWith("base");
const selfCompile = args.includes("self-compile");
writeFileSync(
	output,
	JSON.stringify({
		source: {
			commit: process.env.MAL_INTERNAL_BENCH_SOURCE_COMMIT ?? "candidate",
			digest: "fixture",
		},
		...(selfCompile
			? {
					selfCompileOrdinary: {
						profile: "ordinary",
						units: 3,
						codeUnits: 1000,
						digest:
							control.selfCompileDigestMismatch === label
								? "changed-output"
								: base
									? "base-output"
									: "head-output",
						maligatorMs: base ? 100 : 90,
					},
				}
			: {
					javascript: {
						workload: "fixture",
						phaseChecksums: {
							main: control.checksumMismatch && label.endsWith("head") ? 99 : 42,
						},
						wallMs: base ? 100 : 90,
					},
				}),
		nativePlan: { compiler: "fixture" },
		nativeBuild: base ? { peakRssBytes: 1024 } : {},
	}),
);
