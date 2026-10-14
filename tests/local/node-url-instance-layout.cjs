const { Url, parse, format } = require("node:url");
const collect = globalThis.__mal_collect_garbage ?? globalThis.gc;
const fields = [
	"protocol",
	"slashes",
	"auth",
	"host",
	"port",
	"hostname",
	"hash",
	"search",
	"query",
	"pathname",
	"path",
	"href",
];
function inspect(instance) {
	const descriptors = fields.map((key) => {
		const desc = Object.getOwnPropertyDescriptor(instance, key);
		return `${key}:${desc.value}:${desc.writable}:${desc.enumerable}:${desc.configurable}`;
	});
	console.log(`${Object.keys(instance).join(",")} ${descriptors.join("|")}`);
}
const first = new Url();
inspect(first);
first.protocol = "https:";
first.pathname = "/first";
delete first.auth;
first.extra = "kept";
const second = new Url();
inspect(second);
console.log(
	`independent ${first.protocol} ${first.pathname} ${second.protocol} ${Object.hasOwn(first, "auth")}`,
);
class Derived extends Url {
	constructor() {
		super();
		this.extra = "derived";
	}
}
const derived = new Derived();
console.log(
	`derived ${derived instanceof Derived} ${derived instanceof Url} ${derived.extra} ${Object.keys(derived).join(",")}`,
);
const target = function Target() {}.bind(null);
let prototypeReads = 0;
Object.defineProperty(target, "prototype", {
	get() {
		prototypeReads++;
		if (collect) collect();
		return { inherited: "custom" };
	},
});
const custom = Reflect.construct(Url, [], target);
console.log(
	`prototype ${custom.inherited} ${prototypeReads} ${Object.keys(custom).join(",")}`,
);
const throwingTarget = function ThrowingTarget() {}.bind(null);
Object.defineProperty(throwingTarget, "prototype", {
	get() {
		throw new RangeError("prototype lookup");
	},
});
try {
	Reflect.construct(Url, [], throwingTarget);
} catch (error) {
	console.log(`prototype throw ${error.name}:${error.message}`);
}
const existing = { extra: "existing", protocol: "old" };
Url.call(existing);
console.log(
	`existing ${existing.extra} ${existing.protocol} ${Object.keys(existing).join(",")}`,
);
const parsed = parse("https://user:pass@example.com:8443/path?q=one#hash");
console.log(
	`parse ${parsed.protocol} ${parsed.auth} ${parsed.hostname} ${parsed.port} ${parsed.pathname} ${parsed.search} ${parsed.hash}`,
);
parsed.auth = null;
console.log(`format ${format(parsed)}`);
second.pathname = { retained: "payload" };
if (collect) collect();
console.log(
	`retained ${second.pathname.retained} ${first.protocol} ${derived.extra} ${custom.inherited}`,
);
