import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { getCurrentRealm } from "./execution-contexts/execution-context.ts";
import { Realm } from "./execution-contexts/realm.ts";
import { parseScript } from "./parser/script.ts";
import { evaluate } from "./runtime-semantics/index.ts";

const txt = readFileSync("./local.js", "utf-8");

Realm.init();

const parsed = parseScript(txt, getCurrentRealm());
const result = evaluate(parsed.ECMAScriptCode);

spawnSync(`bat`, ["./local.js"], {
	stdio: "inherit",
	env: {
		...process.env,
		FORCE_COLOR: "1",
	},
});

console.dir(result?.value ?? result.error, { depth: null });
