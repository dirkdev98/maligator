import url, { URL, URLSearchParams, urlToHttpOptions } from "node:url";
const results = [];
const params = new URLSearchParams("a=1&a=2&x=%C3%A9");
results.push([
	"constructors",
	URL === globalThis.URL,
	URLSearchParams === globalThis.URLSearchParams,
	url.URLSearchParams === URLSearchParams,
	new URL("https://example.com?a=1").searchParams instanceof URLSearchParams,
	params.getAll("a"),
	params.get("x"),
]);
function record(label, value) {
	try {
		const options = urlToHttpOptions(value);
		results.push([
			label,
			Object.getPrototypeOf(options) === null,
			Reflect.ownKeys(options).map((k) => [String(k), options[k]]),
		]);
	} catch (error) {
		results.push([label, error.name, error.code]);
	}
}
for (const value of [
	new URL("http://example.com/"),
	new URL("https://user%3Aname:p%40ss@[::1]:8443/a?b=1#x"),
	new URL("file:///a"),
	new URL("https://xn--bcher-kva.example/%E2%82%AC"),
	{},
	[],
	{
		hostname: "[::1]",
		pathname: "/p",
		search: "?x",
		port: "",
		username: "",
		password: "",
		protocol: "http:",
		hash: "#h",
		href: "custom",
		extra: 3,
		[Symbol("key")]: 7,
	},
	{ hostname: "name", port: 123n, pathname: 0, search: false },
	{ hostname: "name", port: undefined, username: undefined, password: "yes" },
	{ hostname: "name", port: "", username: "%ff", password: "" },
	undefined,
	null,
	"x",
	3,
	true,
	1n,
	Symbol("x"),
	function f() {},
])
	record("case", value);
const observations = [];
const original = {
	hostname: "[::1]",
	pathname: "/p",
	port: "80",
	username: "u",
	password: "p",
	search: "?q",
	protocol: "http:",
	hash: "#h",
	href: "x",
	extra: 1,
};
const proxy = new Proxy(original, {
	get(t, k, r) {
		observations.push("get:" + String(k));
		return Reflect.get(t, k, r);
	},
	ownKeys(t) {
		observations.push("keys");
		return Reflect.ownKeys(t);
	},
	getOwnPropertyDescriptor(t, k) {
		observations.push("desc:" + String(k));
		return Reflect.getOwnPropertyDescriptor(t, k);
	},
});
record("proxy", proxy);
results.push(["observations", observations]);
const sentinel = {};
try {
	urlToHttpOptions({
		get hostname() {
			throw sentinel;
		},
	});
} catch (e) {
	results.push(["throw", e === sentinel]);
}
const ntObservations = [];
const target = new Proxy(function Target() {}, {
	get(t, k) {
		ntObservations.push(String(k));
		return Reflect.get(t, k);
	},
});
const instance = Reflect.construct(
	urlToHttpOptions,
	[new URL("http://example.com")],
	target,
);
results.push(["construct", Object.getPrototypeOf(instance) === null, ntObservations]);
console.log(JSON.stringify(results));
