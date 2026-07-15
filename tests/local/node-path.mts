// Native `node:path` (POSIX) acceptance fixture. Exercises the narrow exports and
// the default object against known Node posix outputs (differential: the `want`
// values are exactly what Node's path.posix produces). Prints one line per check
// and a final "RESULT <passed>/<total>" the native harness asserts.
//
// resolve()/relative() depend on process.cwd(); those checks are written to be
// cwd-independent (absolute inputs, or relations verified against resolve('.')).

import path, {
	basename,
	delimiter,
	dirname,
	extname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
	sep,
} from "node:path";

const results: Array<[string, boolean]> = [];
function check(name: string, ok: boolean): void {
	results.push([name, !!ok]);
}
function eq(name: string, got: unknown, want: unknown): void {
	check(
		`${name} (got ${JSON.stringify(got)} want ${JSON.stringify(want)})`,
		got === want,
	);
}
function throwsTypeError(name: string, fn: () => unknown): void {
	let threw = false;
	try {
		fn();
	} catch (e) {
		threw = e instanceof TypeError;
	}
	check(name, threw);
}
function throwsRangeError(name: string, fn: () => unknown): void {
	let threw = false;
	try {
		fn();
	} catch (e) {
		threw = e instanceof RangeError;
	}
	check(name, threw);
}

// --- bootstrap additions ---
eq("basename-nested", basename("/foo/bar.txt"), "bar.txt");
eq("basename-trailing", basename("/foo/bar/"), "bar");
eq("basename-root", basename("/"), "");
eq("delimiter-posix", delimiter, ":");
eq("sep-posix", sep, "/");
eq("default-basename-identity", path.basename === basename, true);
eq("default-delimiter", path.delimiter, ":");
eq("default-sep", path.sep, "/");

// --- dirname ---
eq("dirname-nested", dirname("/foo/bar/baz"), "/foo/bar");
eq("dirname-trailing", dirname("/foo/bar/baz/"), "/foo/bar");
eq("dirname-one-level", dirname("/foo"), "/");
eq("dirname-relative", dirname("foo/bar"), "foo");
eq("dirname-bare", dirname("foo"), ".");
eq("dirname-root", dirname("/"), "/");
eq("dirname-empty", dirname(""), ".");
eq("dirname-double-slash", dirname("//foo"), "//");
eq("dirname-embedded-nul", dirname("/a\0b/c"), "/a\0b");

// --- extname ---
eq("extname-html", extname("index.html"), ".html");
eq("extname-double", extname("index.coffee.md"), ".md");
eq("extname-trailing-dot", extname("index."), ".");
eq("extname-none", extname("index"), "");
eq("extname-dotfile", extname(".index"), "");
eq("extname-dotfile-ext", extname(".index.md"), ".md");
eq("extname-with-dir", extname("path/to/file.txt"), ".txt");
eq("extname-hidden-with-ext", extname("path/.config.json"), ".json");
eq("extname-dot-run", extname("file..."), ".");
eq("extname-dotdot", extname(".."), "");
eq("extname-root", extname("/"), "");
eq("extname-empty", extname(""), "");
eq("extname-embedded-nul", extname("a\0b.txt"), ".txt");

// --- isAbsolute ---
eq("isAbsolute-abs", isAbsolute("/foo/bar"), true);
eq("isAbsolute-abs-dotdot", isAbsolute("/baz/.."), true);
eq("isAbsolute-rel", isAbsolute("qux/"), false);
eq("isAbsolute-dot", isAbsolute("."), false);
eq("isAbsolute-empty", isAbsolute(""), false);
eq("isAbsolute-embedded-nul", isAbsolute("/\0a"), true);

// --- join ---
eq("join-doc", join("/foo", "bar", "baz/asdf", "quux", ".."), "/foo/bar/baz/asdf");
eq("join-relative", join("foo", "bar"), "foo/bar");
eq("join-dotdot", join("/foo", "../bar"), "/bar");
eq("join-empty-middle", join("a", "", "b"), "a/b");
eq("join-collapse", join("foo", ".."), ".");
eq("join-none", join(), ".");
eq("join-all-empty", join("", ""), ".");
eq("join-dot", join(".", "foo"), "foo");
eq("join-extra-slashes", join("foo/", "/bar"), "foo/bar");
eq("join-root", join("/", "foo"), "/foo");
eq("join-above-root", join("a", "..", "..", "b"), "../b");
eq("join-trailing-separator", join("a", "b/"), "a/b/");
eq("join-unicode", join("/alpha", "\u{1f40a}", "..", "beta.txt"), "/alpha/beta.txt");
eq("join-embedded-nul", join("a\0b", "c"), "a\0b/c");
const halfStringLimit = "x".repeat(1 << 23);
throwsRangeError("join-string-limit", () => join(halfStringLimit, halfStringLimit));

// --- normalize ---
eq("normalize-empty", normalize(""), ".");
eq("normalize-dot", normalize("."), ".");
eq("normalize-dot-trailing", normalize("./"), "./");
eq("normalize-repeated-separators", normalize("a//b///c"), "a/b/c");
eq("normalize-dot-segments", normalize("a/./b/../c"), "a/c");
eq("normalize-relative-leading-dotdot", normalize("../../a"), "../../a");
eq("normalize-relative-above-start", normalize("a/../../b"), "../b");
eq("normalize-absolute-root", normalize("///"), "/");
eq("normalize-no-cross-root", normalize("/../../a"), "/a");
eq("normalize-trailing-separator", normalize("a//b/./c/../"), "a/b/");
eq("normalize-relative-root-trailing", normalize("foo/..//"), "./");
eq("normalize-dotdot-trailing", normalize("../"), "../");
eq("normalize-three-dots", normalize("a/..."), "a/...");
eq("normalize-embedded-nul", normalize("a\0b//c/.."), "a\0b");

