const http = require("http");
const canonical = require("node:http");
const Stream = require("node:stream");

const expectedMethods =
	"ACL,BIND,CHECKOUT,CONNECT,COPY,DELETE,GET,HEAD,LINK,LOCK,M-SEARCH,MERGE,MKACTIVITY,MKCALENDAR,MKCOL,MOVE,NOTIFY,OPTIONS,PATCH,POST,PROPFIND,PROPPATCH,PURGE,PUT,QUERY,REBIND,REPORT,SEARCH,SOURCE,SUBSCRIBE,TRACE,UNBIND,UNLINK,UNLOCK,UNSUBSCRIBE";
const checks = [
	http === canonical,
	http.METHODS.join(",") === expectedMethods,
	Object.getPrototypeOf(http.IncomingMessage.prototype) === Stream.Readable.prototype,
	Object.getPrototypeOf(http.ServerResponse.prototype) === Stream.prototype,
	new http.IncomingMessage() instanceof Stream.Readable,
	new http.ServerResponse() instanceof Stream,
	typeof http.createServer === "undefined",
];

console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
