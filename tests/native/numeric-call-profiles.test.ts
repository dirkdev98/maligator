import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
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

describe("numeric call profile differential", () => {
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
const cases = [${cases.map(({ name, profile }) => `[globalThis.${name},${profile === "suspension"},${profile === "loop" || profile === "repeatedLoop"}]`).join(",")}];
for (let index = 0; index < cases.length; index++) {
  const [run, generator, usesCount] = cases[index];
  for (const value of [-0, 0, NaN, Infinity, -Infinity, 1.25, 8]) {
    for (const count of usesCount ? [0, 3] : [3]) {
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
const cases = [${cases.map(({ name, profile }) => `[globalThis.${name},${profile === "suspension"},${profile === "loop"}]`).join(",")}];
for (let index = 0; index < cases.length; index++) {
  const [run, generator, usesCount] = cases[index];
  for (const count of usesCount ? [0, 3] : [3]) {
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
});
