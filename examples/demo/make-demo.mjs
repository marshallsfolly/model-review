#!/usr/bin/env node
// Builds the example project from boxes and cylinders: a keepsake case (a hasp, a lid held by a sliding stay, a
// drawer) with a lighter version, and an engine's crank and piston. It writes the GLBs and the project.json that
// describes their actions, so the action's pivots and the geometry come from the same numbers.
//
//   node examples/demo/make-demo.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGlb } from '../../lib/glb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** @typedef {[number, number, number]} Vec3 */
/** @typedef {{ positions: number[], normals: number[], uvs: number[], indices: number[], material: number }} Shape */

// ---- shapes, written in the model's frame (metres, y up) ----

/** An axis-aligned box from min to max. @param {Vec3} min @param {Vec3} max @param {number} material @returns {Shape} */
function box(min, max, material) {
	const shape = { positions: [], normals: [], uvs: [], indices: [], material };
	for (let axis = 0; axis < 3; axis++) {
		const u = (axis + 1) % 3;
		const v = (axis + 2) % 3;
		for (const sign of [1, -1]) {
			const base = shape.positions.length / 3;
			const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
			if (sign < 0) corners.reverse(); // keep the winding counter-clockwise seen from outside
			for (const [cu, cv] of corners) {
				const p = [0, 0, 0];
				p[axis] = sign > 0 ? max[axis] : min[axis];
				p[u] = cu ? max[u] : min[u];
				p[v] = cv ? max[v] : min[v];
				const n = [0, 0, 0];
				n[axis] = sign;
				shape.positions.push(...p);
				shape.normals.push(...n);
				shape.uvs.push(cu, cv);
			}
			shape.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
		}
	}
	return shape;
}

/**
 * A closed cylinder along one axis (0 x, 1 y, 2 z).
 * @param {0 | 1 | 2} axis @param {Vec3} center @param {number} radius @param {number} length @param {number} segments @param {number} material
 * @returns {Shape}
 */
function cylinder(axis, center, radius, length, segments, material) {
	const shape = { positions: [], normals: [], uvs: [], indices: [], material };
	const u = (axis + 1) % 3;
	const v = (axis + 2) % 3;
	const point = (/** @type {number} */ a, /** @type {number} */ h) => {
		const p = [...center];
		p[u] += radius * Math.cos(a);
		p[v] += radius * Math.sin(a);
		p[axis] += h;
		return p;
	};
	const vertex = (/** @type {number[]} */ p, /** @type {number[]} */ n, /** @type {number} */ s, /** @type {number} */ t) => {
		shape.positions.push(...p);
		shape.normals.push(...n);
		shape.uvs.push(s, t);
		return shape.positions.length / 3 - 1;
	};
	const half = length / 2;
	for (let i = 0; i < segments; i++) {
		const a0 = (i / segments) * 2 * Math.PI;
		const a1 = ((i + 1) / segments) * 2 * Math.PI;
		const radial = (/** @type {number} */ a) => {
			const n = [0, 0, 0];
			n[u] = Math.cos(a);
			n[v] = Math.sin(a);
			return n;
		};
		const b0 = vertex(point(a0, -half), radial(a0), i / segments, 0);
		const b1 = vertex(point(a1, -half), radial(a1), (i + 1) / segments, 0);
		const t1 = vertex(point(a1, half), radial(a1), (i + 1) / segments, 1);
		const t0 = vertex(point(a0, half), radial(a0), i / segments, 1);
		shape.indices.push(b0, b1, t1, b0, t1, t0);
		for (const side of [1, -1]) {
			const n = [0, 0, 0];
			n[axis] = side;
			const c = [...center];
			c[axis] += side * half;
			const mid = vertex(c, n, 0.5, 0.5);
			const p0 = vertex(point(a0, side * half), n, 0.5 + Math.cos(a0) / 2, 0.5 + Math.sin(a0) / 2);
			const p1 = vertex(point(a1, side * half), n, 0.5 + Math.cos(a1) / 2, 0.5 + Math.sin(a1) / 2);
			shape.indices.push(...(side > 0 ? [mid, p0, p1] : [mid, p1, p0]));
		}
	}
	return shape;
}

/**
 * Shapes merged into one primitive per material, moved into the frame of a node whose origin is `origin`.
 * @param {Shape[]} shapes @param {Vec3} origin
 */
