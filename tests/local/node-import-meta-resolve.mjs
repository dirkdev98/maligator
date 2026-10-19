import { escaped } from "./import-meta-resolve-escape.mjs";

const root = new URL("../../", import.meta.url);
const clean = (value) =>
	String(value)
		.replaceAll(root.href, "<root>/")
		.replaceAll(decodeURIComponent(root.pathname), "<root>/");
const show = (label, run) => {
	try {
		console.log(label, clean(run()));
	} catch (error) {
		console.log(label, "throws", error.name, error.code, clean(error.message));
	}
};

show("literal relative", () => import.meta.resolve("./import-meta-resolve-escape.mjs"));
show("literal missing", () => import.meta.resolve("./missing-file.js"));
show("literal parent", () => import.meta.resolve("../fixtures/none/"));
show("literal builtin", () => import.meta.resolve("fs"));
show("literal node:", () => import.meta.resolve("node:path"));
show("literal url", () => import.meta.resolve("https://example.com/a/../b?q#h"));
show("literal package", () => import.meta.resolve("meriyah"));
show("literal unknown package", () =>
	import.meta.resolve("no-such-package-anywhere/sub"),
);

const dynamic = (specifier) => import.meta.resolve(specifier);
show("dynamic relative", () => dynamic("./a b.js"));
show("dynamic builtin", () => dynamic("fs/promises"));
show("dynamic prefix-only builtin", () => dynamic("test"));
show("dynamic imported", () => dynamic("./import-meta-resolve-escape.mjs"));
show("dynamic unknown scoped", () => dynamic("@scope/nothing/deep"));
show("dynamic coercion", () => dynamic({ toString: () => "node:os" }));
show("function", () =>
	[typeof import.meta.resolve, import.meta.resolve.name, import.meta.resolve.length].join(
		" ",
	),
);
show("escaped", escaped);
