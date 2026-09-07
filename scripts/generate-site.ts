import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSiteTemplate } from "../website/templates/layout.ts";
import { generatePlatformApi } from "./generate-platform-api.ts";
import { formatSiteFiles, updateSite } from "./site-data.ts";

export async function generateSite(): Promise<void> {
	updateSite();
	writeFileSync(
		"website/explorer.html",
		renderSiteTemplate(
			readFileSync("website/templates/explorer.html", "utf8"),
			"explorer",
		),
	);
	formatSiteFiles(["website/explorer.html"]);
	await generatePlatformApi();
	console.log(
		"[site-update] Generated Overview, Explorer, Compatibility and platform API pages.",
	);
}

if (
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await generateSite();
}
