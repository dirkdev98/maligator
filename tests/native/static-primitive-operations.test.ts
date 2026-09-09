import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import {
	constantCallProfiles,
	constantCallProfileSource,
} from "../helpers/constant-call-profiles.ts";
import {
	dynamicCallProfiles,
	dynamicCallProfileSource,
} from "../helpers/dynamic-call-profiles.ts";
import {
	dynamicNumericCallCases,
	numericCallCases,
} from "../helpers/numeric-call-profiles.ts";

describe("primitive operation differential", () => {
	it.each(["locked", "mutable"] as const)(
		"preserves partially static numeric calls across coercion, loop joins and suspension with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-dynamic-numeric-profiles-"));
			try {
				const cases = dynamicNumericCallCases.flatMap((entry, index) =>
					dynamicCallProfiles.map((profile) => ({
						entry,
						profile,
						name: `probe_${index}_${profile}`,
					})),
				);
				const fixture = path.join(outDir, "dynamic-numeric-profiles.mjs");
				writeFileSync(
					fixture,
					`${cases.map(({ entry, profile, name }) => dynamicCallProfileSource(entry, profile, "+x", name)).join("\n")}
function encode(value) {
  if (Object.is(value, -0)) return '-0';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number:' + value.toPrecision(12);
  return typeof value + ':' + String(value);
}
const cases = [${cases.map(({ name, profile }) => `[globalThis.${name},${profile === "suspension"}]`).join(",")}];
for (let index = 0; index < cases.length; index++) {
  const [run, generator] = cases[index];
  for (const value of [-0, 0, NaN, Infinity, -Infinity, 1.25, 8]) {
    for (const count of [0, 3]) {
      const events = [];
      const input = {[Symbol.toPrimitive](hint){events.push('convert:' + hint);return value;}};
      const effect = result => {events.push(encode(result));return result;};
      let outcome;
      try {
        const result = run(input, effect, count);
        if (generator) {
          const first = result.next();
          const last = result.next();
          outcome = [encode(first.value), first.done, encode(last.value), last.done].join('|');
        } else outcome = encode(result);
      } catch (error) { outcome = 'throw:' + error.name; }
      console.log(index, encode(value), count, outcome, events.join('|'));
    }
  }
  const sentinel = {};
  let caught = false;
  try {
    const result = run({[Symbol.toPrimitive](){throw sentinel;}}, () => {throw new Error('consumer before conversion');}, 3);
    if (generator) result.next();
  } catch (error) { caught = error === sentinel; }
  if (!caught) throw new Error('lost conversion exception at ' + index);
}
function mixed(x, n) {
  let result = x;
  for (let i = 0; i < n; i++) result = Math.abs(+x);
  return result;
}
const marker = {valueOf(){return -3;}};
if (mixed(marker, 0) !== marker || mixed(marker, 3) !== 3) throw new Error('mixed join');
function* resumed() { const x = yield 1; return Math.abs(x); }
const iterator = resumed(); iterator.next();
if (iterator.next(marker).value !== 3) throw new Error('resume coercion');
const original = Math.round;
const suspended = globalThis.probe_${dynamicNumericCallCases.findIndex(([callee]) => callee === "Math.round")}_suspension(-0.25, x => x, 0);
suspended.next();
if (Object.getOwnPropertyDescriptor(Math, 'round').writable) {
  try { Math.round = () => 37; if (suspended.next().value !== 37) throw new Error('mutated target'); }
  finally { Math.round = original; }
} else if (!Object.is(suspended.next().value, -0)) throw new Error('locked target');
async function awaited(x) { const value = +x; await 0; return Math.abs(value); }
async function* generated(x) { const value = +x; yield Math.min(value, 0); return Math.abs(value); }
const asyncIterator = generated(-3);
console.log('async', await awaited(-3), (await asyncIterator.next()).value, (await asyncIterator.next()).value);
`,
				);
				const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "dynamic-numeric-profiles",
					config: resolveBuildConfig({ engine: { primordials } }),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);

	it.each(["locked", "mutable"] as const)(
		"preserves certified numeric call profiles, effects and suspension with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-numeric-call-profiles-"));
			try {
				const cases = numericCallCases.flatMap((entry, index) =>
					constantCallProfiles.map((profile) => ({
						name: `probe_${index}_${profile}`,
						entry,
						profile,
					})),
				);
				const fixture = path.join(outDir, "numeric-call-profiles.mjs");
				writeFileSync(
					fixture,
					`${cases.map(({ entry, profile, name }) => constantCallProfileSource(entry, profile, name)).join("\n")}
function encode(value) {
  if (Object.is(value, -0)) return '-0';
  return typeof value + ':' + String(value);
}
const cases = [${cases.map(({ name, profile }) => `[globalThis.${name},${profile === "suspension"}]`).join(",")}];
for (let index = 0; index < cases.length; index++) {
  const [run, generator] = cases[index];
  for (const count of [0, 3]) {
    const events = [];
    const result = run(value => { events.push(encode(value)); return value; }, count);
    if (generator) {
      const first = result.next();
      const last = result.next();
      console.log(index, count, encode(first.value), first.done, encode(last.value), last.done, events.join('|'));
    } else console.log(index, count, encode(result), events.join('|'));
  }
  const sentinel = {};
  let caught = false;
  try {
    const result = run(() => { throw sentinel; }, 3);
    if (generator) result.next();
  } catch (error) { caught = error === sentinel; }
  if (!caught) throw new Error('lost callback exception at ' + index);
}
const original = Math.round;
if (Object.getOwnPropertyDescriptor(Math, 'round').writable) {
  const iterator = globalThis.probe_${numericCallCases.findIndex(([callee]) => callee === "Math.round")}_suspension(value => value);
  if (!Object.is(iterator.next().value, -0)) throw new Error('initial rounding');
  try {
    Math.round = () => 37;
    if (iterator.next().value !== 37) throw new Error('missed callee mutation');
  } finally { Math.round = original; }
} else {
  const iterator = globalThis.probe_${numericCallCases.findIndex(([callee]) => callee === "Math.round")}_suspension(value => value);
  if (!Object.is(iterator.next().value, -0) || !Object.is(iterator.next().value, -0)) throw new Error('locked rounding');
}
const events = [];
const list = {
  get length(){events.push('length');return 2;},
  get 0(){events.push('width');return 8;},
  get 1(){events.push('value');return -1n;}
};
console.log('accessors', String(Reflect.apply(BigInt.asUintN, undefined, list)), events.join('|'));
events.length = 0;
console.log('proxy', String(Reflect.apply(BigInt.asUintN, undefined, new Proxy([8,-1n], {
  get(target,key){events.push(key);return target[key];}
}))), events.join('|'));
const sentinel = {};
for (const run of [
  () => Reflect.apply(BigInt.asUintN, undefined, [8, (() => {throw sentinel;})()]),
  () => Reflect.apply(BigInt.asUintN, undefined, {length:2,0:8,get 1(){throw sentinel;}}),
]) {
  let caught = false;
  try { run(); } catch (error) { caught = error === sentinel; }
  if (!caught) throw new Error('lost argument-list exception');
}
console.log('constructed', Reflect.construct(Number,[-1n]).valueOf());
`,
				);
				const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "numeric-call-profiles",
					config: resolveBuildConfig({ engine: { primordials } }),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"preserves wrapper property keys, identity, and object observations with %s primordials",
		(primordials) => {
			const fixture = "tests/local/primitive-wrapper-observations.mjs";
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const outDir = mkdtempSync(
				path.join(os.tmpdir(), "mal-primitive-wrapper-observations-"),
			);
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "primitive-wrapper-observations",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: false },
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"preserves primitive wrapper flow and identity with %s primordials",
		(primordials) => {
			const fixture = "tests/local/primitive-wrapper-flow.mjs";
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-primitive-wrapper-flow-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "primitive-wrapper-flow",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: false },
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"preserves inherited toLocaleString dispatch and argument order with %s primordials",
		(primordials) => {
			const fixture = "tests/local/inherited-wrapper-tolocalestring.mjs";
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const outDir = mkdtempSync(
				path.join(os.tmpdir(), "mal-inherited-wrapper-tolocalestring-"),
			);
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "inherited-wrapper-tolocalestring",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: false },
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"preserves inherited Object valueOf boxing, identity, and argument effects with %s primordials",
		(primordials) => {
			const fixture = "tests/local/inherited-wrapper-valueof.mjs";
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const outDir = mkdtempSync(
				path.join(os.tmpdir(), "mal-inherited-wrapper-valueof-"),
			);
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "inherited-wrapper-valueof",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: false },
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"preserves primitive slots and own-property state at materialization with %s primordials",
		(primordials) => {
			const fixture = "tests/local/primitive-wrapper-state.mjs";
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-primitive-wrapper-state-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "primitive-wrapper-state",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: false },
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"releases discarded Boolean inputs across suspension with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-boolean-wrapper-lifetime-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture: "tests/local/boolean-wrapper-lifetime.mjs",
					name: "boolean-wrapper-lifetime",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: false },
						surface: { node: true },
					}),
					mainFile: HOST_MAIN,
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted])
					for (const env of [{}, STRESS_ENV])
						expect(runToStdout(binary, { env: { ...env, MAL_HOST_GC: "1" } })).toBe(
							"boolean wrapper lifetime PASS\n",
						);
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"preserves immutable wrapper payloads, identity, and coercion effects with %s primordials",
		(primordials) => {
			const fixture = "tests/local/primitive-wrapper-payloads.mjs";
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
			});
			const outDir = mkdtempSync(
				path.join(os.tmpdir(), "mal-primitive-wrapper-payloads-"),
			);
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "primitive-wrapper-payloads",
					config: resolveBuildConfig({
						engine: {
							primordials,
							eval: false,
							realms: false,
							intl: { enabled: true, features: ["collator"] },
						},
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"preserves Boolean text, boxed receivers, and mutable callee identity with %s primordials",
		(primordials) => {
			const fixture = "tests/local/boolean-text.mjs";
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
			});
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-boolean-text-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "boolean-text",
					config: resolveBuildConfig({
						engine: {
							primordials,
							eval: false,
							realms: false,
							intl: { enabled: true, features: ["collator"] },
						},
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"preserves typed character kernels, lazy strings, and coercion order with %s primordials",
		(primordials) => {
			const fixture = "tests/local/typed-string-characters.mjs";
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
			});
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-typed-characters-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "typed-characters",
					config: resolveBuildConfig({
						engine: {
							primordials,
							eval: false,
							realms: false,
							intl: { enabled: true, features: ["collator"] },
						},
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"preserves primitive parameter specialization and cell effects with %s primordials",
		(primordials) => {
			const fixture = "tests/local/primitive-cell-parameters.mjs";
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
			});
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-primitive-parameters-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "primitive-parameters",
					config: resolveBuildConfig({
						engine: {
							primordials,
							eval: false,
							realms: false,
							intl: { enabled: true, features: ["collator"] },
						},
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"preserves immutable Symbol data, registry effects, and cell identity with %s primordials",
		(primordials) => {
			const fixture = "tests/local/symbol-cell-consumers.mjs";
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
			});
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-symbol-cells-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "symbol-cells",
					config: resolveBuildConfig({
						engine: {
							primordials,
							eval: false,
							realms: false,
							intl: { enabled: true, features: ["collator"] },
						},
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"preserves observation-point primitive folds and effects with %s primordials",
		(primordials) => {
			const fixture = "tests/local/observed-primitive-consumers.mjs";
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
			});
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-observed-primitives-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "observed-primitives",
					config: resolveBuildConfig({
						engine: {
							primordials,
							eval: false,
							realms: false,
							intl: { enabled: true, features: ["collator"] },
						},
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"preserves primitive cell initialization and immutable payloads with %s primordials",
		(primordials) => {
			const fixture = "tests/local/primitive-cell-consumers.mjs";
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
			});
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-primitive-cells-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "primitive-cells",
					config: resolveBuildConfig({
						engine: {
							primordials,
							eval: false,
							realms: false,
							intl: { enabled: true, features: ["collator"] },
						},
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"preserves String argument wrapper coercions and effects with %s primordials",
		(primordials) => {
			const fixture = "tests/local/wrapper-string-arguments-consumers.mjs";
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
			});
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-wrapper-string-arguments-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "wrapper-string-arguments",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: false },
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"preserves primitive argument wrapper coercions and effects with %s primordials",
		(primordials) => {
			const fixture = "tests/local/wrapper-primitive-arguments-consumers.mjs";
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
			});
			const outDir = mkdtempSync(
				path.join(os.tmpdir(), "mal-wrapper-primitive-arguments-"),
			);
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "wrapper-primitive-arguments",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: false },
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"preserves numeric Math wrapper coercions and effects with %s primordials",
		(primordials) => {
			const fixture = "tests/local/wrapper-math-consumers.mjs";
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-wrapper-math-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "wrapper-math",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: false },
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"preserves wrapper coercion consumers and identity boundaries with %s primordials",
		(primordials) => {
			const fixture = "tests/local/wrapper-coercion-consumers.mjs";
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-wrapper-coercions-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "wrapper-coercions",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: false },
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"preserves wrapper predicate consumers and conversion boundaries with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-wrapper-predicates-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture: "tests/local/wrapper-predicate-consumers.mjs",
					name: "wrapper-predicates",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: false },
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe("wrapper predicate consumers passed\n");
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(
						"wrapper predicate consumers passed\n",
					);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it("keeps the embedded compiler independent of replaced user globals", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-eval-replaced-globals-"));
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture: "tests/local/eval-replaced-globals.mjs",
				name: "eval-globals",
				config: resolveBuildConfig({
					engine: { primordials: "mutable", eval: true, realms: false },
				}),
				outDir,
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary)).toBe("eval replaced globals passed\n");
				// The embedded compiler reaches many safepoints per source expression.
				expect(
					runToStdout(binary, {
						env: { MAL_GC_STRESS: "1000", MAL_GC_VERIFY: "1" },
						timeoutMs: 60_000,
					}),
				).toBe("eval replaced globals passed\n");
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 600_000);
	it("preserves locked global writes under GC stress without optional features", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-locked-global-bindings-"));
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture: "tests/local/locked-global-bindings.mjs",
				name: "bindings",
				config: resolveBuildConfig({
					engine: { primordials: "locked", eval: false, realms: false },
				}),
				outDir,
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary)).toBe("locked global bindings passed\n");
				expect(runToStdout(binary, { env: STRESS_ENV })).toBe(
					"locked global bindings passed\n",
				);
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 600_000);
	it.each([false, true])(
		"preserves guarded Number predicates and noncoercing arguments with realms=%s",
		(realms) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-predicate-guards-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture: "tests/local/guarded-number-predicates.mjs",
					name: "guards",
					config: resolveBuildConfig({ engine: { primordials: "mutable", realms } }),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe("number predicate guards passed\n");
					expect(runToStdout(binary, { env: { ...STRESS_ENV, MAL_HOST_GC: "1" } })).toBe(
						"number predicate guards passed\n",
					);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each([false, true])(
		"preserves guarded number formatting and callee mutations with realms=%s",
		(realms) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-number-guards-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture: "tests/local/guarded-number-format.mjs",
					name: "guards",
					config: resolveBuildConfig({ engine: { primordials: "mutable", realms } }),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe("number formatting guards passed\n");
					expect(runToStdout(binary, { env: { ...STRESS_ENV, MAL_HOST_GC: "1" } })).toBe(
						"number formatting guards passed\n",
					);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each(["locked", "mutable"] as const)(
		"preserves primitive function identities and rejected construction with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-static-identities-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture: "tests/local/static-primitive-identities.mjs",
					name: "identities",
					config: resolveBuildConfig({ engine: { primordials } }),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe("primitive identities passed\n");
					expect(runToStdout(binary, { env: { ...STRESS_ENV, MAL_HOST_GC: "1" } })).toBe(
						"primitive identities passed\n",
					);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each([false, true])(
		"preserves locale case effects and prepared parameters with Intl=%s",
		(enabled) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-static-locale-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture: "tests/local/static-string-locale.mjs",
					name: "locale",
					config: resolveBuildConfig({
						engine: { primordials: "locked", intl: { enabled, features: ["collator"] } },
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted])
					expect(runToStdout(binary, { env: { ...STRESS_ENV, MAL_HOST_GC: "1" } })).toBe(
						"locale cases passed\n",
					);
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);

	it.each(["locked", "mutable"] as const)(
		"preserves exact sum and iterator closing with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-static-sum-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture: "tests/local/static-math-sum.mjs",
					name: "sum",
					config: resolveBuildConfig({ engine: { primordials } }),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(
						"1\n-0\n-0\nTypeError\ninr\n",
					);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);

	it("matches constant radix spellings to the target formatter across all bases and binary64 extremes", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-static-radix-"));
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture: "tests/local/static-number-radix.mjs",
				name: "radix",
				config: resolveBuildConfig({ engine: { primordials: "locked" } }),
				outDir,
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary)).toBe("280 target radix cases passed\n");
				expect(runToStdout(binary, { env: STRESS_ENV })).toBe(
					"280 target radix cases passed\n",
				);
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 600_000);
	it.each(["locked", "mutable"] as const)(
		"preserves values and coercion order with %s primordials",
		(primordials) => {
			const fixture = "tests/local/static-primitive-operations.mjs";
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-static-primitives-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "primitives",
					config: resolveBuildConfig({ engine: { primordials } }),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: { ...STRESS_ENV, MAL_HOST_GC: "1" } })).toBe(
						expected,
					);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
});
