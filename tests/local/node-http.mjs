import bareHttp from "http";
import Events from "node:events";
import http, {
	createServer,
	IncomingMessage,
	METHODS,
	Server,
	ServerResponse,
	STATUS_CODES,
	validateHeaderName,
	validateHeaderValue,
} from "node:http";
import Stream, { Readable } from "node:stream";

const expectedMethods =
	"ACL,BIND,CHECKOUT,CONNECT,COPY,DELETE,GET,HEAD,LINK,LOCK,M-SEARCH,MERGE,MKACTIVITY,MKCALENDAR,MKCOL,MOVE,NOTIFY,OPTIONS,PATCH,POST,PROPFIND,PROPPATCH,PURGE,PUT,QUERY,REBIND,REPORT,SEARCH,SOURCE,SUBSCRIBE,TRACE,UNBIND,UNLINK,UNLOCK,UNSUBSCRIBE";
const expectedStatuses =
	"100:Continue|101:Switching Protocols|102:Processing|103:Early Hints|200:OK|201:Created|202:Accepted|203:Non-Authoritative Information|204:No Content|205:Reset Content|206:Partial Content|207:Multi-Status|208:Already Reported|226:IM Used|300:Multiple Choices|301:Moved Permanently|302:Found|303:See Other|304:Not Modified|305:Use Proxy|307:Temporary Redirect|308:Permanent Redirect|400:Bad Request|401:Unauthorized|402:Payment Required|403:Forbidden|404:Not Found|405:Method Not Allowed|406:Not Acceptable|407:Proxy Authentication Required|408:Request Timeout|409:Conflict|410:Gone|411:Length Required|412:Precondition Failed|413:Payload Too Large|414:URI Too Long|415:Unsupported Media Type|416:Range Not Satisfiable|417:Expectation Failed|418:I'm a Teapot|421:Misdirected Request|422:Unprocessable Entity|423:Locked|424:Failed Dependency|425:Too Early|426:Upgrade Required|428:Precondition Required|429:Too Many Requests|431:Request Header Fields Too Large|451:Unavailable For Legal Reasons|500:Internal Server Error|501:Not Implemented|502:Bad Gateway|503:Service Unavailable|504:Gateway Timeout|505:HTTP Version Not Supported|506:Variant Also Negotiates|507:Insufficient Storage|508:Loop Detected|509:Bandwidth Limit Exceeded|510:Not Extended|511:Network Authentication Required";
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
let invalidHeaderName = false;
let invalidHeaderValue = false;
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
try {
	validateHeaderName("bad name");
} catch (error) {
	invalidHeaderName = error instanceof TypeError;
}
try {
	validateHeaderValue("x-test", "bad\nvalue");
} catch (error) {
	invalidHeaderValue = error instanceof TypeError;
}
const checks = [
	bareHttp === http,
	http.METHODS === METHODS,
	http.STATUS_CODES === STATUS_CODES,
	http.validateHeaderName === validateHeaderName,
	http.validateHeaderValue === validateHeaderValue,
	http.IncomingMessage === IncomingMessage,
	http.ServerResponse === ServerResponse,
	http.Server === Server,
	http.createServer === createServer,
	METHODS.join(",") === expectedMethods,
	Object.entries(STATUS_CODES)
		.map(([status, reason]) => status + ":" + reason)
		.join("|") === expectedStatuses,
	validateHeaderName("x-valid") === undefined,
	validateHeaderValue("x-valid", ["one", 2, null]) === undefined,
	validateHeaderName.length === 1 && validateHeaderValue.length === 2,
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
	invalidHeaderName,
	invalidHeaderValue,
];

console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
