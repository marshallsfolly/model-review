// The review page. A model turns on a lit stage; its moving parts are scrubbed to any pose; a click pins a note to a
// spot, with reference images and a snapshot of the view; each note keeps its replies; each model gets a verdict.
// Served by `model-review serve` (local mode) or published on claude.ai by `model-review export-artifact`
// (artifact mode); stores.js hides the difference.

import { poseAt, describePose, fmtLen } from './action.js';
import { openStore, noteState, IMAGE_TYPES } from './stores.js';

/** @typedef {import('../lib/review.mjs').Note} Note */
/** @typedef {import('../lib/project.mjs').Model} Model */

const THREE = /** @type {any} */ (window).THREE;
const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = matchMedia('(pointer: fine)').matches;
/** Set by export-artifact as { mode: 'artifact', project }; absent when the local server serves the page. */
const CONFIG = JSON.parse(document.getElementById('model-review-config')?.textContent || '{"mode":"local"}');
const DRACO_PATH = 'https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/libs/draco/gltf/';

/**
 * Make an element. Attributes starting with "on" are listeners; text children are set as text, never as HTML.
 * @param {string} tag @param {Record<string, any>} [attrs] @param {...any} children
 */
function h(tag, attrs = {}, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null || v === false) continue;
		if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
		else if (k === 'class') el.className = v;
		else el.setAttribute(k, v === true ? '' : String(v));
	}
	el.append(...children.flat().filter((c) => c != null && c !== false));
	return el;
}
const fixed = (/** @type {number[]} */ v, digits = 5) => v.map((x) => +x.toFixed(digits));
const sig = (/** @type {number} */ x) => Number(x.toPrecision(3));
/** @param {string} iso */
function fmtTime(iso) {
	try {
		return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
	} catch {
		return '';
	}
}

// ---- state ----

const S = {
	/** @type {{ title: string, description?: string, models: Model[] } | null} */
	project: null,
	/** @type {Record<string, string | null>} model files' revisions, to reload a file that changed */
	revs: {},
	/** @type {any} the loaded model on the stage */
	cur: null,
	modelId: '',
	view: 'Three-quarter',
	mode: 0,
	wire: false,
	lod: false,
	k: 0,
	/** @type {{ t0: number, dur: number, pts: number[][] } | null} */
	play: null,
	/** @type {any} */
	tween: null,
	/** @type {Set<string>} parts the reviewer has hidden */
	hidden: new Set(),
};
const R = {
	store: openStore(CONFIG),
	connected: false,
	canWrite: false,
	canUpload: false,
	/** @type {Note[]} */
	notes: [],
	/** @type {Record<string, { state: string, by: string, at: string }>} */
	verdicts: {},
	/** @type {Record<string, { name: string, isMe: boolean }>} */
	names: {},
	/** @type {string | null} the note shown on the model */
	sel: null,
	draft: newDraft(),
	/** @type {string | null} the note asking "delete?" */
	confirm: null,
	/** @type {string | null} the note with its reply box open */
	replying: null,
};

function newDraft() {
	return {
		/** @type {{ model: string, node: string | null, local: number[] | null, world: number[], radius: number } | null} */
		pin: null,
		/** @type {{ id: string | null, url: string, state: 'busy' | 'done' | 'bad', saved: boolean, name: string }[]} */
		images: [],
		/** @type {string | null} the note being edited */
		editing: null,
		repin: false,
		reradius: false,
	};
}

const modelById = (/** @type {string} */ id) => S.project?.models.find((m) => m.id === id);
const curModel = () => /** @type {Model | undefined} */ (S.cur?.m);
/** A node's label: its own in the model's parts, else its nearest labelled ancestor's, else its name. @param {string | null} node */
function partLabel(node) {
	const m = curModel();
	if (!node) return 'the whole model';
	if (m?.parts?.[node]) return m.parts[node];
	const obj = S.cur?.sets.full.nodes.get(node);
	for (let o = obj?.parent; o; o = o.parent) if (o.userData.node && m?.parts?.[o.userData.node]) return `${m.parts[o.userData.node]} (${node})`;
	return node;
}

// ---- the stage ----

const stage = $('stage');
/** @param {string} title @param {string} text */
function veil(title, text) {
	$('veil').hidden = false;
	$('veil-title').textContent = title;
	$('veil-text').textContent = text;
}
let renderer;
try {
	renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
} catch (e) {
	veil('No 3D here', 'This page needs WebGL, which this browser has turned off. The notes below still work.');
	throw e;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.physicallyCorrectLights = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.domElement.setAttribute('role', 'img');
renderer.domElement.setAttribute('aria-label', 'The model. Drag to turn it; click a spot to pin a note there.');
stage.prepend(renderer.domElement);

const scene = new THREE.Scene();
function lightRoom() {
	const pmrem = new THREE.PMREMGenerator(renderer);
	scene.environment?.dispose();
	scene.environment = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
	pmrem.dispose();
}
lightRoom();
const keyLight = new THREE.DirectionalLight(0xfff1dc, 1.6);
const rimLight = new THREE.DirectionalLight(0xc8d4ff, 0.7);
scene.add(keyLight, keyLight.target, rimLight);
// (a soft painted shadow under the model: shadow maps fail to link on some GPUs)
const blot = document.createElement('canvas');
blot.width = blot.height = 128;
{
	const c = /** @type {CanvasRenderingContext2D} */ (blot.getContext('2d'));
	const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
	g.addColorStop(0, 'rgba(0,0,0,0.45)');
	g.addColorStop(0.55, 'rgba(0,0,0,0.18)');
	g.addColorStop(1, 'rgba(0,0,0,0)');
	c.fillStyle = g;
	c.fillRect(0, 0, 128, 128);
}
const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(blot), transparent: true, depthWrite: false, toneMapped: false }));
floor.rotation.x = -Math.PI / 2;
floor.renderOrder = -1;
scene.add(floor);

const camera = new THREE.PerspectiveCamera(30, 2, 0.01, 100);
const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.09;
controls.zoomSpeed = 0.8;
let dirty = true;
const redraw = () => (dirty = true);
// (a busy GPU can take the WebGL context away; frames drawn meanwhile are lost, and so is the environment light, a
// texture drawn on the GPU, so when the context comes back the light is made again and the stage drawn afresh)
renderer.domElement.addEventListener('webglcontextrestored', () => {
	lightRoom();
	redraw();
});
controls.addEventListener('change', redraw);
controls.addEventListener('start', () => (S.tween = null));

function resize() {
	const w = stage.clientWidth;
	const hgt = stage.clientHeight;
	renderer.setSize(w, hgt, false);
	camera.aspect = w / hgt;
	camera.updateProjectionMatrix();
	redraw();
}
new ResizeObserver(resize).observe(stage);

// ---- the highlight: the area a note is about, lit on the surface (a sphere about the spot, which rides with its
// part), drawn by the finished materials and the channel views alike ----
const HL = { hlP: { value: new THREE.Vector3() }, hlR: { value: 0 }, hlC: { value: new THREE.Color(0.98, 0.72, 0.2) } };
const HL_GLSL = `uniform vec3 hlP; uniform float hlR; uniform vec3 hlC; varying vec3 vHlW;
vec3 hilite(vec3 c) {
	if (hlR <= 0.0) return c;
	float d = distance(vHlW, hlP), w = max(fwidth(d) * 1.4, hlR * 0.012);
	float inside = 1.0 - smoothstep(hlR - w, hlR, d);
	float rim = smoothstep(hlR - 3.5 * w, hlR - 1.5 * w, d) * inside;
	float edge = smoothstep(hlR - w, hlR, d) * (1.0 - smoothstep(hlR, hlR + 1.5 * w, d));
	float r0 = min(hlR * 0.09, hlR * 0.5), pt = 1.0 - smoothstep(r0, r0 + w, d);
	c = mix(c, mix(c, hlC, 0.3) + 0.05, inside * 0.85);
	c = mix(c, vec3(0.04), edge * 0.7);
	c = mix(c, hlC, rim);
	return mix(c, vec3(1.0), pt);
}`;
/** The finished material, the highlight laid over its lit colour. @param {any} mat */
function withHighlight(mat) {
	mat.onBeforeCompile = (/** @type {any} */ sh) => {
		Object.assign(sh.uniforms, HL);
		sh.vertexShader = 'varying vec3 vHlW;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n\tvHlW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
		sh.fragmentShader = HL_GLSL + '\n' + sh.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.rgb = hilite(gl_FragColor.rgb);');
	};
	mat.polygonOffset = true;
	mat.polygonOffsetFactor = 1;
	mat.polygonOffsetUnits = 1;
	mat.needsUpdate = true;
}

