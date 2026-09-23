import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { compileBuildFrontend } from "../../src/build-frontend-cache.ts";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
import { buildNativeProgramImage } from "../../src/test-harness.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "core-private-cache-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it("keeps private brands distinct across cold and relocated warm Core imports", () => {
	const source = `
		export function makeClass() {
			return class Box {
				#value;
				constructor(value) { this.#value = value; }
				read() { return this.#value; }
				write(value) { this.#value = value; }
				static owns(value) { return #value in value; }
			};
		}
	`;
	writeFileSync(path.join(directory, "first.mjs"), source);
	writeFileSync(path.join(directory, "second.mjs"), source);
	const entry = path.join(directory, "entry.mjs");
	const body = `
		import { makeClass as first } from './first.mjs';
		import { makeClass as second } from './second.mjs';
		const First = first(), Second = second(), Later = first();
		const a = new First(11), b = new Second(22), c = new Later(33);
		a.write(44);
		console.log(a.read(), b.read(), c.read(), First.owns(a), First.owns(b), First.owns(c), Second.owns(b), Later.owns(a));
	`;
	writeFileSync(entry, body);
	const node = spawnSync(process.execPath, [entry], { encoding: "utf8" });
	expect(node.status).toBe(0);
	const options = {
		entrypoint: entry,
		cacheDirectory: path.join(directory, "cache"),
		config: resolveBuildConfig({}),
		stripTypes: stripCompactTypes,
		stripperIdentity: "private-core-native-test",
		forceCompile: true,
	};
	const compile = (cached: boolean, name: string) => {
		const frontend = compileBuildFrontend({ ...options, coreModuleCache: cached });
		const binary = buildNativeProgramImage(frontend.programImage, {
			name,
			outDir: directory,
			compiled: true,
			evalEnabled: false,
			realmsEnabled: false,
			intlEnabled: false,
			temporalEnabled: false,
			regexpEnabled: false,
			webPlatformEnabled: false,
		});
		const result = spawnSync(binary, [], { encoding: "utf8", timeout: 30_000 });
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toBe(node.stdout);
		return frontend;
	};
	compile(false, "private-ordinary");
	const cold = compile(true, "private-cold");
	expect(cold.coreModules).toMatchObject({ misses: 2, unsupported: 0 });
	writeFileSync(entry, `function insertedBeforeImports() { return 7; }\n${body}`);
	const warm = compile(true, "private-warm");
	expect(warm.coreModules).toMatchObject({
		hits: 2,
		misses: 0,
		constructedFunctions: 0,
		optimizedFunctions: 0,
	});
}, 120_000);
