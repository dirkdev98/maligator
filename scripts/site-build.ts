import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { CommandProgress } from "../src/command-progress.ts";
import { buildExplorerSite } from "./build-explorer-site.ts";
import { formatSiteFiles, updateSite } from "./site-data.ts";

const META_FILE = "website/site-meta.json";

function build(): string {
	const output = execFileSync(
		process.execPath,
		[
			"src/index.ts",
			"build",
			"--production",
			"website/server.mts",
			"--config",
			"website/maligator.build.ts",
			"--name",
			"maligator-site",
		],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
	);
	const binary = output.trim().split("\n").at(-1);
	if (binary === undefined || binary === "")
		throw new Error("site build produced no binary path");
	return binary;
}

let binary = "";
const progress = new CommandProgress("site-build");
progress.start("update generated site data and build the native server");
await buildExplorerSite();
for (let attempt = 0; attempt < 4; attempt++) {
	progress.stage(attempt + 1, 4, `stabilize site metadata (attempt ${attempt + 1})`);
	updateSite();
	binary = build();
	const bytes = statSync(binary).size;
	const meta = JSON.parse(readFileSync(META_FILE, "utf8")) as {
		binaryBytes: number | null;
	};
	if (meta.binaryBytes === bytes) {
		progress.stagePassed(attempt + 1, 4, "stabilize site metadata", `${bytes} bytes`);
		break;
	}
	progress.stagePassed(
		attempt + 1,
		4,
		"stabilize site metadata",
		`refresh size to ${bytes} bytes`,
	);
	writeFileSync(
		META_FILE,
		`${JSON.stringify({ ...meta, binaryBytes: bytes }, null, 2)}\n`,
	);
	formatSiteFiles([META_FILE]);
}

updateSite();
progress.complete();
console.log(binary);
