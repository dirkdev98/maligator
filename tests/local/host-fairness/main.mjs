import { MessageChannel } from "node:worker_threads";

function check(condition, message) {
	if (!condition) throw new Error(message);
}

async function bounded(promise) {
	let timer;
	try {
		await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("host fairness timed out")), 3000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function dueTimerDuringMessages() {
	const { port1, port2 } = new MessageChannel();
	const limit = 1024;
	let received = 0;
	let checkpoint = 0;
	let timerFired = false;
	let timerCheckpoint = false;
	try {
		const messages = new Promise((resolve) => {
			port2.on("message", () => {
				check(
					checkpoint === received,
					"each message follows the prior Promise checkpoint",
				);
				if (timerFired) check(timerCheckpoint, "timer Promise precedes the next message");
				received++;
				Promise.resolve().then(() => {
					checkpoint = received;
				});
				if (received === limit) resolve();
				else port1.postMessage(received);
			});
		});
		const timer = new Promise((resolve) => {
			setTimeout(() => {
				check(received < limit, "a due timer runs before the message flood drains");
				check(checkpoint === received, "message Promise precedes the timer");
				timerFired = true;
				Promise.resolve().then(() => {
					timerCheckpoint = true;
				});
				resolve();
			}, 0);
		});
		port1.postMessage(0);
		const until = Date.now() + 3;
		while (Date.now() < until) {}
		await bounded(Promise.all([messages, timer]));
	} finally {
		port1.close();
		port2.close();
	}
}

async function competingSources() {
	const { port1, port2 } = new MessageChannel();
	const limit = 1024;
	let messages = 0;
	let immediates = 0;
	let messageCheckpoint = 0;
	let immediateCheckpoint = 0;
	let immediate;
	try {
		const messagesDone = new Promise((resolve) => {
			port2.on("message", () => {
				check(
					messageCheckpoint === messages,
					"message checkpoints survive source rotation",
				);
				messages++;
				Promise.resolve().then(() => {
					messageCheckpoint = messages;
				});
				if (messages === limit) {
					check(immediates > 0, "immediates progress during continuous messages");
					resolve();
				} else port1.postMessage(messages);
			});
		});
		const immediatesDone = new Promise((resolve) => {
			function next() {
				check(
					immediateCheckpoint === immediates,
					"immediate checkpoints survive source rotation",
				);
				immediates++;
				Promise.resolve().then(() => {
					immediateCheckpoint = immediates;
				});
				if (immediates === limit) {
					check(messages > 0, "messages progress during continuous immediates");
					resolve();
				} else immediate = setImmediate(next);
			}
			immediate = setImmediate(next);
		});
		port1.postMessage(0);
		await bounded(Promise.all([messagesDone, immediatesDone]));
	} finally {
		clearImmediate(immediate);
		port1.close();
		port2.close();
	}
}

await dueTimerDuringMessages();
await competingSources();
console.log("host-fairness PASS");
