import { spawnSync } from "node:child_process";
import { CommandProgress } from "../src/command-progress.ts";

type QualityCommand = "format" | "lint" | "lint-ci" | "type-check";

const command = process.argv[2] as QualityCommand | undefined;
const stages: Record<
	QualityCommand,
	Array<{ label: string; tool: string; args: Array<string> }>
> = {
	format: [{ label: "format files", tool: "oxfmt", args: [] }],
	lint: [
		{
			label: "lint and fix",
			tool: "eslint",
			args: [
				".",
				"--concurrency=auto",
				"--fix",
				"--cache",
				"--cache-location",
				".cache/eslint/",
			],
		},
		{ label: "format files", tool: "oxfmt", args: [] },
	],
	"lint-ci": [
		{
			label: "check platform API generation",
			tool: process.execPath,
			args: ["./scripts/generate-platform-api.ts", "--check"],
		},
		{ label: "lint", tool: "eslint", args: [".", "--concurrency=auto"] },
		{ label: "check formatting", tool: "oxfmt", args: ["--check"] },
	],
	"type-check": [{ label: "check TypeScript", tool: "tsc", args: [] }],
};

if (command === undefined || stages[command] === undefined) {
	throw new Error("usage: node scripts/quality.ts <format|lint|lint-ci|type-check>");
}

const progress = new CommandProgress(command);
const selected = stages[command];
progress.start(`${selected.length} stage${selected.length === 1 ? "" : "s"}`);
for (const [index, stage] of selected.entries()) {
	progress.stage(index + 1, selected.length, stage.label);
	const result = spawnSync(stage.tool, stage.args, {
		stdio: "inherit",
		env: process.env,
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) {
		progress.stageFailed(index + 1, selected.length, stage.label);
		process.exit(result.status ?? 1);
	}
	progress.stagePassed(index + 1, selected.length, stage.label);
}
progress.complete();
