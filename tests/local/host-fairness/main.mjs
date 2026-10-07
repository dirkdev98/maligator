import { MessageChannel } from "node:worker_threads";

function check(condition, message) {
	if (!condition) throw new Error(message);
}

async function bounded(promise, progress) {
	let timer;
	try {
		await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								`host fairness timed out: ${progress()}; stress=${process.env.MAL_GC_STRESS ?? "0"}`,
							),
						),
					3000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function dueTimerDuringMessages() {
	const { port1, port2 } = new MessageChannel();
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
					if (timerFired) resolve();
				});
				if (!timerFired) port1.postMessage(received);
			});
		});
		const timer = new Promise((resolve) => {
			setTimeout(() => {
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
		await bounded(
			Promise.all([messages, timer]),
			() =>
				`dueTimerDuringMessages received=${received} checkpoint=${checkpoint} timerFired=${timerFired} timerCheckpoint=${timerCheckpoint}`,
		);
	} finally {
		port1.close();
		port2.close();
	}
}

async function competingSources() {
	const { port1, port2 } = new MessageChannel();
	let messages = 0;
	let immediates = 0;
	let messageCheckpoint = 0;
	let immediateCheckpoint = 0;
	let priorMessages;
	let priorImmediates;
	let messageRotated = false;
	let immediateRotated = false;
	let immediate;
	try {
		const rotated = new Promise((resolve) => {
			function complete() {
				if (messageRotated && immediateRotated) resolve();
			}
			port2.on("message", () => {
				check(
					messageCheckpoint === messages,
					"message checkpoints survive source rotation",
				);
				check(
					immediateCheckpoint === immediates,
					"immediate Promise precedes the next message",
				);
				if (priorImmediates !== undefined && immediates > priorImmediates) {
					messageRotated = true;
				}
				priorImmediates = immediates;
				messages++;
				port1.postMessage(messages);
				Promise.resolve().then(() => {
					messageCheckpoint = messages;
					complete();
				});
			});
			function next() {
				check(
					immediateCheckpoint === immediates,
					"immediate checkpoints survive source rotation",
				);
				check(
					messageCheckpoint === messages,
					"message Promise precedes the next immediate",
				);
				if (priorMessages !== undefined && messages > priorMessages) {
					immediateRotated = true;
				}
				priorMessages = messages;
				immediates++;
				immediate = setImmediate(next);
				Promise.resolve().then(() => {
					immediateCheckpoint = immediates;
					complete();
				});
			}
			immediate = setImmediate(next);
		});
		port1.postMessage(0);
		await bounded(
			rotated,
			() =>
				`competingSources messages=${messages} immediates=${immediates} messageCheckpoint=${messageCheckpoint} immediateCheckpoint=${immediateCheckpoint} messageRotated=${messageRotated} immediateRotated=${immediateRotated}`,
		);
	} finally {
		clearImmediate(immediate);
		port1.close();
		port2.close();
	}
}

await dueTimerDuringMessages();
await competingSources();
console.log("host-fairness PASS");