// ---- channel views: a material's inputs as data, unlit (its maps where it has them, its factors where not) ----
const CHANNEL_VS = `#include <common>
#include <skinning_pars_vertex>
varying vec2 vUv; varying vec3 vHlW; varying vec3 vNrm;
void main() {
	vUv = uv;
	#include <beginnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <begin_vertex>
	#include <skinning_vertex>
	vNrm = normalize(mat3(modelMatrix) * objectNormal);
	vec4 world = modelMatrix * vec4(transformed, 1.0);
	vHlW = world.xyz;
	gl_Position = projectionMatrix * viewMatrix * world;
}`;
const CHANNEL_FS = HL_GLSL + `
uniform sampler2D tColor, tMR, tAO, tNormal; uniform bool hasColor, hasMR, hasAO, hasNormal;
uniform vec3 baseColor; uniform float roughness, metalness, aoStrength; uniform int mode;
varying vec2 vUv; varying vec3 vNrm;
void main() {
	vec3 c;
	if (mode == 1) { c = baseColor; if (hasColor) c *= texture2D(tColor, vUv).rgb; c = pow(c, vec3(1.0 / 2.2)); }
	else if (mode == 2) c = vec3(roughness * (hasMR ? texture2D(tMR, vUv).g : 1.0));
	else if (mode == 3) c = vec3(metalness * (hasMR ? texture2D(tMR, vUv).b : 1.0));
	else if (mode == 4) c = vec3(hasAO ? 1.0 + aoStrength * (texture2D(tAO, vUv).r - 1.0) : 1.0);
	else c = hasNormal ? texture2D(tNormal, vUv).rgb : normalize(vNrm) * 0.5 + 0.5;
	gl_FragColor = vec4(hilite(c), 1.0);
}`;
const LEGEND = [
	'',
	'Colour: the base colour, no light on it',
	'Roughness: dark is polished, light is matte',
	'Metal: white is bare metal, black is not',
	'Occlusion: darker where light can’t reach',
	'Normals: the normal map as stored, or the surface’s direction where there is none',
];
const channelMode = { value: 1 };
const channels = new Map();
/** The channel view of a material, made once. @param {any} mat */
function channelOf(mat) {
	if (!channels.has(mat)) {
		const tex = (/** @type {any} */ t) => ({ value: t || null });
		channels.set(mat, new THREE.ShaderMaterial({
			uniforms: {
				...HL,
				mode: channelMode,
				tColor: tex(mat.map), hasColor: { value: !!mat.map },
				tMR: tex(mat.roughnessMap || mat.metalnessMap), hasMR: { value: !!(mat.roughnessMap || mat.metalnessMap) },
				tAO: tex(mat.aoMap), hasAO: { value: !!mat.aoMap }, aoStrength: { value: mat.aoMapIntensity ?? 1 },
				tNormal: tex(mat.normalMap), hasNormal: { value: !!mat.normalMap },
				baseColor: { value: mat.color ? mat.color.clone() : new THREE.Color(1, 1, 1) },
				roughness: { value: mat.roughness ?? 1 }, metalness: { value: mat.metalness ?? 0 },
			},
			vertexShader: CHANNEL_VS,
			fragmentShader: CHANNEL_FS,
			side: mat.side,
			polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
			extensions: { derivatives: true },
		}));
	}
	return channels.get(mat);
}

// ---- loading a model ----

const loader = new THREE.GLTFLoader();
if (THREE.DRACOLoader) loader.setDRACOLoader(new THREE.DRACOLoader().setDecoderPath(DRACO_PATH));
if (/** @type {any} */ (window).MeshoptDecoder) loader.setMeshoptDecoder(/** @type {any} */ (window).MeshoptDecoder);

/** Where a project file is fetched from: beside the page in artifact mode, from the server's project route locally. @param {string} rel */
function fileUrl(rel) {
	if (CONFIG.mode === 'artifact') return rel;
	return `project/${rel.split('/').map(encodeURIComponent).join('/')}?v=${encodeURIComponent(S.revs[rel] || '')}`;
}
/** A GLB's bytes. An artifact can't serve .glb, so there each one is wrapped as base64 in a JSON file. @param {string} rel */
async function fetchGlb(rel) {
	const res = await fetch(fileUrl(rel));
	if (!res.ok) throw new Error(`${rel}: ${res.status} ${res.statusText}`);
	if (!/\.json$/i.test(rel)) return res.arrayBuffer();
	const bin = atob((await res.json()).glb);
	const buf = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
	return buf.buffer;
}
/** A texture from a project file (by fetch and a blob URL, so no cross-origin image rules apply). @param {string} rel @param {boolean} srgb */
async function fetchTexture(rel, srgb) {
	const res = await fetch(fileUrl(rel));
	if (!res.ok) throw new Error(`${rel}: ${res.status} ${res.statusText}`);
	const img = new Image();
	img.src = URL.createObjectURL(await res.blob());
	await img.decode();
	const t = new THREE.Texture(img);
	t.flipY = false; // glTF's UVs
	if (srgb) t.encoding = THREE.sRGBEncoding;
	t.anisotropy = renderer.capabilities.getMaxAnisotropy();
	t.needsUpdate = true;
	return t;
}
/** One material from a model's external maps, in place of the GLB's own. @param {NonNullable<Model['maps']>} maps */
async function mapsMaterial(maps) {
	const [color, orm, normal] = await Promise.all([maps.color ? fetchTexture(maps.color, true) : null, maps.orm ? fetchTexture(maps.orm, false) : null, maps.normal ? fetchTexture(maps.normal, false) : null]);
	const mat = new THREE.MeshStandardMaterial({
		map: color, aoMap: orm, roughnessMap: orm, metalnessMap: orm, roughness: orm ? 1 : 0.6, metalness: orm ? 1 : 0,
		normalMap: normal, normalMapType: maps.normalSpace === 'object' ? THREE.ObjectSpaceNormalMap : THREE.TangentSpaceNormalMap,
	});
	if (normal && maps.normalSpace !== 'object') mat.normalScale.set(1, -1); // glTF's tangent space, as GLTFLoader reads it
	return mat;
}

/**
 * A loaded GLB made ready for the stage: its meshes, its named nodes and their rest frames (the action's motions
 * are given in the model's frame at rest), and its animation when the action scrubs one.
 * @param {any} gltf @param {any} mapsMat @param {Model} m
 */
function prepare(gltf, mapsMat, m) {
	const root = gltf.scene;
	const json = gltf.parser.json;
	/** @type {Map<string, any>} */
	const nodes = new Map();
	for (const [obj, link] of gltf.parser.associations) {
		if (!obj.isObject3D || link.nodes === undefined) continue;
		const name = json.nodes[link.nodes].name || `node${link.nodes}`;
		obj.userData.node = name;
		if (!nodes.has(name)) nodes.set(name, obj);
	}
	const meshes = [];
	const materials = new Set();
	let triangles = 0;
	root.traverse((/** @type {any} */ o) => {
		if (!o.isMesh) return;
		meshes.push(o);
		if (mapsMat) {
			o.material = mapsMat;
			if (o.geometry.attributes.uv && !o.geometry.attributes.uv2) o.geometry.setAttribute('uv2', o.geometry.attributes.uv); // this three.js reads occlusion off uv2
		}
		for (const mat of [].concat(o.material)) materials.add(mat);
		o.userData.finished = o.material;
		triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
	});
	for (const mat of materials) withHighlight(mat);
	root.updateMatrixWorld(true);
	const rest = new Map();
	for (const [name, obj] of nodes) {
		const parent = obj.parent ? obj.parent.matrixWorld.clone() : new THREE.Matrix4();
		rest.set(name, { local: obj.matrix.clone(), parent, parentInv: parent.clone().invert(), visible: obj.visible });
	}
	let clip = null;
	const wanted = m.action?.clip;
	if (gltf.animations.length && (wanted || !m.action)) {
		const anim = wanted ? gltf.animations.find((/** @type {any} */ a) => a.name === wanted) : gltf.animations[0];
		if (anim) {
			const mixer = new THREE.AnimationMixer(root);
			mixer.clipAction(anim).play();
			clip = { mixer, name: anim.name || 'Animation', duration: anim.duration };
		}
	}
	return { root, meshes, nodes, rest, triangles, clip };
}

