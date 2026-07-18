import bareHttp from "http";
import Events from "node:events";
import http, { IncomingMessage, METHODS, ServerResponse } from "node:http";
import Stream, { Readable } from "node:stream";

const expectedMethods =
	"ACL,BIND,CHECKOUT,CONNECT,COPY,DELETE,GET,HEAD,LINK,LOCK,M-SEARCH,MERGE,MKACTIVITY,MKCALENDAR,MKCOL,MOVE,NOTIFY,OPTIONS,PATCH,POST,PROPFIND,PROPPATCH,PURGE,PUT,QUERY,REBIND,REPORT,SEARCH,SOURCE,SUBSCRIBE,TRACE,UNBIND,UNLINK,UNLOCK,UNSUBSCRIBE";
const incoming = new IncomingMessage();
const response = new ServerResponse();
const checks = [
	bareHttp === http,
	http.METHODS === METHODS,
	http.IncomingMessage === IncomingMessage,
	http.ServerResponse === ServerResponse,
	METHODS.join(",") === expectedMethods,
	Object.getPrototypeOf(IncomingMessage.prototype) === Readable.prototype,
	Object.getPrototypeOf(ServerResponse.prototype) === Stream.prototype,
	incoming instanceof IncomingMessage,
	incoming instanceof Readable,
	response instanceof ServerResponse,
	response instanceof Stream,
	response instanceof Events,
	typeof http.createServer === "undefined",
];

console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
