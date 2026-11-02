import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";

let model: CModel;
beforeAll(() => {
	const directory = mkdtempSync(join(tmpdir(), "mal-ffi-notification-contract-"));
	try {
		writeFileSync(
			join(directory, "notify.h"),
			`
            typedef struct Resource Resource;
            typedef int Row[3];
            void numeric(void (*callback)(const int *, int, void *), void *data, void (*release)(void *));
            void rows(void (*callback)(const Row *, int, void *), void *data, void (*release)(void *));
            void strings(void (*callback)(const char *const *, int, void *), void *data, void (*release)(void *));
            void resources(void (*callback)(Resource *const *, int, void *), void *data, void (*release)(void *));
        `,
		);
		const compiler = process.env.CC ?? "clang";
		const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
		expect(version.status, version.stderr).toBe(0);
		model = extractCModel({
			compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
			environment: process.env,
			headers: ["notify.h"],
			compileArguments: ["-I", directory],
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
it.each(["numeric", "rows", "strings"])(
	"declares copied notification arrays through %s",
	(name) => {
		const plan = planBindings(model, {
			types: {},
			functions: {
				[name]: {
					params: {
						callback: {
							callback: {
								data: "data",
								release: "release",
								queued: true,
								params: { "1": { array: { length: "2" } } },
							},
						},
					},
				},
			},
		});
		const declaration = [...generateDeclarations([{ name: "notify", plan }])].join("");
		expect(declaration).toContain(
			name === "rows"
				? "callback: (arg1: Array<[number, number, number]> | null) => void"
				: name === "strings"
					? "callback: (arg1: Array<string | null> | null) => void"
					: "callback: (arg1: Array<number> | null) => void",
		);
	},
);
it.each([["resources", "resource-bearing values"]])(
	"rejects notification arrays without a safe copy contract through %s",
	(name, diagnostic) => {
		expect(() =>
			planBindings(model, {
				types: { Resource: { handle: {} } },
				functions: {
					[name]: {
						params: {
							callback: {
								callback: {
									data: "data",
									release: "release",
									queued: true,
									params: { "1": { array: { length: "2" } } },
								},
							},
						},
					},
				},
			}),
		).toThrow(diagnostic);
	},
);
it("keeps pointer arrays available to waiting callbacks", () => {
	const plan = planBindings(model, {
		types: {},
		functions: {
			strings: {
				params: {
					callback: {
						callback: {
							data: "data",
							release: "release",
							queued: "wait",
							params: { "1": { array: { length: "2" } } },
						},
					},
				},
			},
		},
	});
	const declaration = [...generateDeclarations([{ name: "notify", plan }])].join("");
	expect(declaration).toContain("callback: (arg1: Array<string | null> | null) => void");
});
