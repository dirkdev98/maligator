import consoleModule, { Console, log } from "node:console";

const chunks = [];
const out = { write: (text) => chunks.push(`out:${text}`) };
const err = { write: (text) => chunks.push(`err:${text}`) };
const custom = new Console(out, err, false);
custom.log("hello %s", "world", { a: 1 });
custom.error("bad", [1]);
custom.group("G");
custom.info("in\nside");
custom.groupEnd();
custom.count();
custom.count();
custom.table([{ x: 1 }]);
custom.dir({ d: { e: { f: {} } } }, { depth: 0 });
custom.assert(false, "nope");
const wide = new Console({ stdout: out, groupIndentation: 4, ignoreErrors: false });
wide.group();
wide.log("four");
wide.groupEnd();
wide.warn("warn goes to stdout");
Console(out, out, false).log("without new");
Console.prototype.log.call(custom, "prototype call");
console.log.call(custom, "global call");
console.log(chunks);
console.log(consoleModule === console, log === console.log, console.Console === Console);
console.log(custom instanceof Console, typeof Console.prototype.table);
try {
	new Console({});
} catch (error) {
	console.log(error.name, error.code, error.message);
}
