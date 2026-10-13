// A model's action: its moving parts posed at k, from 0 (at rest) to 1 (fully worked), from data in project.json.
// Pure math with no dependencies, so the page, the CLI and the tests all use this one file.
//
//   action: { name?, states?: [{ at, text }], clip?, steps: [...] }
//
// Steps run over k in [from, to] (default 0 to 1), eased with smoothstep unless `ease: 'linear'`:
//   { type: 'move', part, by: [x, y, z] }
//   { type: 'turn', part, axis: [x, y, z], pivot: [x, y, z], angle }   (radians, right-handed about the axis)
//   { type: 'hide' | 'show', part, at }
//   { type: 'linkage', crank, coupler, slider, pivot, knee, pin, angle, axis, line? }
//
// Coordinates are the GLB's own frame (metres, y up) with every part at rest, and parts are GLB node names. A part's
// steps compose in order, each riding on the ones before it: a step's pivot, axis and direction are fixed to the part
// as it sits at rest, so a drawer that slides out and then tips about its front edge tips about that edge where the
// slide has taken it. A child node rides with its parent through the GLB's own hierarchy.
//
// `clip` names a glTF animation in the GLB to scrub instead of steps (k runs over the clip's length).

/** @typedef {[number, number, number]} Vec3 */
/** @typedef {[number, number, number, number]} Quat  xyzw */
/** @typedef {{ q: Quat, t: Vec3 }} Rigid  p' = q·p + t */

/**
 * @typedef {object} Step
 * @property {'move' | 'turn' | 'hide' | 'show' | 'linkage'} type
 * @property {string} [part]
 * @property {Vec3} [by]
 * @property {Vec3} [axis]
 * @property {Vec3} [pivot]
 * @property {number} [angle]
 * @property {number} [at]
 * @property {number} [from]
 * @property {number} [to]
 * @property {'smooth' | 'linear'} [ease]
 * @property {string} [crank]
 * @property {string} [coupler]
 * @property {string} [slider]
 * @property {Vec3} [knee]
 * @property {Vec3} [pin]
 * @property {Vec3} [line]
 *
 * @typedef {object} Action
 * @property {string} [name]
 * @property {{ at: number, text: string }[]} [states]
 * @property {string} [clip]
 * @property {Step[]} [steps]
 */

export const STEP_TYPES = ['move', 'turn', 'hide', 'show', 'linkage'];

export const clamp01 = (/** @type {number} */ x) => Math.min(1, Math.max(0, x));
export const smoothstep = (/** @type {number} */ x) => {
	const c = clamp01(x);
	return c * c * (3 - 2 * c);
};

