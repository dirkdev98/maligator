import util, { MIMEParams, MIMEType } from "node:util";

const show = (label, value) => console.log(label, JSON.stringify(value));
const attempt = (label, run) => {
	try {
		show(label, run());
	} catch (error) {
		show(label, [error.name, error.code, error.message]);
	}
};

const mime = new MIMEType(
	'  Text/HTML ; Charset="UTF-8" ; q=0.9; empty=; q=dup; "bad"=x; quoted="a\\"b\\\\c"',
);
show("parts", [mime.type, mime.subtype, mime.essence, String(mime), mime.toJSON()]);
show("params", [...mime.params]);
show("get", [
	mime.params.get("charset"),
	mime.params.get("CHARSET"),
	mime.params.get("missing"),
]);
show("has", [mime.params.has("q"), mime.params.has("empty")]);
mime.params.set("Format", "flowed text");
mime.params.set("plain", "value");
mime.params.delete("q");
show("updated", String(mime));
mime.type = "APPLICATION";
mime.subtype = "Json";
show("renamed", [mime.essence, String(mime.params), JSON.stringify(mime)]);
show("keys", [[...mime.params.keys()], [...mime.params.values()]]);
show("iterator", mime.params[Symbol.iterator] === mime.params.entries);
show("instances", [
	mime.params instanceof MIMEParams,
	mime instanceof MIMEType,
	util.MIMEType === MIMEType,
]);
show("own keys", [Reflect.ownKeys(mime), Reflect.ownKeys(mime.params)]);
show("trailing backslash", String(new MIMEType('a/b;x="tail\\')));
show("unterminated", new MIMEType('a/b;x="open;y=z').params.get("x"));
show("empty quoted", String(new MIMEType('a/b;x=""')));
show("junk after quote", [...new MIMEType('a/b;x="v"junk;y=1').params]);
show(
	"standalone",
	(() => {
		const params = new MIMEParams();
		params.set("a", "1");
		params.set("b", "");
		return [String(params), params.toJSON()];
	})(),
);
show("parse", [MIMEType.parse("text/plain;a=b")?.toString(), MIMEType.parse("nope")]);
attempt("no slash", () => new MIMEType("text"));
attempt("bad type", () => new MIMEType("te xt/plain"));
attempt("bad subtype", () => new MIMEType("text/pla in"));
attempt("empty subtype", () => new MIMEType("text/ ;a=b"));
attempt("set bad type", () => {
	mime.type = "bad type";
});
attempt("set bad name", () => mime.params.set("bad name", "x"));
attempt("set bad value", () => mime.params.set("ok", "line\nbreak"));
attempt("call", () => MIMEType("a/b"));
