import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./bench-compiler-host-gap.ts";

const args = process.argv.slice(2);
if (
	!["--preset", "--case", "--category", "--suite", "--group"].some((option) =>
		args.includes(option),
	)
) {
	args.push("--preset", "quick");
}
if (!args.includes("--output")) {
	args.push("--output", ".cache/runtime-gap/report.json");
}
if (!args.includes("--markdown")) {
	args.push("--markdown", ".cache/runtime-gap/report.md");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	main(args);
}
