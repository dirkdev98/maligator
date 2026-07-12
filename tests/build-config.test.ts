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
	rustConfigCacheSuffix,
} from "../src/build-config.ts";
import type { ResolvedBuildConfig } from "../src/build-config.ts";
import { parseScript } from "../src/parser.ts";
import {
	analyzeSourceAndRunSemanticAnalysis,
	collectDisallowedEvalUsage,
	collectDisallowedRegexpUsage,
} from "../src/semantic-analysis.ts";

function tmpdir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "mal-cfg-"));
}

function writeConfig(dir: string, contents: string): void {
	writeFileSync(path.join(dir, "maligator.build.json"), contents);
}

describe("resolveBuildConfig defaults", () => {
	it("defaults eval OFF and picks the conservative product surface", () => {
		const config = resolveBuildConfig({});
		expect(config.engine.eval).toBe(false);
		expect(config.engine.intl.enabled).toBe(false);
		expect(config.host.scheduler).toBe("single");
		expect(config.surface).toEqual({ webPlatform: false, node: false, maligator: true });
	});

	it("defaults RegExp ON (core language, unlike eval/Intl/web)", () => {
		expect(resolveBuildConfig({}).engine.regexp).toBe(true);
		expect(resolveBuildConfig({ engine: { regexp: false } }).engine.regexp).toBe(false);
	});

	it("honors explicit values", () => {
		const config = resolveBuildConfig({ engine: { eval: true } });
		expect(config.engine.eval).toBe(true);
	});
});

