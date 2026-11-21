import { embedDirectory, embedFile } from "maligator:assets";
import { siteResponse } from "./responses.ts";
import type { ExplorerAsset, SiteResource } from "./responses.ts";

const explorer = embedDirectory("../.cache/explorer-site/current", {
	include: ["index.html", "manifest.json", "*.js", "*.css", "*.wasm.br", "*.txt"],
});
const documentation = embedDirectory("maligator-site:documentation");
const member = (directory: typeof explorer, path: string) => {
	const file = directory.get(path);
	if (file === undefined) throw new Error(`The site build did not produce ${path}`);
	return file;
};

const pages = new Map<string, SiteResource>([
	[
		"/.well-known/maligator-site.json",
		{
			body: embedFile("../.cache/website-build/deployment.json").text(),
			type: "application/json",
		},
	],
	[
		"/favicon.ico",
		{ body: embedFile("./favicon.ico").bytes(), type: "image/vnd.microsoft.icon" },
	],
	[
		"/favicon-32x32.png",
		{ body: embedFile("./favicon-32x32.png").bytes(), type: "image/png" },
	],
	[
		"/apple-touch-icon.png",
		{ body: embedFile("./apple-touch-icon.png").bytes(), type: "image/png" },
	],
	["/", { body: embedFile("./index.html").text(), type: "text/html; charset=utf-8" }],
	[
		"/compatibility",
		{ body: embedFile("./compatibility.html").text(), type: "text/html; charset=utf-8" },
	],
	[
		"/explorer",
		{
			body: member(explorer, "index.html").text(),
			type: "text/html; charset=utf-8",
			explorer: true,
		},
	],
]);
for (const asset of member(explorer, "manifest.json").json() as Array<ExplorerAsset>) {
	pages.set(asset.url, {
		body: member(explorer, asset.file).bytes(),
		type: asset.type,
		bytes: asset.bytes,
		etag: `"${asset.digest}"`,
		encoding: asset.encoding,
		immutable: true,
		explorer: true,
	});
}
for (const asset of member(
	documentation,
	"manifest.json",
).json() as Array<ExplorerAsset>) {
	pages.set(asset.url, {
		body: member(documentation, asset.file).bytes(),
		type: asset.type,
		bytes: asset.bytes,
		etag: `"${asset.digest}"`,
		documentation: true,
	});
}
const hostname = process.env.SITE_HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? "3000");
const server = Mal.serve({
	hostname,
	port,
	fetch: (request) => siteResponse(request, pages),
});

// oxlint-disable-next-line no-console -- The standalone server needs one startup status line.
console.log(`Maligator site listening on http://${hostname}:${server.port}`);
