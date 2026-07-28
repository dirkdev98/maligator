const http = require("http");
const canonical = require("node:http");
const Stream = require("node:stream");
const Events = require("node:events");

const expectedMethods =
	"ACL,BIND,CHECKOUT,CONNECT,COPY,DELETE,GET,HEAD,LINK,LOCK,M-SEARCH,MERGE,MKACTIVITY,MKCALENDAR,MKCOL,MOVE,NOTIFY,OPTIONS,PATCH,POST,PROPFIND,PROPPATCH,PURGE,PUT,QUERY,REBIND,REPORT,SEARCH,SOURCE,SUBSCRIBE,TRACE,UNBIND,UNLINK,UNLOCK,UNSUBSCRIBE";
let listenerReceiver;
function listener() {
	listenerReceiver = this;
}
const server = http.createServer(listener);
server.emit("request");
let invalidListener = false;
try {
	http.createServer({}, null);
} catch (error) {
	invalidListener = error instanceof TypeError;
}
const checks = [
	http === canonical,
	http.METHODS.join(",") === expectedMethods,
	http.STATUS_CODES[103] === "Early Hints",
	http.STATUS_CODES[425] === "Too Early",
	http.STATUS_CODES[511] === "Network Authentication Required",
	http.validateHeaderName("x-valid") === undefined,
	http.validateHeaderValue("x-valid", "value") === undefined,
	Object.getPrototypeOf(http.IncomingMessage.prototype) === Stream.Readable.prototype,
	Object.getPrototypeOf(http.ServerResponse.prototype) === Stream.prototype,
	new http.IncomingMessage() instanceof Stream.Readable,
	new http.ServerResponse() instanceof Stream,
	Object.getPrototypeOf(http.Server.prototype) === Events.prototype,
	Object.getPrototypeOf(http.Server) === Events,
	http.Server.length === 2 && http.createServer.length === 2,
	server instanceof http.Server,
	server instanceof Events,
	server.listenerCount("request") === 1,
	server.listeners("request")[0] === listener,
	listenerReceiver === server,
	http.Server.call(server) !== server,
	http.createServer.call({ Server: null }) instanceof http.Server,
	invalidListener,
];

console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
