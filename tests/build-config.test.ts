import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertEvalPolicy,
	assertRegexpPolicy,
	BuildConfigError,
	buildConfigCacheSuffix,
	buildDerivationFromConfig,
	intlCargoFeatures,
	loadBuildConfig,
	resolveBuildConfig,
	resolveOutputName,
} from "../src/build-config.ts";
import type { MaligatorBuildConfig, ResolvedBuildConfig } from "../src/build-config.ts";
import { normalizeNativeFeatures } from "../src/build-flags.ts";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import {
	analyzeSourceAndRunSemanticAnalysis,
	collectDisallowedEvalUsage,
	collectDisallowedRegexpUsage,
} from "../src/compiler/frontend/semantic-analysis.ts";

function tmpdir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "mal-cfg-"));
}

function writeConfig(dir: string, contents: string): void {
	writeFileSync(
		path.join(dir, "maligator.build.ts"),
		`import { defineBuild } from "@maligator/cli";\nexport default defineBuild(${contents});\n`,
	);
}

describe("resolveBuildConfig defaults", () => {
	it("defaults eval OFF and picks the conservative product surface", () => {
		const config = resolveBuildConfig({});
		expect(config.engine.primordials).toBe("locked");
		expect(config.engine.eval).toBe(false);
		expect(config.engine.intl.enabled).toBe(false);
		expect(config.surface).toEqual({ webPlatform: false, node: false });
		expect(config.modules.aliases).toEqual({});
	});

	it("defaults RegExp ON (core language, unlike eval/Intl/web)", () => {
		expect(resolveBuildConfig({}).engine.regexp).toBe(true);
		expect(resolveBuildConfig({ engine: { regexp: false } }).engine.regexp).toBe(false);
	});

	it("defaults Temporal OFF and honors an explicit opt-in", () => {
		expect(resolveBuildConfig({}).engine.temporal).toBe(false);
		expect(resolveBuildConfig({ engine: { temporal: true } }).engine.temporal).toBe(true);
	});

	it("honors explicit values", () => {
		const config = resolveBuildConfig({ engine: { eval: true } });
		expect(config.engine.eval).toBe(true);
		expect(resolveBuildConfig({ engine: { eval: "compile-check" } }).engine.eval).toBe(
			"compile-check",
		);
	});

	it("allows conformance builds to opt into mutable primordials", () => {
		const config = resolveBuildConfig({ engine: { primordials: "mutable" } });
		expect(config.engine.primordials).toBe("mutable");
		expect(buildDerivationFromConfig(config).features.primordialsLocked).toBe(false);
		expect(buildDerivationFromConfig(config).features.cDefines).toContain(
			"-DMAL_PRIMORDIALS_LOCKED=0",
		);
	});
});

