import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, describePose, poseAt, solveLinkage, validateAction, fmtLen } from '../app/action.js';

const near = (/** @type {number[]} */ a, /** @type {number[]} */ b, eps = 1e-9) =>
	assert.ok(a.every((v, i) => Math.abs(v - b[i]) < eps), `${JSON.stringify(a)} is not ${JSON.stringify(b)}`);
const dist = (/** @type {number[]} */ a, /** @type {number[]} */ b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// An engine's crank and piston: the crank turns about z at the origin, the rod joins its pin to the piston's.
/** @type {import('../app/action.js').Step} */
const engine = { type: 'linkage', crank: 'crank', coupler: 'rod', slider: 'piston', pivot: [0, 0, 0], knee: [0.03, 0, 0], pin: [0.12, 0, 0], axis: [0, 0, 1], angle: 2 * Math.PI, ease: 'linear' };

test('linkage at rest moves nothing', () => {
	const s = solveLinkage(engine, 0);
	assert.equal(s.travel, 0);
	near(apply(s.coupler, [0.07, 0.01, 0.02]), [0.07, 0.01, 0.02]);
	near(apply(s.crank, [0.03, 0, 0]), [0.03, 0, 0]);
});

test('linkage keeps its joints together all the way round', () => {
	const rod = 0.09;
	for (let i = 0; i <= 40; i++) {
		const u = i / 40;
		const s = solveLinkage(engine, u);
		const knee = apply(s.crank, engine.knee);
		const pin = apply(s.slider, engine.pin);
		// the crank carries the knee round its circle, the slider keeps the pin on its line, the rod keeps its length
		assert.ok(Math.abs(dist(knee, [0, 0, 0]) - 0.03) < 1e-12);
		assert.ok(Math.abs(pin[1]) < 1e-12 && Math.abs(pin[2]) < 1e-12, 'the pin left the slider line');
		assert.ok(Math.abs(dist(knee, pin) - rod) < 1e-12, 'the rod changed length');
		// the coupler is one rigid body carried from (knee, pin) at rest to where they are now
		near(apply(s.coupler, engine.knee), knee, 1e-12);
		near(apply(s.coupler, engine.pin), pin, 1e-12);
		// and matches the textbook slider-crank: x = r cos(θ) + sqrt(L² - r² sin²(θ))
		const th = 2 * Math.PI * u;
		const x = 0.03 * Math.cos(th) + Math.sqrt(rod * rod - 0.03 * 0.03 * Math.sin(th) ** 2);
		assert.ok(Math.abs(pin[0] - x) < 1e-12);
		assert.ok(s.reached);
	}
});

test('linkage in 3D with an explicit line, off the pivot', () => {
	// a lid on a sliding stay: the lid turns about the x axis through its hinge, the stay's foot runs along z
	/** @type {import('../app/action.js').Step} */
	const stay = { type: 'linkage', crank: 'lid', coupler: 'stay', slider: 'shoe', pivot: [0.13, 0.12, -0.1], knee: [0.13, 0.112, -0.05], pin: [0.13, 0.112, 0.05], line: [0, 0, 1], axis: [-1, 0, 0], angle: 1.75 };
	const s = solveLinkage(stay, 1);
	const knee = apply(s.crank, /** @type {any} */ (stay.knee));
	const pin = apply(s.slider, /** @type {any} */ (stay.pin));
	assert.ok(knee[1] > 0.16, 'the lid did not rise');
	assert.ok(pin[2] < 0.05, 'the shoe did not slide back');
	assert.ok(Math.abs(dist(knee, pin) - 0.1) < 1e-12);
	near(apply(s.coupler, /** @type {any} */ (stay.pin)), pin, 1e-12);
	assert.deepEqual(validateAction({ steps: [stay] }), []);
});

test('a linkage that cannot reach is reported', () => {
	// the rod (0.02) is shorter than the crank's reach off the line (0.03) once it has turned a quarter
	const errors = validateAction({ steps: [{ ...engine, pin: [0.05, 0, 0], angle: Math.PI / 2 }] });
	assert.equal(errors.length, 1);
	assert.match(errors[0], /can't reach/);
});

test('steps compose in order, later ones riding on earlier ones', () => {
	// slide a drawer out 0.3 along z, then tip it 90 degrees about its front edge (at rest at z = 0.1)
	const action = {
		steps: [
			{ type: 'move', part: 'drawer', by: [0, 0, 0.3], to: 0.5 },
			{ type: 'turn', part: 'drawer', axis: [1, 0, 0], pivot: [0, 0, 0.1], angle: Math.PI / 2, from: 0.5 },
		],
	};
	const tf = /** @type {any} */ (poseAt(action, 1).transforms.get('drawer'));
	// the front edge has slid to z = 0.4 and stays on the hinge line it tipped about
	near(apply(tf, [0, 0, 0.1]), [0, 0, 0.4], 1e-12);
	// a point 0.1 behind the edge swings up about it
	near(apply(tf, [0, 0, 0]), [0, 0.1, 0.4], 1e-12);
	// halfway, only the slide has happened
	near(apply(/** @type {any} */ (poseAt(action, 0.5).transforms.get('drawer')), [0, 0, 0]), [0, 0, 0.3], 1e-12);
});

test('easing and spans', () => {
	const action = { steps: [{ type: 'move', part: 'p', by: [1, 0, 0], from: 0.2, to: 0.6 }] };
	const x = (/** @type {number} */ k) => apply(/** @type {any} */ (poseAt(action, k).transforms.get('p')), [0, 0, 0])[0];
	assert.equal(x(0.1), 0);
	assert.ok(Math.abs(x(0.4) - 0.5) < 1e-12);
	assert.ok(x(0.25) < 0.125, 'smoothstep starts slow');
	assert.equal(x(0.9), 1);
});

test('hide and show switch at their marks', () => {
	const action = { steps: [{ type: 'hide', part: 'cap', at: 0.3 }, { type: 'show', part: 'cap', at: 0.8 }, { type: 'show', part: 'round', at: 0.5 }] };
	const seen = (/** @type {number} */ k) => Object.fromEntries(poseAt(action, k).visible);
	assert.deepEqual(seen(0), { cap: true, round: false });
	assert.deepEqual(seen(0.3), { cap: false, round: false });
	assert.deepEqual(seen(0.6), { cap: false, round: true });
	assert.deepEqual(seen(1), { cap: true, round: true });
});

test('describePose says where the action is', () => {
	const action = {
		states: [{ at: 0, text: 'Shut' }, { at: 0.01, text: 'Opening' }, { at: 1, text: 'Open' }],
		steps: [{ type: 'turn', part: 'lid', axis: [-1, 0, 0], pivot: [0, 0, 0], angle: Math.PI / 2 }, { type: 'move', part: 'drawer', by: [0, 0, 0.12] }],
	};
	const labels = { lid: 'Lid', drawer: 'Drawer' };
	assert.deepEqual(describePose(action, 0, (p) => labels[/** @type {'lid'} */ (p)]), { state: 'Shut', moves: [] });
	assert.deepEqual(describePose(action, 0.5, (p) => labels[/** @type {'lid'} */ (p)]), { state: 'Opening', moves: ['Lid turned 45° of 90°', 'Drawer moved 60 mm of 120 mm'] });
	assert.equal(describePose(action, 1).state, 'Open');
});

test('validateAction catches bad shapes and unknown parts', () => {
	assert.deepEqual(validateAction(undefined), []);
	const errors = validateAction({ steps: [{ type: 'spin', part: 'x' }, { type: 'move', part: 'nope', by: [0, 1] }, { type: 'turn', part: 'lid', axis: [0, 0, 0], pivot: [0, 0, 0], angle: 1, from: 0.6, to: 0.2 }] }, ['lid']);
	assert.ok(errors.some((e) => /type must be one of/.test(e)));
	assert.ok(errors.some((e) => /no node named "nope"/.test(e)));
	assert.ok(errors.some((e) => /by must be \[x, y, z\]/.test(e)));
	assert.ok(errors.some((e) => /axis must not be zero/.test(e)));
	assert.ok(errors.some((e) => /from must be less than to/.test(e)));
});

test('fmtLen', () => {
	assert.equal(fmtLen(0.0042), '4.2 mm');
	assert.equal(fmtLen(0.137), '137 mm');
	assert.equal(fmtLen(2.5), '2.50 m');
});
