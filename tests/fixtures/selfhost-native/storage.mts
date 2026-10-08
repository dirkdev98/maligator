// Native storage probes compiled by both compiler hosts: more than 128 simultaneously
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
	readonly p72: Marked;
	readonly p73: Marked;
	readonly p74: Marked;
	readonly p75: Marked;
	readonly p76: Marked;
	readonly p77: Marked;
	readonly p78: Marked;
	readonly p79: Marked;
	readonly p80: Marked;
	readonly p81: Marked;
	readonly p82: Marked;
	readonly p83: Marked;
	readonly p84: Marked;
	readonly p85: Marked;
	readonly p86: Marked;
	readonly p87: Marked;
	readonly p88: Marked;
	readonly p89: Marked;
	readonly p90: Marked;
	readonly p91: Marked;
	readonly p92: Marked;
	readonly p93: Marked;
	readonly p94: Marked;
	readonly p95: Marked;
	readonly p96: Marked;
	readonly p97: Marked;
	readonly p98: Marked;
	readonly p99: Marked;
	readonly p100: Marked;
	readonly p101: Marked;
	readonly p102: Marked;
	readonly p103: Marked;
	readonly p104: Marked;
	readonly p105: Marked;
	readonly p106: Marked;
	readonly p107: Marked;
	readonly p108: Marked;
	readonly p109: Marked;
	readonly p110: Marked;
	readonly p111: Marked;
	readonly p112: Marked;
	readonly p113: Marked;
	readonly p114: Marked;
	readonly p115: Marked;
	readonly p116: Marked;
	readonly p117: Marked;
	readonly p118: Marked;
	readonly p119: Marked;
	readonly p120: Marked;
	readonly p121: Marked;
	readonly p122: Marked;
	readonly p123: Marked;
	readonly p124: Marked;
	readonly p125: Marked;
	readonly p126: Marked;
	readonly p127: Marked;
	readonly p128: Marked;
	readonly p129: Marked;
	readonly p130: Marked;
	readonly p131: Marked;
	readonly p132: Marked;
	readonly p133: Marked;
	readonly p134: Marked;
	readonly p135: Marked;
	readonly p136: Marked;
	readonly p137: Marked;
	readonly p138: Marked;
	readonly p139: Marked;
}

const host = globalThis as { __mal_collect_garbage?: () => void };

function collect(): void {
	host.__mal_collect_garbage?.();
}