describe("loadBuildConfig", () => {
	it("returns defaults (eval OFF) when no config file is present", () => {
		expect(loadBuildConfig(undefined, tmpdir()).engine.eval).toBe(false);
	});

	it("reads maligator.build.ts from cwd", () => {
		const dir = tmpdir();
		writeConfig(dir, JSON.stringify({ engine: { eval: true } }));
		expect(loadBuildConfig(undefined, dir).engine.eval).toBe(true);
	});

	it("accepts the complete supported shape", () => {
		const dir = tmpdir();
		writeConfig(
			dir,
			JSON.stringify({
				entry: "src/main.ts",
				engine: { eval: false, intl: { enabled: false, languages: [] } },
				surface: { webPlatform: false, node: false },
			}),
		);
		expect(loadBuildConfig(undefined, dir).engine.eval).toBe(false);
	});

	it("rejects the removed host scheduler option", () => {
		const dir = tmpdir();
		writeConfig(dir, JSON.stringify({ host: { scheduler: "single" } }));
		expect(() => loadBuildConfig(undefined, dir)).toThrow(/unknown key 'host'/);
	});

	it("accepts exact module aliases", () => {
		const dir = tmpdir();
		writeConfig(
			dir,
			JSON.stringify({ modules: { aliases: { "package-entry": "./src/pure.ts" } } }),
		);
		expect(loadBuildConfig(undefined, dir).modules.aliases).toEqual({
			"package-entry": "./src/pure.ts",
		});
	});

	it("rejects malformed module aliases", () => {
		const dir = tmpdir();
		writeConfig(dir, JSON.stringify({ modules: { aliases: { package: "" } } }));
		expect(() => loadBuildConfig(undefined, dir)).toThrow(
			/modules\.aliases.*record of non-empty string replacements/,
		);
	});

	it("rejects the removed asset configuration", () => {
		const dir = tmpdir();
		writeConfig(
			dir,
			JSON.stringify({ assets: { data: { type: "file", path: "data.bin" } } }),
		);
		expect(() => loadBuildConfig(undefined, dir)).toThrow(/unknown key 'assets'/);
	});

	it("accepts C libraries with discovery overrides", () => {
		const dir = tmpdir();
		const ffi = {
			raylib: {
				contract: "native/raylib.ffi.ts",
				find: { pkgConfig: "raylib", frameworks: ["Cocoa"] },
				link: "shared",
			},
		};
		writeConfig(dir, JSON.stringify({ ffi }));
		expect(loadBuildConfig(undefined, dir).ffi).toEqual(ffi);
	});

	it("rejects C library names, discovery, and link modes it cannot use", () => {
		const dir = tmpdir();
		const rejects = (ffi: unknown, message: RegExp): void => {
			writeConfig(dir, JSON.stringify({ ffi }));
			expect(() => loadBuildConfig(undefined, dir)).toThrow(message);
		};
		rejects(
			{ "ray-lib": { contract: "a.ts" } },
			/'ffi\.ray-lib' must be named by lowercase/,
		);
		rejects(
			{ raylib: { contract: "a.ts", find: {} } },
			/'ffi\.raylib\.find' must name pkgConfig/,
		);
		rejects(
			{ raylib: { contract: "a.ts", find: { pkgConfig: "raylib", static: true } } },
			/unknown key 'ffi\.raylib\.find\.static'/,
		);
		rejects(
			{ raylib: { contract: "a.ts", link: "dynamic" } },
			/'ffi\.raylib\.link' must be "static" or "shared"/,
		);
	});

	it("throws when an explicit --config path is missing", () => {
		expect(() => loadBuildConfig("nope.json", tmpdir())).toThrow(BuildConfigError);
	});

	it("hard-errors on an unknown key", () => {
		const dir = tmpdir();
		writeConfig(dir, JSON.stringify({ engine: { evel: true } }));
		expect(() => loadBuildConfig(undefined, dir)).toThrow(/unknown key 'engine\.evel'/);
	});

	it("hard-errors on a wrong value type", () => {
		const dir = tmpdir();
		writeConfig(dir, JSON.stringify({ engine: { eval: "yes" } }));
		expect(() => loadBuildConfig(undefined, dir)).toThrow(
			/'engine\.eval' must be a boolean or "compile-check"/,
		);
	});

	it("rejects an unknown primordial policy", () => {
		const dir = tmpdir();
		writeConfig(dir, JSON.stringify({ engine: { primordials: "frozen" } }));
		expect(() => loadBuildConfig(undefined, dir)).toThrow(
			/'engine\.primordials' must be "locked" or "mutable"/,
		);
	});

	it("hard-errors on invalid JSON", () => {
		const dir = tmpdir();
		writeConfig(dir, "{ not valid TypeScript");
		expect(() => loadBuildConfig(undefined, dir)).toThrow(BuildConfigError);
	});

	it("hard-errors on locale subsetting (not yet supported)", () => {
		const dir = tmpdir();
		writeConfig(
			dir,
			JSON.stringify({ engine: { intl: { enabled: true, languages: ["en"] } } }),
		);
		expect(() => loadBuildConfig(undefined, dir)).toThrow(
			/locale subsetting.*not yet supported/,
		);
	});

	it("allows languages when Intl is disabled (irrelevant, no error)", () => {
		const dir = tmpdir();
		writeConfig(
			dir,
			JSON.stringify({ engine: { intl: { enabled: false, languages: ["en"] } } }),
		);
		expect(loadBuildConfig(undefined, dir).engine.intl.enabled).toBe(false);
	});

	it("hard-errors on an unknown intl.features service name", () => {
		const dir = tmpdir();
		writeConfig(
			dir,
			JSON.stringify({
				engine: { intl: { enabled: true, features: ["collator", "bogus"] } },
			}),
		);
		expect(() => loadBuildConfig(undefined, dir)).toThrow(/unknown service 'bogus'/);
	});

	it("accepts a valid intl.features subset", () => {
		const dir = tmpdir();
		writeConfig(
			dir,
			JSON.stringify({
				engine: { intl: { enabled: true, features: ["number-format"] } },
			}),
		);
		expect(loadBuildConfig(undefined, dir).engine.intl.features).toEqual([
			"number-format",
		]);
	});

	it("evaluates ordinary TypeScript configuration logic", () => {
		const dir = tmpdir();
		writeFileSync(
			path.join(dir, "maligator.build.ts"),
			`import { defineBuild } from "@maligator/cli";
const enabled: boolean = [1, 2, 3].length === 3;
function entry(): string { return "src/main.ts"; }
export default defineBuild({ entry: entry(), engine: { eval: enabled } });
`,
		);
		const config = loadBuildConfig(undefined, dir);
		expect(config.entry).toBe("src/main.ts");
		expect(config.engine.eval).toBe(true);
	});

	it("requires a default export", () => {
		const dir = tmpdir();
		writeFileSync(path.join(dir, "maligator.build.ts"), "const config = {};\n");
		expect(() => loadBuildConfig(undefined, dir)).toThrow(/missing default export/);
	});

	it("accepts the legacy maligator module spelling", () => {
		const dir = tmpdir();
		writeFileSync(
			path.join(dir, "maligator.build.ts"),
			`import { defineBuild } from "maligator";\nexport default defineBuild({ entry: "legacy.ts" });\n`,
		);
		expect(loadBuildConfig(undefined, dir).entry).toBe("legacy.ts");
	});

	it("rejects imports other than defineBuild from @maligator/cli", () => {
		const dir = tmpdir();
		writeFileSync(
			path.join(dir, "maligator.build.ts"),
			`import { readFileSync } from "node:fs";\nexport default {};\n`,
		);
		expect(() => loadBuildConfig(undefined, dir)).toThrow(/only.*defineBuild.*supported/);
	});

	it("preserves config source lines in evaluation errors", () => {
		const dir = tmpdir();
		writeFileSync(
			path.join(dir, "maligator.build.ts"),
			`import { defineBuild } from "@maligator/cli";
const message = "broken";
throw new Error(message);
export default defineBuild({});
`,
		);
		expect(() => loadBuildConfig(undefined, dir)).toThrow(/maligator\.build\.ts:3/);
	});
});

