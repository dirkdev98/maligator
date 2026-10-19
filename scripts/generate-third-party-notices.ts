import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "THIRD_PARTY_NOTICES.md");

interface Derivation {
	file: string;
	upstream: string;
}

// Runtime files that translate upstream code closely enough to carry its notice.
const NODE_DERIVED: Array<Derivation> = [
	{
		file: "runtime/src/runtime/node_assert_strict.c",
		upstream: "lib/internal/assert/assertion_error.js, lib/internal/assert/myers_diff.js",
	},
	{
		file: "runtime/src/runtime/node_buffer.c",
		upstream: "lib/buffer.js, src/node_buffer.cc",
	},
	{
		file: "runtime/src/runtime/node_deep_equal.c",
		upstream: "lib/internal/util/comparisons.js",
	},
	{
		file: "runtime/src/runtime/node_diagnostics_channel.c",
		upstream: "lib/diagnostics_channel.js",
	},
	{ file: "runtime/src/runtime/node_dns.c", upstream: "lib/dns.js" },
	{ file: "runtime/src/runtime/node_dotenv.c", upstream: "src/node_dotenv.cc" },
	{
		file: "runtime/src/runtime/node_fs.c",
		upstream: "lib/internal/fs/cp/cp.js, lib/internal/fs/cp/cp-sync.js, src/node_file.cc",
	},
	{ file: "runtime/src/runtime/node_http.c", upstream: "lib/_http_outgoing.js" },
	{
		file: "runtime/src/runtime/node_inspect.c",
		upstream: "lib/internal/util/inspect.js",
	},
	{ file: "runtime/src/runtime/node_dgram.c", upstream: "lib/dgram.js" },
	{ file: "runtime/src/runtime/node_net.c", upstream: "lib/net.js, lib/_tls_wrap.js" },
	{ file: "runtime/src/runtime/node_path.c", upstream: "lib/path.js" },
	{
		file: "runtime/src/runtime/node_url.c",
		upstream: "lib/url.js, lib/internal/querystring.js",
	},
	{ file: "runtime/src/runtime/node_tls.c", upstream: "lib/tls.js, lib/_tls_wrap.js" },
	{ file: "runtime/src/runtime/node_util_mime.c", upstream: "lib/internal/mime.js" },
];

const LIBUV_DERIVED: Array<Derivation> = [
	{ file: "runtime/src/host/posix_fs.c", upstream: "src/unix/fs.c uv_fs_copyfile" },
];

function read(relative: string): string {
	return readFileSync(path.join(root, relative), "utf8").trimEnd();
}

function fence(text: string): string {
	return ["```text", text, "```"].join("\n");
}

function derivationTable(project: string, entries: Array<Derivation>): string {
	for (const entry of entries) {
		const header = `// Portions derived from ${project} ${entry.upstream} (MIT); see THIRD_PARTY_NOTICES.md.`;
		if (read(entry.file).split("\n", 1)[0] !== header) {
			throw new Error(`${entry.file} must start with the line: ${header}`);
		}
	}
	return [
		"| Maligator file | Upstream source |",
		"| --- | --- |",
		...entries.map((entry) => `| \`${entry.file}\` | ${entry.upstream} |`),
	].join("\n");
}

interface CargoPackage {
	id: string;
	name: string;
	version: string;
	license: string | null;
	license_file: string | null;
	manifest_path: string;
	source: string | null;
}

interface CargoMetadata {
	packages: Array<CargoPackage>;
	resolve: {
		root: string | null;
		nodes: Array<{
			id: string;
			deps: Array<{ pkg: string; dep_kinds: Array<{ kind: string | null }> }>;
		}>;
	};
}

// The pinned toolchain's cargo needs its own rustc on PATH, which rustup proxies may not provide.
function cargoMetadata(): CargoMetadata {
	const cwd = path.join(root, "runtime/rust");
	const cargo = execFileSync("rustup", ["which", "cargo"], {
		cwd,
		encoding: "utf8",
	}).trim();
	const text = execFileSync(
		cargo,
		["metadata", "--format-version", "1", "--locked", "--offline", "--all-features"],
		{
			cwd,
			encoding: "utf8",
			maxBuffer: 1 << 28,
			env: {
				...process.env,
				PATH: `${path.dirname(cargo)}${path.delimiter}${process.env.PATH ?? ""}`,
			},
		},
	);
	return JSON.parse(text) as CargoMetadata;
}