/** @type {Map<string, { key: string, promise: Promise<any> }>} */
const cache = new Map();
/** A model's files and their revisions: a new key means the files must be fetched again. @param {Model} m */
const filesKey = (m) =>
	[m.file, m.lod, m.maps?.color, m.maps?.orm, m.maps?.normal]
		.filter(Boolean)
		.map((f) => `${f}@${S.revs[/** @type {string} */ (f)] || ''}`)
		.join('|') + JSON.stringify(m.maps || {});
/** A model loaded once per revision of its files. @param {Model} m */
function load(m) {
	const key = filesKey(m);
	const hit = cache.get(m.id);
	if (hit && hit.key === key) return hit.promise;
	const promise = (async () => {
		const mapsMat = m.maps && (m.maps.color || m.maps.orm || m.maps.normal) ? await mapsMaterial(m.maps) : null;
		const [full, lod] = await Promise.all([fetchGlb(m.file).then((b) => loader.parseAsync(b, '')), m.lod ? fetchGlb(m.lod).then((b) => loader.parseAsync(b, '')) : null]);
		return { m, sets: { full: prepare(full, mapsMat, m), lod: lod ? prepare(lod, mapsMat, m) : null } };
	})();
	promise.catch(() => cache.delete(m.id));
	cache.set(m.id, { key, promise });
	return promise;
}

const currentSet = () => (S.cur ? S.cur.sets[S.lod && S.cur.sets.lod ? 'lod' : 'full'] : null);

// ---- surface, wireframe, light version ----

const wireMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.32, depthWrite: false });
const accent = () => new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c88a2c');

function applyLook() {
	if (!S.cur) return;
	channelMode.value = S.mode;
	for (const key of ['full', 'lod']) {
		const set = S.cur.sets[key];
		if (!set) continue;
		set.root.visible = (key === 'lod') === (S.lod && !!S.cur.sets.lod);
		for (const mesh of set.meshes) {
			const finished = mesh.userData.finished;
			mesh.material = S.mode === 0 ? finished : Array.isArray(finished) ? finished.map(channelOf) : channelOf(finished);
			if (S.wire && !mesh.userData.wire) {
				mesh.userData.wire = new THREE.LineSegments(new THREE.WireframeGeometry(mesh.geometry), wireMat);
				mesh.add(mesh.userData.wire);
			}
			if (mesh.userData.wire) mesh.userData.wire.visible = S.wire;
		}
	}
	wireMat.color.copy(accent());
	stageNote();
	redraw();
}

// (under the stage: the channel shown, else the spot pinned, else the mesh)
function stageNote(fresh = '') {
	const set = currentSet();
	if (!set) return;
	const pin = draftPin();
	const left = $('note-left');
	left.className = fresh ? 'fresh' : '';
	left.textContent = fresh || (S.mode ? LEGEND[S.mode] : pin ? `Pinned: ${whereText(pin)}` : `${S.lod ? 'Light version' : 'Full model'} · ${Math.round(set.triangles).toLocaleString('en-US')} triangles`);
}
$('note-right').textContent = finePointer ? 'Click to pin a note · drag to turn · scroll to zoom · right-drag to pan' : 'Tap to pin a note · drag to turn · pinch to zoom';

// ---- views ----

// (the three-quarter view looks mostly at the model's long side: glTF's front is +z, so a model longer in z than in
// x is seen from +x)
const PRESETS = /** @type {Record<string, (size: any) => number[]>} */ ({
	'Three-quarter': (size) => (size.z > size.x ? [1.25, 0.75, 0.85] : [0.85, 0.75, 1.25]),
	Front: () => [0, 0.06, 1],
	Side: () => [1, 0.06, 0],
	Top: () => [0, 1, 0.02],
});
/** The camera that frames the whole model (as it rests) seen from a direction. @param {number[]} dir */
function framed(dir) {
	const z = new THREE.Vector3(...dir).normalize();
	const x = new THREE.Vector3(0, 1, 0).cross(z).normalize();
	const y = z.clone().cross(x);
	const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * 0.94;
	const tanH = tanV * camera.aspect;
	const { box, center } = S.cur;
	let d = 0;
	for (let i = 0; i < 8; i++) {
		const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
		const depth = p.dot(z);
		d = Math.max(d, depth + Math.abs(p.dot(x)) / tanH, depth + Math.abs(p.dot(y)) / tanV);
	}
	return { pos: center.clone().addScaledVector(z, d), target: center.clone() };
}
/** @param {string} name */
function viewPose(name) {
	const custom = curModel()?.views?.[name];
	if (custom) return { pos: new THREE.Vector3(...custom.pos), target: new THREE.Vector3(...custom.target) };
	return framed((PRESETS[name] || PRESETS['Three-quarter'])(S.cur.size));
}
/** @param {{ pos: any, target: any }} to @param {boolean} [instant] */
function flyTo(to, instant) {
	if (instant || reduceMotion) {
		camera.position.copy(to.pos);
		controls.target.copy(to.target);
		S.tween = null;
		controls.update();
		redraw();
	} else S.tween = { t0: performance.now(), dur: 750, p0: camera.position.clone(), q0: controls.target.clone(), p1: to.pos.clone(), q1: to.target.clone() };
}
/** @param {string} name @param {boolean} [instant] */
function go(name, instant) {
	S.view = name;
	for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (b).dataset.view === name));
	if (S.cur) flyTo(viewPose(name), instant);
}
function buildViews() {
	const names = [...Object.keys(PRESETS), ...Object.keys(curModel()?.views || {})];
	if (!names.includes(S.view)) S.view = 'Three-quarter';
	$('views').replaceChildren(h('span', { class: 'label', id: 'views-label' }, 'View'), ...names.map((n) => h('button', { class: 'btn', type: 'button', 'data-view': n, 'aria-pressed': String(n === S.view), onclick: () => go(n) }, n)));
}

// ---- parts: the reviewer can hide any labelled part to see behind or inside it ----

function buildParts() {
	const m = curModel();
	const names = Object.keys(m?.parts || {}).filter((n) => S.cur.sets.full.nodes.has(n));
	$('parts').hidden = !names.length;
	$('parts').replaceChildren(
		h('span', { class: 'label', id: 'parts-label' }, 'Parts'),
		...names.map((n) => h('button', { class: 'btn sm part', type: 'button', 'aria-pressed': String(!S.hidden.has(n)), title: `Hide or show: ${m?.parts?.[n]}`, onclick: (/** @type {Event} */ e) => {
			if (S.hidden.has(n)) S.hidden.delete(n);
			else S.hidden.add(n);
			/** @type {HTMLElement} */ (e.currentTarget).setAttribute('aria-pressed', String(!S.hidden.has(n)));
			applyPose();
		} }, m?.parts?.[n])),
	);
}

// ---- the action, worked by hand: k runs from 0 (at rest) to 1, and stays wherever it's let go ----

const actionOf = () => curModel()?.action || (S.cur?.sets.full.clip ? { name: 'Animation', clip: S.cur.sets.full.clip.name } : null);
const _m = new THREE.Matrix4();
const _d = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _t = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);