function primitives(shapes, origin) {
	/** @type {Map<number, Shape>} */
	const byMaterial = new Map();
	for (const s of shapes) {
		const into = byMaterial.get(s.material) || { positions: [], normals: [], uvs: [], indices: [], material: s.material };
		const base = into.positions.length / 3;
		s.positions.forEach((x, i) => into.positions.push(x - origin[i % 3]));
		into.normals.push(...s.normals);
		into.uvs.push(...s.uvs);
		into.indices.push(...s.indices.map((i) => i + base));
		byMaterial.set(s.material, into);
	}
	return [...byMaterial.values()];
}

/**
 * A node at `origin` (in the model frame) drawing `shapes`; its children's origins are in the model frame too.
 * @param {string} name @param {Vec3} origin @param {Shape[]} shapes @param {{ name: string, origin: Vec3, shapes: Shape[], children?: any[] }[]} [children]
 * @param {Vec3} [parentOrigin]
 * @returns {import('../../lib/glb.mjs').NodeSpec}
 */
function node(name, origin, shapes, children = [], parentOrigin = [0, 0, 0]) {
	return {
		name,
		translation: [origin[0] - parentOrigin[0], origin[1] - parentOrigin[1], origin[2] - parentOrigin[2]],
		primitives: primitives(shapes, origin),
		children: children.map((c) => node(c.name, c.origin, c.shapes, c.children, origin)),
	};
}

// ---- the keepsake case ----

const WALNUT = 0;
const BRASS = 1;
const FELT = 2;
const STEEL = 3;
const PAINT = 4;
const MATERIALS = [
	{ name: 'walnut', color: [0.075, 0.032, 0.015], roughness: 0.5 },
	{ name: 'brass', color: [0.8, 0.55, 0.22], metallic: 1, roughness: 0.3 },
	{ name: 'felt', color: [0.015, 0.09, 0.045], roughness: 0.95 },
	{ name: 'steel', color: [0.56, 0.57, 0.58], metallic: 1, roughness: 0.35 },
	{ name: 'paint', color: [0.05, 0.12, 0.2], roughness: 0.6 },
];

// 300 wide (x), 120 tall to the lid's seam (y), 200 deep (z); walls 10 thick. The lid hinges on the back top edge.
const W = 0.15;
const D = 0.1;
const SEAM = 0.12;
const T = 0.01;
const HINGE = /** @type {Vec3} */ ([0, SEAM, -D]);
// The lid stay, on the inside of the right wall: its knee on a bracket under the lid, its foot a shoe on a rail.
const STAY_X = 0.131;
const KNEE = /** @type {Vec3} */ ([STAY_X, 0.112, -0.05]);
const PIN = /** @type {Vec3} */ ([STAY_X, 0.112, 0.05]);
const HASP_PIVOT = /** @type {Vec3} */ ([0, 0.128, 0.105]);
const DRAWER_OUT = 0.13;

