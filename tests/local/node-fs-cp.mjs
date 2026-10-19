import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mal-cp-")));
const at = (...parts) => path.join(root, ...parts);
const rel = (value) => String(value).replaceAll(root, "<root>");
const describe = (error) =>
	[
		error.name,
		error.code,
		rel(error.message),
		error.errno,
		error.syscall,
		error.path === undefined ? undefined : rel(error.path),
		Object.keys(error).join(),
		error.info === undefined ? "" : rel(JSON.stringify(error.info)),
	].join(" | ");
const trySync = (label, run) => {
	try {
		run();
		console.log(label, "ok");
	} catch (error) {
		console.log(label, describe(error));
	}
};
const tryAsync = async (label, run) => {
	try {
		await run();
		console.log(label, "ok");
	} catch (error) {
		console.log(label, describe(error));
	}
};
const tree = (dir) =>
	fs
		.readdirSync(dir, { recursive: true })
		.sort()
		.map((entry) => {
			const stat = fs.lstatSync(path.join(dir, entry));
			if (stat.isSymbolicLink())
				return `${entry}->${rel(fs.readlinkSync(path.join(dir, entry)))}`;
			if (stat.isDirectory()) return `${entry}/`;
			return `${entry}=${fs.readFileSync(path.join(dir, entry), "utf8")}`;
		})
		.join(" ");

fs.mkdirSync(at("src", "sub", "deep"), { recursive: true });
fs.writeFileSync(at("src", "a.txt"), "a");
fs.writeFileSync(at("src", "sub", "b.txt"), "b");
fs.writeFileSync(at("src", "sub", "deep", "c.txt"), "c");
fs.symlinkSync("a.txt", at("src", "link"));
fs.chmodSync(at("src", "a.txt"), 0o640);
fs.utimesSync(at("src", "a.txt"), 1000.5, 2000.25);

console.log(
	fs.cp.length,
	fs.cpSync.length,
	fsp.cp.length,
	fs.glob.length,
	fs.globSync.length,
);

fs.cpSync(at("src"), at("copy"), { recursive: true });
console.log("copy", tree(at("copy")));
console.log("mode", (fs.statSync(at("copy", "a.txt")).mode & 0o777).toString(8));

fs.cpSync(at("src"), at("verbatim"), { recursive: true, verbatimSymlinks: true });
console.log("verbatim", rel(fs.readlinkSync(at("verbatim", "link"))));
fs.cpSync(at("src"), at("deref"), { recursive: true, dereference: true });
console.log("deref", fs.lstatSync(at("deref", "link")).isFile());

const seen = [];
fs.cpSync(at("src"), at("filtered"), {
	recursive: true,
	filter: (src, dest) => {
		seen.push(`${rel(src)}>${rel(dest)}`);
		return !src.endsWith("sub");
	},
});
console.log("filter", seen.sort().join(" "));
console.log("filtered", tree(at("filtered")));

fs.writeFileSync(at("copy", "a.txt"), "old");
fs.cpSync(at("src"), at("copy"), { recursive: true, force: false });
console.log("no force", fs.readFileSync(at("copy", "a.txt"), "utf8"));
fs.cpSync(at("src"), at("copy"), { recursive: true });
console.log("force", fs.readFileSync(at("copy", "a.txt"), "utf8"));

fs.cpSync(at("src", "a.txt"), at("ts.txt"), { preserveTimestamps: true });
console.log("timestamps", fs.statSync(at("ts.txt")).mtimeMs);
fs.cpSync(at("src", "a.txt"), at("nested", "dir", "a.txt"));
console.log("parents", fs.existsSync(at("nested", "dir", "a.txt")));
fs.cpSync(new URL(`file://${at("src", "a.txt")}`), at("url.txt"));
console.log("url", fs.readFileSync(at("url.txt"), "utf8"));