const add = (/** @type {Vec3} */ a, /** @type {Vec3} */ b) => /** @type {Vec3} */ ([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
const sub = (/** @type {Vec3} */ a, /** @type {Vec3} */ b) => /** @type {Vec3} */ ([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
const scale = (/** @type {Vec3} */ a, /** @type {number} */ s) => /** @type {Vec3} */ ([a[0] * s, a[1] * s, a[2] * s]);
const dot = (/** @type {Vec3} */ a, /** @type {Vec3} */ b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (/** @type {Vec3} */ a, /** @type {Vec3} */ b) => /** @type {Vec3} */ ([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
const length = (/** @type {Vec3} */ a) => Math.sqrt(dot(a, a));
const unit = (/** @type {Vec3} */ a) => scale(a, 1 / (length(a) || 1));

/** @param {Quat} a @param {Quat} b @returns {Quat} a·b */
function qmul(a, b) {
	const [ax, ay, az, aw] = a;
	const [bx, by, bz, bw] = b;
	return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/** @param {Quat} q @param {Vec3} v @returns {Vec3} v turned by q */
export function rotate(q, v) {
	const u = /** @type {Vec3} */ ([q[0], q[1], q[2]]);
	const t = scale(cross(u, v), 2);
	return add(add(v, scale(t, q[3])), cross(u, t));
}

/** @param {Vec3} axis @param {number} angle @returns {Quat} */
function axisAngle(axis, angle) {
	const a = unit(axis);
	const s = Math.sin(angle / 2);
	return [a[0] * s, a[1] * s, a[2] * s, Math.cos(angle / 2)];
}

/** The shortest turn taking unit vector a onto unit vector b. @param {Vec3} a @param {Vec3} b @returns {Quat} */
function between(a, b) {
	const d = dot(a, b);
	if (d < -1 + 1e-12) {
		const side = Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]);
		return axisAngle(side, Math.PI);
	}
	const c = cross(a, b);
	const q = /** @type {Quat} */ ([c[0], c[1], c[2], 1 + d]);
	const n = Math.hypot(...q);
	return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** @type {Rigid} */
export const IDENTITY = Object.freeze({ q: /** @type {Quat} */ ([0, 0, 0, 1]), t: /** @type {Vec3} */ ([0, 0, 0]) });

/** a∘b: b first, then a. @param {Rigid} a @param {Rigid} b @returns {Rigid} */
export function compose(a, b) {
	return { q: qmul(a.q, b.q), t: add(rotate(a.q, b.t), a.t) };
}

/** @param {Rigid} tf @param {Vec3} p @returns {Vec3} */
export function apply(tf, p) {
	return add(rotate(tf.q, p), tf.t);
}

/** @param {Vec3} v @returns {Rigid} */
export function translation(v) {
	return { q: [0, 0, 0, 1], t: [v[0], v[1], v[2]] };
}

/** A turn of `angle` about the line through `pivot` along `axis`. @param {Vec3} axis @param {number} angle @param {Vec3} pivot @returns {Rigid} */
export function turnAbout(axis, angle, pivot) {
	const q = axisAngle(axis, angle);
	return { q, t: sub(pivot, rotate(q, pivot)) };
}

/**
 * How far through its span a step is at k, eased.
 * @param {Step} step @param {number} k
 */
export function progress(step, k) {
	const from = step.from ?? 0;
	const to = step.to ?? 1;
	const x = to > from ? (k - from) / (to - from) : k >= to ? 1 : 0;
	return step.ease === 'linear' ? clamp01(x) : smoothstep(x);
}

/**
 * A slider-crank solved exactly. The crank turns about the line through `pivot` along `axis` by `angle`·u, carrying
 * the knee (the crank's joint with the coupler) round. The coupler keeps its length from knee to pin, and the slider
 * moves along `line` (by default from the pivot towards the pin, as in an inline slider-crank) so that the pin stays
 * on it. The pin takes the solution that starts where it rests, so it never jumps to the far branch.
 * @param {Step} step @param {number} u  0..1
 * @returns {{ crank: Rigid, coupler: Rigid, slider: Rigid, travel: number, reached: boolean }}
 */
export function solveLinkage(step, u) {
	const pivot = /** @type {Vec3} */ (step.pivot);
	const knee = /** @type {Vec3} */ (step.knee);
	const pin = /** @type {Vec3} */ (step.pin);
	const line = unit(step.line ?? sub(pin, pivot));
	const crank = turnAbout(/** @type {Vec3} */ (step.axis), (step.angle ?? 0) * u, pivot);
	const knee2 = apply(crank, knee);
	const rod = length(sub(pin, knee));
	// |pin + s·line - knee2| = rod, a quadratic in s
	const w = sub(pin, knee2);
	const b = dot(w, line);
	const disc = b * b - dot(w, w) + rod * rod;
	const side = Math.sign(dot(sub(pin, knee), line)) || 1;
	const travel = -b + side * Math.sqrt(Math.max(0, disc));
	const pin2 = add(pin, scale(line, travel));
	const q = between(unit(sub(pin, knee)), unit(sub(pin2, knee2)));
	return { crank, coupler: { q, t: sub(knee2, rotate(q, knee)) }, slider: translation(scale(line, travel)), travel, reached: disc >= -1e-12 };
}

/**
 * Every moving part's offset from rest at k, as a rigid motion in the GLB's frame, and whether each part that has
 * hide or show steps is visible.
 * @param {Action | null | undefined} action @param {number} k
 * @returns {{ transforms: Map<string, Rigid>, visible: Map<string, boolean> }}
 */
export function poseAt(action, k) {
	/** @type {Map<string, Rigid>} */
	const transforms = new Map();
	/** @type {Map<string, Step[]>} */
	const switches = new Map();
	const put = (/** @type {string | undefined} */ part, /** @type {Rigid} */ tf) => {
		if (part) transforms.set(part, compose(transforms.get(part) || IDENTITY, tf));
	};
	for (const step of action?.steps || []) {
		const u = progress(step, k);
		if (step.type === 'move') put(step.part, translation(scale(/** @type {Vec3} */ (step.by), u)));
		else if (step.type === 'turn') put(step.part, turnAbout(/** @type {Vec3} */ (step.axis), (step.angle ?? 0) * u, /** @type {Vec3} */ (step.pivot)));
		else if (step.type === 'linkage') {
			const solved = solveLinkage(step, u);
			put(step.crank, solved.crank);
			put(step.coupler, solved.coupler);
			put(step.slider, solved.slider);
		} else if ((step.type === 'hide' || step.type === 'show') && step.part) {
			switches.set(step.part, [...(switches.get(step.part) || []), step]);
		}
	}
	/** @type {Map<string, boolean>} */
	const visible = new Map();
	for (const [part, list] of switches) {
		const sorted = [...list].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
		let shown = sorted[0].type !== 'show';
		for (const s of sorted) if (k >= (s.at ?? 0)) shown = s.type === 'show';
		visible.set(part, shown);
	}
	return { transforms, visible };
}

/** A length in metres, written in millimetres under a metre. @param {number} m */
export function fmtLen(m) {
	const a = Math.abs(m);
	if (a >= 1) return `${m.toFixed(a >= 10 ? 1 : 2)} m`;
	const mm = m * 1000;
	return `${Math.abs(mm) >= 10 ? Math.round(mm) : Math.round(mm * 10) / 10} mm`;
}

const deg = (/** @type {number} */ r) => Math.round((Math.abs(r) * 180) / Math.PI);

/**
 * The action at k in words: the state it has reached, and how far each part has gone.
 * @param {Action | null | undefined} action @param {number} k
 * @param {(part: string) => string} [label]  a part's display name
 * @returns {{ state: string | null, moves: string[] }}
 */
export function describePose(action, k, label = (p) => p) {
	if (!action) return { state: null, moves: [] };
	const reached = (action.states || []).filter((s) => s.at <= k + 1e-9).sort((a, b) => a.at - b.at);
	const state = reached.length ? reached[reached.length - 1].text : null;
	if (action.clip) return { state, moves: [`${action.clip} at ${Math.round(k * 100)}%`] };
	const moves = [];
	for (const step of action.steps || []) {
		const u = progress(step, k);
		if (step.type === 'move' && u > 0) {
			const full = length(/** @type {Vec3} */ (step.by));
			moves.push(`${label(step.part || '')} moved ${fmtLen(full * u)} of ${fmtLen(full)}`);
		} else if (step.type === 'turn' && u > 0) {
			moves.push(`${label(step.part || '')} turned ${deg((step.angle ?? 0) * u)}° of ${deg(step.angle ?? 0)}°`);
		} else if (step.type === 'linkage' && u > 0) {
			const solved = solveLinkage(step, u);
			moves.push(`${label(step.crank || '')} turned ${deg((step.angle ?? 0) * u)}° of ${deg(step.angle ?? 0)}°`);
			moves.push(`${label(step.slider || '')} moved ${fmtLen(Math.abs(solved.travel))}`);
		}
	}
	for (const [part, shown] of poseAt(action, k).visible) if (!shown) moves.push(`${label(part)} hidden`);
	return { state, moves };
}

/**
 * What is wrong with an action, if anything: shapes, spans, unknown parts (when the GLB's node names are given) and
 * linkages whose coupler can't reach the slider's line.
 * @param {any} action @param {string[]} [nodeNames]
 * @returns {string[]}
 */
export function validateAction(action, nodeNames) {
	if (action == null) return [];
	if (typeof action !== 'object' || Array.isArray(action)) return ['action must be an object'];
	const errors = [];
	const vec = (/** @type {any} */ v) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
	const num = (/** @type {any} */ v) => typeof v === 'number' && Number.isFinite(v);
	if (action.name !== undefined && typeof action.name !== 'string') errors.push('action.name must be a string');
	if (action.clip !== undefined && typeof action.clip !== 'string') errors.push('action.clip must be the name of an animation in the GLB');
	if (action.states !== undefined) {
		if (!Array.isArray(action.states)) errors.push('action.states must be a list of { at, text }');
		else action.states.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
			if (!s || !num(s.at) || s.at < 0 || s.at > 1 || typeof s.text !== 'string') errors.push(`action.states[${i}] must be { at: 0..1, text }`);
		});
	}
	if (action.steps !== undefined && !Array.isArray(action.steps)) return [...errors, 'action.steps must be a list'];
	const known = nodeNames ? new Set(nodeNames) : null;
	(action.steps || []).forEach((/** @type {any} */ s, /** @type {number} */ i) => {
		const at = `action.steps[${i}]`;
		if (!s || typeof s !== 'object') return errors.push(`${at} must be an object`);
		if (!STEP_TYPES.includes(s.type)) return errors.push(`${at}.type must be one of ${STEP_TYPES.join(', ')}`);
		for (const key of ['from', 'to', 'at']) if (s[key] !== undefined && (!num(s[key]) || s[key] < 0 || s[key] > 1)) errors.push(`${at}.${key} must be a number from 0 to 1`);
		if (num(s.from) && num(s.to) && s.from >= s.to) errors.push(`${at}: from must be less than to`);
		if (s.ease !== undefined && s.ease !== 'smooth' && s.ease !== 'linear') errors.push(`${at}.ease must be 'smooth' or 'linear'`);
		const parts = s.type === 'linkage' ? ['crank', 'coupler', 'slider'] : ['part'];
		for (const key of parts) {
			if (typeof s[key] !== 'string' || !s[key]) errors.push(`${at}.${key} must be a node name`);
			else if (known && !known.has(s[key])) errors.push(`${at}.${key}: the GLB has no node named "${s[key]}"`);
		}
		const needs = { move: ['by'], turn: ['axis', 'pivot'], linkage: ['axis', 'pivot', 'knee', 'pin'], hide: [], show: [] }[/** @type {'move'} */ (s.type)];
		for (const key of needs) if (!vec(s[key])) errors.push(`${at}.${key} must be [x, y, z]`);
		if ((s.type === 'turn' || s.type === 'linkage') && !num(s.angle)) errors.push(`${at}.angle must be a number (radians)`);
		if ((s.type === 'hide' || s.type === 'show') && !num(s.at)) errors.push(`${at}.at must be a number from 0 to 1`);
		if (vec(s.axis) && length(s.axis) < 1e-9) errors.push(`${at}.axis must not be zero`);
		if (s.type === 'linkage' && needs.every((key) => vec(s[key])) && num(s.angle)) {
			if (s.line !== undefined && (!vec(s.line) || length(s.line) < 1e-9)) errors.push(`${at}.line must be a non-zero [x, y, z]`);
			else if (length(sub(s.pin, s.knee)) < 1e-9) errors.push(`${at}: knee and pin must be apart`);
			else if (!s.line && length(sub(s.pin, s.pivot)) < 1e-9) errors.push(`${at}: give a line, since pin and pivot are the same point`);
			else {
				const stuck = Array.from({ length: 65 }, (_, j) => j / 64).find((u) => !solveLinkage(s, u).reached);
				if (stuck !== undefined) errors.push(`${at}: the coupler can't reach the slider's line ${Math.round(stuck * 100)}% of the way through (lengthen it or turn the crank less)`);
			}
		}
	});
	return errors;
}
