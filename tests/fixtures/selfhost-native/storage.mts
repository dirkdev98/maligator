// Native storage probes compiled by both compiler hosts: more than 64 simultaneously
// live private roots, slot reuse after they die, collecting getters and calls,
// forward branches, a caught exception and a suspended generator.
interface Marked {
	readonly marker: number;
}

interface WideOwner {
	readonly p0: Marked;
	readonly p1: Marked;
	readonly p2: Marked;
	readonly p3: Marked;
	readonly p4: Marked;
	readonly p5: Marked;
	readonly p6: Marked;
	readonly p7: Marked;
	readonly p8: Marked;
	readonly p9: Marked;
	readonly p10: Marked;
	readonly p11: Marked;
	readonly p12: Marked;
	readonly p13: Marked;
	readonly p14: Marked;
	readonly p15: Marked;
	readonly p16: Marked;
	readonly p17: Marked;
	readonly p18: Marked;
	readonly p19: Marked;
	readonly p20: Marked;
	readonly p21: Marked;
	readonly p22: Marked;
	readonly p23: Marked;
	readonly p24: Marked;
	readonly p25: Marked;
	readonly p26: Marked;
	readonly p27: Marked;
	readonly p28: Marked;
	readonly p29: Marked;
	readonly p30: Marked;
	readonly p31: Marked;
	readonly p32: Marked;
	readonly p33: Marked;
	readonly p34: Marked;
	readonly p35: Marked;
	readonly p36: Marked;
	readonly p37: Marked;
	readonly p38: Marked;
	readonly p39: Marked;
	readonly p40: Marked;
	readonly p41: Marked;
	readonly p42: Marked;
	readonly p43: Marked;
	readonly p44: Marked;
	readonly p45: Marked;
	readonly p46: Marked;
	readonly p47: Marked;
	readonly p48: Marked;
	readonly p49: Marked;
	readonly p50: Marked;
	readonly p51: Marked;
	readonly p52: Marked;
	readonly p53: Marked;
	readonly p54: Marked;
	readonly p55: Marked;
	readonly p56: Marked;
	readonly p57: Marked;
	readonly p58: Marked;
	readonly p59: Marked;
	readonly p60: Marked;
	readonly p61: Marked;
	readonly p62: Marked;
	readonly p63: Marked;
	readonly p64: Marked;
	readonly p65: Marked;
	readonly p66: Marked;
	readonly p67: Marked;
	readonly p68: Marked;
	readonly p69: Marked;
	readonly p70: Marked;
	readonly p71: Marked;
}

const host = globalThis as { __mal_collect_garbage?: () => void };

function collect(): void {
	host.__mal_collect_garbage?.();
}

function makeOwner(offset: number): WideOwner {
	const owner: Record<string, Marked> = {};
	for (let index = 0; index < 72; index++)
		owner[`p${index}`] = { marker: index + offset };
	return owner as unknown as WideOwner;
}

let collections = 0;
const trigger = {
	get value(): Marked {
		collections++;
		collect();
		return { marker: 1000 };
	},
};

function total(values: ReadonlyArray<Marked>): number {
	let sum = 0;
	for (const value of values) sum += value.marker;
	return sum;
}

function wideRoots(owner: WideOwner): number {
	const {
		p0,
		p1,
		p2,
		p3,
		p4,
		p5,
		p6,
		p7,
		p8,
		p9,
		p10,
		p11,
		p12,
		p13,
		p14,
		p15,
		p16,
		p17,
		p18,
		p19,
		p20,
		p21,
		p22,
		p23,
		p24,
		p25,
		p26,
		p27,
		p28,
		p29,
		p30,
		p31,
		p32,
		p33,
		p34,
		p35,
		p36,
		p37,
		p38,
		p39,
		p40,
		p41,
		p42,
		p43,
		p44,
		p45,
		p46,
		p47,
		p48,
		p49,
		p50,
		p51,
		p52,
		p53,
		p54,
		p55,
		p56,
		p57,
		p58,
		p59,
		p60,
		p61,
		p62,
		p63,
		p64,
		p65,
		p66,
		p67,
		p68,
		p69,
		p70,
		p71,
	} = owner;
	const first = trigger.value;
	const held = [
		p0,
		p1,
		p2,
		p3,
		p4,
		p5,
		p6,
		p7,
		p8,
		p9,
		p10,
		p11,
		p12,
		p13,
		p14,
		p15,
		p16,
		p17,
		p18,
		p19,
		p20,
		p21,
		p22,
		p23,
		p24,
		p25,
		p26,
		p27,
		p28,
		p29,
		p30,
		p31,
		p32,
		p33,
		p34,
		p35,
		p36,
		p37,
		p38,
		p39,
		p40,
		p41,
		p42,
		p43,
		p44,
		p45,
		p46,
		p47,
		p48,
		p49,
		p50,
		p51,
		p52,
		p53,
		p54,
		p55,
		p56,
		p57,
		p58,
		p59,
		p60,
		p61,
		p62,
		p63,
		p64,
		p65,
		p66,
		p67,
		p68,
		p69,
		p70,
		p71,
	];
	const second = trigger.value;
	return total(held) + first.marker + second.marker;
}

