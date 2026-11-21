import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import {
	WatchProducers,
	producerTasks,
	runBuildProducers,
} from "../src/asset-producers.ts";
import type { ProducerCommand } from "../src/asset-producers.ts";
import { BuildConfigError } from "../src/build-config.ts";
import { canonicalEmbedDeclaration } from "../src/compiler/frontend/embed-declarations.ts";
import type { EmbedRequest } from "../src/compiler/frontend/embed-declarations.ts";

const root = mkdtempSync(path.join(tmpdir(), "mal-asset-producers-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function declare(file: string, options: Omit<EmbedRequest, "kind" | "specifier">) {
	return canonicalEmbedDeclaration(
		{ kind: "directory", specifier: file, ...options },
		path.join(root, file),
		(cwd) => path.join(root, cwd ?? "."),
	);
}

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}

const build = { command: ["make"] };
const watch = { command: ["serve"], url: "http://127.0.0.1:1" };
const modes = (
	command: ProducerCommand,
	...declarations: Array<ReturnType<typeof declare>>
) => producerTasks(declarations, command).map((task) => task.mode);

describe("asset producer selection", () => {
	it("builds for build and run, uses existing files for test and watches in dev", () => {
		const both = declare("web", { build, watch });
		expect(modes("build", both)).toEqual(["build"]);
		expect(modes("run", both)).toEqual(["build"]);
		expect(modes("test", both)).toEqual([]);
		expect(modes("dev", both)).toEqual(["watch"]);
		expect(modes("dev", declare("css", { build }))).toEqual(["build"]);
	});

	it("follows the declaration's use option", () => {
		const declaration = declare("web", {
			build,
			watch,
			use: { build: "existing", run: "watch", test: "build", dev: "existing" },
		});
		expect(modes("build", declaration)).toEqual([]);
		expect(modes("run", declaration)).toEqual(["watch"]);
		expect(modes("test", declaration)).toEqual(["build"]);
		expect(modes("dev", declaration)).toEqual([]);
	});

	it("runs one task for declarations that share a producer", () => {
		const tasks = producerTasks(
			[declare("web/dist", { build }), declare("web/assets", { build })],
			"build",
		);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.outputs).toEqual([
			path.join(root, "web/dist"),
			path.join(root, "web/assets"),
		]);
	});
});

describe("asset producer processes", () => {
	it("runs a build producer in its directory and reports a failure", () => {
		const output = path.join(root, "built.txt");
		const script = `require("node:fs").writeFileSync("built.txt", process.cwd())`;
		runBuildProducers(
			producerTasks(
				[declare("built.txt", { build: { command: [process.execPath, "-e", script] } })],
				"build",
			),
			() => {},
		);
		expect(readFileSync(output, "utf8")).toBe(root);
		expect(() =>
			runBuildProducers(
				producerTasks(
					[
						declare("failed", {
							build: { command: [process.execPath, "-e", "process.exit(3)"] },
						}),
					],
					"build",
				),
				() => {},
			),
		).toThrow(BuildConfigError);
	});

	it.skipIf(process.platform === "win32")(
		"waits for a watcher's server and stops its process group",
		async () => {
			const port = await freePort();
			const pidFile = path.join(root, "grandchild.pid");
			const server = path.join(root, "server.cjs");
			writeFileSync(
				server,
				`const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setTimeout(() => {
	require("node:http")
		.createServer((_request, response) => response.end("ok"))
		.listen(${port}, "127.0.0.1");
}, 300);
`,
			);
			const watchers = new WatchProducers(() => {});
			try {
				await watchers.ensure(
					producerTasks(
						[
							declare("served", {
								watch: {
									command: [process.execPath, server],
									url: `http://127.0.0.1:${port}/`,
								},
							}),
						],
						"dev",
					),
				);
				expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
			} finally {
				await watchers.close();
			}
			const grandchild = Number(readFileSync(pidFile, "utf8"));
			await delay(200);
			expect(() => process.kill(grandchild, 0)).toThrow();
		},
	);

	it("fails when a watcher exits before its server answers", async () => {
		const watchers = new WatchProducers(() => {});
		try {
			await expect(
				watchers.ensure(
					producerTasks(
						[
							declare("crashed", {
								watch: {
									command: [process.execPath, "-e", "process.exit(4)"],
									url: `http://127.0.0.1:${await freePort()}/`,
								},
							}),
						],
						"dev",
					),
				),
			).rejects.toThrow(/stopped with exit code 4/);
		} finally {
			await watchers.close();
		}
	});
});