// Build scripts and dev-dependencies never reach a linked binary; only normal edges count.
function linkedPackages(metadata: CargoMetadata): Array<CargoPackage> {
	const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
	const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
	const rootId = metadata.resolve.root;
	if (rootId === null) throw new Error("cargo metadata did not report a root package");
	const seen = new Set<string>();
	const pending = [rootId];
	while (pending.length > 0) {
		const id = pending.pop()!;
		if (seen.has(id)) continue;
		seen.add(id);
		for (const dep of nodes.get(id)?.deps ?? []) {
			if (dep.dep_kinds.some((kind) => kind.kind === null)) pending.push(dep.pkg);
		}
	}
	return [...seen]
		.map((id) => packages.get(id)!)
		.filter((pkg) => pkg.source !== null)
		.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense)([-._].*)?$/i;

function licenseFiles(pkg: CargoPackage): Array<string> {
	const directory = path.dirname(pkg.manifest_path);
	const files = readdirSync(directory)
		.filter((name) => LICENSE_FILE.test(name))
		.map((name) => path.join(directory, name));
	if (pkg.license_file !== null) {
		const declared = path.resolve(directory, pkg.license_file);
		if (!files.includes(declared)) files.push(declared);
	}
	return files.sort();
}

function rustSection(): string {
	const crates = linkedPackages(cargoMetadata());
	const texts = new Map<string, { text: string; users: Array<string> }>();
	const missing: Array<string> = [];
	for (const pkg of crates) {
		const label = `${pkg.name} ${pkg.version}${pkg.license === null ? "" : ` (${pkg.license})`}`;
		const files = licenseFiles(pkg);
		if (files.length === 0) missing.push(label);
		for (const file of files) {
			const text = readFileSync(file, "utf8").replaceAll("\r\n", "\n").trimEnd();
			const key = createHash("sha256").update(text).digest("hex");
			const entry = texts.get(key) ?? { text, users: [] };
			entry.users.push(`${label}: ${path.basename(file)}`);
			texts.set(key, entry);
		}
	}
	const lines = [
		"## Rust crates",
		"",
		"The runtime links these crates from crates.io through `runtime/rust/Cargo.lock`. Each license",
		"text below is followed by the crates that ship it; dual-licensed crates list every text they",
		"provide, and the recipient may choose among the alternatives their license expression offers.",
		"",
		"| Crate | Version | License |",
		"| --- | --- | --- |",
		...crates.map(
			(pkg) => `| ${pkg.name} | ${pkg.version} | ${pkg.license ?? "see license file"} |`,
		),
	];
	if (missing.length > 0) {
		lines.push(
			"",
			"These crates publish no license file; their declared license expression applies:",
			"",
		);
		lines.push(...missing.map((label) => `- ${label}`));
	}
	for (const entry of [...texts.values()].sort((a, b) =>
		a.users[0]!.localeCompare(b.users[0]!),
	)) {
		lines.push("", `### ${entry.users[0]}`, "");
		if (entry.users.length > 1) {
			lines.push(
				"Also shipped by:",
				"",
				...entry.users.slice(1).map((user) => `- ${user}`),
				"",
			);
		}
		lines.push(fence(entry.text));
	}
	return lines.join("\n");
}

const sqliteDedication = read("runtime/vendor/sqlite/README.md")
	.split("\n")
	.filter(
		(line) => line.includes("public domain") || line.includes("sqlite.org/copyright"),
	)
	.join("\n");

const document = [
	"# Third-party notices",
	"",
	"Maligator's runtime ships as source inside the compiler and is compiled into every binary",
	"it builds. It contains code derived from, or vendored from, the projects below. Their",
	"notices travel with Maligator's own [LICENSE](LICENSE). This file is generated by",
	"`node scripts/generate-third-party-notices.ts`; edit the script, not this file.",
	"",
	"## Node.js",
	"",
	"These files translate parts of Node.js to C, following the upstream algorithms, messages",
	"and error codes closely:",
	"",
	derivationTable("Node.js", NODE_DERIVED),
	"",
	fence(read("runtime/vendor/node/LICENSE")),
	"",
	"## libuv",
	"",
	derivationTable("libuv", LIBUV_DERIVED),
	"",
	fence(read("runtime/vendor/libuv/LICENSE")),
	"",
	"## llhttp",
	"",
	"Vendored under `runtime/vendor/llhttp` and compiled into the host runtime.",
	"",
	fence(read("runtime/vendor/llhttp/LICENSE-MIT")),
	"",
	"## SQLite",
	"",
	"Vendored under `runtime/vendor/sqlite` and compiled into the host runtime.",
	"",
	sqliteDedication,
	"",
	"## Unicode data",
	"",
	"The generated Unicode tables in `runtime/src` derive from the Unicode Character Database.",
	"",
	fence(read("runtime/vendor/unicode/LICENSE.txt")),
	"",
	rustSection(),
	"",
].join("\n");

writeFileSync(output, document);
execFileSync(path.join(root, "node_modules/.bin/oxfmt"), [output], {
	cwd: root,
	stdio: "ignore",
});
console.log(`[third-party-notices] wrote ${path.relative(root, output)}`);