function reusedRoots(owner: WideOwner, other: WideOwner): number {
	const {
		p0,
		p1,
		p2,
		p3,
		p4,
		p5,
		p6,
		p7,
		p8,
		p9,
		p10,
		p11,
		p12,
		p13,
		p14,
		p15,
		p16,
		p17,
		p18,
		p19,
		p20,
		p21,
		p22,
		p23,
		p24,
		p25,
		p26,
		p27,
		p28,
		p29,
		p30,
		p31,
		p32,
		p33,
		p34,
		p35,
		p36,
		p37,
		p38,
		p39,
		p40,
		p41,
		p42,
		p43,
		p44,
		p45,
		p46,
		p47,
		p48,
		p49,
		p50,
		p51,
		p52,
		p53,
		p54,
		p55,
		p56,
		p57,
		p58,
		p59,
		p60,
		p61,
		p62,
		p63,
		p64,
		p65,
		p66,
		p67,
		p68,
		p69,
		p70,
		p71,
	} = owner;
	const before = trigger.value;
	const firstTotal = total([
		p0,
		p1,
		p2,
		p3,
		p4,
		p5,
		p6,
		p7,
		p8,
		p9,
		p10,
		p11,
		p12,
		p13,
		p14,
		p15,
		p16,
		p17,
		p18,
		p19,
		p20,
		p21,
		p22,
		p23,
		p24,
		p25,
		p26,
		p27,
		p28,
		p29,
		p30,
		p31,
		p32,
		p33,
		p34,
		p35,
		p36,
		p37,
		p38,
		p39,
		p40,
		p41,
		p42,
		p43,
		p44,
		p45,
		p46,
		p47,
		p48,
		p49,
		p50,
		p51,
		p52,
		p53,
		p54,
		p55,
		p56,
		p57,
		p58,
		p59,
		p60,
		p61,
		p62,
		p63,
		p64,
		p65,
		p66,
		p67,
		p68,
		p69,
		p70,
		p71,
	]);
	const {
		p0: q0,
		p1: q1,
		p2: q2,
		p3: q3,
		p4: q4,
		p5: q5,
		p6: q6,
		p7: q7,
		p8: q8,
		p9: q9,
		p10: q10,
		p11: q11,
		p12: q12,
		p13: q13,
		p14: q14,
		p15: q15,
		p16: q16,
		p17: q17,
		p18: q18,
		p19: q19,
		p20: q20,
		p21: q21,
		p22: q22,
		p23: q23,
		p24: q24,
		p25: q25,
		p26: q26,
		p27: q27,
		p28: q28,
		p29: q29,
		p30: q30,
		p31: q31,
		p32: q32,
		p33: q33,
		p34: q34,
		p35: q35,
		p36: q36,
		p37: q37,
		p38: q38,
		p39: q39,
		p40: q40,
		p41: q41,
		p42: q42,
		p43: q43,
		p44: q44,
		p45: q45,
		p46: q46,
		p47: q47,
		p48: q48,
		p49: q49,
		p50: q50,
		p51: q51,
		p52: q52,
		p53: q53,
		p54: q54,
		p55: q55,
		p56: q56,
		p57: q57,
		p58: q58,
		p59: q59,
		p60: q60,
		p61: q61,
		p62: q62,
		p63: q63,
		p64: q64,
		p65: q65,
		p66: q66,
		p67: q67,
		p68: q68,
		p69: q69,
		p70: q70,
		p71: q71,
	} = other;
	const after = trigger.value;
	return (
		firstTotal +
		total([
			q0,
			q1,
			q2,
			q3,
			q4,
			q5,
			q6,
			q7,
			q8,
			q9,
			q10,
			q11,
			q12,
			q13,
			q14,
			q15,
			q16,
			q17,
			q18,
			q19,
			q20,
			q21,
			q22,
			q23,
			q24,
			q25,
			q26,
			q27,
			q28,
			q29,
			q30,
			q31,
			q32,
			q33,
			q34,
			q35,
			q36,
			q37,
			q38,
			q39,
			q40,
			q41,
			q42,
			q43,
			q44,
			q45,
			q46,
			q47,
			q48,
			q49,
			q50,
			q51,
			q52,
			q53,
			q54,
			q55,
			q56,
			q57,
			q58,
			q59,
			q60,
			q61,
			q62,
			q63,
			q64,
			q65,
			q66,
			q67,
			q68,
			q69,
			q70,
			q71,
		]) +
		before.marker +
		after.marker
	);
}

function make(marker: number): Marked {
	collect();
	return { marker };
}

function branchy(flag: boolean): number {
	const held = make(1);
	let result = held.marker;
	if (flag) {
		const extra = make(2);
		result += extra.marker;
	}
	collect();
	return result + held.marker;
}

function caught(): number {
	const held = make(5);
	try {
		const thrown = make(7);
		if (thrown.marker === 7) throw new Error(String(held.marker));
		return 0;
	} catch (error) {
		collect();
		return held.marker + (error instanceof Error ? Number(error.message) : 0);
	}
}

function* markers(limit: number): Generator<Marked> {
	for (let index = 0; index < limit; index++) {
		const value = make(index);
		yield value;
	}
}

const results: Array<number> = [];
for (let round = 0; round < 3; round++)
	results.push(
		wideRoots(makeOwner(round)),
		reusedRoots(makeOwner(round), makeOwner(round + 1)),
	);
let generated = 0;
for (const value of markers(5)) {
	collect();
	generated += value.marker;
}
results.push(branchy(true), branchy(false), caught(), generated, collections);
// oxlint-disable-next-line no-console -- fixture output is the acceptance protocol.
console.log(`storage:${results.join(",")}`);
