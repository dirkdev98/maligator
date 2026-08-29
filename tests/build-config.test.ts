import { createHash } from "node:crypto";
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
	intlDisabledDefines,
	loadBuildConfig,
	resolveBuildConfig,
	resolveOutputName,
} from "../src/build-config.ts";
import type { ResolvedBuildConfig } from "../src/build-config.ts";
import { featureDefines } from "../src/build-flags.ts";
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
		expect(config.surface).toEqual({ webPlatform: false, node: false, maligator: true });
		expect(config.assets).toEqual({});
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
				surface: { webPlatform: false, node: false, maligator: true },
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

	it("accepts strict file and directory asset entries", () => {
		const dir = tmpdir();
		writeConfig(
			dir,
			JSON.stringify({
				assets: {
					wire: { type: "file", path: "compiler.malw" },
					runtime: {
						type: "directory",
						path: "runtime",
						include: ["rust/Cargo.toml", "src/**"],
					},
				},
			}),
		);
		expect(loadBuildConfig(undefined, dir).assets.runtime).toEqual({
			type: "directory",
			path: "runtime",
			include: ["rust/Cargo.toml", "src/**"],
		});
	});

	it("rejects malformed asset entries and unknown fields", () => {
		const dir = tmpdir();
		writeConfig(
			dir,
			JSON.stringify({ assets: { runtime: { type: "directory", path: "runtime" } } }),
		);
		expect(() => loadBuildConfig(undefined, dir)).toThrow(
			/'assets\.runtime\.include' must be a non-empty array of strings/,
		);

		writeConfig(
			dir,
			JSON.stringify({
				assets: { runtime: { type: "file", path: "runtime", exclude: [] } },
			}),
		);
		expect(() => loadBuildConfig(undefined, dir)).toThrow(
			/unknown key 'assets\.runtime\.exclude'/,
		);
	});

	it("requires the Maligator surface when assets are configured", () => {
		expect(() =>
			resolveBuildConfig({
				assets: { data: { type: "file", path: "data.bin" } },
				surface: { maligator: false },
			}),
		).toThrow(/assets require surface\.maligator/);
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

describe("intl feature → cargo features + C defines", () => {
	const config = (intl: object) => resolveBuildConfig({ engine: { intl } });

	it("Intl off → no cargo features, no service defines (-DMAL_INTL=0 handles it)", () => {
		const off = config({ enabled: false });
		expect(intlCargoFeatures(off)).toEqual([]);
		expect(intlDisabledDefines(off)).toEqual([]);
	});

	it("all services (empty features) → default intl-full, no disable defines", () => {
		const all = config({ enabled: true });
		expect(intlCargoFeatures(all)).toEqual([]); // empty → cargo default (intl-full)
		expect(intlDisabledDefines(all)).toEqual([]);
	});

	it("subset → per-service cargo features + disable defines for the rest", () => {
		const subset = config({ enabled: true, features: ["number-format", "collator"] });
		expect(intlCargoFeatures(subset).sort()).toEqual([
			"intl-collator",
			"intl-number-format",
		]);
		const defines = intlDisabledDefines(subset);
		expect(defines).toContain("-DMAL_INTL_HAS_SEGMENTER=0");
		expect(defines).toContain("-DMAL_INTL_HAS_DISPLAY_NAMES=0");
		// selected services are NOT disabled
		expect(defines).not.toContain("-DMAL_INTL_HAS_COLLATOR=0");
		expect(defines).not.toContain("-DMAL_INTL_HAS_NUMBER_FORMAT=0");
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
		expect(featureDefines({ primordialsLocked: false })).toContain(
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
		expect(featureDefines({ temporalEnabled: false })).toContain("-DMAL_TEMPORAL=0");
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
		expect(featureDefines({ realmsEnabled: false })).toContain("-DMAL_REALMS=0");
		expect(featureDefines({ realmsEnabled: true })).not.toContain("-DMAL_REALMS=0");
		expect(featureDefines({})).not.toContain("-DMAL_REALMS=0");
	});

	it("realms-on is canonical (C suffix ''); realms-off gets a distinct C hash", () => {
		expect(buildConfigCacheSuffix(canonical)).toBe("");
		expect(buildConfigCacheSuffix(realmsOff)).toMatch(/^[0-9a-f]{8}$/);
		expect(buildConfigCacheSuffix(realmsOff)).not.toBe(buildConfigCacheSuffix(canonical));
	});
});

// The cache suffix moved from a streaming createHash("sha256").update(...).digest()
// to the one-shot node:crypto.hash(...) so the compiler dogfoods the native `hash`
// export. Both compute the same SHA-256 hex, so every suffix must be byte-identical
// to the pre-swap value. These tests pin output-name parity against the legacy
// digest and a literal.
describe("build-cache parity (createHash → node:crypto.hash swap)", () => {
	// The exact build-affecting projection the module hashes (key order matters for
	// JSON.stringify), reconstructed here so parity is checked against the legacy
	// streaming digest independent of build-config.ts's own hashing.
	function legacyShortHash(value: unknown): string {
		return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 8);
	}
	// Full reimplementation of the suffix function using the legacy streaming digest.
	function legacyCSuffix(c: ResolvedBuildConfig): string {
		const services = [...new Set(c.engine.intl.features)].sort();
		if (
			c.engine.eval &&
			c.engine.realms &&
			c.engine.intl.enabled &&
			services.length === 0 &&
			c.surface.webPlatform &&
			c.engine.regexp &&
			c.engine.temporal &&
			c.engine.primordials === "locked" &&
			!c.surface.node
		) {
			return "";
		}
		return legacyShortHash({
			eval: c.engine.eval,
			intl: c.engine.intl.enabled,
			services,
			web: c.surface.webPlatform,
			regexp: c.engine.regexp,
			temporal: c.engine.temporal,
			primordials: c.engine.primordials,
			node: c.surface.node,
			realms: c.engine.realms,
		});
	}
	const configs: Array<[string, ResolvedBuildConfig]> = [
		["eval-off", resolveBuildConfig({ engine: { eval: false } })],
		[
			"node-on",
			resolveBuildConfig({
				engine: { eval: true, intl: { enabled: true } },
				surface: { webPlatform: true, node: true },
			}),
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
		],
	];

	it.each(configs)("%s suffix matches the legacy streaming digest", (_name, config) => {
		expect(buildConfigCacheSuffix(config)).toBe(legacyCSuffix(config));
	});

	it("pins the node-on C suffix to its pre-swap literal", () => {
		const nodeOn = resolveBuildConfig({
			engine: { eval: true, intl: { enabled: true } },
			surface: { webPlatform: true, node: true },
		});
		expect(buildConfigCacheSuffix(nodeOn)).toBe("cd505751");
	});

	it("does not include executable assets in the output suffix", () => {
		const plain = resolveBuildConfig({});
		const withAssets = resolveBuildConfig({
			assets: { data: { type: "file", path: "data.bin" } },
		});
		expect(buildConfigCacheSuffix(withAssets)).toBe(buildConfigCacheSuffix(plain));
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
