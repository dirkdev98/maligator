import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertEvalPolicy,
	BuildConfigError,
	buildConfigCacheSuffix,
	intlCargoFeatures,
	intlDisabledDefines,
	loadBuildConfig,
	resolveBuildConfig,
	rustConfigCacheSuffix,
} from "../src/build-config.ts";
import { parseScript } from "../src/parser.ts";
import {
	analyzeSourceAndRunSemanticAnalysis,
	collectDisallowedEvalUsage,
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
		writeConfig(dir, JSON.stringify({ engine: { intl: { enabled: true, languages: ["en"] } } }));
		expect(() => loadBuildConfig(undefined, dir)).toThrow(/locale subsetting.*not yet supported/);
	});

	it("allows languages when Intl is disabled (irrelevant, no error)", () => {
		const dir = tmpdir();
		writeConfig(dir, JSON.stringify({ engine: { intl: { enabled: false, languages: ["en"] } } }));
		expect(loadBuildConfig(undefined, dir).engine.intl.enabled).toBe(false);
	});

	it("hard-errors on an unknown intl.features service name", () => {
		const dir = tmpdir();
		writeConfig(
			dir,
			JSON.stringify({ engine: { intl: { enabled: true, features: ["collator", "bogus"] } } }),
		);
		expect(() => loadBuildConfig(undefined, dir)).toThrow(/unknown service 'bogus'/);
	});

	it("accepts a valid intl.features subset", () => {
		const dir = tmpdir();
		writeConfig(
			dir,
			JSON.stringify({ engine: { intl: { enabled: true, features: ["number-format"] } } }),
		);
		expect(loadBuildConfig(undefined, dir).engine.intl.features).toEqual(["number-format"]);
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
		expect(intlCargoFeatures(subset).sort()).toEqual(["intl-collator", "intl-number-format"]);
		const defines = intlDisabledDefines(subset);
		expect(defines).toContain("-DMAL_INTL_HAS_SEGMENTER=0");
		expect(defines).toContain("-DMAL_INTL_HAS_DISPLAY_NAMES=0");
		// selected services are NOT disabled
		expect(defines).not.toContain("-DMAL_INTL_HAS_COLLATOR=0");
		expect(defines).not.toContain("-DMAL_INTL_HAS_NUMBER_FORMAT=0");
	});

	it("distinct feature sets get distinct cache suffixes; all-services is canonical", () => {
		const all = resolveBuildConfig({ engine: { eval: true, intl: { enabled: true } } });
		const subset = resolveBuildConfig({
			engine: { eval: true, intl: { enabled: true, features: ["number-format"] } },
		});
		expect(buildConfigCacheSuffix(all)).toBe(""); // canonical
		expect(rustConfigCacheSuffix(all)).toBe("");
		expect(buildConfigCacheSuffix(subset)).toMatch(/^[0-9a-f]{8}$/);
		expect(rustConfigCacheSuffix(subset)).toMatch(/^[0-9a-f]{8}$/);
		expect(buildConfigCacheSuffix(subset)).not.toBe(buildConfigCacheSuffix(all));
	});
});

describe("buildConfigCacheSuffix", () => {
	it("is empty for the canonical (eval-on, Intl-on) archive", () => {
		expect(
			buildConfigCacheSuffix(
				resolveBuildConfig({ engine: { eval: true, intl: { enabled: true } } }),
			),
		).toBe("");
	});

	it("is a stable non-empty hash for eval-off", () => {
		const off = resolveBuildConfig({ engine: { eval: false } });
		const suffix = buildConfigCacheSuffix(off);
		expect(suffix).toMatch(/^[0-9a-f]{8}$/);
		expect(buildConfigCacheSuffix(off)).toBe(suffix);
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
