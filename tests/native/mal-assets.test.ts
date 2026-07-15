import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { includeConfiguredAssets } from "../../src/assets.ts";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "mal-assets-native-"));
const sourceTree = path.join(root, "source");
const baseDirectory = path.join(root, "materialized");
const entry = path.join(root, "main.js");
const outDir = path.join(root, "out");

describe("mal.assets.materialize", () => {
	let binary: string;
	let expectedHash: string;
	let expectedFileHash: string;

	beforeAll(() => {
		mkdirSync(path.join(sourceTree, "nested"), { recursive: true });
		writeFileSync(path.join(sourceTree, "hello.txt"), "hello asset\n");
		writeFileSync(
			path.join(sourceTree, "nested", "bytes.bin"),
			new Uint8Array([0, 1, 2, 255]),
		);
		writeFileSync(
			entry,
			`console.log(globalThis.mal === mal && typeof mal.assets.materialize === "function");
const explicit = mal.assets.materialize("fixture", { baseDirectory: ${JSON.stringify(baseDirectory)} });
console.log(explicit);
console.log(explicit === mal.assets.materialize("fixture", { baseDirectory: ${JSON.stringify(baseDirectory)} }));
console.log(mal.assets.materialize("fixture"));
console.log(mal.assets.materialize("single", { baseDirectory: ${JSON.stringify(baseDirectory)} }));
try { mal.assets.materialize("missing"); } catch (error) { console.log(error.message); }
`,
		);
		const assets = {
			fixture: {
				type: "directory" as const,
				path: sourceTree,
				include: ["**/*"],
			},
			single: { type: "file" as const, path: path.join(sourceTree, "hello.txt") },
		};
		const included = includeConfiguredAssets(assets);
		expectedHash = included.find((asset) => asset.name === "fixture")!.hash;
		expectedFileHash = included.find((asset) => asset.name === "single")!.hash;
		const config = resolveBuildConfig({
			assets,
			engine: {
				eval: true,
				realms: true,
				regexp: true,
				intl: { enabled: true },
			},
			surface: { webPlatform: true, node: false, maligator: true },
		});
		binary = buildNativeBinary({
			fixture: entry,
			name: "mal-assets",
			outDir,
			config,
		});
	});

	function assertRun(env?: NodeJS.ProcessEnv): void {
		const lines = runToStdout(binary, { env }).trim().split("\n");
		expect(lines[0]).toBe("true");
		expect(lines[1]).toBe(path.join(realpathSync(baseDirectory), `${expectedHash}-1`));
		expect(lines[2]).toBe("true");
		expect(path.dirname(lines[3]!)).toBe(realpathSync(os.tmpdir()));
		expect(path.basename(lines[3]!)).toBe(`${expectedHash}-1`);
		expect(lines[4]).toBe(
			path.join(realpathSync(baseDirectory), `${expectedFileHash}-1`, "hello.txt"),
		);
		expect(lines[5]).toBe('Unknown configured asset "missing"');
		expect(readFileSync(path.join(lines[1]!, "hello.txt"), "utf8")).toBe("hello asset\n");
		expect(readFileSync(lines[4]!, "utf8")).toBe("hello asset\n");
		expect(readFileSync(path.join(lines[1]!, "nested", "bytes.bin"))).toEqual(
			Buffer.from([0, 1, 2, 255]),
		);
		expect(readFileSync(path.join(lines[1]!, ".maligator-asset-complete"), "utf8")).toBe(
			`${expectedHash}-1`,
		);
	}

	it("materializes exact bytes and reuses the completion marker", () => {
		assertRun();
	});

	it("keeps the nested API alive under GC stress", () => {
		assertRun(STRESS_ENV);
	});
});