/** @param {boolean} full  false for the lighter version: fewer cylinder sides, no feet or hinge knuckles */
function keepsakeCase(full) {
	const sides = full ? 32 : 8;
	const body = [
		box([-W, 0, -D], [W, T, D], WALNUT),
		box([-W, T, -D], [W, SEAM, -D + T], WALNUT),
		box([-W, T, -D + T], [-W + T, SEAM, D], WALNUT),
		box([W - T, T, -D + T], [W, SEAM, D], WALNUT),
		box([-W + T, 0.055, D - T], [W - T, SEAM, D], WALNUT), // the front, above the drawer
		box([-W + T, 0.045, -D + T], [W - T, 0.055, D - T], WALNUT), // the shelf over the drawer
		box([-W + T, 0.055, -D + T], [W - T, 0.058, D - T], FELT),
		box([0.134, 0.102, -0.035], [0.14, 0.108, 0.065], BRASS), // the stay's rail
		box([-0.012, 0.104, D], [0.012, 0.112, D + 0.003], BRASS), // the hasp's keeper
	];
	if (full) {
		for (const x of [-0.095, 0.095]) body.push(cylinder(0, [x, SEAM, -D], 0.004, 0.03, sides, BRASS));
		for (const x of [-0.13, 0.13]) for (const z of [-0.08, 0.08]) body.push(cylinder(1, [x, -0.003, z], 0.008, 0.006, sides, BRASS));
	}
	const lid = [
		box([-W, SEAM, -D], [W, 0.15, D], WALNUT),
		box([-0.13, 0.15, -0.08], [0.13, 0.155, 0.08], WALNUT),
		box([0.127, 0.11, -0.054], [0.135, SEAM, -0.046], BRASS), // the stay's bracket
		box([-0.011, 0.124, D], [0.011, 0.132, D + 0.0025], BRASS), // the hasp's leaf
	];
	const handle = [cylinder(0, [0, 0.162, 0], 0.004, 0.09, sides, BRASS), ...[-0.04, 0.04].map((x) => cylinder(1, [x, 0.1585, 0], 0.0035, 0.007, sides, BRASS))];
	const hasp = [box([-0.01, 0.1, 0.1035], [0.01, 0.128, 0.1065], BRASS), cylinder(0, HASP_PIVOT, 0.0028, 0.02, sides, BRASS)];
	const stay = [box([0.128, 0.109, -0.05], [0.134, 0.115, 0.05], BRASS), cylinder(0, KNEE, 0.004, 0.006, sides, BRASS), cylinder(0, PIN, 0.004, 0.006, sides, BRASS)];
	const shoe = [box([0.125, 0.108, 0.043], [0.137, 0.116, 0.057], BRASS)];
	const drawer = [
		box([-0.138, 0.012, 0.088], [0.138, 0.044, D], WALNUT),
		box([-0.135, 0.012, -0.085], [0.135, 0.016, 0.088], WALNUT),
		box([-0.135, 0.016, -0.085], [-0.131, 0.04, 0.088], WALNUT),
		box([0.131, 0.016, -0.085], [0.135, 0.04, 0.088], WALNUT),
		box([-0.131, 0.016, -0.085], [0.131, 0.04, -0.081], WALNUT),
		box([-0.131, 0.016, -0.081], [0.131, 0.018, 0.088], FELT),
	];
	const knob = [cylinder(2, [0, 0.028, 0.104], 0.004, 0.008, sides, BRASS), cylinder(2, [0, 0.028, 0.111], 0.009, 0.006, sides, BRASS)];
	return writeGlb({
		generator: 'model-review examples/demo/make-demo.mjs',
		materials: MATERIALS,
		nodes: [
			node('body', [0, 0, 0], body),
			node('lid', HINGE, lid, [
				{ name: 'lid_handle', origin: [0, 0.16, 0], shapes: handle },
				{ name: 'hasp', origin: HASP_PIVOT, shapes: hasp },
			]),
			node('stay', KNEE, stay),
			node('shoe', PIN, shoe),
			node('drawer', [0, 0.012, D], drawer, [{ name: 'drawer_knob', origin: [0, 0.028, D], shapes: knob }]),
		],
	});
}

// ---- the crank and piston, lying flat on its frame ----

const CRANK = 0.03;
const ROD = 0.09;
const PLANE = 0.016; // the rod's height above the frame

function crankAndPiston() {
	const frame = [
		box([-0.07, -0.012, -0.06], [0.2, 0, 0.06], PAINT),
		cylinder(1, [0, 0.001, 0], 0.012, 0.002, 32, PAINT),
		box([0.055, 0, -0.028], [0.19, 0.044, -0.021], PAINT),
		box([0.055, 0, 0.021], [0.19, 0.044, 0.028], PAINT),
	];
	const crank = [cylinder(1, [0, 0.007, 0], 0.042, 0.01, 48, STEEL), cylinder(1, [0, 0.0145, 0], 0.008, 0.005, 24, STEEL), cylinder(1, [CRANK, PLANE, 0], 0.005, 0.008, 24, STEEL)];
	const rod = [box([CRANK, 0.013, -0.005], [CRANK + ROD, 0.019, 0.005], STEEL), cylinder(1, [CRANK, PLANE, 0], 0.009, 0.006, 24, STEEL), cylinder(1, [CRANK + ROD, PLANE, 0], 0.007, 0.006, 24, STEEL)];
	const piston = [cylinder(0, [0.1385, 0.022, 0], 0.0195, 0.053, 40, BRASS)];
	return writeGlb({
		generator: 'model-review examples/demo/make-demo.mjs',
		materials: MATERIALS,
		nodes: [
			node('frame', [0, 0, 0], frame),
			node('crank', [0, 0, 0], crank),
			node('rod', [CRANK, PLANE, 0], rod),
			node('piston', [CRANK + ROD, PLANE, 0], piston),
		],
	});
}

// ---- the project ----

const round = (/** @type {number[]} */ v) => v.map((x) => Math.round(x * 1e6) / 1e6);