// --- relative (absolute inputs => cwd-independent) ---
eq(
	"relative-doc",
	relative("/data/orandea/test/aaa", "/data/orandea/impl/bbb"),
	"../../impl/bbb",
);
eq("relative-descend", relative("/foo/bar", "/foo/bar/baz"), "baz");
eq("relative-ascend", relative("/foo/bar/baz", "/foo/bar"), "..");
eq("relative-sibling", relative("/foo/bar", "/foo/baz"), "../baz");
eq(
	"relative-prefix-collision",
	relative("/foo/bar", "/foo/barista/baz"),
	"../barista/baz",
);
eq("relative-from-root", relative("/", "/foo"), "foo");
eq("relative-to-root", relative("/foo/bar", "/"), "../..");
eq("relative-equal", relative("/foo", "/foo"), "");
eq("relative-deep-descend", relative("/a/b/c", "/a/b/c/d/e"), "d/e");
eq("relative-deep-ascend", relative("/a/b/c/d", "/a/b"), "../..");
eq("relative-embedded-nul", relative("/a", "/b\0c"), "../b\0c");

// --- resolve (absolute inputs => cwd-independent) ---
eq("resolve-abs-plus-rel", resolve("/foo", "bar"), "/foo/bar");
eq("resolve-last-abs-wins", resolve("/a/b", "/c", "d"), "/c/d");
eq("resolve-dot-segment", resolve("/foo/bar", "./baz"), "/foo/bar/baz");
eq("resolve-dotdot", resolve("/foo/bar", ".."), "/foo");
eq("resolve-empty-segments", resolve("", "/foo", "", "bar"), "/foo/bar");
eq("resolve-root", resolve("/"), "/");
eq("resolve-collapse-to-root", resolve("/a/.."), "/");
eq("resolve-embedded-nul", resolve("/a\0b", "c"), "/a\0b/c");

// resolve is lazy right-to-left: an absolute segment stops the scan before an
// earlier non-string is ever validated (so this must NOT throw).
const nonStr: unknown = 123;
eq("resolve-lazy-validation", resolve(nonStr as string, "/abs"), "/abs");

// --- resolve/relative cwd relations (cwd-independent) ---
const cwd = resolve(".");
check("resolve-cwd-absolute", isAbsolute(cwd));
eq("resolve-no-args-is-cwd", resolve(), cwd);
eq("resolve-empty-is-cwd", resolve(""), cwd);
eq("resolve-cwd-anchored", resolve(cwd, "x/y"), resolve("x/y"));
eq("resolve-relative-endswith", resolve("a/b").slice(-4), "/a/b");
eq("relative-cwd-roundtrip", relative(cwd, resolve("sub/dir")), "sub/dir");

// --- default object: same identities and behavior as named exports ---
eq("default-dirname-identity", path.dirname === dirname, true);
eq("default-join-identity", path.join === join, true);
eq("default-normalize-identity", path.normalize === normalize, true);
eq("default-resolve-identity", path.resolve === resolve, true);
eq("default-typeof-join", typeof path.join, "function");
eq("default-behaves", path.join("/a", "b", "..", "c"), "/a/c");
eq("default-isAbsolute", path.isAbsolute("/x"), true);
eq("default-extname-identity", path.extname === extname, true);
eq("default-isAbsolute-identity", path.isAbsolute === isAbsolute, true);
eq("default-relative-identity", path.relative === relative, true);

// --- built-in function metadata ---
eq("dirname-name", dirname.name, "dirname");
eq("dirname-length", dirname.length, 1);
eq("extname-length", extname.length, 1);
eq("isAbsolute-length", isAbsolute.length, 1);
eq("join-length", join.length, 0);
eq("normalize-name", normalize.name, "normalize");
eq("normalize-length", normalize.length, 1);
eq("relative-length", relative.length, 2);
eq("resolve-length", resolve.length, 0);

// --- argument validation (Node validateString: non-string => TypeError) ---
throwsTypeError("dirname-nonstring", () => dirname(123 as unknown as string));
throwsTypeError("dirname-missing", () => (dirname as (p?: string) => string)());
throwsTypeError("extname-null", () => extname(null as unknown as string));
throwsTypeError("isAbsolute-undefined", () => isAbsolute(undefined as unknown as string));
throwsTypeError("join-nonstring", () => join("ok", 5 as unknown as string));
throwsTypeError("normalize-nonstring", () => normalize(5 as unknown as string));
throwsTypeError("normalize-missing", () => (normalize as (p?: string) => string)());
throwsTypeError("relative-from-nonstring", () => relative(1 as unknown as string, "/x"));
throwsTypeError("relative-to-nonstring", () => relative("/x", {} as unknown as string));
throwsTypeError("resolve-visited-nonstring", () =>
	resolve("/abs", true as unknown as string),
);

// --- summary ---
let passed = 0;
for (const [name, ok] of results) {
	if (ok) {
		passed++;
	} else {
		console.log(`FAIL: ${name}`);
	}
}
console.log(`RESULT ${passed}/${results.length}`);