describe("resolveOutputName", () => {
	it("prefers outputName over package.json and the directory", () => {
		const dir = tmpdir();
		writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ name: "package-name" }),
		);
		expect(resolveOutputName(resolveBuildConfig({ outputName: "configured" }), dir)).toBe(
			"configured",
		);
	});

	it("uses the unscoped portion of package.json#name", () => {
		const dir = tmpdir();
		writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ name: "@scope/tool" }),
		);
		expect(resolveOutputName(resolveBuildConfig({}), dir)).toBe("tool");
	});

	it("falls back to the working-directory basename", () => {
		const dir = tmpdir();
		expect(resolveOutputName(resolveBuildConfig({}), dir)).toBe(path.basename(dir));
	});

	it.each(["", ".", "..", "nested/name", "nested\\name"])(
		"rejects unsafe configured output name %j",
		(outputName) => {
			expect(() =>
				resolveOutputName(resolveBuildConfig({ outputName }), tmpdir()),
			).toThrow(/non-empty binary name/);
		},
	);
});

describe("intl feature → cargo features", () => {
	const config = (intl: object) => resolveBuildConfig({ engine: { intl } });

	it("Intl off → no cargo features", () => {
		expect(intlCargoFeatures(config({ enabled: false }))).toEqual([]);
	});

	it("all services (empty features) → default intl-full", () => {
		expect(intlCargoFeatures(config({ enabled: true }))).toEqual([]); // empty → cargo default (intl-full)
	});

	it("subset → per-service cargo features", () => {
		const subset = config({ enabled: true, features: ["number-format", "collator"] });
		expect(intlCargoFeatures(subset).sort()).toEqual([
			"intl-collator",
			"intl-number-format",
		]);
	});

	it("compiles the same C runtime for every Intl and Temporal policy", () => {
		const engines: Array<NonNullable<MaligatorBuildConfig["engine"]>> = [
			{},
			{ temporal: true },
			{ intl: { enabled: true } },
			{ intl: { enabled: true, features: ["segmenter"] } },
		];
		const defines = engines.map(
			(engine) =>
				buildDerivationFromConfig(resolveBuildConfig({ engine })).features.cDefines,
		);
		expect(new Set(defines.map((entry) => JSON.stringify(entry))).size).toBe(1);
	});

	it("distinct feature sets get distinct output suffixes; all-services is canonical", () => {
		const all = resolveBuildConfig({
			engine: { eval: true, realms: true, temporal: true, intl: { enabled: true } },
			surface: { webPlatform: true },
		});
		const subset = resolveBuildConfig({
			engine: { eval: true, intl: { enabled: true, features: ["number-format"] } },
			surface: { webPlatform: true },
		});
		expect(buildConfigCacheSuffix(all)).toBe(""); // canonical
		expect(buildConfigCacheSuffix(subset)).toMatch(/^[0-9a-f]{8}$/);
		expect(buildConfigCacheSuffix(subset)).not.toBe(buildConfigCacheSuffix(all));
	});
});