function applyPose() {
	if (!S.cur) return;
	const action = actionOf();
	const pose = action && !action.clip ? poseAt(action, S.k) : null;
	for (const key of ['full', 'lod']) {
		const set = S.cur.sets[key];
		if (!set) continue;
		if (set.clip) set.clip.mixer.setTime(Math.min(S.k * set.clip.duration, set.clip.duration - 1e-4));
		// (a part's motion is given in the model's frame at rest; carried into its parent's rest frame, so a child
		// part rides on its parent's motion through the GLB's own hierarchy)
		for (const [name, tf] of pose?.transforms || []) {
			const node = set.nodes.get(name);
			const rest = set.rest.get(name);
			if (!node) continue;
			_d.compose(_t.fromArray(tf.t), _q.fromArray(tf.q), ONE);
			_m.copy(rest.parentInv).multiply(_d).multiply(rest.parent).multiply(rest.local);
			_m.decompose(node.position, node.quaternion, node.scale);
		}
		for (const [name, rest] of set.rest) {
			const shown = pose?.visible.get(name);
			set.nodes.get(name).visible = rest.visible && shown !== false && !S.hidden.has(name);
		}
	}
	$('act').value = String(Math.round(S.k * 1000));
	$('act-read').replaceChildren(...poseWords());
	redraw();
}
function poseWords() {
	const action = actionOf();
	if (!action) return [];
	const { state, moves } = describePose(action, S.k, partLabel);
	return [h('b', {}, state || `${Math.round(S.k * 100)}%`), moves.length ? ` · ${moves.join(', ')}` : ''];
}
function setupAction() {
	const action = actionOf();
	$('action-bar').hidden = !action;
	if (action) $('act-label').textContent = action.name || 'Action';
	stopPlay();
}
const easeInOut = (/** @type {number} */ u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
// (played for the eye: out to fully worked, a beat, and home again; from fully worked, just home)
function startPlay() {
	if (!actionOf()) return;
	const k = S.k;
	const pts = k > 0.999 ? [[1, 0], [0, 1]] : [[k, 0], [1, 0.45], [1, 0.55], [0, 1]];
	S.play = { t0: performance.now(), dur: +$('speed').value * (k > 0.999 ? 0.5 : 1), pts };
	$('play').setAttribute('aria-pressed', 'true');
	$('play').textContent = 'Pause';
}
function stopPlay() {
	S.play = null;
	$('play').setAttribute('aria-pressed', 'false');
	$('play').textContent = 'Play';
}
/** The model's size at rest, and the space it takes up through its action (at rest and four poses on to fully
 * worked), which the camera frames so that no pose leaves the picture. */
function reach() {
	const k = S.k;
	const boxAt = (/** @type {number} */ at) => {
		S.k = at;
		applyPose();
		return new THREE.Box3().setFromObject(S.cur.sets.full.root);
	};
	const rest = boxAt(0);
	const box = rest.clone();
	if (actionOf()) for (const at of [0.25, 0.5, 0.75, 1]) box.union(boxAt(at));
	S.k = k;
	applyPose();
	const size = rest.getSize(new THREE.Vector3());
	return { box, size, center: box.getCenter(new THREE.Vector3()), span: Math.max(size.x, size.y, size.z) || 1, radius: size.length() / 2 || 1 };
}
/** @param {number} now */
function playAt(now) {
	const play = /** @type {NonNullable<typeof S.play>} */ (S.play);
	const t = Math.min(1, (now - play.t0) / play.dur);
	let i = 1;
	while (i < play.pts.length - 1 && t > play.pts[i][1]) i++;
	const [k0, t0] = play.pts[i - 1];
	const [k1, t1] = play.pts[i];
	S.k = k0 + (k1 - k0) * easeInOut(t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 1);
	applyPose();
	if (t >= 1) stopPlay();
}
$('play').addEventListener('click', () => (S.play ? stopPlay() : startPlay()));
$('act').addEventListener('input', (/** @type {Event} */ e) => {
	stopPlay();
	S.k = +(/** @type {HTMLInputElement} */ (e.target).value) / 1000;
	applyPose();
});
for (const [id, step] of /** @type {[string, number][]} */ ([['act-back', -0.01], ['act-fwd', 0.01]])) {
	$(id).addEventListener('click', () => {
		stopPlay();
		S.k = Math.min(1, Math.max(0, Math.round((S.k + step) * 100) / 100));
		applyPose();
	});
}

// ---- controls ----

for (const b of document.querySelectorAll('[data-mode]')) {
	b.addEventListener('click', () => {
		S.mode = +(/** @type {HTMLElement} */ (b).dataset.mode || 0);
		for (const x of document.querySelectorAll('[data-mode]')) x.setAttribute('aria-pressed', String(x === b));
		applyLook();
	});
}
$('wire').addEventListener('click', (/** @type {Event} */ e) => {
	S.wire = !S.wire;
	/** @type {HTMLElement} */ (e.currentTarget).setAttribute('aria-pressed', String(S.wire));
	applyLook();
});
$('lod').addEventListener('click', (/** @type {Event} */ e) => {
	S.lod = !S.lod;
	/** @type {HTMLElement} */ (e.currentTarget).setAttribute('aria-pressed', String(S.lod));
	applyLook();
	buildPins();
});
const themeChanged = () => {
	wireMat.color.copy(accent());
	redraw();
};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeChanged);
new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ---- showing a model ----

function buildPicker() {
	const models = S.project?.models || [];
	const groups = [...new Set(models.map((m) => m.group || ''))];
	const tab = (/** @type {Model} */ m) => h('button', { class: 'tab', role: 'tab', type: 'button', id: `tab-${m.id}`, 'data-id': m.id, 'aria-selected': String(m.id === S.modelId), onclick: () => show(m.id) }, h('b', {}, m.name), h('small', {}, ''));
	$('picker').hidden = models.length < 2;
	$('picker').replaceChildren(
		...groups.map((g) => h('div', { class: 'group-row' }, g ? h('span', { class: 'group-name' }, g) : null, h('div', { class: 'row', role: 'tablist', 'aria-label': g || 'Models' }, models.filter((m) => (m.group || '') === g).map(tab)))),
	);
	renderTabs();
}

/** @param {Model} m */
function renderSheet(m) {
	$('name').textContent = m.name;
	$('lede').textContent = m.info?.lede || S.project?.description || '';
	document.title = `${m.name} · ${S.project?.title || 'Model review'}`;
	const facts = [...(m.info?.facts || [])];
	if (S.cur?.m === m) {
		const s = S.cur.size;
		facts.push(['Bounds', `${fmtLen(s.x)} × ${fmtLen(s.y)} × ${fmtLen(s.z)} (x, y, z)`]);
		facts.push(['Triangles', Math.round(S.cur.sets.full.triangles).toLocaleString('en-US') + (S.cur.sets.lod ? `; light version ${Math.round(S.cur.sets.lod.triangles).toLocaleString('en-US')}` : '')]);
	}
	$('facts').replaceChildren(...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
	$('made').replaceChildren(...(m.info?.notes || []).map((n) => h('li', {}, n)));
	$('sources').replaceChildren(...((m.info?.sources || []).length ? [h('p', {}, h('b', {}, 'Sources')), ...(m.info?.sources || []).map((s) => h('p', {}, s))] : []));
	$('about').hidden = !(m.info?.notes?.length || m.info?.sources?.length);
	$('sheet').hidden = !facts.length && $('about').hidden;
}

/**
 * Put a model on the stage. `reload` keeps the camera, pose and selection: the model's files or description changed.
 * @param {string} id @param {{ reload?: boolean }} [options]
 */
async function show(id, { reload = false } = {}) {
	const m = modelById(id) || S.project?.models[0];
	if (!m) {
		veil('No models yet', 'Add one with: model-review add <project> <file.glb>');
		return;
	}
	S.modelId = m.id;
	for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(/** @type {HTMLElement} */ (t).dataset.id === m.id));
	renderSheet(m);
	if (!reload) veil(m.name, 'Loading the model…');
	try {
		const next = await load(m);
		if (S.modelId !== m.id) return; // another tab was chosen meanwhile
		const same = S.cur?.m.id === m.id;
		if (S.cur) {
			scene.remove(S.cur.sets.full.root);
			if (S.cur.sets.lod) scene.remove(S.cur.sets.lod.root);
		}
		S.cur = next;
		S.cur.m = m; // (the project's latest description of it)
		scene.add(next.sets.full.root);
		if (next.sets.lod) scene.add(next.sets.lod.root);
		if (!(reload && same)) {
			S.hidden = new Set();
			S.k = 0;
			R.sel = null;
		}
		setupAction();
		Object.assign(next, reach());
		const { center: c, size: sz, span, radius } = next;
		floor.position.set(c.x, next.box.min.y - span * 0.004, c.z);
		floor.scale.set(sz.x * 1.25 + span * 0.25, sz.z * 1.25 + span * 0.25, 1);
		keyLight.target.position.copy(c);
		keyLight.position.copy(c).add(new THREE.Vector3(1.2, 3.2, 1).multiplyScalar(span));
		rimLight.position.copy(c).add(new THREE.Vector3(-1.5, 1.2, -1.8).multiplyScalar(span));
		camera.near = radius / 200;
		camera.far = radius * 80;
		camera.updateProjectionMatrix();
		controls.minDistance = radius * 0.08;
		controls.maxDistance = radius * 12;
		$('lod').disabled = !next.sets.lod;
		if (!next.sets.lod) S.lod = false;
		$('lod').setAttribute('aria-pressed', String(S.lod));
		buildViews();
		buildParts();
		applyPose();
		applyLook();
		renderSheet(m);
		if (!(reload && same)) go(S.view, true);
		$('veil').hidden = true;
		if (reload && same) {
			stageNote('Updated just now: the model’s files or description changed');
			setTimeout(() => stageNote(), 6000);
		}
		// (a pin being placed belongs to the model it was placed on; the note's words stay)
		if (R.draft.pin && R.draft.pin.model !== m.id) R.draft.pin = null;
		if (R.draft.editing && !R.notes.some((n) => n.id === R.draft.editing && n.model === m.id)) clearDraft(false);
		renderReview();
		try {
			history.replaceState(null, '', `#${m.id}`);
		} catch {
			// (some frames refuse; the hash is only a convenience)
		}
	} catch (e) {
		console.error(e);
		veil(`Couldn’t load ${m.name}`, String(/** @type {Error} */ (e).message || e));
	}
}

