import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import type { ExplorerAsset } from "../website/responses.ts";

export const DEPLOYMENT_FILE = ".cache/website-build/deployment.json";
export const DEPLOYMENT_ROUTE = "/.well-known/maligator-site.json";
export const SITE_ORIGIN = "https://maligator.ddv.tools";
const INPUTS = [
	"website",
	"src",
	"runtime",
	"scripts",
	"package.json",
	"package-lock.json",
	".npmrc",
	".oxfmtrc.json",
	"LICENSE",
	"bench/baseline.json",
	"tests/wpt/curated.json",
	"tests/wpt/expectations.json",
	".github/workflows/website-build.yml",
	".github/actions/setup-linux/action.yml",
];

interface Deployment {
	schema: 1;
	digest: string;
	revision: string;
}

export function siteInputDigest(root = process.cwd()): string {
	const git = (args: Array<string>) =>
		execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
	const hash = createHash("sha256");
	const files = git(["ls-files", "-z", "--", ...INPUTS])
		.toString()
		.split("\0")
		.filter(Boolean)
		.sort();
	for (const file of files) {
		const body = readFileSync(path.join(root, file));
		hash.update(`${file}\0${body.length}\0`).update(body);
	}
	// Chart labels and weekly samples depend on history as well as current file bytes.
	for (const file of ["bench/baseline.json", "scripts/test262.json"])
		hash
			.update(`${file}\0`)
			.update(git(["log", "--follow", "--format=%H %cI", "--", file]));
	return hash.digest("hex");
}

export function writeSiteDeployment(): Deployment {
	const deployment: Deployment = {
		schema: 1,
		digest: siteInputDigest(),
		revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	};
	mkdirSync(path.dirname(DEPLOYMENT_FILE), { recursive: true });
	writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(deployment, null, 2)}\n`);
	console.log(`[site-deployment] ${DEPLOYMENT_FILE}: ${deployment.digest}`);
	return deployment;
}

export async function deployedDigest(origin: string): Promise<string | undefined> {
	const response = await fetch(new URL(DEPLOYMENT_ROUTE, origin), {
		headers: { "Cache-Control": "no-cache" },
		signal: AbortSignal.timeout(30_000),
	});
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`Deployment marker returned HTTP ${response.status}`);
	const value: unknown = await response.json();
	if (
		typeof value !== "object" ||
		value === null ||
		!("schema" in value) ||
		value.schema !== 1 ||
		!("digest" in value) ||
		typeof value.digest !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.digest)
	)
		throw new Error("Invalid website deployment marker");
	return value.digest;
}

export async function verifySiteResponses(
	origin: string,
	root = process.cwd(),
): Promise<void> {
	const files: Array<{ url: string; file: string; encoding?: "br" }> = [
		{ url: DEPLOYMENT_ROUTE, file: DEPLOYMENT_FILE },
		{ url: "/", file: "website/index.html" },
		{ url: "/compatibility", file: "website/compatibility.html" },
		{ url: "/explorer", file: ".cache/explorer-site/current/index.html" },
		{ url: "/favicon.ico", file: "website/favicon.ico" },
		{ url: "/favicon-32x32.png", file: "website/favicon-32x32.png" },
		{ url: "/apple-touch-icon.png", file: "website/apple-touch-icon.png" },
	];
	for (const directory of [
		".cache/explorer-site/current",
		".cache/documentation/container",
	]) {
		const assets = JSON.parse(
			readFileSync(path.join(root, directory, "manifest.json"), "utf8"),
		) as Array<ExplorerAsset>;
		files.push(
			...assets.map((asset) => ({
				url: asset.url,
				file: path.join(directory, asset.file),
				encoding: asset.encoding,
			})),
		);
	}
	const results: Array<{ url: string; digest: string }> = [];
	for (let start = 0; start < files.length; start += 8) {
		results.push(
			...(await Promise.all(
				files.slice(start, start + 8).map(async (file) => {
					const response = await fetch(new URL(file.url, origin), {
						headers: { "Cache-Control": "no-cache", "Accept-Encoding": "br, gzip" },
						signal: AbortSignal.timeout(30_000),
					});
					if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
					const stored = readFileSync(path.join(root, file.file));
					const expected = file.encoding === "br" ? brotliDecompressSync(stored) : stored;
					const actual = Buffer.from(await response.arrayBuffer());
					if (!actual.equals(expected))
						throw new Error(`${file.url}: response differs from build`);
					return {
						url: file.url,
						digest: createHash("sha256").update(actual).digest("hex"),
					};
				}),
			)),
		);
	}
	const report = path.join(
		root,
		`.cache/website-build/verification-${new URL(origin).hostname}.json`,
	);
	mkdirSync(path.dirname(report), { recursive: true });
	writeFileSync(report, `${JSON.stringify({ origin, results }, null, 2)}\n`);
	console.log(`[site-deployment] ${results.length} responses match: ${report}`);
}

async function main(): Promise<void> {
	const [command, origin = SITE_ORIGIN] = process.argv.slice(2);
	if (command === "check") {
		const digest = siteInputDigest();
		const changed = (await deployedDigest(origin)) !== digest;
		console.log(`[site-deployment] ${changed ? "Changed" : "Unchanged"}: ${digest}`);
		if (process.env.GITHUB_OUTPUT)
			writeFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\ndigest=${digest}\n`, {
				flag: "a",
			});
	} else if (command === "verify") {
		if (process.argv.includes("--wait")) {
			const { digest } = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Deployment;
			const deadline = Date.now() + 15 * 60_000;
			while (true) {
				try {
					if ((await deployedDigest(origin)) === digest) break;
				} catch (error) {
					console.log(
						`[site-deployment] Waiting for container rollout: ${String(error)}`,
					);
				}
				if (Date.now() >= deadline)
					throw new Error("Timed out waiting for the website container rollout");
				await setTimeout(10_000);
			}
			// The marker flips on the first new container; the rest of the rollout can
			// still answer a page with HTTP 500 for a few seconds.
			console.log("[site-deployment] Marker matches; letting the rollout settle for 30s");
			await setTimeout(30_000);
		}
		await verifySiteResponses(origin);
	} else {
		throw new Error(
			"Usage: node scripts/site-deployment.ts check|verify [origin] [--wait]",
		);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	await main();
