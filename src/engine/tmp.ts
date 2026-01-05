import { getCurrentRealm } from "./execution-contexts/execution-context.ts";
import { Realm } from "./execution-contexts/realm.ts";
import { parseScript } from "./parser/script.ts";
import { evaluate } from "./runtime-semantics/index.ts";

const txt = process.argv[2] ?? "1 + 1";

Realm.init();

const parsed = parseScript(txt, getCurrentRealm());
const result = evaluate(parsed.ECMAScriptCode);
console.dir(result, { depth: null });