const project = {
	title: 'Model review demo',
	description: 'Two small generated models to try the review loop on. Rebuild them with node examples/demo/make-demo.mjs.',
	models: [
		{
			id: 'case',
			name: 'Keepsake case',
			group: 'Furniture',
			file: 'models/case.glb',
			lod: 'models/case_lod.glb',
			parts: { body: 'Body', lid: 'Lid', lid_handle: 'Lid handle', hasp: 'Hasp', stay: 'Lid stay', shoe: 'Stay shoe', drawer: 'Drawer', drawer_knob: 'Drawer knob' },
			action: {
				name: 'Open the case',
				states: [
					{ at: 0, text: 'Shut, the hasp down' },
					{ at: 0.001, text: 'Lifting the hasp' },
					{ at: 0.15, text: 'Opening the lid' },
					{ at: 0.6, text: 'Sliding the drawer out' },
					{ at: 1, text: 'Open' },
				],
				steps: [
					{ type: 'turn', part: 'hasp', axis: [-1, 0, 0], pivot: round(HASP_PIVOT), angle: 2.8, from: 0, to: 0.15 },
					{ type: 'linkage', crank: 'lid', coupler: 'stay', slider: 'shoe', pivot: round([STAY_X, SEAM, -D]), knee: round(KNEE), pin: round(PIN), line: [0, 0, 1], axis: [-1, 0, 0], angle: 1.75, from: 0.15, to: 0.75 },
					{ type: 'move', part: 'drawer', by: [0, 0, DRAWER_OUT], from: 0.6, to: 1 },
				],
			},
			views: {
				Inside: { pos: [0.02, 0.5, 0.42], target: [0, 0.05, 0.03] },
				'Lid stay': { pos: [-0.1, 0.3, 0.2], target: [0.12, 0.12, -0.02] },
			},
			info: {
				lede: 'A walnut keepsake case with brass fittings. Lift the hasp and the lid rises on a sliding stay; the drawer underneath pulls out. Built from boxes and cylinders by a script, so it is small and its moving parts are exact.',
				facts: [
					['Size', '300 × 162 × 200 mm, shut'],
					['Materials', 'Walnut, brass, felt'],
					['Moving parts', 'Hasp, lid on its stay, drawer'],
					['Lid', 'Opens 100° about its back edge'],
					['Drawer', 'Pulls out 130 mm'],
				],
				notes: [
					'The lid and its stay are a slider-crank: the lid turns about its hinge, the stay joins a bracket under the lid to a shoe that slides along a rail on the right wall.',
					'The hasp and the lid handle are children of the lid in the GLB, so they ride with it.',
				],
				sources: ['Generated by examples/demo/make-demo.mjs'],
			},
		},
		{
			id: 'crank',
			name: 'Crank and piston',
			group: 'Mechanisms',
			file: 'models/crank.glb',
			parts: { frame: 'Frame', crank: 'Crank', rod: 'Connecting rod', piston: 'Piston' },
			action: {
				name: 'Turn the crank',
				states: [
					{ at: 0, text: 'Outer dead centre' },
					{ at: 0.001, text: 'Piston coming in' },
					{ at: 0.5, text: 'Inner dead centre' },
					{ at: 0.501, text: 'Piston going out' },
					{ at: 1, text: 'Outer dead centre, one turn' },
				],
				steps: [{ type: 'linkage', crank: 'crank', coupler: 'rod', slider: 'piston', pivot: [0, PLANE, 0], knee: [CRANK, PLANE, 0], pin: [CRANK + ROD, PLANE, 0], axis: [0, 1, 0], angle: round([2 * Math.PI])[0], ease: 'linear' }],
			},
			info: {
				lede: "An engine's crank, connecting rod and piston: the classic slider-crank, solved exactly at every point of the turn.",
				facts: [
					['Crank throw', '30 mm'],
					['Connecting rod', '90 mm, centre to centre'],
					['Stroke', '60 mm'],
				],
				sources: ['Generated by examples/demo/make-demo.mjs'],
			},
		},
	],
};

mkdirSync(join(HERE, 'models'), { recursive: true });
writeFileSync(join(HERE, 'models/case.glb'), keepsakeCase(true));
writeFileSync(join(HERE, 'models/case_lod.glb'), keepsakeCase(false));
writeFileSync(join(HERE, 'models/crank.glb'), crankAndPiston());
writeFileSync(join(HERE, 'project.json'), JSON.stringify(project, null, '\t') + '\n');
console.log('wrote examples/demo/project.json and examples/demo/models/{case,case_lod,crank}.glb');
