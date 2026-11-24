import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import { matchingNativeSymbols } from "../helpers/native-symbols.ts";

// Linking HOST_MAIN for a program that names no web global must not retain ada or its
// C++ dependency.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-web-off-"));
// Runtime eval can name any global, so it would link every web global.
const config = resolveBuildConfig({ engine: { eval: false, primordials: "mutable" } });

describe("a host program that names no web global", () => {
	let webOffBin: string;
	beforeAll(() => {
		webOffBin = buildNativeBinary({
			fixture: "tests/local/web_disabled.js",
			name: "web-disabled",
			mainFile: HOST_MAIN,
			outDir,
			config,
		});
	});

	it("links without the URL parser and runs the core engine", () => {
		assertResultPass(runToStdout(webOffBin));
	});

	it("still holds under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(webOffBin, { env: STRESS_ENV }));
	});

	it("does not retain the host entropy archive member", async () => {
		expect(
			await matchingNativeSymbols(webOffBin, (symbol) =>
				symbol.includes("mal_host_entropy"),
			),
		).toEqual([]);
	});

	it("links Ada only for the program that parses a URL", async () => {
		const webOnFixture = path.join(outDir, "web-enabled.js");
		writeFileSync(
			webOnFixture,
			`${readFileSync("tests/local/web_disabled.js", "utf8")}\nconsole.log(new URL("https://example.com/").host);\n`,
		);
		const webOnBin = buildNativeBinary({
			fixture: webOnFixture,
			name: "web-enabled",
			mainFile: HOST_MAIN,
			outDir,
			config,
		});
		const isAdaSymbol = (symbol: string) => symbol.startsWith("ada_");
		expect(await matchingNativeSymbols(webOffBin, isAdaSymbol)).toEqual([]);
		expect(await matchingNativeSymbols(webOnBin, isAdaSymbol)).toContain("ada_parse");
		expect(runToStdout(webOnBin)).toContain("example.com\n");
	});
});
