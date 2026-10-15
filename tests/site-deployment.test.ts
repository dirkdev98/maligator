import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { brotliCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEPLOYMENT_FILE,
	DEPLOYMENT_ROUTE,
	deployedDigest,
	siteInputDigest,
	verifySiteResponses,
} from "../scripts/site-deployment.ts";

let root: string;
let server: Server | undefined;

function write(file: string, body: string | Uint8Array): void {
	mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	writeFileSync(path.join(root, file), body);
}

function git(...args: Array<string>): void {
	execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

function commit(): void {
	git("add", ".");
	git(
		"-c",
		"user.name=Website test",
		"-c",
		"user.email=website@example.com",
		"commit",
		"--no-gpg-sign",
		"-m",
		"fixture",
	);
}

async function serve(
	resources: Map<
		string,
		{ body: string | Uint8Array; status?: number; encoding?: string }
	>,
): Promise<string> {
	server = createServer((request, response) => {
		const resource = resources.get(request.url!);
		response.statusCode = resource?.status ?? (resource === undefined ? 404 : 200);
		if (resource?.encoding) response.setHeader("Content-Encoding", resource.encoding);
		response.end(resource?.body);
	});
	await new Promise<void>((resolve) => {
		server!.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("Missing server port");
	return `http://127.0.0.1:${address.port}`;
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "maligator-site-deployment-"));
});

afterEach(async () => {
	if (server !== undefined) {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => {
			server!.close((error) => (error ? reject(error) : resolve()));
		});
		server = undefined;
	}
	rmSync(root, { recursive: true, force: true });
});

describe("website deployment inputs", () => {
	it("ignores unrelated commits but notices source edits and reversions", () => {
		git("init", "--quiet");
		write("src/index.ts", "export const version = 1;\n");
		commit();
		const original = siteInputDigest(root);
		write("README.md", "Unrelated project note\n");
		commit();
		expect(siteInputDigest(root)).toBe(original);
		write("src/index.ts", "export const version = 2;\n");
		expect(siteInputDigest(root)).not.toBe(original);
		write("src/index.ts", "export const version = 1;\n");
		expect(siteInputDigest(root)).toBe(original);
	});

	it("includes chart history even when the current baseline bytes return to an earlier value", () => {
		git("init", "--quiet");
		write("bench/baseline.json", '{"measurement":1}\n');
		commit();
		const original = siteInputDigest(root);
		write("bench/baseline.json", '{"measurement":2}\n');
		commit();
		write("bench/baseline.json", '{"measurement":1}\n');
		commit();
		expect(siteInputDigest(root)).not.toBe(original);
	});
});

describe("live website deployment", () => {
	it("recognizes bootstrap, matching deployments, and errors without treating an outage as a change", async () => {
		const resources = new Map<string, { body: string; status?: number }>();
		const origin = await serve(resources);
		expect(await deployedDigest(origin)).toBeUndefined();
		const digest = "a".repeat(64);
		resources.set(DEPLOYMENT_ROUTE, { body: JSON.stringify({ schema: 1, digest }) });
		expect(await deployedDigest(origin)).toBe(digest);
		resources.set(DEPLOYMENT_ROUTE, { body: "Unavailable", status: 503 });
		await expect(deployedDigest(origin)).rejects.toThrow("HTTP 503");
		resources.set(DEPLOYMENT_ROUTE, { body: '{"schema":1,"digest":"invalid"}' });
		await expect(deployedDigest(origin)).rejects.toThrow(
			"Invalid website deployment marker",
		);
	});

	it("compares decoded container responses, including documentation and compressed Explorer assets", async () => {
		const resources = new Map<string, { body: string | Uint8Array; encoding?: string }>();
		const pages = [
			[DEPLOYMENT_ROUTE, DEPLOYMENT_FILE],
			["/", "website/index.html"],
			["/compatibility", "website/compatibility.html"],
			["/explorer", ".cache/explorer-site/current/index.html"],
			["/favicon.ico", "website/favicon.ico"],
			["/favicon-32x32.png", "website/favicon-32x32.png"],
			["/apple-touch-icon.png", "website/apple-touch-icon.png"],
		];
		for (const [url, file] of pages) {
			write(file!, `contents of ${url}`);
			resources.set(url!, { body: readFileSync(path.join(root, file!)) });
		}
		const wasm = brotliCompressSync(Buffer.from("Explorer compiler bytes"));
		write(".cache/explorer-site/current/compiler.wasm.br", wasm);
		write(
			".cache/explorer-site/current/manifest.json",
			JSON.stringify([
				{
					url: "/explorer/assets/compiler.wasm",
					file: "compiler.wasm.br",
					encoding: "br",
				},
			]),
		);
		resources.set("/explorer/assets/compiler.wasm", { body: wasm, encoding: "br" });
		write(".cache/documentation/container/docs.html", "<h1>Documentation</h1>");
		write(
			".cache/documentation/container/manifest.json",
			JSON.stringify([{ url: "/docs", file: "docs.html" }]),
		);
		resources.set("/docs", { body: "<h1>Documentation</h1>" });
		const origin = await serve(resources);
		await verifySiteResponses(origin, root);
		const report = JSON.parse(
			readFileSync(
				path.join(root, ".cache/website-build/verification-127.0.0.1.json"),
				"utf8",
			),
		) as { results: Array<unknown> };
		expect(report.results).toHaveLength(9);
		resources.set("/docs", { body: "Stale documentation" });
		await expect(verifySiteResponses(origin, root)).rejects.toThrow(
			"/docs: response differs from build",
		);
	});
});
