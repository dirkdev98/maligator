import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { build } from "rolldown";
import { EXPLORER_SCHEMA } from "../src/explorer/config.ts";
import type { ExplorerSiteData } from "../src/explorer/protocol.ts";
import { SAMPLES } from "../src/explorer/samples.ts";
import type { WasmToolchain } from "../src/toolchain.ts";
import type { ExplorerAsset } from "../website/responses.ts";
import { explorerLicenses } from "./explorer-licenses.ts";

const digest = (bytes: Uint8Array | string) =>
	createHash("sha256").update(bytes).digest("hex");

export async function buildExplorerSite(): Promise<void> {
	execFileSync(process.execPath, ["scripts/build-wasm.ts"], { stdio: "inherit" });
	const root = path.resolve(".cache/explorer-site");
	mkdirSync(root, { recursive: true });
	const staging = mkdtempSync(path.join(root, "build-"));
	await build({
		input: { explorer: "website/explorer.ts", worker: "website/explorer-worker.ts" },
		platform: "browser",
		output: {
			dir: staging,
			format: "esm",
			entryFileNames: "[name].[hash].js",
			chunkFileNames: "chunk.[hash].js",
			minify: true,
		},
	});
	const assets: Array<ExplorerAsset> = [];
	function record(file: string, type: string, encoding?: "br", urlFile = file): string {
		const bytes = readFileSync(path.join(staging, file));
		const url = `/explorer/assets/${urlFile}`;
		assets.push({
			url,
			file,
			type,
			encoding,
			bytes: bytes.length,
			digest: digest(bytes),
		});
		return url;
	}
	const files = readdirSync(staging);
	for (const file of files) record(file, "text/javascript; charset=utf-8");
	function entry(name: string): string {
		const asset = assets.find((item) => item.file.startsWith(`${name}.`));
		if (asset === undefined) throw new Error(`Missing ${name} bundle`);
		return asset.url;
	}
	const wasm = readFileSync(".cache/wasm/explorer.wasm");
	const compressed = brotliCompressSync(wasm, {
		params: { [constants.BROTLI_PARAM_QUALITY]: 9 },
	});
	const wasmName = `compiler.${digest(wasm)}.wasm`;
	writeFileSync(path.join(staging, `${wasmName}.br`), compressed);
	const wasmUrl = record(`${wasmName}.br`, "application/wasm", "br", wasmName);
	// Explorer's CSP permits external styles only, including the shared site layout.
	const css = `${readFileSync("website/explorer.css", "utf8")}\n${readFileSync("website/templates/shared.css", "utf8")}`;
	const cssName = `explorer.${digest(css)}.css`;
	writeFileSync(path.join(staging, cssName), css);
	const cssUrl = record(cssName, "text/css; charset=utf-8");
	const manifest = JSON.parse(readFileSync(".cache/wasm/explorer.wasm.json", "utf8")) as {
		toolchain: WasmToolchain;
	};
	const notices = explorerLicenses(manifest.toolchain);
	const licenseName = `licenses.${digest(notices)}.txt`;
	writeFileSync(path.join(staging, licenseName), notices);
	const licenseUrl = record(licenseName, "text/plain; charset=utf-8");
	const data: ExplorerSiteData = {
		schema: EXPLORER_SCHEMA,
		identity: digest(
			JSON.stringify({ wasm: digest(wasm), assets, schema: EXPLORER_SCHEMA }),
		),
		version: (JSON.parse(readFileSync("package.json", "utf8")) as { version: string })
			.version,
		wasmUrl,
		wasmBytes: wasm.length,
		compressedBytes: compressed.length,
		workerUrl: entry("worker"),
		samples: SAMPLES,
	};
	const html = readFileSync("website/explorer.html", "utf8")
		.replace("__EXPLORER_CSS__", cssUrl)
		.replace("__EXPLORER_JS__", entry("explorer"))
		.replace("__LICENSES__", licenseUrl)
		.replace("__EXPLORER_DATA__", JSON.stringify(data).replaceAll("<", "\\u003c"));
	writeFileSync(path.join(staging, "index.html"), html);
	writeFileSync(
		path.join(staging, "manifest.json"),
		`${JSON.stringify(assets, null, 2)}\n`,
	);
	const current = path.join(root, "current");
	if (existsSync(current)) renameSync(current, path.join(root, `previous-${Date.now()}`));
	renameSync(staging, current);
	console.log(
		`[explorer] ${wasm.length} raw bytes, ${compressed.length} Brotli bytes; ${assets.length} assets`,
	);
}
