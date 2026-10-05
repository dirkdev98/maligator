import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { developmentCompilerInstallation, prepareCommand } from "../src/cli-commands.ts";
import { parseCliArgs } from "../src/cli.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { createNodeCompilerService } from "../src/node-compiler-service.ts";

const installation = developmentCompilerInstallation(path.resolve("src"));

function command(entry: string, output: string) {
	const value = parseCliArgs(["build", entry, "--serialize", output]);
	if (value.kind !== "build") throw new Error("expected build command");
	return value;
}

describe("Node compiler service", () => {
	it("drains admitted builds before close with the same wire as the synchronous build kernel", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "mal-node-compiler-"));
		const service = createNodeCompilerService(installation);
		try {
			const entry = path.join(root, "entry.mts");
			writeFileSync(entry, "const value: number = 41; console.log(value + 1);\n");
			const expected = path.join(root, "expected.malw");
			prepareCommand(command(entry, expected), {
				installation,
				stripTypes: stripCompactTypes,
			});
			const first = service.prepare(command(entry, path.join(root, "first.malw")));
			const second = service.prepare(command(entry, path.join(root, "second.malw")));
			const closing = service.close();
			const results = await Promise.all([first, second]);
			await closing;
			for (const result of results) {
				expect(readFileSync(result.serializedPath!)).toEqual(readFileSync(expected));
			}
			await expect(service.prepare(command(entry, expected))).rejects.toThrow("closed");
		} finally {
			await service.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves a syntax failure and accepts a corrected subsequent compilation", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "mal-node-compiler-error-"));
		const service = createNodeCompilerService(installation);
		try {
			const entry = path.join(root, "entry.mts");
			const output = path.join(root, "output.malw");
			writeFileSync(entry, "const = ;\n");
			await expect(service.prepare(command(entry, output))).rejects.toBeInstanceOf(
				SyntaxError,
			);
			writeFileSync(entry, "console.log(42);\n");
			const result = await service.prepare(command(entry, output), {
				invalidatedPaths: [entry],
			});
			expect(result.serializedPath).toBe(output);
			expect(readFileSync(output).subarray(0, 4).toString()).toBe("MALW");
		} finally {
			await service.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects cancellation without losing the next admitted build", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "mal-node-compiler-cancel-"));
		const service = createNodeCompilerService(installation);
		try {
			const entry = path.join(root, "entry.mts");
			writeFileSync(entry, "console.log(42);\n");
			const controller = new AbortController();
			const cancelled = service.prepare(
				command(entry, path.join(root, "cancelled.malw")),
				{
					signal: controller.signal,
				},
			);
			const rejection = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
			controller.abort();
			const subsequent = service.prepare(command(entry, path.join(root, "next.malw")));
			await rejection;
			expect((await subsequent).serializedPath).toBe(path.join(root, "next.malw"));
		} finally {
			await service.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports observer failure only after the compilation has drained", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "mal-node-compiler-observer-"));
		const service = createNodeCompilerService(installation);
		try {
			const entry = path.join(root, "entry.mts");
			const output = path.join(root, "output.malw");
			writeFileSync(entry, "console.log(42);\n");
			const failure = new Error("observer failed");
			await expect(
				service.prepare(command(entry, output), {
					onPhase() {
						throw failure;
					},
				}),
			).rejects.toBe(failure);
			expect(readFileSync(output).subarray(0, 4).toString()).toBe("MALW");
			const next = await service.prepare(command(entry, path.join(root, "next.malw")));
			expect(readFileSync(next.serializedPath!)).toEqual(readFileSync(output));
		} finally {
			await service.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
