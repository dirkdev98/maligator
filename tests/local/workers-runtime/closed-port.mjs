import { MessageChannel, receiveMessageOnPort } from "maligator:workers";

const collect = globalThis.__mal_collect_garbage;
if (typeof collect !== "function") throw new Error("closed-port requires MAL_HOST_GC=1");

// Each turn is a port delivery macrotask, so a microtask checkpoint (and the WeakRef
// kept-set clear) separates the turns without host timers.
const ticker = new MessageChannel();
function turn() {
	return new Promise((resolve) => {
		ticker.port2.once("message", resolve);
		ticker.port1.postMessage(null);
	});
}

function closeEvent(port) {
	return new Promise((resolve) => port.once("close", resolve));
}

function outcome(action) {
	try {
		action();
		return "ok";
	} catch (error) {
		return error.name;
	}
}

async function peerClosedPortKeepsItsBrand() {
	const { port1: port, port2: peer } = new MessageChannel();
	let closes = 0;
	port.on("close", () => closes++);
	const closed = closeEvent(port);
	port.start();
	peer.close();
	await closed;
	const buffer = new ArrayBuffer(8);
	const onMessage = () => {};
	const calls = [
		outcome(() => port.close()),
		outcome(() => port.close()),
		outcome(() => port.start()),
		outcome(() => port.ref()),
		outcome(() => port.unref()),
		outcome(() => port.ref()),
		outcome(() => port.postMessage("dropped")),
		// Serialization still runs without a peer, so the transfer detaches.
		outcome(() => port.postMessage(buffer, [buffer])),
		outcome(() => port.postMessage(null, [port])),
		outcome(() => port.postMessage(onMessage)),
		outcome(() => {
			port.onmessage = onMessage;
		}),
		outcome(() => port.on("message", onMessage)),
	];
	const listening = port.listenerCount("message");
	port.off("message", onMessage);
	await turn();
	console.log(
		"peer-closed:",
		JSON.stringify([
			calls,
			closes,
			port.hasRef(),
			buffer.byteLength,
			receiveMessageOnPort(port) === undefined,
			port.onmessage === onMessage,
			listening,
			port.listenerCount("message"),
		]),
	);
}

async function ownCloseIsIdempotentAndTransferredPortsStayDistinct() {
	const { port1: port, port2: peer } = new MessageChannel();
	let closes = 0;
	port.on("close", () => closes++);
	const peerClosed = closeEvent(peer);
	peer.start();
	port.close();
	port.close();
	await peerClosed;
	await turn();
	port.close();
	const carrier = new MessageChannel();
	const moved = new MessageChannel();
	const movedPeerClosed = closeEvent(moved.port2);
	moved.port2.start();
	// Nothing receives a port transferred through a closed port, so its channel closes.
	const viaClosed = outcome(() => port.postMessage(moved.port1, [moved.port1]));
	await movedPeerClosed;
	const transferred = [
		outcome(() => moved.port1.close()),
		outcome(() => moved.port1.postMessage(1)),
		outcome(() => carrier.port1.postMessage(moved.port1, [moved.port1])),
		moved.port1.hasRef(),
	];
	carrier.port1.close();
	const prototype = Object.getPrototypeOf(port);
	const invalid = [
		outcome(() => prototype.close.call({})),
		outcome(() => prototype.postMessage.call({}, 1)),
		outcome(() => prototype.ref.call(prototype)),
		outcome(() => receiveMessageOnPort({})),
	];
	console.log("own-closed:", JSON.stringify([closes, viaClosed, transferred, invalid]));
}

let survivor;
let survivorRef;
let abandonedRef;

// Not async: no suspended frame may keep the abandoned port reachable.
function closeAbandonedPort() {
	const { port1, port2 } = new MessageChannel();
	abandonedRef = new WeakRef(port1);
	const closed = closeEvent(port1);
	port1.start();
	port2.close();
	return closed;
}

function closeSurvivingPort() {
	const { port1, port2 } = new MessageChannel();
	survivor = port1;
	survivorRef = new WeakRef(port1);
	const closed = closeEvent(port1);
	port1.start();
	port2.close();
	return closed;
}

async function closedPortsLiveExactlyAsLongAsTheirWrappers() {
	await Promise.all([closeAbandonedPort(), closeSurvivingPort()]);
	let delivered = 0;
	// Added after close: only the wrapper's tracer keeps this listener alive.
	survivor.on("message", (value) => {
		delivered += value;
	});
	await turn();
	await turn();
	collect();
	await turn();
	survivor.emit("message", 2);
	console.log(
		"gc:",
		JSON.stringify([
			abandonedRef.deref() === undefined,
			survivorRef.deref() === survivor,
			outcome(() => survivor.close()),
			survivor.listenerCount("message"),
			delivered,
		]),
	);
	survivor = undefined;
}

async function main() {
	await peerClosedPortKeepsItsBrand();
	await ownCloseIsIdempotentAndTransferredPortsStayDistinct();
	await closedPortsLiveExactlyAsLongAsTheirWrappers();
}

main().finally(() => ticker.port1.close());