describe("loadBuildConfig", () => {
	it("returns defaults (eval OFF) when no config file is present", () => {
		expect(loadBuildConfig(undefined, tmpdir()).engine.eval).toBe(false);
	});

	it("reads maligator.build.json from cwd", () => {
		const dir = tmpdir();
		writeConfig(dir, JSON.stringify({ engine: { eval: true } }));
		expect(loadBuildConfig(undefined, dir).engine.eval).toBe(true);
	});

	it("accepts the full issue #2 shape", () => {
		const dir = tmpdir();
		writeConfig(
			dir,
			JSON.stringify({
				entry: "src/main.ts",
				engine: { eval: false, intl: { enabled: false, languages: [] } },
				host: { scheduler: "single" },
				surface: { webPlatform: false, node: false, maligator: true },
			}),
		);
		expect(loadBuildConfig(undefined, dir).engine.eval).toBe(false);
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
			/'engine\.eval' must be a boolean/,
		);
	});

	it("hard-errors on invalid JSON", () => {
		const dir = tmpdir();
		writeConfig(dir, "{ not json");
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

	it("distinct feature sets get distinct cache suffixes; all-services is canonical", () => {
		const all = resolveBuildConfig({
			engine: { eval: true, intl: { enabled: true } },
			surface: { webPlatform: true },
		});
		const subset = resolveBuildConfig({
			engine: { eval: true, intl: { enabled: true, features: ["number-format"] } },
			surface: { webPlatform: true },
		});
		expect(buildConfigCacheSuffix(all)).toBe(""); // canonical
		expect(rustConfigCacheSuffix(all)).toBe("");
		expect(buildConfigCacheSuffix(subset)).toMatch(/^[0-9a-f]{8}$/);
		expect(rustConfigCacheSuffix(subset)).toMatch(/^[0-9a-f]{8}$/);
		expect(buildConfigCacheSuffix(subset)).not.toBe(buildConfigCacheSuffix(all));
	});
});

describe("buildConfigCacheSuffix", () => {
	it("is empty for the canonical (eval-on, Intl-on, web-on) archive", () => {
		expect(
			buildConfigCacheSuffix(
				resolveBuildConfig({
					engine: { eval: true, intl: { enabled: true } },
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

	it("webPlatform-off is a distinct non-empty hash for both the C and Rust archives", () => {
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
		// The Rust archive changes too (ada in/out), so its suffix must differ.
		expect(rustConfigCacheSuffix(noWeb)).not.toBe(rustConfigCacheSuffix(canonical));
	});

	it("regexp-off is a distinct non-empty hash for both the C and Rust archives", () => {
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
		// The Rust archive changes too (regress in/out), so its suffix must differ.
		expect(rustConfigCacheSuffix(noRegexp)).not.toBe(rustConfigCacheSuffix(canonical));
	});
});

describe("surface.node build derivation + cache", () => {
	const canonical = resolveBuildConfig({
		engine: { eval: true, intl: { enabled: true } },
		surface: { webPlatform: true },
	});
	const nodeOn = resolveBuildConfig({
		engine: { eval: true, intl: { enabled: true } },
		surface: { webPlatform: true, node: true },
	});

	it("defaults node OFF and threads surface.node into the build derivation", () => {
		expect(buildDerivationFromConfig(resolveBuildConfig({})).nodeEnabled).toBe(false);
		expect(buildDerivationFromConfig(nodeOn).nodeEnabled).toBe(true);
	});

	it("node-on gets a distinct non-empty C cache suffix; node-off stays canonical", () => {
		// node defaults off and all internal-tooling builds are node-off, so node-off
		// keeps the unsuffixed (canonical) archive; node-on gets its own C archive.
		expect(buildConfigCacheSuffix(canonical)).toBe("");
		expect(buildConfigCacheSuffix(nodeOn)).toMatch(/^[0-9a-f]{8}$/);
		expect(buildConfigCacheSuffix(nodeOn)).not.toBe(buildConfigCacheSuffix(canonical));
	});

	it("node does NOT change the Rust cache suffix (node adds no Rust deps)", () => {
		expect(rustConfigCacheSuffix(nodeOn)).toBe(rustConfigCacheSuffix(canonical));
	});
});

// The cache suffix moved from a streaming createHash("sha256").update(...).digest()
// to the one-shot node:crypto.hash(...) so the compiler dogfoods the native `hash`
// export. Both compute the same SHA-256 hex, so every suffix must be byte-identical
// to the pre-swap value — a drift here would silently orphan already-cached C/Rust
// archives. These tests pin that parity (against the legacy digest and a literal).
describe("build-cache parity (createHash → node:crypto.hash swap)", () => {
	// The exact build-affecting projection the module hashes (key order matters for
	// JSON.stringify), reconstructed here so parity is checked against the legacy
	// streaming digest independent of build-config.ts's own hashing.
	function legacyShortHash(value: unknown): string {
		return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 8);
	}
	// Full reimplementations of the two suffix functions using the legacy streaming
	// digest — canonical-"" shortcuts included — so the swap is proven byte-identical
	// across every axis (a canonical archive still yields "", a non-canonical one the
	// same hash as before).
	function legacyCSuffix(c: ResolvedBuildConfig): string {
		const services = [...new Set(c.engine.intl.features)].sort();
		if (
			c.engine.eval &&
			c.engine.intl.enabled &&
			services.length === 0 &&
			c.surface.webPlatform &&
			c.engine.regexp &&
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
			node: c.surface.node,
		});
	}
	function legacyRustSuffix(c: ResolvedBuildConfig): string {
		const services = [...new Set(c.engine.intl.features)].sort();
		if (
			c.engine.intl.enabled &&
			services.length === 0 &&
			c.surface.webPlatform &&
			c.engine.regexp
		) {
			return "";
		}
		return legacyShortHash({
			intl: c.engine.intl.enabled,
			services,
			web: c.surface.webPlatform,
			regexp: c.engine.regexp,
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

	it.each(configs)("%s suffixes match the legacy streaming digest", (_name, config) => {
		expect(buildConfigCacheSuffix(config)).toBe(legacyCSuffix(config));
		expect(rustConfigCacheSuffix(config)).toBe(legacyRustSuffix(config));
	});

	it("pins the node-on C suffix to its pre-swap literal", () => {
		const nodeOn = resolveBuildConfig({
			engine: { eval: true, intl: { enabled: true } },
			surface: { webPlatform: true, node: true },
		});
		expect(buildConfigCacheSuffix(nodeOn)).toBe("7b87e0b6");
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
	it("throws with the offending sites when eval is disabled", () => {
		const usages = collectDisallowedEvalUsage(analyze(`eval("x");`));
		expect(() => assertEvalPolicy(evalOff, usages)).toThrow(/engine\.eval is false/);
	});

	it("is a no-op when eval is enabled", () => {
		const usages = collectDisallowedEvalUsage(analyze(`eval("x");`));
		expect(() => assertEvalPolicy(evalOn, usages)).not.toThrow();
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
