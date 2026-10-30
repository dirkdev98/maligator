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
	mutate?: string;
	mutateCheckout?: string;
};
appendFileSync(path.join(controlDirectory, "calls.jsonl"), `${JSON.stringify(label)}\n`);
process.stdout.write(`fixture started ${label}\n`);
if (control.mutate === label)
	writeFileSync("scripts/bench.ts", `${readFileSync("scripts/bench.ts", "utf8")}\n`);
if (control.mutateCheckout === label) {
	writeFileSync(path.join(controlDirectory, "repository", "candidate-value.json"), "999");
	writeFileSync(
		path.join(controlDirectory, "repository", "new-source.ts"),
		"export const changed = true;\n",
	);
	for (const file of ["untracked-value.json", "node_modules/fixture-value/value.json"]) {
		const target = path.join(controlDirectory, "repository", file);
		if (existsSync(target)) writeFileSync(target, "999");
	}
}
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
	const checkpoint = args[args.indexOf("--checkpoint") + 1]!;
	if (!existsSync(checkpoint)) {
		writeFileSync(checkpoint, '{"stage":"prepared"}');
		process.exit(0);
	}
}
const base = label.endsWith("base");
writeFileSync(
	output,
	JSON.stringify({
		source: {
			commit: process.env.MAL_INTERNAL_BENCH_SOURCE_COMMIT ?? "candidate",
			digest: process.env.MAL_INTERNAL_BENCH_SOURCE_DIGEST ?? "fixture",
			dirty: process.env.MAL_INTERNAL_BENCH_SOURCE_DIRTY === "true",
		},
		[args.includes("javascript-v2") ? "javascriptV2" : "javascript"]: {
			workload: "fixture",
			phaseChecksums: {
				main: control.checksumMismatch && label.endsWith("head") ? 99 : 42,
			},
			wallMs: base
				? 100
				: (JSON.parse(readFileSync("candidate-value.json", "utf8")) as number),
		},
		nativePlan: { compiler: "fixture" },
		nativeBuild: base ? { peakRssBytes: 1024 } : {},
	}),
);
