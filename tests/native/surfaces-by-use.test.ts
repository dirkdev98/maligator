import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import type { MaligatorBuildConfig } from "../../src/build-config.ts";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

// Every program may reach the web and Node globals and modules without surface flags.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-surfaces-by-use-"));
const dataFile = path.join(outDir, "data.txt");
writeFileSync(dataFile, "data\n");

function build(
	name: string,
	source: string,
	compiled: boolean,
	config: MaligatorBuildConfig = {},
): string {
	const fixture = path.join(outDir, `${name}.mjs`);
	writeFileSync(fixture, source);
	return buildNativeBinary({
		fixture,
		name: `${name}-${compiled ? "compiled" : "interpreted"}`,
		compiled,
		outDir,
		config: resolveBuildConfig({ engine: { eval: false }, ...config }),
	});
}

const HOST_APIS = `import { readFileSync } from "node:fs";
const text = readFileSync(${JSON.stringify(dataFile)}, "utf8").trim();
const fetched = await (await fetch("data:text/plain,fetched")).text();
const query = new URL("https://example.com/a?b=c").searchParams.get("b");
console.log(text, fetched, query, Buffer.from("hi").toString("hex"), typeof process.pid);
`;

const SERVE = `import { serve } from "maligator:http";
const server = serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("served") });
console.log(await (await fetch(server.url)).text());
await server.close();
`;

// Node and Bun print the same two lines for this program.
const TIMERS = `const order = [];
const timeout = setTimeout(() => order.push("timeout"), 1);
const cleared = setTimeout(() => order.push("cleared"), 1);
clearTimeout(+cleared);
const interval = setInterval(function () {
	order.push(this === interval ? "interval-this" : "interval-wrong-this");
	clearInterval(this);
}, 1);
const immediate = setImmediate(() => order.push("immediate"));
const clearedImmediate = setImmediate(() => order.push("cleared-immediate"));
clearImmediate(clearedImmediate);
const unreferenced = setTimeout(() => order.push("unreferenced"), 60_000).unref();
let runs = 0;
const refreshed = setTimeout(() => (++runs === 1 ? refreshed.refresh() : order.push("refreshed")), 1);
console.log(
	typeof timeout,
	timeout.hasRef(),
	unreferenced.hasRef(),
	Number.isInteger(+timeout) && +timeout > 0,
	typeof immediate,
	immediate.hasRef(),
	timeout.refresh() === timeout,
);
setTimeout(() => console.log(order.sort().join(",")), 30);
`;

describe.each([
	["compiled", true],
	["interpreted", false],
])("a program without surface flags (%s)", (_backend, compiled) => {
	it("uses node:fs, fetch, URL, Buffer and process", () => {
		expect(runToStdout(build("host-apis", HOST_APIS, compiled)).trim()).toBe(
			"data fetched c 6869 number",
		);
	});

	it("serves with maligator:http", () => {
		expect(runToStdout(build("serve", SERVE, compiled)).trim()).toBe("served");
	});

	it("schedules Node timers that clear by their numeric id", () => {
		expect(
			runToStdout(build("timers", TIMERS, compiled))
				.trim()
				.split("\n"),
		).toEqual([
			"object true false true object true true",
			"immediate,interval-this,refreshed,timeout",
		]);
	});
});

describe("package export conditions", () => {
	const packageDir = path.join(outDir, "node_modules", "conditional");
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(
		path.join(packageDir, "package.json"),
		JSON.stringify({
			type: "module",
			exports: { browser: "./browser.js", node: "./node.js", import: "./import.js" },
		}),
	);
	for (const variant of ["browser", "node", "import"])
		writeFileSync(
			path.join(packageDir, `${variant}.js`),
			`export default "${variant}";\n`,
		);
	const source = `import selected from "conditional";\nconsole.log(selected);\n`;

	it("resolves a package to its Node build", () => {
		expect(runToStdout(build("conditions", source, true)).trim()).toBe("node");
	});

	it("resolves with the configured conditions instead", () => {
		const binary = build("configured-conditions", source, true, {
			modules: { conditions: ["maligator"] },
		});
		expect(runToStdout(binary).trim()).toBe("import");
	});
});
