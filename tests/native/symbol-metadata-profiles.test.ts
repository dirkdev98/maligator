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
	symbolMetadataCases,
	symbolMetadataConsumers,
	symbolMetadataProfiles,
	symbolMetadataSource,
} from "../helpers/symbol-metadata-profiles.ts";

describe("symbol metadata differential", () => {
	it.each(["locked", "mutable"] as const)(
		"preserves symbol keys, coercion and escaped identity across metadata profiles with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-symbol-metadata-"));
			try {
				const cases = symbolMetadataCases.flatMap((entry, i) =>
					symbolMetadataConsumers.flatMap((consumer, j) =>
						symbolMetadataProfiles.map((profile) => ({
							entry,
							consumer,
							profile,
							name: `probe_${i}_${j}_${profile}`,
						})),
					),
				);
				const fixture = path.join(outDir, "symbol-metadata.mjs");
				writeFileSync(
					fixture,
					`${cases.map(({ entry, consumer, profile, name }) => symbolMetadataSource(entry, consumer, profile, name)).join("\n")}
function encode(value) {
  if (typeof value === 'symbol') return 'symbol:' + JSON.stringify(value.description) + ':' + JSON.stringify(Symbol.keyFor(value));
  return typeof value + ':' + String(JSON.stringify(typeof value === 'bigint' ? String(value) : value));
}
const cases = [${cases.map(({ name, profile }) => `[globalThis.${name},${profile === "suspension"}]`).join(",")}];
for (let index = 0; index < cases.length; index++) {
  const [run, generator] = cases[index];
  for (const value of [undefined, null, '', 'undefined', 'A😀', 7, 12n, Symbol('input')]) {
    for (const count of [0, 3]) {
      const events = [];
      let result;
      const input = {[Symbol.toPrimitive](hint){events.push('convert:' + hint);return value;}};
      try {
        const output = run(input, v => {events.push(encode(v));return v;}, count);
        if (generator) {
          const first = output.next();
          const last = output.next();
          result = [encode(first.value), first.done, encode(last.value), last.done].join('|');
        } else result = encode(output);
      } catch (error) {result = 'throw:' + error.name;}
      console.log(index, encode(value), count, result, events.join('|'));
    }
  }
  const sentinel = {};
  let caught = false;
  try {
    const result = run({[Symbol.toPrimitive](){throw sentinel;}}, () => {throw new Error('consumer before key conversion');}, 3);
    if (generator) result.next();
  } catch (error) {caught = error === sentinel;}
  if (!caught) throw new Error('lost key exception at ' + index);
}
const escaped = [];
const save = value => {escaped.push(value);return value;};
const key = {toString(){return 'original';}};
console.log('retained', globalThis.probe_2_0_escape(key, symbol => {save(symbol);key.toString=()=> 'changed';}, 0));
if (escaped[0] !== Symbol.for('original')) throw new Error('registry identity');
globalThis.probe_0_0_escape('same', save, 0);
globalThis.probe_0_0_escape('same', save, 0);
if (escaped[1] === escaped[2]) throw new Error('fresh identity merged');
globalThis.probe_1_0_escape('same', save, 0);
globalThis.probe_2_0_escape('same', save, 0);
if (escaped[3] !== escaped[4]) throw new Error('registry identity split');
const iterator = globalThis.probe_2_0_suspension('suspended', save, 0);
iterator.next();
const descriptor = Object.getOwnPropertyDescriptor(Symbol.prototype, 'description');
if (descriptor.configurable) {
  try {
    Object.defineProperty(Symbol.prototype, 'description', {get(){return 'replaced';}, configurable:true});
    if (iterator.next().value !== 'replaced') throw new Error('missed descriptor mutation');
  } finally {Object.defineProperty(Symbol.prototype, 'description', descriptor);}
} else if (iterator.next().value !== 'suspended') throw new Error('locked descriptor');
const events = [];
const extra = () => events.push('extra');
const coercible = {[Symbol.toPrimitive](hint){events.push(hint);return 'ordered';}};
const s = Symbol.for.call(undefined, coercible, extra());
console.log('order', s.description, Symbol.keyFor(s), events.join('|'));
for (const value of [undefined, null, 'text', 1, 1n, Object(Symbol('wrapped')), new Proxy(Object(Symbol('proxy')), {})]) {
  try {Symbol.keyFor(value);throw new Error('accepted non-symbol');}
  catch (error) {if (!(error instanceof TypeError)) throw error;}
}
`,
				);
				const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "symbol-metadata",
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
