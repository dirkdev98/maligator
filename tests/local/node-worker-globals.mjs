const channel = new MessageChannel();
channel.port1.on("message", (value) => {
	console.log(
		"port message",
		value,
		typeof BroadcastChannel,
		typeof MessagePort,
		channel.port1 instanceof MessagePort,
	);
	channel.port1.close();
});
channel.port2.postMessage({ hello: "world" });
console.log(Object.getOwnPropertyDescriptor(globalThis, "MessageChannel").enumerable);
