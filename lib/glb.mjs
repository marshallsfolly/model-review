// Minimal GLB (binary glTF 2.0) reading and writing: enough to list a model's nodes, and to build the
// example's flat-coloured models without any dependency.

const MAGIC = 0x46546c67; // 'glTF'
const JSON_CHUNK = 0x4e4f534a; // 'JSON'
const BIN_CHUNK = 0x004e4942; // 'BIN\0'
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

/**
 * Split a GLB into its JSON document and its binary chunk.
 * @param {Buffer} buf
 * @returns {{ json: any, bin: Buffer | null }}
 */
export function readGlb(buf) {
	if (buf.length < 20 || buf.readUInt32LE(0) !== MAGIC) throw new Error('not a GLB file (no glTF magic number)');
	const version = buf.readUInt32LE(4);
	if (version !== 2) throw new Error(`GLB version ${version} is not supported (only 2)`);
	const total = Math.min(buf.readUInt32LE(8), buf.length);
	let json = null;
	let bin = null;
	for (let at = 12; at + 8 <= total; ) {
		const length = buf.readUInt32LE(at);
		const type = buf.readUInt32LE(at + 4);
		const body = buf.subarray(at + 8, at + 8 + length);
		if (type === JSON_CHUNK) json = JSON.parse(body.toString('utf8'));
		else if (type === BIN_CHUNK && !bin) bin = body;
		at += 8 + length;
	}
	if (!json) throw new Error('GLB has no JSON chunk');
	return { json, bin };
}

/**
 * @typedef {object} NodeInfo
 * @property {number} index
 * @property {string} name   the node's name, or `node<index>` when it has none (the viewer uses the same rule)
 * @property {string | null} parent
 * @property {number} depth
 * @property {boolean} mesh  whether the node draws a mesh itself
 * @property {string} path   its names from the scene root down, joined with ' / '
 */

/**
 * The nodes of a glTF document, in document order.
 * @param {any} json
 * @returns {NodeInfo[]}
 */
export function listNodes(json) {
	const nodes = json.nodes || [];
	const parent = new Array(nodes.length).fill(-1);
	nodes.forEach((n, i) => (n.children || []).forEach((/** @type {number} */ c) => (parent[c] = i)));
	const name = (/** @type {number} */ i) => nodes[i].name || `node${i}`;
	return nodes.map((n, i) => {
		const path = [];
		for (let j = i; j >= 0; j = parent[j]) path.unshift(name(j));
		return { index: i, name: name(i), parent: parent[i] >= 0 ? name(parent[i]) : null, depth: path.length - 1, mesh: n.mesh !== undefined, path: path.join(' / ') };
	});
}

/**
 * @typedef {object} MaterialSpec
 * @property {string} name
 * @property {number[]} color      linear RGB or RGBA, 0..1
 * @property {number} [metallic]   default 0
 * @property {number} [roughness]  default 0.6
 *
 * @typedef {object} PrimitiveSpec
 * @property {number[]} positions  xyz triples, in the node's own frame
 * @property {number[]} normals
 * @property {number[]} [uvs]
 * @property {number[]} indices    counter-clockwise triangles seen from outside
 * @property {number} material     index into the materials
 *
 * @typedef {object} NodeSpec
 * @property {string} name
 * @property {number[]} [translation]
 * @property {number[]} [rotation]  a quaternion, xyzw
 * @property {PrimitiveSpec[]} [primitives]
 * @property {NodeSpec[]} [children]
 */

/**
 * Build a GLB from nodes of flat-coloured PBR primitives.
 * @param {{ materials: MaterialSpec[], nodes: NodeSpec[], generator?: string }} doc
 * @returns {Buffer}
 */