describe("buildConfigCacheSuffix", () => {
	it("is empty for the canonical (eval-on, realms-on, Intl-on, web-on) archive", () => {
		expect(
			buildConfigCacheSuffix(
				resolveBuildConfig({
					engine: { eval: true, realms: true, temporal: true, intl: { enabled: true } },
					surface: { webPlatform: true },
				}),
			),
		).toBe("");
	});

	it("is a stable non-empty hash for eval-off", () => {
		const off = resolveBuildConfig({ engine: { eval: false } });
		const suffix = buildConfigCacheSuffix(off);
		expect(suffix).toMatch(/^[0-9a-f]{8}$/);
		expect(buildConfigCacheSuffix(off)).toBe(suffix);
	});

	it("separates mutable and locked primordial artifacts", () => {
		const locked = resolveBuildConfig({
			engine: { eval: true, realms: true, temporal: true, intl: { enabled: true } },
			surface: { webPlatform: true },
		});
		const mutable = resolveBuildConfig({
			engine: {
				primordials: "mutable",
				eval: true,
				realms: true,
				temporal: true,
				intl: { enabled: true },
			},
			surface: { webPlatform: true },
		});
		expect(buildConfigCacheSuffix(locked)).toBe("");
		expect(buildConfigCacheSuffix(mutable)).toMatch(/^[0-9a-f]{8}$/);
		expect(normalizeNativeFeatures({ primordialsLocked: false }).cDefines).toContain(
			"-DMAL_PRIMORDIALS_LOCKED=0",
		);
	});

	it("compile-check shares eval-off runtime features and cache identity", () => {
		const off = resolveBuildConfig({ engine: { eval: false } });
		const checked = resolveBuildConfig({ engine: { eval: "compile-check" } });
		expect(buildDerivationFromConfig(checked).features.evalEnabled).toBe(false);
		expect(buildDerivationFromConfig(checked).features).toEqual(
			buildDerivationFromConfig(off).features,
		);
		expect(buildConfigCacheSuffix(checked)).toBe(buildConfigCacheSuffix(off));
	});

	it("webPlatform-off gets a distinct non-empty output suffix", () => {
		const canonical = resolveBuildConfig({
			engine: { eval: true, intl: { enabled: true } },
			surface: { webPlatform: true },
		});
		const noWeb = resolveBuildConfig({
			engine: { eval: true, intl: { enabled: true } },
			surface: { webPlatform: false },
		});
		expect(buildConfigCacheSuffix(noWeb)).toMatch(/^[0-9a-f]{8}$/);
		expect(buildConfigCacheSuffix(noWeb)).not.toBe(buildConfigCacheSuffix(canonical));
	});

	it("regexp-off gets a distinct non-empty output suffix", () => {
		const canonical = resolveBuildConfig({
			engine: { eval: true, intl: { enabled: true } },
			surface: { webPlatform: true },
		});
		const noRegexp = resolveBuildConfig({
			engine: { eval: true, regexp: false, intl: { enabled: true } },
			surface: { webPlatform: true },
		});
		expect(buildConfigCacheSuffix(noRegexp)).toMatch(/^[0-9a-f]{8}$/);
		expect(buildConfigCacheSuffix(noRegexp)).not.toBe(buildConfigCacheSuffix(canonical));
	});

	it("Temporal-off gets a distinct non-empty output suffix", () => {
		const canonical = resolveBuildConfig({
			engine: { eval: true, realms: true, temporal: true, intl: { enabled: true } },
			surface: { webPlatform: true },
		});
		const noTemporal = resolveBuildConfig({
			engine: { eval: true, realms: true, temporal: false, intl: { enabled: true } },
			surface: { webPlatform: true },
		});
		expect(buildDerivationFromConfig(noTemporal).features.temporalEnabled).toBe(false);
		expect(buildDerivationFromConfig(canonical).features.temporalEnabled).toBe(true);
		expect(buildConfigCacheSuffix(noTemporal)).not.toBe(
			buildConfigCacheSuffix(canonical),
		);
	});
});

