import bareHttp from "http";
import Events from "node:events";
import http, {
	createServer,
	IncomingMessage,
	METHODS,
	Server,
	ServerResponse,
} from "node:http";
import Stream, { Readable } from "node:stream";

const expectedMethods =
	"ACL,BIND,CHECKOUT,CONNECT,COPY,DELETE,GET,HEAD,LINK,LOCK,M-SEARCH,MERGE,MKACTIVITY,MKCALENDAR,MKCOL,MOVE,NOTIFY,OPTIONS,PATCH,POST,PROPFIND,PROPPATCH,PURGE,PUT,QUERY,REBIND,REPORT,SEARCH,SOURCE,SUBSCRIBE,TRACE,UNBIND,UNLINK,UNLOCK,UNSUBSCRIBE";
const incoming = new IncomingMessage();
const response = new ServerResponse();
const responseReceiver = {};
const calledResponse = ServerResponse.call(responseReceiver);
class DerivedResponse extends ServerResponse {}
const derivedResponse = new DerivedResponse();
let listenerReceiver;
function listener() {
	listenerReceiver = this;
}
const server = createServer({ keepAlive: true }, listener);
server.emit("request");
const calledServer = Server.call({ ignored: true }, listener);
class DerivedServer extends Server {}
const derivedServer = new DerivedServer();
let invalidListener = false;
let invalidOptions = false;
try {
	createServer({}, 1);
} catch (error) {
	invalidListener = error instanceof TypeError;
}
try {
	new Server(1);
} catch (error) {
	invalidOptions = error instanceof TypeError;
}
const checks = [
	bareHttp === http,
	http.METHODS === METHODS,
	http.IncomingMessage === IncomingMessage,
	http.ServerResponse === ServerResponse,
	http.Server === Server,
	http.createServer === createServer,
	METHODS.join(",") === expectedMethods,
	Object.getPrototypeOf(IncomingMessage.prototype) === Readable.prototype,
	Object.getPrototypeOf(ServerResponse.prototype) === Stream.prototype,
	incoming instanceof IncomingMessage,
	incoming instanceof Readable,
	response instanceof ServerResponse,
	response instanceof Stream,
	response instanceof Events,
	calledResponse === responseReceiver,
	Object.getPrototypeOf(calledResponse) === Object.prototype,
	Object.getOwnPropertyNames(calledResponse).join(",") ===
		"_events,_eventsCount,_maxListeners,destroyed,_malStreamKind,statusCode,statusMessage,headersSent,finished,writableEnded,writableFinished",
	calledResponse.statusCode === 200,
	derivedResponse instanceof DerivedResponse,
	derivedResponse instanceof ServerResponse,
	derivedResponse instanceof Stream,
	Object.getPrototypeOf(derivedResponse) === DerivedResponse.prototype,
	Object.getPrototypeOf(Server.prototype) === Events.prototype,
	Object.getPrototypeOf(Server) === Events,
	Server.length === 2 && createServer.length === 2,
	server instanceof Server,
	server instanceof Events,
	server.listenerCount("request") === 1,
	server.listeners("request")[0] === listener,
	listenerReceiver === server,
	calledServer instanceof Server && calledServer.ignored === undefined,
	calledServer.listenerCount("request") === 1,
	derivedServer instanceof DerivedServer && derivedServer instanceof Server,
	createServer.call(null) instanceof Server,
	invalidListener,
	invalidOptions,
];

console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
