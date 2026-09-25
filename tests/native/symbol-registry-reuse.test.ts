import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import {
	registryKeys,
	registryProfiles,
	registrySource,
} from "../helpers/symbol-registry-reuse.ts";

it.each(["locked", "mutable"] as const)(
	"preserves registry identity, coercion order and abrupt completion with %s primordials",
	(primordials) => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-registry-reuse-"));
		try {
			const names = registryKeys.flatMap((key, i) =>
				registryProfiles.map((profile, j) => ({
					key,
					profile,
					name: `probe_${i}_${j}`,
				})),
			);
			const fixture = path.join(outDir, "registry.mjs");
			// Only the loop profile reads count; other profiles need one input sweep.
			writeFileSync(
				fixture,
				`${names.map(({ key, profile, name }) => registrySource(key, profile, name)).join("\n")}
function encode(value){if(typeof value==='symbol')return 'symbol:'+JSON.stringify(Symbol.keyFor(value));return String(value);}
for(const [run,counts] of [${names.map(({ name, profile }) => `[globalThis.${name},${profile === "loop" ? "[0,3]" : "[0]"}]`).join(",")}]) {
  for(const input of [undefined,null,'','a😀',0,-0,7,12n,Symbol('input')]) {
    for(const count of counts) {
      const events=[];let output;
      const x={[Symbol.toPrimitive](hint){events.push(hint);return input;}};
      try {const result=run(x,v=>{events.push(encode(v));return v;},count);output=Array.isArray(result)?result.map(encode).join('|'):encode(result);}
      catch(e){output='throw:'+e.name;}
      console.log(encode(input),count,output,events.join('|'));
    }
  }
}
function raw(x,effect){const a=Symbol.for(x);effect(a);const b=Symbol.for(x);return [a,b];}globalThis.raw=raw;
const events=[];let step=0;
const key={[Symbol.toPrimitive](hint){events.push(hint);return 'raw'+step++;}};
const pair=globalThis.raw(key,s=>events.push(Symbol.keyFor(s)));
if(pair[0]===pair[1])throw new Error('repeated object conversion lost');
console.log('raw',pair.map(Symbol.keyFor).join('|'),events.join('|'));
const sentinel={};let calls=0;
try {globalThis.raw({toString(){if(calls++===1)throw sentinel;return 'first';}},()=>{});throw new Error('missed second throw');}
catch(e){if(e!==sentinel)throw e;}
let observed=false;
try {globalThis.raw({toString(){throw sentinel;}},()=>{observed=true;});throw new Error('missed first throw');}
catch(e){if(e!==sentinel||observed)throw new Error('exception ordering');}
const escape=[];
globalThis.probe_0_0('stable',s=>{escape.push(s);for(let i=0;i<64;i++)Symbol.for('other'+i);},0);
if(escape[0]!==escape[1]||escape[0]!==Symbol.for('stable'))throw new Error('registry identity');
function* suspended(x){const k=String(x);const a=Symbol.for(k);yield a;return Symbol.for(k);}globalThis.suspended=suspended;
const iterator=globalThis.suspended('yielded');const before=iterator.next().value;Symbol.for('between');if(iterator.next().value!==before)throw new Error('suspended identity');
const original=Symbol.for;
const descriptor=Object.getOwnPropertyDescriptor(Symbol,'for');
if(descriptor.writable){let replaced=0;try{const value=globalThis.probe_0_0('mutation',()=>{Symbol.for=()=>{replaced++;return Symbol('replacement');};},0);if(value[0]===value[1]||replaced!==1)throw new Error('mutable target lost');}finally{Symbol.for=original;}}
const a=Symbol('fresh'),b=Symbol('fresh');if(a===b)throw new Error('fresh identities merged');
console.log('boundaries ok');
`,
			);
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
			});
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: "registry",
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
