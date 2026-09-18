import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { main as runRuntimeGap } from "./runtime-gap.ts";

const HELP = `Usage: npm run bench:performance -- COMMAND [options]

Commands:
  gap                         Run isolated Node/native diagnostic cases

Use "npm run bench:performance -- gap --help" for command options.
`;

function main(args: ReadonlyArray<string>): void {
	const [command, ...commandArgs] = args;
	if (command === undefined || command === "--help" || command === "-h") {
		console.log(HELP);
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
	runRuntimeGap(forwarded);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2));
}