// ---- the frame loop ----

/** @param {number} now */
function frame(now) {
	requestAnimationFrame(frame);
	if (S.tween) {
		const u = Math.min(1, (now - S.tween.t0) / S.tween.dur);
		const e = easeInOut(u);
		camera.position.lerpVectors(S.tween.p0, S.tween.p1, e);
		controls.target.lerpVectors(S.tween.q0, S.tween.q1, e);
		if (u >= 1) S.tween = null;
		redraw();
	}
	if (S.play && S.cur) playAt(now);
	if (controls.update()) dirty = true;
	if (dirty) {
		highlight();
		renderer.render(scene, camera);
		placePins();
		dirty = false;
	}
}

// ---- the review: pins on the model ----

const pinsEl = h('div', { class: 'pins' });
stage.append(pinsEl);

/** The area round a spot runs from 1/500 to 1/5 of the model's size, in even steps by ratio. */
const areaRange = () => {
	const span = S.cur?.span || 1;
	return [span / 500, span / 5];
};
const radiusOf = (/** @type {number} */ v) => {
	const [lo, hi] = areaRange();
	return sig(lo * Math.pow(hi / lo, v / 100));
};
const sliderOf = (/** @type {number} */ r) => {
	const [lo, hi] = areaRange();
	return Math.round((100 * Math.log(r / lo)) / Math.log(hi / lo));
};
const defaultRadius = () => sig((S.cur?.span || 1) / 60);

/** @param {{ node: string | null, world: number[] | null, radius: number | null }} n */
function whereText(n) {
	if (!n.node && !n.world) return 'On the whole model';
	const w = n.world || [0, 0, 0];
	return `${partLabel(n.node)} · x ${fmtLen(w[0])}, y ${fmtLen(w[1])}, z ${fmtLen(w[2])}${n.radius ? ` · ${fmtLen(n.radius)} round` : ''}`;
}
const modelNotes = (/** @type {string} */ id) => R.notes.filter((n) => n.model === id).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
const draftPin = () => (R.draft.pin && R.draft.pin.model === S.modelId ? R.draft.pin : null);
function activePin() {
	const draft = draftPin();
	if (draft) return draft;
	const n = R.sel ? R.notes.find((x) => x.id === R.sel) : null;
	return n && n.model === S.modelId && n.world ? n : null;
}
/** Where a pin is now: its spot in its node's frame, carried by the node as posed. @param {any} p */
function pinWorld(p) {
	const node = p.node && currentSet()?.nodes.get(p.node);
	if (node && p.local) return node.localToWorld(new THREE.Vector3().fromArray(p.local));
	return new THREE.Vector3().fromArray(p.world || [0, 0, 0]);
}
function highlight() {
	const p = activePin();
	HL.hlR.value = p ? p.radius || defaultRadius() : 0;
	if (p) HL.hlP.value.copy(pinWorld(p));
}

function buildPins() {
	pinsEl.replaceChildren();
	if (!S.cur) return;
	const list = modelNotes(S.modelId);
	list.forEach((n, i) => {
		if (!n.world || n.id === R.draft.editing) return;
		const state = noteState(n);
		const b = h('button', { type: 'button', class: `pin${n.id === R.sel ? ' sel' : ''}${state === 'resolved' ? ' done' : ''}${state === 'addressed' ? ' addressed' : ''}`, 'aria-label': `Note ${i + 1}, ${state}: ${n.text ? n.text.slice(0, 80) : 'images'}`, onclick: () => showNote(n.id, true) }, String(i + 1));
		/** @type {any} */ (b)._pin = n;
		pinsEl.append(b);
	});
	const draft = draftPin();
	if (draft) {
		const editing = R.draft.editing ? list.findIndex((n) => n.id === R.draft.editing) + 1 : 0;
		const b = h('button', { type: 'button', class: 'pin draft', 'aria-label': 'The spot pinned for the note you are writing', onclick: () => $('fb-text').focus() }, editing ? String(editing) : '+');
		/** @type {any} */ (b)._pin = draft;
		pinsEl.append(b);
	}
	placePins();
}
const _v = new THREE.Vector3();
function placePins() {
	if (!S.cur || !pinsEl.children.length) return;
	const w = stage.clientWidth;
	const hgt = stage.clientHeight;
	for (const el of /** @type {any[]} */ ([...pinsEl.children])) {
		_v.copy(pinWorld(el._pin)).project(camera);
		const visible = _v.z < 1 && Math.abs(_v.x) <= 1.02 && Math.abs(_v.y) <= 1.02;
		el.hidden = !visible;
		if (visible) {
			el.style.left = `${((_v.x + 1) / 2) * w}px`;
			el.style.top = `${((1 - _v.y) / 2) * hgt}px`;
		}
	}
}

// ---- pinning: a click (not a drag) on the model puts the note on that spot; another click moves it ----