function makeOwner(offset: number): WideOwner {
	const owner: Record<string, Marked> = {};
	for (let index = 0; index < 140; index++)
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
		p72,
		p73,
		p74,
		p75,
		p76,
		p77,
		p78,
		p79,
		p80,
		p81,
		p82,
		p83,
		p84,
		p85,
		p86,
		p87,
		p88,
		p89,
		p90,
		p91,
		p92,
		p93,
		p94,
		p95,
		p96,
		p97,
		p98,
		p99,
		p100,
		p101,
		p102,
		p103,
		p104,
		p105,
		p106,
		p107,
		p108,
		p109,
		p110,
		p111,
		p112,
		p113,
		p114,
		p115,
		p116,
		p117,
		p118,
		p119,
		p120,
		p121,
		p122,
		p123,
		p124,
		p125,
		p126,
		p127,
		p128,
		p129,
		p130,
		p131,
		p132,
		p133,
		p134,
		p135,
		p136,
		p137,
		p138,
		p139,
	} = owner;
	const first = trigger.value;
	const total =
		p0.marker +
		p1.marker +
		p2.marker +
		p3.marker +
		p4.marker +
		p5.marker +
		p6.marker +
		p7.marker +
		p8.marker +
		p9.marker +
		p10.marker +
		p11.marker +
		p12.marker +
		p13.marker +
		p14.marker +
		p15.marker +
		p16.marker +
		p17.marker +
		p18.marker +
		p19.marker +
		p20.marker +
		p21.marker +
		p22.marker +
		p23.marker +
		p24.marker +
		p25.marker +
		p26.marker +
		p27.marker +
		p28.marker +
		p29.marker +
		p30.marker +
		p31.marker +
		p32.marker +
		p33.marker +
		p34.marker +
		p35.marker +
		p36.marker +
		p37.marker +
		p38.marker +
		p39.marker +
		p40.marker +
		p41.marker +
		p42.marker +
		p43.marker +
		p44.marker +
		p45.marker +
		p46.marker +
		p47.marker +
		p48.marker +
		p49.marker +
		p50.marker +
		p51.marker +
		p52.marker +
		p53.marker +
		p54.marker +
		p55.marker +
		p56.marker +
		p57.marker +
		p58.marker +
		p59.marker +
		p60.marker +
		p61.marker +
		p62.marker +
		p63.marker +
		p64.marker +
		p65.marker +
		p66.marker +
		p67.marker +
		p68.marker +
		p69.marker +
		p70.marker +
		p71.marker +
		p72.marker +
		p73.marker +
		p74.marker +
		p75.marker +
		p76.marker +
		p77.marker +
		p78.marker +
		p79.marker +
		p80.marker +
		p81.marker +
		p82.marker +
		p83.marker +
		p84.marker +
		p85.marker +
		p86.marker +
		p87.marker +
		p88.marker +
		p89.marker +
		p90.marker +
		p91.marker +
		p92.marker +
		p93.marker +
		p94.marker +
		p95.marker +
		p96.marker +
		p97.marker +
		p98.marker +
		p99.marker +
		p100.marker +
		p101.marker +
		p102.marker +
		p103.marker +
		p104.marker +
		p105.marker +
		p106.marker +
		p107.marker +
		p108.marker +
		p109.marker +
		p110.marker +
		p111.marker +
		p112.marker +
		p113.marker +
		p114.marker +
		p115.marker +
		p116.marker +
		p117.marker +
		p118.marker +
		p119.marker +
		p120.marker +
		p121.marker +
		p122.marker +
		p123.marker +
		p124.marker +
		p125.marker +
		p126.marker +
		p127.marker +
		p128.marker +
		p129.marker +
		p130.marker +
		p131.marker +
		p132.marker +
		p133.marker +
		p134.marker +
		p135.marker +
		p136.marker +
		p137.marker +
		p138.marker +
		p139.marker;
	const second = trigger.value;
	return total + first.marker + second.marker;
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
		p72,
		p73,
		p74,
		p75,
		p76,
		p77,
		p78,
		p79,
		p80,
		p81,
		p82,
		p83,
		p84,
		p85,
		p86,
		p87,
		p88,
		p89,
		p90,
		p91,
		p92,
		p93,
		p94,
		p95,
		p96,
		p97,
		p98,
		p99,
		p100,
		p101,
		p102,
		p103,
		p104,
		p105,
		p106,
		p107,
		p108,
		p109,
		p110,
		p111,
		p112,
		p113,
		p114,
		p115,
		p116,
		p117,
		p118,
		p119,
		p120,
		p121,
		p122,
		p123,
		p124,
		p125,
		p126,
		p127,
		p128,
		p129,
		p130,
		p131,
		p132,
		p133,
		p134,
		p135,
		p136,
		p137,
		p138,
		p139,
	} = owner;
	const before = trigger.value;
	const firstTotal =
		p0.marker +
		p1.marker +
		p2.marker +
		p3.marker +
		p4.marker +
		p5.marker +
		p6.marker +
		p7.marker +
		p8.marker +
		p9.marker +
		p10.marker +
		p11.marker +
		p12.marker +
		p13.marker +
		p14.marker +
		p15.marker +
		p16.marker +
		p17.marker +
		p18.marker +
		p19.marker +
		p20.marker +
		p21.marker +
		p22.marker +
		p23.marker +
		p24.marker +
		p25.marker +
		p26.marker +
		p27.marker +
		p28.marker +
		p29.marker +
		p30.marker +
		p31.marker +
		p32.marker +
		p33.marker +
		p34.marker +
		p35.marker +
		p36.marker +
		p37.marker +
		p38.marker +
		p39.marker +
		p40.marker +
		p41.marker +
		p42.marker +
		p43.marker +
		p44.marker +
		p45.marker +
		p46.marker +
		p47.marker +
		p48.marker +
		p49.marker +
		p50.marker +
		p51.marker +
		p52.marker +
		p53.marker +
		p54.marker +
		p55.marker +
		p56.marker +
		p57.marker +
		p58.marker +
		p59.marker +
		p60.marker +
		p61.marker +
		p62.marker +
		p63.marker +
		p64.marker +
		p65.marker +
		p66.marker +
		p67.marker +
		p68.marker +
		p69.marker +
		p70.marker +
		p71.marker +
		p72.marker +
		p73.marker +
		p74.marker +
		p75.marker +
		p76.marker +
		p77.marker +
		p78.marker +
		p79.marker +
		p80.marker +
		p81.marker +
		p82.marker +
		p83.marker +
		p84.marker +
		p85.marker +
		p86.marker +
		p87.marker +
		p88.marker +
		p89.marker +
		p90.marker +
		p91.marker +
		p92.marker +
		p93.marker +
		p94.marker +
		p95.marker +
		p96.marker +
		p97.marker +
		p98.marker +
		p99.marker +
		p100.marker +
		p101.marker +
		p102.marker +
		p103.marker +
		p104.marker +
		p105.marker +
		p106.marker +
		p107.marker +
		p108.marker +
		p109.marker +
		p110.marker +
		p111.marker +
		p112.marker +
		p113.marker +
		p114.marker +
		p115.marker +
		p116.marker +
		p117.marker +
		p118.marker +
		p119.marker +
		p120.marker +
		p121.marker +
		p122.marker +
		p123.marker +
		p124.marker +
		p125.marker +
		p126.marker +
		p127.marker +
		p128.marker +
		p129.marker +
		p130.marker +
		p131.marker +
		p132.marker +
		p133.marker +
		p134.marker +
		p135.marker +
		p136.marker +
		p137.marker +
		p138.marker +
		p139.marker;
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
		p72: q72,
		p73: q73,
		p74: q74,
		p75: q75,
		p76: q76,
		p77: q77,
		p78: q78,
		p79: q79,
		p80: q80,
		p81: q81,
		p82: q82,
		p83: q83,
		p84: q84,
		p85: q85,
		p86: q86,
		p87: q87,
		p88: q88,
		p89: q89,
		p90: q90,
		p91: q91,
		p92: q92,
		p93: q93,
		p94: q94,
		p95: q95,
		p96: q96,
		p97: q97,
		p98: q98,
		p99: q99,
		p100: q100,
		p101: q101,
		p102: q102,
		p103: q103,
		p104: q104,
		p105: q105,
		p106: q106,
		p107: q107,
		p108: q108,
		p109: q109,
		p110: q110,
		p111: q111,
		p112: q112,
		p113: q113,
		p114: q114,
		p115: q115,
		p116: q116,
		p117: q117,
		p118: q118,
		p119: q119,
		p120: q120,
		p121: q121,
		p122: q122,
		p123: q123,
		p124: q124,
		p125: q125,
		p126: q126,
		p127: q127,
		p128: q128,
		p129: q129,
		p130: q130,
		p131: q131,
		p132: q132,
		p133: q133,
		p134: q134,
		p135: q135,
		p136: q136,
		p137: q137,
		p138: q138,
		p139: q139,
	} = other;
	const after = trigger.value;
	const secondTotal =
		q0.marker +
		q1.marker +
		q2.marker +
		q3.marker +
		q4.marker +
		q5.marker +
		q6.marker +
		q7.marker +
		q8.marker +
		q9.marker +
		q10.marker +
		q11.marker +
		q12.marker +
		q13.marker +
		q14.marker +
		q15.marker +
		q16.marker +
		q17.marker +
		q18.marker +
		q19.marker +
		q20.marker +
		q21.marker +
		q22.marker +
		q23.marker +
		q24.marker +
		q25.marker +
		q26.marker +
		q27.marker +
		q28.marker +
		q29.marker +
		q30.marker +
		q31.marker +
		q32.marker +
		q33.marker +
		q34.marker +
		q35.marker +
		q36.marker +
		q37.marker +
		q38.marker +
		q39.marker +
		q40.marker +
		q41.marker +
		q42.marker +
		q43.marker +
		q44.marker +
		q45.marker +
		q46.marker +
		q47.marker +
		q48.marker +
		q49.marker +
		q50.marker +
		q51.marker +
		q52.marker +
		q53.marker +
		q54.marker +
		q55.marker +
		q56.marker +
		q57.marker +
		q58.marker +
		q59.marker +
		q60.marker +
		q61.marker +
		q62.marker +
		q63.marker +
		q64.marker +
		q65.marker +
		q66.marker +
		q67.marker +
		q68.marker +
		q69.marker +
		q70.marker +
		q71.marker +
		q72.marker +
		q73.marker +
		q74.marker +
		q75.marker +
		q76.marker +
		q77.marker +
		q78.marker +
		q79.marker +
		q80.marker +
		q81.marker +
		q82.marker +
		q83.marker +
		q84.marker +
		q85.marker +
		q86.marker +
		q87.marker +
		q88.marker +
		q89.marker +
		q90.marker +
		q91.marker +
		q92.marker +
		q93.marker +
		q94.marker +
		q95.marker +
		q96.marker +
		q97.marker +
		q98.marker +
		q99.marker +
		q100.marker +
		q101.marker +
		q102.marker +
		q103.marker +
		q104.marker +
		q105.marker +
		q106.marker +
		q107.marker +
		q108.marker +
		q109.marker +
		q110.marker +
		q111.marker +
		q112.marker +
		q113.marker +
		q114.marker +
		q115.marker +
		q116.marker +
		q117.marker +
		q118.marker +
		q119.marker +
		q120.marker +
		q121.marker +
		q122.marker +
		q123.marker +
		q124.marker +
		q125.marker +
		q126.marker +
		q127.marker +
		q128.marker +
		q129.marker +
		q130.marker +
		q131.marker +
		q132.marker +
		q133.marker +
		q134.marker +
		q135.marker +
		q136.marker +
		q137.marker +
		q138.marker +
		q139.marker;
	return firstTotal + secondTotal + before.marker + after.marker;
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
for (let round = 0; round < 3; round++) {
	results.push(
		wideRoots(makeOwner(round)),
		reusedRoots(makeOwner(round), makeOwner(round + 1)),
	);
}
let generated = 0;
for (const value of markers(5)) {
	collect();
	generated += value.marker;
}
results.push(branchy(true), branchy(false), caught(), generated, collections);
// oxlint-disable-next-line no-console -- fixture output is the acceptance protocol.
console.log(`storage:${results.join(",")}`);