describe("surface.node build derivation + cache", () => {
	const canonical = resolveBuildConfig({
		engine: { eval: true, realms: true, temporal: true, intl: { enabled: true } },
		surface: { webPlatform: true },
	});
	const nodeOn = resolveBuildConfig({
		engine: { eval: true, realms: true, temporal: true, intl: { enabled: true } },
		surface: { webPlatform: true, node: true },
	});

	it("defaults node OFF and threads surface.node into the build derivation", () => {
		expect(buildDerivationFromConfig(resolveBuildConfig({})).features.nodeEnabled).toBe(
			false,
		);
		expect(buildDerivationFromConfig(nodeOn).features.nodeEnabled).toBe(true);
	});

	it("keeps the shared URL runtime in a node-only build", () => {
		const nodeOnly = resolveBuildConfig({
			surface: { webPlatform: false, node: true },
		});
		expect(buildDerivationFromConfig(nodeOnly).features.cargoFeatures).toContain("url");
	});

	it("node-on gets a distinct non-empty C cache suffix; node-off stays canonical", () => {
		// node defaults off and all internal-tooling builds are node-off, so node-off
		// keeps the unsuffixed (canonical) archive; node-on gets its own C archive.
		expect(buildConfigCacheSuffix(canonical)).toBe("");
		expect(buildConfigCacheSuffix(nodeOn)).toMatch(/^[0-9a-f]{8}$/);
		expect(buildConfigCacheSuffix(nodeOn)).not.toBe(buildConfigCacheSuffix(canonical));
	});
});

describe("engine.realms build plumbing", () => {
	const canonical = resolveBuildConfig({
		engine: { eval: true, realms: true, temporal: true, intl: { enabled: true } },
		surface: { webPlatform: true },
	});
	const realmsOff = resolveBuildConfig({
		engine: { eval: true, realms: false, intl: { enabled: true } },
		surface: { webPlatform: true },
	});

	it("defaults realms OFF (product default), honors explicit true", () => {
		expect(resolveBuildConfig({}).engine.realms).toBe(false);
		expect(resolveBuildConfig({ engine: { realms: true } }).engine.realms).toBe(true);
	});

	it("threads engine.realms into the build derivation", () => {
		expect(buildDerivationFromConfig(canonical).features.realmsEnabled).toBe(true);
		expect(buildDerivationFromConfig(realmsOff).features.realmsEnabled).toBe(false);
	});

	it("emits -DMAL_REALMS=0 only when realms is disabled", () => {
		expect(normalizeNativeFeatures({ realmsEnabled: false }).cDefines).toContain(
			"-DMAL_REALMS=0",
		);
		expect(normalizeNativeFeatures({ realmsEnabled: true }).cDefines).not.toContain(
			"-DMAL_REALMS=0",
		);
		expect(normalizeNativeFeatures({}).cDefines).not.toContain("-DMAL_REALMS=0");
	});

	it("realms-on is canonical (C suffix ''); realms-off gets a distinct C hash", () => {
		expect(buildConfigCacheSuffix(canonical)).toBe("");
		expect(buildConfigCacheSuffix(realmsOff)).toMatch(/^[0-9a-f]{8}$/);
		expect(buildConfigCacheSuffix(realmsOff)).not.toBe(buildConfigCacheSuffix(canonical));
	});
});

describe("build-cache suffix stability", () => {
	const configs: Array<[string, ResolvedBuildConfig, string]> = [
		["eval-off", resolveBuildConfig({ engine: { eval: false } }), "fdaeecf2"],
		[
			"node-on",
			resolveBuildConfig({
				engine: { eval: true, intl: { enabled: true } },
				surface: { webPlatform: true, node: true },
			}),
			"cd505751",
		],
		[
			"intl-subset + web-off",
			resolveBuildConfig({
				engine: {
					eval: true,
					regexp: false,
					intl: { enabled: true, features: ["segmenter"] },
				},
				surface: { webPlatform: false },
			}),
			"680c6d9c",
		],
	];

	it.each(configs)("%s has a stable output suffix", (_name, config, expected) => {
		expect(buildConfigCacheSuffix(config)).toBe(expected);
	});
});