addEventListener('keydown', (e) => {
	if (e.key !== 'Escape' || $('lightbox').open) return;
	if (R.draft.pin && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) unpin();
});
/** @type {{ x: number, y: number, button: number } | null} */
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (/** @type {PointerEvent} */ e) => {
	downAt = e.isPrimary ? { x: e.clientX, y: e.clientY, button: e.button } : null;
});
renderer.domElement.addEventListener('pointerup', (/** @type {PointerEvent} */ e) => {
	const d = downAt;
	downAt = null;
	if (!d || d.button !== 0 || !S.cur || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
	if (!R.connected || !R.canWrite) return;
	const r = renderer.domElement.getBoundingClientRect();
	const ray = new THREE.Raycaster();
	ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
	const set = currentSet();
	const shown = (/** @type {any} */ o) => {
		for (let x = o; x; x = x.parent) if (!x.visible) return false;
		return true;
	};
	const hit = ray.intersectObjects(set.meshes.filter(shown), false)[0];
	if (!hit) return; // (a click off the model leaves the pin where it was)
	let node = hit.object;
	while (node && !node.userData.node && node !== set.root) node = node.parent;
	const named = node && node.userData.node ? node : null;
	const old = R.draft.pin;
	const editing = R.draft.editing ? R.notes.find((n) => n.id === R.draft.editing) : null;
	R.draft.pin = {
		model: S.modelId,
		node: named ? named.userData.node : null,
		local: named ? fixed(named.worldToLocal(hit.point.clone()).toArray()) : null,
		world: fixed(hit.point.toArray()),
		radius: old?.model === S.modelId && old.radius ? old.radius : editing?.radius || defaultRadius(),
	};
	if (R.draft.editing) R.draft.repin = true;
	composerHead();
	buildPins();
	stageNote();
	redraw();
	if (finePointer) $('fb-text').focus({ preventScroll: true });
	status(R.draft.editing ? 'Moved. Save the note to keep the new spot.' : 'Pinned. Set the area and the pose to show it, write the note, then save it. Click again to move it.');
});
function unpin() {
	R.draft.pin = null;
	R.draft.repin = !!R.draft.editing;
	composerHead();
	buildPins();
	stageNote();
	redraw();
}
$('fb-area').addEventListener('input', (/** @type {Event} */ e) => {
	const pin = R.draft.pin;
	if (!pin) return;
	pin.radius = radiusOf(+(/** @type {HTMLInputElement} */ (e.target).value));
	if (R.draft.editing) R.draft.reradius = true;
	composerHead();
	stageNote();
	redraw();
});

// ---- the composer ----

/** @param {string} [msg] @param {boolean} [err] */
function status(msg, err) {
	$('fb-status').textContent = msg || '';
	$('fb-status').classList.toggle('err', !!err);
}
function composerHead() {
	const d = R.draft;
	const list = modelNotes(S.modelId);
	const editingNo = d.editing ? list.findIndex((n) => n.id === d.editing) + 1 : 0;
	$('fb-title').textContent = editingNo ? `Editing note ${editingNo}` : 'New note';
	const pin = draftPin();
	const editingNote = d.editing ? R.notes.find((n) => n.id === d.editing) : null;
	$('fb-where').textContent = pin
		? `${whereText(pin)}. ${d.editing ? 'Click the model to move it.' : 'Click again to move it.'}`
		: editingNote && !d.repin
			? whereText(editingNote)
			: 'On the whole model. Click the model to pin the spot it’s about.';
	$('fb-area-row').hidden = !pin;
	if (pin) {
		$('fb-area').value = String(sliderOf(pin.radius || defaultRadius()));
		$('fb-area-val').textContent = `${fmtLen(pin.radius || defaultRadius())} round`;
	}
	$('fb-unpin').hidden = !pin;
	$('fb-snap-row').hidden = !R.canUpload || !!d.editing;
	$('fb-drop').hidden = !R.canUpload;
	$('fb-save').textContent = d.editing ? 'Save changes' : 'Save note';
}
function drawThumbs() {
	$('fb-thumbs').replaceChildren(
		...R.draft.images.map((im, i) =>
			h('div', { class: `fb-thumb${im.state === 'busy' ? ' busy' : ''}${im.state === 'bad' ? ' bad' : ''}` }, h('img', { src: im.url, alt: im.name }), h('button', { type: 'button', class: 'x', 'aria-label': `Remove ${im.name}`, onclick: () => removeDraftImage(i) }, '×')),
		),
	);
}
/** @param {number} i */
function removeDraftImage(i) {
	const [im] = R.draft.images.splice(i, 1);
	drawThumbs();
	// (uploaded for this draft and on no saved note yet: it goes now; one on a saved note goes when the note is saved)
	if (im?.id && !im.saved) R.store.deleteImage(im.id).catch(() => {});
}
/** An image the store will take as it is, else redrawn as a JPEG at most 4000 px across. @param {Blob} file */
async function storable(file) {
	if (IMAGE_TYPES.includes(file.type) && file.size <= 20 * 1024 * 1024) return file;
	const bmp = await createImageBitmap(file);
	const k = Math.min(1, 4000 / Math.max(bmp.width, bmp.height));
	const c = h('canvas', { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
	/** @type {CanvasRenderingContext2D} */ (c.getContext('2d')).drawImage(bmp, 0, 0, c.width, c.height);
	return new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('encode'))), 'image/jpeg', 0.9));
}
/** @param {any} e @param {string} name */
function uploadError(e, name) {
	const code = e?.code;
	if (code === 'too_large' || e?.status === 413) return `${name} is over 20 MB. Save it smaller and add it again.`;
	if (code === 'unsupported_type' || e?.status === 400) return `${name} isn’t a type that can be kept. Use JPEG, PNG, WebP or GIF.`;
	if (code === 'quota_or_state') return 'The image storage is full. Remove images from old notes to make room.';
	if (code === 'rate_limited') return 'Too many uploads at once. Wait a moment, then add the rest.';
	if (e?.message === 'encode' || e?.name === 'InvalidStateError' || e?.name === 'EncodingError') return `${name} couldn’t be read. Export it as JPEG or PNG and add it again.`;
	return `${name} didn’t upload: ${e?.message || 'try again'}.`;
}
/** @param {Iterable<File>} files */
async function addFiles(files) {
	if (!R.canUpload) return status('Only people who can edit this page can attach images.', true);
	const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(heic|heif|png|jpe?g|webp|gif|bmp|tiff?)$/i.test(f.name || ''));
	if (!list.length) return status('Those files aren’t images. Use JPEG, PNG, WebP or GIF.', true);
	for (const f of list) {
		/** @type {typeof R.draft.images[number]} */
		const im = { name: f.name || 'pasted image', url: URL.createObjectURL(f), state: 'busy', id: null, saved: false };
		R.draft.images.push(im);
		drawThumbs();
		try {
			im.id = await R.store.uploadImage(await storable(f));
			im.state = 'done';
		} catch (e) {
			im.state = 'bad';
			status(uploadError(e, im.name), true);
		}
		drawThumbs();
	}
	if (R.draft.images.every((im) => im.state === 'done')) status(`${R.draft.images.length} image${R.draft.images.length === 1 ? '' : 's'} ready.`);
}
$('fb-file').addEventListener('change', (/** @type {Event} */ e) => {
	const input = /** @type {HTMLInputElement} */ (e.target);
	addFiles(input.files || []);
	input.value = '';
});
for (const el of [$('fb-drop'), $('fb-form')]) {
	el.addEventListener('dragover', (/** @type {DragEvent} */ e) => {
		if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) {
			e.preventDefault();
			$('fb-drop').classList.add('over');
		}
	});
	el.addEventListener('dragleave', (/** @type {DragEvent} */ e) => {
		if (!el.contains(e.relatedTarget)) $('fb-drop').classList.remove('over');
	});
	el.addEventListener('drop', (/** @type {DragEvent} */ e) => {
		e.preventDefault();
		$('fb-drop').classList.remove('over');
		if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
	});
}
// (an image pasted anywhere on the page goes on the note being written)
addEventListener('paste', (e) => {
	const files = [...(e.clipboardData?.files || [])];
	if (!files.length || !R.canWrite || $('review-body').hidden) return;
	e.preventDefault();
	addFiles(files);
	$('fb-form').scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
});
$('fb-unpin').addEventListener('click', () => unpin());
$('fb-clear').addEventListener('click', () => clearDraft(true));
/** @param {boolean} dropImages */
function clearDraft(dropImages) {
	if (dropImages) for (const im of R.draft.images) if (im.id && !im.saved) R.store.deleteImage(im.id).catch(() => {});
	R.draft = newDraft();
	$('fb-text').value = '';
	drawThumbs();
	composerHead();
	buildPins();
	stageNote();
	redraw();
	status('');
}

/** What is on the stage, the pinned area lit, drawn over the stage's own ground. @param {any} pin @returns {Promise<Blob | null>} */
function snapshot(pin) {
	highlight();
	renderer.render(scene, camera);
	const src = renderer.domElement;
	const k = Math.min(1, 1600 / src.width);
	const c = h('canvas', { width: Math.round(src.width * k), height: Math.round(src.height * k) });
	const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
	const css = getComputedStyle(document.documentElement);
	const g = x.createRadialGradient(c.width / 2, c.height * 0.38, 0, c.width / 2, c.height * 0.38, c.width * 0.6);
	g.addColorStop(0, css.getPropertyValue('--stage-hi').trim() || '#fbfbf8');
	g.addColorStop(1, css.getPropertyValue('--stage-lo').trim() || '#c4c3bb');
	x.fillStyle = g;
	x.fillRect(0, 0, c.width, c.height);
	x.drawImage(src, 0, 0, c.width, c.height);
	if (pin) {
		// (an area too small to see at this distance is ringed as well)
		const at = pinWorld(pin);
		const side = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).multiplyScalar(pin.radius || 0);
		const edge = at.clone().add(side).project(camera);
		_v.copy(at).project(camera);
		const px = Math.hypot(((edge.x - _v.x) / 2) * c.width, ((edge.y - _v.y) / 2) * c.height);
		if (_v.z < 1 && px < 12) {
			const cx = ((_v.x + 1) / 2) * c.width;
			const cy = ((1 - _v.y) / 2) * c.height;
			const r = Math.max(14, c.width / 70);
			x.lineWidth = Math.max(3, r / 4);
			x.strokeStyle = '#ffffff';
			x.beginPath();
			x.arc(cx, cy, r + 2, 0, Math.PI * 2);
			x.stroke();
			x.strokeStyle = css.getPropertyValue('--accent').trim() || '#965800';
			x.beginPath();
			x.arc(cx, cy, r, 0, Math.PI * 2);
			x.stroke();
		}
	}
	return new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.86));
}
const viewNow = () => ({ pos: fixed(camera.position.toArray(), 4), target: fixed(controls.target.toArray(), 4) });
/** The pin and the pose it was made in, as a note keeps them. @param {any} pin */
const pinFields = (pin) => ({
	node: pin ? pin.node : null,
	local: pin ? pin.local : null,
	world: pin ? pin.world : null,
	radius: pin ? pin.radius : null,
	view: viewNow(),
	k: actionOf() ? +S.k.toFixed(3) : null,
	hidden: [...S.hidden],
});