trySync("dir without recursive", () => fs.cpSync(at("src"), at("x")));
trySync("same", () => fs.cpSync(at("src"), at("src"), { recursive: true }));
trySync("subdirectory", () =>
	fs.cpSync(at("src"), at("src", "sub", "x"), { recursive: true }),
);
trySync("dir onto file", () =>
	fs.cpSync(at("src"), at("src", "a.txt"), { recursive: true }),
);
trySync("file onto dir", () => fs.cpSync(at("src", "a.txt"), at("src", "sub")));
trySync("exists", () =>
	fs.cpSync(at("src", "a.txt"), at("copy", "a.txt"), {
		force: false,
		errorOnExist: true,
	}),
);
trySync("dir exists", () =>
	fs.cpSync(at("src"), at("copy"), { recursive: true, force: false, errorOnExist: true }),
);
trySync("excl", () =>
	fs.cpSync(at("src", "a.txt"), at("copy", "a.txt"), {
		mode: fs.constants.COPYFILE_EXCL,
	}),
);
trySync("missing", () => fs.cpSync(at("missing"), at("x")));
trySync("bad src", () => fs.cpSync(1, at("x")));
trySync("bad option", () => fs.cpSync(at("src"), at("x"), { recursive: 1 }));
trySync("bad mode", () => fs.cpSync(at("src"), at("x"), { mode: 9 }));
trySync("bad filter", () => fs.cpSync(at("src"), at("x"), { filter: true }));
trySync("pair", () =>
	fs.cpSync(at("src"), at("x"), { dereference: true, verbatimSymlinks: true }),
);
trySync("async filter", () =>
	fs.cpSync(at("src"), at("x"), { filter: async () => true }),
);
trySync("throwing filter", () =>
	fs.cpSync(at("src"), at("x"), {
		filter: () => {
			throw new Error("filter failed");
		},
	}),
);

await fsp.cp(at("src"), at("async"), { recursive: true });
console.log("async", tree(at("async")));
await fsp.cp(at("src"), at("async-filtered"), {
	recursive: true,
	filter: async (src) => {
		await new Promise((resolve) => setTimeout(resolve, 1));
		return !src.endsWith("deep");
	},
});
console.log("async filtered", tree(at("async-filtered")));
await fsp.cp(at("src"), at("thenable"), {
	recursive: true,
	filter: (src) => ({ then: (resolve) => resolve(!src.endsWith("a.txt")) }),
});
console.log("thenable", tree(at("thenable")));
await tryAsync("async dir", () => fsp.cp(at("src"), at("y")));
await tryAsync("async same", () => fsp.cp(at("src"), at("src"), { recursive: true }));
await tryAsync("async subdirectory", () =>
	fsp.cp(at("src"), at("src", "sub", "y"), { recursive: true }),
);
await tryAsync("async dir onto file", () =>
	fsp.cp(at("src"), at("src", "a.txt"), { recursive: true }),
);
await tryAsync("async file onto dir", () => fsp.cp(at("src", "a.txt"), at("src", "sub")));
await tryAsync("async exists", () =>
	fsp.cp(at("src", "a.txt"), at("copy", "a.txt"), { force: false, errorOnExist: true }),
);
await tryAsync("async missing", () => fsp.cp(at("missing"), at("y")));
await tryAsync("async bad option", () => fsp.cp(at("src"), at("y"), { force: "yes" }));
await tryAsync("async rejecting filter", () =>
	fsp.cp(at("src"), at("y"), { filter: () => Promise.reject(new Error("rejected")) }),
);

await new Promise((resolve) => {
	fs.cp(at("src"), at("callback"), { recursive: true }, (error, ...rest) => {
		console.log("callback", error, rest.length, tree(at("callback")));
		resolve();
	});
});
await new Promise((resolve) => {
	fs.cp(at("src"), at("callback2"), (error) => {
		console.log("callback error", error.code);
		resolve();
	});
});
trySync("callback missing", () => fs.cp(at("src"), at("z")));

console.log(
	"globSync",
	fs
		.globSync("**/*.txt", { cwd: at("src") })
		.sort()
		.join(" "),
);
console.log(
	"globSync types",
	fs
		.globSync("sub/*", { cwd: at("src"), withFileTypes: true })
		.map((entry) => `${entry.name}:${entry.isDirectory()}`)
		.sort()
		.join(" "),
);
console.log(
	"globSync exclude",
	fs.globSync(["*.txt", "sub/*.txt"], { cwd: at("src"), exclude: ["sub/**"] }).join(" "),
);
trySync("globSync bad", () => fs.globSync(1));
trySync("globSync bad element", () => fs.globSync(["a", 1]));
trySync("globSync bad exclude", () => fs.globSync("a", { exclude: 1 }));
await new Promise((resolve) => {
	let sync = true;
	fs.glob("**/b.txt", { cwd: at("src") }, (error, matches) => {
		console.log("glob callback", error, matches, sync);
		resolve();
	});
	sync = false;
});
await new Promise((resolve) => {
	fs.glob("*.txt", (error, matches) => {
		console.log("glob cwd", error, Array.isArray(matches));
		resolve();
	});
});
trySync("glob bad", () => fs.glob(1, () => {}));

fs.rmSync(root, { recursive: true });
