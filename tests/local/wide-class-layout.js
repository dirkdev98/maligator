// Class layouts wider than the ordinary 64-slot shape bound stay correct, including
// growth past the constructor's reservation and subclass extension.
class Wide {
	#p0 = 0;
	#p1 = 1;
	#p2 = 2;
	q0 = 0;
	#p4 = 4;
	#p5 = 5;
	#p6 = 6;
	q1 = 2;
	#p8 = 8;
	#p9 = 9;
	#p10 = 10;
	q2 = 4;
	#p12 = 12;
	#p13 = 13;
	#p14 = 14;
	q3 = 6;
	#p16 = 16;
	#p17 = 17;
	#p18 = 18;
	q4 = 8;
	#p20 = 20;
	#p21 = 21;
	#p22 = 22;
	q5 = 10;
	#p24 = 24;
	#p25 = 25;
	#p26 = 26;
	q6 = 12;
	#p28 = 28;
	#p29 = 29;
	#p30 = 30;
	q7 = 14;
	#p32 = 32;
	#p33 = 33;
	#p34 = 34;
	q8 = 16;
	#p36 = 36;
	#p37 = 37;
	#p38 = 38;
	q9 = 18;
	#p40 = 40;
	#p41 = 41;
	#p42 = 42;
	q10 = 20;
	#p44 = 44;
	#p45 = 45;
	#p46 = 46;
	q11 = 22;
	#p48 = 48;
	#p49 = 49;
	#p50 = 50;
	q12 = 24;
	#p52 = 52;
	#p53 = 53;
	#p54 = 54;
	q13 = 26;
	#p56 = 56;
	#p57 = 57;
	#p58 = 58;
	q14 = 28;
	#p60 = 60;
	#p61 = 61;
	#p62 = 62;
	q15 = 30;
	#p64 = 64;
	#p65 = 65;
	#p66 = 66;
	q16 = 32;
	#p68 = 68;
	#p69 = 69;
	#p70 = 70;
	q17 = 34;
	#p72 = 72;
	#p73 = 73;
	#p74 = 74;
	q18 = 36;
	#p76 = 76;
	#p77 = 77;
	#p78 = 78;
	q19 = 38;
	#p3 = 3;
	#p7 = 7;
	#p11 = 11;
	#p15 = 15;
	#p19 = 19;
	#p23 = 23;
	#p27 = 27;
	#p31 = 31;
	#p35 = 35;
	#p39 = 39;
	#p43 = 43;
	#p47 = 47;
	#p51 = 51;
	#p55 = 55;
	#p59 = 59;
	#p63 = 63;
	#p67 = 67;
	#p71 = 71;
	#p75 = 75;
	#p79 = 79;
	sumPrivates() {
		return (
			this.#p0 +
			this.#p1 +
			this.#p2 +
			this.#p3 +
			this.#p4 +
			this.#p5 +
			this.#p6 +
			this.#p7 +
			this.#p8 +
			this.#p9 +
			this.#p10 +
			this.#p11 +
			this.#p12 +
			this.#p13 +
			this.#p14 +
			this.#p15 +
			this.#p16 +
			this.#p17 +
			this.#p18 +
			this.#p19 +
			this.#p20 +
			this.#p21 +
			this.#p22 +
			this.#p23 +
			this.#p24 +
			this.#p25 +
			this.#p26 +
			this.#p27 +
			this.#p28 +
			this.#p29 +
			this.#p30 +
			this.#p31 +
			this.#p32 +
			this.#p33 +
			this.#p34 +
			this.#p35 +
			this.#p36 +
			this.#p37 +
			this.#p38 +
			this.#p39 +
			this.#p40 +
			this.#p41 +
			this.#p42 +
			this.#p43 +
			this.#p44 +
			this.#p45 +
			this.#p46 +
			this.#p47 +
			this.#p48 +
			this.#p49 +
			this.#p50 +
			this.#p51 +
			this.#p52 +
			this.#p53 +
			this.#p54 +
			this.#p55 +
			this.#p56 +
			this.#p57 +
			this.#p58 +
			this.#p59 +
			this.#p60 +
			this.#p61 +
			this.#p62 +
			this.#p63 +
			this.#p64 +
			this.#p65 +
			this.#p66 +
			this.#p67 +
			this.#p68 +
			this.#p69 +
			this.#p70 +
			this.#p71 +
			this.#p72 +
			this.#p73 +
			this.#p74 +
			this.#p75 +
			this.#p76 +
			this.#p77 +
			this.#p78 +
			this.#p79
		);
	}
	bump(step) {
		this.#p0 += step;
		this.#p79 += step;
		this.q19 += step;
	}
	static has(value) {
		return #p79 in value;
	}
	read79() {
		return this.#p79;
	}
}

class Wider extends Wide {
	#extra = "extra";
	tail = "tail";
	describe() {
		return `${this.#extra}:${this.tail}:${this.read79()}`;
	}
}

const lines = [];
const wide = new Wide();
lines.push(
	`sum ${wide.sumPrivates()} q ${wide.q0},${wide.q19} keys ${Object.keys(wide).length}`,
);
wide.bump(5);
lines.push(`bump ${wide.read79()} ${wide.q19} ${wide.sumPrivates()}`);
for (let index = 0; index < 200; index++) wide[`dynamic${index}`] = index;
wide.bump(1);
lines.push(
	`grown ${Object.keys(wide).length} ${wide.dynamic0},${wide.dynamic199} ${wide.read79()} ${wide.q19} ${Wide.has(wide)}`,
);
delete wide.q3;
lines.push(`deleted ${"q3" in wide} ${wide.q4} ${wide.sumPrivates()}`);

const wider = new Wider();
lines.push(
	`subclass ${wider.describe()} ${Wide.has(wider)} ${Object.keys(wider).length}`,
);
let brandError = "";
try {
	Wide.prototype.read79.call({});
} catch (error) {
	brandError = error.constructor.name;
}
lines.push(`brand ${brandError} ${Wide.has({})}`);

const instances = [];
for (let index = 0; index < 50; index++) {
	const instance = index % 2 === 0 ? new Wide() : new Wider();
	instance.bump(index);
	instances.push(instance);
}
lines.push(
	`many ${instances.reduce((total, instance) => total + instance.read79() + instance.q19, 0)}`,
);

const record = {};
for (let index = 0; index < 100; index++) record[`k${index}`] = index;
const parsed = JSON.parse(JSON.stringify(record));
lines.push(
	`json ${Object.keys(parsed).length} ${parsed.k0} ${parsed.k99} ${JSON.stringify(parsed).length}`,
);

console.log(lines.join("\n"));