$('fb-form').addEventListener('submit', async (/** @type {Event} */ e) => {
	e.preventDefault();
	if (!R.connected || !S.cur) return;
	if (CONFIG.mode !== 'artifact' && !R.store.me.name) {
		status('Say who you are first: your name goes on your notes.', true);
		return $('who-name').focus();
	}
	const d = R.draft;
	const text = $('fb-text').value.trim();
	if (d.images.some((im) => im.state === 'busy')) return status('Wait for the images to finish uploading.', true);
	const images = /** @type {string[]} */ (d.images.filter((im) => im.state === 'done' && im.id).map((im) => im.id));
	if (!text && !images.length) return status('Write a note or add an image first.', true);
	$('fb-save').disabled = true;
	status('Saving…');
	try {
		const pin = draftPin();
		if (d.editing) {
			const note = R.notes.find((n) => n.id === d.editing);
			if (!note) throw new Error('That note was deleted meanwhile.');
			/** @type {Record<string, any>} */
			const change = { text, images };
			if (d.repin) Object.assign(change, pinFields(pin));
			else if (d.reradius && pin) change.radius = pin.radius;
			await R.store.updateNote(note, change);
		} else {
			let shot = null;
			if (R.canUpload && $('fb-snap').checked) {
				try {
					const blob = await snapshot(pin);
					if (blob) shot = await R.store.uploadImage(blob);
				} catch (err) {
					console.warn('snapshot', err);
				}
			}
			await R.store.createNote({ model: S.modelId, text, images, snapshot: shot, ...pinFields(pin) });
		}
		for (const im of d.images) im.saved = true;
		clearDraft(false);
		status('Saved.');
	} catch (err) {
		status(saveError(err), true);
	} finally {
		$('fb-save').disabled = false;
	}
});
/** @param {any} err */
function saveError(err) {
	if (err?.code === 'conflict') return 'Someone changed this note while you were editing it, so your change wasn’t saved. The list shows their version; make your change again.';
	if (err?.code === 'quota_exceeded') return 'The note storage is full. Delete old notes to make room.';
	if (err?.code === 'invalid_argument') return 'This page is read-only for you, so the note wasn’t saved.';
	return `That didn’t save: ${err?.message || 'check the connection and press Save again'}.`;
}

// ---- who is writing (local mode; on claude.ai the platform says) ----

function renderWho() {
	const local = CONFIG.mode !== 'artifact';
	const name = R.store.me.name;
	$('who').hidden = !local || !R.canWrite || !!name;
	$('who-line').hidden = !local || !name;
	$('who-show').textContent = name;
}
$('who').addEventListener('submit', (/** @type {Event} */ e) => {
	e.preventDefault();
	const name = $('who-name').value.trim();
	if (!name) return $('who-name').focus();
	/** @type {any} */ (R.store).setName(name);
	renderWho();
	status(`Writing as ${name}.`);
});
$('who-change').addEventListener('click', () => {
	$('who-name').value = R.store.me.name;
	$('who').hidden = false;
	$('who-line').hidden = true;
	$('who-name').focus();
});

// ---- the notes ----

/** A person's name as this viewer sees it. @param {string | undefined} id */
function who(id) {
	if (!id) return 'Someone';
	const p = R.names[id];
	if (CONFIG.mode === 'artifact') return p?.isMe ? 'You' : p?.name || 'Someone';
	return id;
}
async function resolveNames() {
	const ids = [...new Set(R.notes.flatMap((n) => [n.author, ...n.replies.map((r) => r.user || '')]).filter(Boolean))];
	R.names = await R.store.names(ids);
}