/** Analyze a script and return its SemanticProgram. */
function analyze(source: string) {
	return analyzeSourceAndRunSemanticAnalysis(
		source,
		"test.js",
		parseScript(source, { strict: true }),
	);
}

const evalOff = resolveBuildConfig({ engine: { eval: false } });
const evalOn = resolveBuildConfig({ engine: { eval: true } });
const evalCompileCheck = resolveBuildConfig({ engine: { eval: "compile-check" } });

describe("collectDisallowedEvalUsage (narrow static check)", () => {
	it("flags a direct eval call", () => {
		const usages = collectDisallowedEvalUsage(analyze(`eval("1 + 1");`));
		expect(usages.map((u) => u.kind)).toEqual(["eval"]);
	});

	it("flags new Function and Function(...) constructions", () => {
		const usages = collectDisallowedEvalUsage(
			analyze(`new Function("return 1"); Function("return 2");`),
		);
		expect(usages.map((u) => u.kind)).toEqual(["Function", "Function"]);
	});

	it("does NOT flag aliased indirect eval (runtime gate's job)", () => {
		expect(collectDisallowedEvalUsage(analyze(`const e = eval; e("1");`))).toEqual([]);
	});

	it("does NOT flag harmless bare references", () => {
		const usages = collectDisallowedEvalUsage(
			analyze(
				`const t = typeof eval; const b = ({}) instanceof Function; Function.prototype;`,
			),
		);
		expect(usages).toEqual([]);
	});

	it("does NOT flag a shadowing local eval", () => {
		const usages = collectDisallowedEvalUsage(
			analyzeSourceAndRunSemanticAnalysis(
				`function eval(s){ return s; } eval("x");`,
				"test.js",
				parseScript(`function eval(s){ return s; } eval("x");`, { strict: false }),
			),
		);
		expect(usages).toEqual([]);
	});
});

describe("assertEvalPolicy", () => {
	it("throws with the offending sites in compile-check mode", () => {
		const usages = collectDisallowedEvalUsage(analyze(`eval("x");`));
		expect(() => assertEvalPolicy(evalCompileCheck, usages)).toThrow(
			/engine\.eval is "compile-check"/,
		);
	});

	it("is a no-op when eval is enabled", () => {
		const usages = collectDisallowedEvalUsage(analyze(`eval("x");`));
		expect(() => assertEvalPolicy(evalOn, usages)).not.toThrow();
	});

	it("is a no-op when eval is runtime-disabled", () => {
		const usages = collectDisallowedEvalUsage(analyze(`eval("x");`));
		expect(() => assertEvalPolicy(evalOff, usages)).not.toThrow();
	});

	it("is a no-op when nothing was flagged", () => {
		expect(() => assertEvalPolicy(evalOff, [])).not.toThrow();
	});
});

const regexpOff = resolveBuildConfig({ engine: { regexp: false } });
const regexpOn = resolveBuildConfig({}); // default ON

describe("collectDisallowedRegexpUsage + assertRegexpPolicy", () => {
	it("flags a regex literal and new RegExp / RegExp(...) on the global", () => {
		expect(
			collectDisallowedRegexpUsage(analyze(`const r = /a/g;`)).map((u) => u.kind),
		).toEqual(["literal"]);
		expect(
			collectDisallowedRegexpUsage(analyze(`new RegExp("a"); RegExp("b");`)).map(
				(u) => u.kind,
			),
		).toEqual(["RegExp", "RegExp"]);
	});

	it("does not flag a shadowed local RegExp binding or a bare reference", () => {
		expect(
			collectDisallowedRegexpUsage(analyze(`function RegExp(){} RegExp();`)),
		).toEqual([]);
		expect(collectDisallowedRegexpUsage(analyze(`typeof RegExp;`))).toEqual([]);
	});

	it("throws when regexp is disabled and a literal is present", () => {
		const usages = collectDisallowedRegexpUsage(analyze(`const r = /a/;`));
		expect(() => assertRegexpPolicy(regexpOff, usages)).toThrow(
			/engine\.regexp is false/,
		);
	});

	it("is a no-op when regexp is enabled (the default) or nothing was flagged", () => {
		const usages = collectDisallowedRegexpUsage(analyze(`const r = /a/;`));
		expect(() => assertRegexpPolicy(regexpOn, usages)).not.toThrow();
		expect(() => assertRegexpPolicy(regexpOff, [])).not.toThrow();
	});
});
