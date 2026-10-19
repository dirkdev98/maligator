import path from "node:path";
import win32 from "node:path/win32";

const show = (value) => JSON.stringify(value);
const samples = [
	"",
	".",
	"..",
	"C:",
	"C:\\",
	"C:foo",
	"c:\\foo\\..\\bar\\",
	"C:/a//b/./c/../d",
	"\\",
	"/",
	"\\\\",
	"\\\\server",
	"\\\\server\\share",
	"//server/share/dir/file.txt",
	"\\\\?\\C:\\x\\..\\y",
	"\\\\.\\PHYSICALDRIVE0",
	"\\\\.\\CON:x",
	"foo\\bar\\..\\..\\..\\baz",
	"a/b\\c/./d.e.f",
	".bashrc",
	"file.",
	"dir\\.hidden.txt",
	"CON",
	"CONx",
	"con:x",
	"LPT1:",
	"a:b",
	"x:/y",
	"C:\\temp\\\\foo\\bar\\..\\",
	"/foo/bar/baz/asdf/quux.html",
];
console.log(
	"identity",
	path.win32 === win32,
	win32.win32 === win32,
	win32.posix === path.posix,
	path.posix.win32 === win32,
);
console.log("constants", show(win32.sep), show(win32.delimiter));
for (const sample of samples) {
	console.log(
		"sample",
		show(sample),
		show(win32.normalize(sample)),
		win32.isAbsolute(sample),
		show(win32.dirname(sample)),
		show(win32.basename(sample)),
		show(win32.extname(sample)),
		show(win32.parse(sample)),
	);
}
console.log(
	"basename suffix",
	show(win32.basename("C:\\foo.html", ".html")),
	show(win32.basename("aaa\\bbb", "bbb")),
	show(win32.basename("file.js", "file.js")),
);
const joins = [
	["a", "b", "c"],
	["C:\\", "a", "..\\b"],
	["\\\\server", "share"],
	["//", "a"],
	["", ""],
	["a", "", "b/"],
	["CON:", "x"],
	["\\\\?\\C:", "x"],
	["/foo", "bar", "baz/asdf", "quux", ".."],
];
for (const parts of joins) console.log("join", show(parts), show(win32.join(...parts)));
const absolute = [
	["C:\\a", "b"],
	["C:\\a", "D:b", "c"],
	["C:\\a", "\\\\server\\share\\x", "..\\y"],
	["c:/ignore", "c:/some/file"],
	["d:\\ignore", "d:some/dir//"],
	["//server/share", "..", "relative\\"],
	["c:/", "//"],
	["c:/", "//dir"],
	["c:/", "//server/share"],
	["c:/", "///some//dir"],
	["C:\\foo\\tmp.3\\", "..\\tmp.3\\cycles\\root.js"],
];
for (const parts of absolute)
	console.log("resolve", show(parts), show(win32.resolve(...parts)));
console.log(
	"resolve cwd",
	win32.resolve() === process.cwd().replaceAll("/", "\\"),
	win32.resolve("a") === win32.join(process.cwd(), "a"),
);
const relatives = [
	["c:/blah\\blah", "d:/games"],
	["c:/aaaa/bbbb", "c:/aaaa"],
	["c:/aaaa/bbbb", "c:/cccc"],
	["c:/aaaa/bbbb", "c:/aaaa/bbbb"],
	["c:/aaaa/bbbb", "c:/aaaa/cccc"],
	["c:/aaaa/", "c:/aaaa/cccc"],
	["c:/", "c:\\aaaa\\bbbb"],
	["c:/aaaa/bbbb", "d:\\"],
	["c:/AaAa/bbbb", "c:/aaaa/bbbb"],
	["c:/aaaaa/", "c:/aaaa/cccc"],
	["C:\\foo\\bar\\baz\\quux", "C:\\"],
	["C:\\foo\\test", "C:\\foo\\test\\bar\\package.json"],
	["\\\\foo\\bar", "\\\\foo\\bar\\baz"],
	["\\\\foo\\bar\\baz", "\\\\foo\\bar"],
	["C:\\baz-quux", "C:\\baz"],
	["\\\\foo\\baz", "\\\\foo\\baz-quux"],
];
for (const [from, to] of relatives)
	console.log("relative", show(from), show(to), show(win32.relative(from, to)));
for (const sample of [
	"C:\\foo",
	"c:/a/b",
	"\\\\server\\share\\x",
	"\\\\?\\C:\\x",
	"\\\\.\\pipe\\x",
	"",
	"rel",
]) {
	const namespaced = win32.toNamespacedPath(sample);
	console.log(
		"namespaced",
		show(sample),
		show(sample === "rel" ? namespaced.endsWith("\\rel") : namespaced),
	);
}
console.log("namespaced non-string", win32.toNamespacedPath(42));
console.log(
	"format",
	show(win32.format({ dir: "C:\\path\\dir", base: "file.txt" })),
	show(win32.format({ root: "C:\\", name: "file", ext: "txt" })),
	show(win32.format({ root: "C:\\", dir: "C:\\", base: "x" })),
);
try {
	win32.join("a", 1);
} catch (error) {
	console.log("join type", error.name, error.message.split(".")[0]);
}

for (const [file, pattern] of [
	["a\\b.js", "a/*.js"],
	["a/b.js", "a\\*.js"],
	["A\\B.JS", "a/*.js"],
	["a\\b\\c.js", "a/**"],
	["x.ts", "*.js"],
]) {
	console.log("glob", show(file), show(pattern), win32.matchesGlob(file, pattern));
}
