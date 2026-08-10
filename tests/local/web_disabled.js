// Runtime fixture for `surface.webPlatform: false`. Built with webPlatformEnabled:
// false against the host entry, so the entire WinterTC web personality is gated out
// of host_main — and with it the ada C++ URL parser + `-lc++`. Unlike eval (which
// keeps a throwing binding), these globals are simply never installed. The main
// point of this fixture is that a host binary LINKS AT ALL with the web surface +
// ada gone (no undefined symbols); it then asserts the surface is absent and the
// core engine intact.

const absent = [
	// URL / URLSearchParams (web_url.c → ada).
	"URL",
	"URLSearchParams",
	// fetch surface + Mal.serve (web_fetch.c).
	"fetch",
	"Response",
	"Request",
	"Mal",
	// timers (web_host_timer.c).
	"setTimeout",
	"clearTimeout",
	// web globals (web_globals.c).
	"TextEncoder",
	"structuredClone",
	"queueMicrotask",
	// events (web_events.c).
	"Event",
	"CustomEvent",
	"EventTarget",
	"AbortController",
];

const results = [];
for (const name of absent) {
	results.push([name + " undefined", typeof globalThis[name] === "undefined"]);
}
// The core engine is unaffected by dropping the web surface.
results.push(["core intact", [1, 2, 3].map((x) => x * 2).join(",") === "2,4,6"]);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