function renderNotes() {
	if (!S.cur) return;
	const m = curModel();
	const list = modelNotes(S.modelId);
	const open = list.filter((n) => noteState(n) !== 'resolved').length;
	$('fb-count').textContent = list.length ? `Notes on ${m?.name} · ${open} unresolved` : `Notes on ${m?.name}`;
	$('fb-empty').hidden = !!list.length;
	$('fb-list').replaceChildren(...list.map((n, i) => noteCard(n, i + 1)));
}
/** @param {Note} n @param {number} no */
function noteCard(n, no) {
	const state = noteState(n);
	const chip = h('span', { class: `fb-chip ${state}` }, state === 'resolved' ? 'Fixed' : state === 'addressed' ? 'Addressed' : 'Open');
	const pose = curModel()?.action && typeof n.k === 'number' ? describePose(actionOf(), n.k, partLabel) : null;
	const images = [...n.images.map((id) => [id, '']), ...(n.snapshot ? [[n.snapshot, 'View']] : [])];
	const actions = h('div', { class: 'fb-actions' });
	const btn = (/** @type {string} */ label, /** @type {() => void} */ act, cls = 'btn sm') => actions.append(h('button', { type: 'button', class: cls, onclick: act }, label));
	if (n.world || n.view) btn('Show on the model', () => showNote(n.id, false));
	if (R.canWrite) {
		if (R.confirm === n.id) {
			actions.append(h('span', { class: 'fb-confirm' }, 'Delete this note and its images?'));
			btn('Delete', () => deleteNote(n));
			btn('Keep', () => {
				R.confirm = null;
				renderNotes();
			});
		} else {
			btn('Reply', () => {
				R.replying = n.id;
				renderNotes();
				document.querySelector(`#reply-${CSS.escape(n.id)}`)?.focus();
			});
			btn('Edit', () => editNote(n));
			btn(n.status === 'resolved' ? 'Reopen' : 'Mark fixed', () => setStatus(n, n.status === 'resolved' ? 'open' : 'resolved'));
			btn('Delete', () => {
				R.confirm = n.id;
				renderNotes();
			});
		}
	}
	const replyBox =
		R.replying === n.id
			? h(
					'form',
					{ class: 'reply-box', onsubmit: (/** @type {Event} */ e) => sendReply(e, n) },
					h('label', { class: 'label', for: `reply-${n.id}` }, 'Reply'),
					h('textarea', { id: `reply-${n.id}`, rows: 3, placeholder: 'Say what still looks wrong, or what you’d like instead' }),
					h('div', { class: 'fb-actions' }, h('button', { class: 'btn act', type: 'submit' }, 'Send reply'), h('button', { class: 'btn', type: 'button', onclick: () => { R.replying = null; renderNotes(); } }, 'Cancel')),
				)
			: null;
	return h(
		'li',
		{ class: `fb-card${state === 'resolved' ? ' done' : ''}`, 'data-id': n.id, 'aria-current': n.id === R.sel ? 'true' : null },
		h('span', { class: `fb-num${n.world ? '' : ' general'}`, 'aria-hidden': 'true' }, String(no)),
		h(
			'div',
			{ class: 'fb-main' },
			h('div', { class: 'fb-meta' }, chip, `${whereText(n)} · ${who(n.author)}, ${fmtTime(n.at)}${n.edited ? ' (edited)' : ''}`),
			pose ? h('div', { class: 'fb-meta' }, `Pose: ${[pose.state, pose.moves.join(', ')].filter(Boolean).join(' · ') || 'at rest'}`) : null,
			n.hidden?.length ? h('div', { class: 'fb-meta' }, `Hidden: ${n.hidden.map(partLabel).join(', ')}`) : null,
			n.text ? h('p', { class: 'fb-text' }, n.text) : null,
			images.length
				? h('div', { class: 'fb-imgs' }, images.map(([id, tag]) => h('button', { type: 'button', class: 'fb-thumb', 'aria-label': tag ? 'Open the snapshot of the view' : 'Open the reference image', onclick: () => openLightbox(R.store.imageUrl(id), tag ? `Note ${no}: the view as it was pinned` : `Note ${no}: reference image`) }, h('img', { src: R.store.imageUrl(id), alt: '', loading: 'lazy' }), tag ? h('small', {}, tag) : null)))
				: null,
			n.replies.map((r) => h('div', { class: `fb-reply${r.by === 'agent' ? ' agent' : ''}` }, h('div', {}, h('b', {}, r.by === 'agent' ? `${r.name || 'Agent'} · agent` : who(r.user || r.name)), h('time', { datetime: r.at }, fmtTime(r.at))), h('p', {}, r.text))),
			replyBox,
			actions,
		),
	);
}
/** @param {Event} e @param {Note} n */
async function sendReply(e, n) {
	e.preventDefault();
	const area = /** @type {HTMLTextAreaElement} */ (/** @type {HTMLFormElement} */ (e.target).querySelector('textarea'));
	const text = area.value.trim();
	if (!text) return area.focus();
	if (CONFIG.mode !== 'artifact' && !R.store.me.name) {
		status('Say who you are first: your name goes on your replies.', true);
		return $('who-name').focus();
	}
	try {
		await R.store.reply(n, text);
		R.replying = null;
		renderNotes();
	} catch (err) {
		status(saveError(err), true);
	}
}
/** @param {Note} n */
function editNote(n) {
	const pin = n.world ? { model: n.model, node: n.node, local: n.local, world: n.world, radius: n.radius || defaultRadius() } : null;
	R.draft = { ...newDraft(), pin, editing: n.id, images: n.images.map((id) => ({ id, url: R.store.imageUrl(id), state: /** @type {const} */ ('done'), saved: true, name: 'reference image' })) };
	$('fb-text').value = n.text || '';
	drawThumbs();
	composerHead();
	buildPins();
	stageNote();
	redraw();
	$('fb-text').focus();
	status('Change the note, or click the model to move its pin, then save it.');
}
/** @param {Note} n @param {'open' | 'resolved'} state */
async function setStatus(n, state) {
	try {
		await R.store.updateNote(n, { status: state });
	} catch (err) {
		status(saveError(err), true);
	}
}
/** @param {Note} n */
async function deleteNote(n) {
	R.confirm = null;
	try {
		await R.store.deleteNote(n);
		if (R.sel === n.id) R.sel = null;
	} catch (err) {
		status(saveError(err), true);
	}
	renderReview();
}
/** Show a note on the model: its pose, the parts it had hidden, and (unless its pin was clicked) its view. @param {string} id @param {boolean} fromPin */
function showNote(id, fromPin) {
	const n = R.notes.find((x) => x.id === id);
	if (!n) return;
	R.sel = id;
	if (typeof n.k === 'number' && actionOf()) {
		stopPlay();
		S.k = n.k;
	}
	S.hidden = new Set(n.hidden || []);
	buildParts();
	applyPose();
	if (n.view && !fromPin) {
		flyTo({ pos: new THREE.Vector3().fromArray(n.view.pos), target: new THREE.Vector3().fromArray(n.view.target) });
		stage.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
	}
	buildPins();
	renderNotes();
	if (fromPin) document.querySelector(`.fb-card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
	redraw();
}

// ---- verdicts, and the tabs that show them ----

for (const b of document.querySelectorAll('[data-verdict]')) {
	b.addEventListener('click', async () => {
		if (!R.connected || !S.cur) return;
		const v = /** @type {HTMLElement} */ (b).dataset.verdict;
		try {
			await R.store.setVerdict(S.modelId, R.verdicts[S.modelId]?.state === v ? null : /** @type {any} */ (v));
		} catch (err) {
			status(`The verdict didn’t save: ${/** @type {Error} */ (err).message}`, true);
		}
	});
}
function renderVerdict() {
	const v = R.verdicts[S.modelId]?.state || null;
	for (const b of document.querySelectorAll('[data-verdict]')) {
		b.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (b).dataset.verdict === v));
		/** @type {HTMLButtonElement} */ (b).disabled = !R.connected || !R.canWrite;
	}
}
function renderTabs() {
	for (const t of document.querySelectorAll('.tab')) {
		const id = /** @type {HTMLElement} */ (t).dataset.id || '';
		const v = R.verdicts[id]?.state;
		const open = R.notes.filter((n) => n.model === id && noteState(n) === 'open').length;
		const addressed = R.notes.filter((n) => n.model === id && noteState(n) === 'addressed').length;
		const counts = [open && `${open} open`, addressed && `${addressed} addressed`].filter(Boolean).join(', ');
		/** @type {HTMLElement} */ (t).dataset.state = v || (open ? 'notes' : '');
		const small = t.querySelector('small');
		if (small) small.textContent = [v === 'approved' ? 'Approved' : v === 'changes' ? 'Needs changes' : counts ? '' : 'Not reviewed yet', counts].filter(Boolean).join(' · ');
	}
}
function renderReview() {
	renderTabs();
	if (!S.cur) return;
	renderVerdict();
	if (!R.connected) return;
	composerHead();
	renderNotes();
	buildPins();
}

// ---- lightbox ----

/** @param {string} src @param {string} caption */
function openLightbox(src, caption) {
	const lb = $('lightbox');
	lb.querySelector('img').src = src;
	lb.querySelector('p').textContent = caption;
	lb.showModal();
}
$('lightbox').addEventListener('click', (/** @type {MouseEvent} */ e) => {
	if (e.target === $('lightbox') || /** @type {HTMLElement} */ (e.target).tagName === 'IMG') $('lightbox').close();
});

// ---- starting up: the project, then the notes ----

/** @param {{ project: any, revs: Record<string, string | null> }} state */
function projectChanged(state) {
	const before = curModel();
	S.project = state.project;
	S.revs = state.revs;
	$('project-title').textContent = state.project.title;
	buildPicker();
	const now = modelById(S.modelId);
	if (!now) return show(S.project?.models[0]?.id || '');
	// (the model on the stage reloads, keeping the camera and pose, if its files or its description changed)
	if (before && (JSON.stringify(now) !== JSON.stringify(before) || cache.get(now.id)?.key !== filesKey(now))) show(now.id, { reload: true });
}

async function connect() {
	if (CONFIG.mode === 'artifact' && !(/** @type {any} */ (window).claude?.use)) {
		$('review-off').textContent = 'Notes work when this page is opened in claude.ai, signed in.';
		return;
	}
	let access = null;
	try {
		access = await R.store.connect();
	} catch (e) {
		$('review-off').textContent = `The review server isn’t answering (${/** @type {Error} */ (e).message}). Is model-review serve still running?`;
		return;
	}
	if (!access) {
		$('review-off').textContent = 'Notes open once this page has connected to claude.ai. Open it there, signed in, to read and add them.';
		return;
	}
	R.canWrite = access.canWrite;
	R.canUpload = access.canUpload && access.canWrite;
	R.connected = true;
	$('review-off').hidden = true;
	$('review-body').hidden = false;
	$('fb-form').hidden = !R.canWrite;
	if (!R.canWrite) $('fb-empty').textContent = 'No notes on this model yet.';
	renderWho();
	R.store.subscribe({
		notes: async (notes) => {
			R.notes = notes;
			if (R.sel && !notes.some((n) => n.id === R.sel)) R.sel = null;
			await resolveNames();
			renderReview();
		},
		verdicts: (verdicts) => {
			R.verdicts = verdicts || {};
			renderReview();
		},
		project: projectChanged,
		status: (problem) => {
			$('review-off').hidden = !problem;
			if (problem) $('review-off').textContent = problem;
		},
	});
	renderReview();
}

async function start() {
	resize();
	requestAnimationFrame(frame);
	$('foot').textContent = CONFIG.mode === 'artifact' ? 'model-review · notes are kept with this page on claude.ai' : 'model-review · notes are kept in the project’s review folder';
	try {
		const state = CONFIG.mode === 'artifact' ? { project: CONFIG.project, revs: {} } : await /** @type {any} */ (R.store).project();
		S.project = state.project;
		S.revs = state.revs;
	} catch (e) {
		veil('Can’t open the project', `${/** @type {Error} */ (e).message}. Is model-review serve still running?`);
		return;
	}
	$('project-title').textContent = S.project?.title || 'Model review';
	const wanted = decodeURIComponent((location.hash || '').slice(1));
	S.modelId = modelById(wanted) ? wanted : S.project?.models[0]?.id || '';
	buildPicker();
	connect();
	await show(S.modelId);
}

start();
