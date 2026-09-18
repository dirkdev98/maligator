import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runPortfolio } from "./performance-portfolio.ts";
import { runExperimentCommand } from "./runtime-gap-experiment.ts";
import { main as runRuntimeGap } from "./runtime-gap.ts";
import { reexecWithCleanTestEnvironment } from "./test-environment.ts";

const HELP = `Usage: npm run bench:performance -- COMMAND [options]

Commands:
  gap                         Run isolated Node/native diagnostic cases
  experiment                  Create, run, promote, or remove a scratch case
  portfolio                   Compare the fixed representative workload portfolio

Use "npm run bench:performance -- gap --help" for command options.
`;

async function main(args: ReadonlyArray<string>): Promise<void> {
	const [command, ...commandArgs] = args;
	if (command === undefined || command === "--help" || command === "-h") {
		console.log(HELP);
		return;
	}
	if (command === "experiment") {
		await runExperimentCommand(commandArgs);
		return;
	}
	if (command === "portfolio") {
		await runPortfolio(commandArgs);
		return;
	}
	if (command !== "gap") throw new Error(`unknown performance command: ${command}`);
	const forwarded = [...commandArgs];
	if (
		!["--preset", "--case", "--category", "--suite", "--group"].some((option) =>
			forwarded.includes(option),
		)
	) {
		forwarded.push("--preset", "quick");
	}
	await runRuntimeGap(forwarded);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	reexecWithCleanTestEnvironment("MAL_PERFORMANCE_CANONICAL");
	await main(process.argv.slice(2));
}
