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
	stringRawProfiles,
	stringRawSegments,
	stringRawSource,
} from "../helpers/string-raw-profiles.ts";

describe("String.raw dynamic segment differential", () => {
	it.each(["locked", "mutable"] as const)(
		"preserves interleaved conversion, abrupt completion and observable templates with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-raw-segments-"));
			try {
				const cases = stringRawSegments.flatMap((segments, i) =>
					stringRawProfiles.map((profile) => ({
						segments,
						profile,
						name: `probe_${i}_${profile}`,
					})),
				);
				const fixture = path.join(outDir, "raw-segments.mjs");
				writeFileSync(
					fixture,
					`${cases.map(({ segments, profile, name }) => stringRawSource(segments, profile, name)).join("\n")}
function encode(value) {
  if (typeof value === 'symbol') return 'symbol';
  return typeof value + ':' + String(JSON.stringify(typeof value === 'bigint' ? String(value) : value));
}
const cases = [${cases.map(({ name, profile }) => `[globalThis.${name},${profile === "suspension"}]`).join(",")}];
const inputs = [undefined, null, '', '42', 'A😀', '\\ud800', 7, 12n, Symbol('input')];
for (let index = 0; index < cases.length; index++) {
  const [run, generator] = cases[index];
  for (const value of inputs) {
    for (const substitute of inputs) {
      for (const count of [0, 2]) {
        const events = [];
        const x = {[Symbol.toPrimitive](hint){events.push('raw:' + hint);return value;}};
        const y = {[Symbol.toPrimitive](hint){events.push('sub:' + hint);return substitute;}};
        let result;
        try {
          const output = run(x,y,v => {events.push(encode(v));return v;},count);
          if (generator) {
            const first = output.next();
            const last = output.next();
            result = [encode(first.value),first.done,encode(last.value),last.done].join('|');
          } else result = encode(output);
        } catch(error) {result = 'throw:' + error.name;}
        console.log(index,encode(value),encode(substitute),count,result,events.join('|'));
      }
    }
  }
}
function alternating(x,y,effect){return String.raw({raw:[x,x,x]},y,effect());}
for (const failAt of [0,1,2,3,4]) {
  const sentinel = {};
  const events = [];
  let conversions = 0;
  const part = label => ({[Symbol.toPrimitive](hint){events.push(label+':'+hint);if(conversions++===failAt)throw sentinel;return label+conversions;}});
  let caught = false;
  try {alternating(part('raw'),part('sub'),()=>{events.push('argument');return part('extra');});}
  catch(error) {caught=error===sentinel;}
  if (!caught) throw new Error('lost ordered exception '+failAt);
  console.log('exception',failAt,events.join('|'));
}
let conversions = 0;
const changing = {[Symbol.toPrimitive](){return ++conversions;}};
if (alternating(changing,'-',()=>'-') !== '1-2-3' || conversions !== 3) throw new Error('merged raw conversions');
const raw = [null,'tail'];
raw[0] = {[Symbol.toPrimitive](){raw[1]='changed';return 'head';}};
if (String.raw({raw},'|') !== 'head|changed') throw new Error('lost raw alias mutation');
const events = [];
const template = {get raw(){events.push('raw');return {get length(){events.push('length');return 2;},get 0(){events.push('zero');return 'a';},get 1(){events.push('one');return 'b';}};}};
if (String.raw(template,{toString(){events.push('sub');return 'x';}}) !== 'axb' || events.join('|') !== 'raw|length|zero|sub|one') throw new Error('lost raw access order');
const proxyEvents = [];
const proxy = new Proxy(['a','b'],{get(target,key,receiver){proxyEvents.push(String(key));return Reflect.get(target,key,receiver);}});
if (String.raw({raw:proxy},'x') !== 'axb' || proxyEvents.join('|') !== 'length|0|1') throw new Error('lost proxy reads');
const descriptor = Object.getOwnPropertyDescriptor(String,'raw');
if (descriptor.writable) {
  const original = String.raw;
  let calls = 0;
  try {
    String.raw = function(template){calls++;if(template.raw[0] !== 'r')throw new Error('missing template');return 'overridden';};
    for (const name of ['direct','call','apply','reflect','bind']) {
      if (globalThis['probe_0_'+name]('r','s',x=>x,0) !== 'overridden') throw new Error('missed mutable raw target');
    }
    if (calls !== 5) throw new Error('missed replacement call');
    calls = 0;
    String.raw = new Proxy(original,{apply(target,receiver,args){calls++;if(args[0].raw[0] !== 'r')throw new Error('missing proxy template');return 'proxied';}});
    for (const name of ['direct','call','apply','reflect']) {
      if (globalThis['probe_0_'+name]('r','s',x=>x,0) !== 'proxied') throw new Error('missed proxied raw target');
    }
    if (calls !== 4) throw new Error('missed proxy call');
  } finally {String.raw=original;}
}
`,
				);
				const expected = execFileSync(process.execPath, [fixture], {
					encoding: "utf8",
					maxBuffer: 16 * 1024 * 1024,
				});
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "raw-segments",
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
