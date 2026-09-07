import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { includeConfiguredAssets } from "../src/assets.ts";
import { loadBuildConfig } from "../src/build-config.ts";
import { CommandProgress } from "../src/command-progress.ts";
import { buildExplorerSite } from "./build-explorer-site.ts";
import { generateSite } from "./generate-site.ts";
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
let stabilized = false;
const progress = new CommandProgress("site-build");
progress.start("update generated site data and build the native server");
await generateSite();
await buildExplorerSite();
for (let attempt = 0; attempt < 4; attempt++) {
	progress.stage(attempt + 1, 4, `stabilize site metadata (attempt ${attempt + 1})`);
	updateSite();
	binary = build();
	const bytes = statSync(binary).size;
	const assets = includeConfiguredAssets(
		loadBuildConfig("website/maligator.build.ts").assets,
	);
	const embeddedAssetBytes = assets.reduce(
		(total, asset) => total + asset.files.reduce((size, file) => size + file.size, 0),
		0,
	);
	if (embeddedAssetBytes > bytes)
		throw new Error("Embedded assets exceed the website binary size");
	const meta = JSON.parse(readFileSync(META_FILE, "utf8")) as {
		binaryBytes: number | null;
		embeddedAssetBytes: number | null;
	};
	if (meta.binaryBytes === bytes && meta.embeddedAssetBytes === embeddedAssetBytes) {
		progress.stagePassed(
			attempt + 1,
			4,
			"stabilize site metadata",
			`${bytes - embeddedAssetBytes} server bytes + ${embeddedAssetBytes} asset bytes`,
		);
		stabilized = true;
		break;
	}
	progress.stagePassed(
		attempt + 1,
		4,
		"stabilize site metadata",
		`refresh size to ${bytes - embeddedAssetBytes} server bytes + ${embeddedAssetBytes} asset bytes`,
	);
	writeFileSync(
		META_FILE,
		`${JSON.stringify({ ...meta, binaryBytes: bytes, embeddedAssetBytes }, null, 2)}\n`,
	);
	formatSiteFiles([META_FILE]);
}

if (!stabilized)
	throw new Error("Website size metadata did not stabilize after four builds");
progress.complete();
console.log(binary);