export function writeGlb({ materials, nodes, generator = 'model-review' }) {
	/** @type {any} */
	const json = {
		asset: { version: '2.0', generator },
		scene: 0,
		scenes: [{ nodes: [] }],
		nodes: [],
		meshes: [],
		materials: materials.map((m) => ({
			name: m.name,
			pbrMetallicRoughness: {
				baseColorFactor: m.color.length === 4 ? m.color : [...m.color, 1],
				metallicFactor: m.metallic ?? 0,
				roughnessFactor: m.roughness ?? 0.6,
			},
		})),
		accessors: [],
		bufferViews: [],
		buffers: [],
	};
	/** @type {Buffer[]} */
	const chunks = [];
	let length = 0;
	/** @param {Float32Array | Uint16Array | Uint32Array} typed @param {number} target */
	const bufferView = (typed, target) => {
		const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
		json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, target });
		chunks.push(bytes);
		length += bytes.length;
		const pad = (4 - (length % 4)) % 4;
		if (pad) {
			chunks.push(Buffer.alloc(pad));
			length += pad;
		}
		return json.bufferViews.length - 1;
	};
	/** @param {number[]} values @param {'VEC2' | 'VEC3'} type @param {boolean} [bounds] */
	const floats = (values, type, bounds = false) => {
		const size = type === 'VEC2' ? 2 : 3;
		/** @type {any} */
		const accessor = { bufferView: bufferView(new Float32Array(values), ARRAY_BUFFER), componentType: FLOAT, count: values.length / size, type };
		if (bounds) {
			accessor.min = [Infinity, Infinity, Infinity];
			accessor.max = [-Infinity, -Infinity, -Infinity];
			for (let i = 0; i < values.length; i++) {
				accessor.min[i % 3] = Math.min(accessor.min[i % 3], values[i]);
				accessor.max[i % 3] = Math.max(accessor.max[i % 3], values[i]);
			}
		}
		json.accessors.push(accessor);
		return json.accessors.length - 1;
	};
	/** @param {number[]} indices @param {number} vertexCount */
	const indexAccessor = (indices, vertexCount) => {
		const wide = vertexCount > 65535;
		const typed = wide ? new Uint32Array(indices) : new Uint16Array(indices);
		json.accessors.push({ bufferView: bufferView(typed, ELEMENT_ARRAY_BUFFER), componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT, count: indices.length, type: 'SCALAR' });
		return json.accessors.length - 1;
	};
	/** @param {NodeSpec} spec @returns {number} */
	const addNode = (spec) => {
		/** @type {any} */
		const node = { name: spec.name };
		const index = json.nodes.length;
		json.nodes.push(node);
		if (spec.translation) node.translation = spec.translation;
		if (spec.rotation) node.rotation = spec.rotation;
		if (spec.primitives?.length) {
			node.mesh = json.meshes.length;
			json.meshes.push({
				name: spec.name,
				primitives: spec.primitives.map((p) => {
					/** @type {any} */
					const attributes = { POSITION: floats(p.positions, 'VEC3', true), NORMAL: floats(p.normals, 'VEC3') };
					if (p.uvs) attributes.TEXCOORD_0 = floats(p.uvs, 'VEC2');
					return { attributes, indices: indexAccessor(p.indices, p.positions.length / 3), material: p.material };
				}),
			});
		}
		if (spec.children?.length) node.children = spec.children.map(addNode);
		return index;
	};
	json.scenes[0].nodes = nodes.map(addNode);
	json.buffers.push({ byteLength: length });

	const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
	const jsonPad = Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20);
	const bin = Buffer.concat(chunks);
	const header = Buffer.alloc(12);
	const jsonHead = Buffer.alloc(8);
	const binHead = Buffer.alloc(8);
	jsonHead.writeUInt32LE(jsonBytes.length + jsonPad.length, 0);
	jsonHead.writeUInt32LE(JSON_CHUNK, 4);
	binHead.writeUInt32LE(bin.length, 0);
	binHead.writeUInt32LE(BIN_CHUNK, 4);
	header.writeUInt32LE(MAGIC, 0);
	header.writeUInt32LE(2, 4);
	header.writeUInt32LE(12 + 8 + jsonBytes.length + jsonPad.length + 8 + bin.length, 8);
	return Buffer.concat([header, jsonHead, jsonBytes, jsonPad, binHead, bin]);
}
