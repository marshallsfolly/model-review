// A review project is a folder: project.json, the GLBs it lists, and review/ where the notes, images and verdicts are
// kept (lib/review.mjs). Paths in project.json are relative to the folder, so a project can be moved, zipped or
// committed to a repo as it is.

import { readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, extname, basename, sep, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readGlb, listNodes } from './glb.mjs';
import { validateAction } from '../app/action.js';

export const PROJECT_FILE = 'project.json';
/** Model ids: lowercase, short, safe in a URL's #anchor and a file name. */
export const MODEL_ID = /^[a-z0-9][a-z0-9._~-]{0,63}$/;
export const MAP_KINDS = /** @type {const} */ (['color', 'orm', 'normal']);
const MAP_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

/**
 * @typedef {[number, number, number]} Vec3
 * @typedef {object} Model
 * @property {string} id
 * @property {string} name
 * @property {string} [group]
 * @property {string} file   the GLB, relative to the project
 * @property {string} [lod]  a lighter GLB with the same node names
 * @property {{ color?: string, orm?: string, normal?: string, normalSpace?: 'tangent' | 'object' }} [maps]
 * @property {Record<string, string>} [parts]  GLB node name: label
 * @property {import('../app/action.js').Action} [action]
 * @property {{ lede?: string, facts?: [string, string][], notes?: string[], sources?: string[] }} [info]
 * @property {Record<string, { pos: Vec3, target: Vec3 }>} [views]
 * @typedef {{ title: string, description?: string, models: Model[] }} Project
 */

/** Write a file atomically: to a temporary name beside it, then renamed over it. @param {string} file @param {string | Buffer} data */
export function writeAtomic(file, data) {
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	writeFileSync(tmp, data);
	renameSync(tmp, file);
}

/** @param {string} dir */
export function isProject(dir) {
	return existsSync(join(dir, PROJECT_FILE));
}

/** @param {string} dir @returns {Project} */
export function loadProject(dir) {
	const file = join(dir, PROJECT_FILE);
	let data;
	try {
		data = JSON.parse(readFileSync(file, 'utf8'));
	} catch (e) {
		const err = /** @type {NodeJS.ErrnoException} */ (e);
		throw new Error(err.code === 'ENOENT' ? `${dir} has no ${PROJECT_FILE} (create one with: model-review init ${dir})` : `${file}: ${err.message}`);
	}
	const errors = validateProject(data);
	if (errors.length) throw new Error(`${file} has problems:\n  ${errors.join('\n  ')}`);
	return data;
}

/** @param {string} dir @param {Project} data */
export function saveProject(dir, data) {
	const errors = validateProject(data);
	if (errors.length) throw new Error(`not saved:\n  ${errors.join('\n  ')}`);
	writeAtomic(join(dir, PROJECT_FILE), JSON.stringify(data, null, '\t') + '\n');
}

/**
 * What is wrong with a project.json, if anything.
 * @param {any} data @returns {string[]}
 */
export function validateProject(data) {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return ['project.json must be an object'];
	const errors = [];
	const str = (/** @type {any} */ v) => typeof v === 'string';
	const vec = (/** @type {any} */ v) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
	const relPath = (/** @type {any} */ v) => str(v) && v.length > 0 && !isAbsolute(v) && !v.split(/[\\/]/).includes('..');
	if (!str(data.title)) errors.push('title must be a string');
	if (data.description !== undefined && !str(data.description)) errors.push('description must be a string');
	if (!Array.isArray(data.models)) return [...errors, 'models must be a list'];
	const ids = new Set();
	data.models.forEach((/** @type {any} */ m, /** @type {number} */ i) => {
		const at = `models[${i}]${m && str(m.id) ? ` (${m.id})` : ''}`;
		if (!m || typeof m !== 'object') return errors.push(`${at} must be an object`);
		if (!str(m.id) || !MODEL_ID.test(m.id)) errors.push(`${at}.id must be lowercase letters, digits, . _ ~ or -, starting with a letter or digit`);
		else if (ids.has(m.id)) errors.push(`${at}.id is used twice`);
		ids.add(m.id);
		if (!str(m.name) || !m.name.trim()) errors.push(`${at}.name must be a string`);
		if (m.group !== undefined && !str(m.group)) errors.push(`${at}.group must be a string`);
		if (!relPath(m.file)) errors.push(`${at}.file must be a path inside the project`);
		if (m.lod !== undefined && !relPath(m.lod)) errors.push(`${at}.lod must be a path inside the project`);
		if (m.maps !== undefined) {
			if (!m.maps || typeof m.maps !== 'object') errors.push(`${at}.maps must be an object`);
			else {
				for (const kind of MAP_KINDS) if (m.maps[kind] !== undefined && !relPath(m.maps[kind])) errors.push(`${at}.maps.${kind} must be a path inside the project`);
				if (m.maps.normalSpace !== undefined && !['tangent', 'object'].includes(m.maps.normalSpace)) errors.push(`${at}.maps.normalSpace must be 'tangent' or 'object'`);
			}
		}
		if (m.parts !== undefined && (!m.parts || typeof m.parts !== 'object' || Array.isArray(m.parts) || !Object.values(m.parts).every(str))) errors.push(`${at}.parts must map node names to labels`);
		errors.push(...validateAction(m.action).map((e) => `${at}.${e}`));
		if (m.info !== undefined) {
			const info = m.info;
			if (!info || typeof info !== 'object') errors.push(`${at}.info must be an object`);
			else {
				if (info.lede !== undefined && !str(info.lede)) errors.push(`${at}.info.lede must be a string`);
				if (info.facts !== undefined && (!Array.isArray(info.facts) || !info.facts.every((/** @type {any} */ f) => Array.isArray(f) && f.length === 2 && f.every(str)))) errors.push(`${at}.info.facts must be a list of [name, value]`);
				for (const key of ['notes', 'sources']) if (info[key] !== undefined && (!Array.isArray(info[key]) || !info[key].every(str))) errors.push(`${at}.info.${key} must be a list of strings`);
			}
		}
		if (m.views !== undefined) {
			if (!m.views || typeof m.views !== 'object' || Array.isArray(m.views)) errors.push(`${at}.views must map names to { pos, target }`);
			else for (const [name, v] of Object.entries(m.views)) if (!v || !vec(v.pos) || !vec(v.target)) errors.push(`${at}.views["${name}"] must be { pos: [x, y, z], target: [x, y, z] }`);
		}
	});
	return errors;
}

/**
 * Start a project in a folder (made if need be).
 * @param {string} dir @param {{ title?: string, description?: string }} [options]
 */
export function initProject(dir, { title, description } = {}) {
	mkdirSync(dir, { recursive: true });
	if (isProject(dir)) throw new Error(`${dir} already has a ${PROJECT_FILE}`);
	/** @type {Project} */
	const data = { title: title || basename(resolve(dir)), ...(description ? { description } : {}), models: [] };
	saveProject(dir, data);
	return data;
}

/**
 * The absolute path of a file given relative to the project, refusing any path that leaves it.
 * @param {string} dir @param {string} rel
 */
export function inside(dir, rel) {
	const root = resolve(dir);
	const full = resolve(root, rel);
	if (isAbsolute(rel) || (full !== root && !full.startsWith(root + sep))) throw new Error(`${rel} is outside the project`);
	return full;
}

/** The node names in a GLB file. @param {string} file */
export function nodeNames(file) {
	return listNodes(readGlb(readFileSync(file)).json).map((n) => n.name);
}

/** @param {string} text */
export function slug(text) {
	const s = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
	return s || 'model';
}

/** @param {string} text */
const titleCase = (text) => text.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());

/**
 * Add a model, or replace an existing model's files. Files outside the project are copied into its models/ folder;
 * a file already inside the project (an export written straight there) is listed where it is.
 * @param {string} dir
 * @param {{ file: string, id?: string, name?: string, group?: string, lod?: string, maps?: { color?: string, orm?: string, normal?: string, normalSpace?: 'tangent' | 'object' }, parts?: Record<string, string>, replace?: boolean }} options
 * @returns {{ model: Model, nodes: string[], warnings: string[], created: boolean }}
 */
export function addModel(dir, { file, id, name, group, lod, maps, parts, replace = false }) {
	const data = loadProject(dir);
	const root = resolve(dir);
	const src = resolve(file);
	if (!existsSync(src)) throw new Error(`${file} not found`);
	if (extname(src).toLowerCase() !== '.glb') throw new Error(`${file} is not a .glb file (export binary glTF)`);
	const nodes = nodeNames(src); // also checks that it is a GLB
	const modelId = id || slug(name || basename(src, extname(src)));
	if (!MODEL_ID.test(modelId)) throw new Error(`model id "${modelId}" must be lowercase letters, digits, . _ ~ or -`);
	const index = data.models.findIndex((m) => m.id === modelId);
	if (index >= 0 && !replace) throw new Error(`the project already has a model "${modelId}": pass replace (--replace) to give it new files, or choose another id`);
	const previous = index >= 0 ? data.models[index] : null;

	mkdirSync(join(root, 'models'), { recursive: true });
	const place = (/** @type {string} */ from, /** @type {string} */ as) => {
		const full = resolve(from);
		if (!existsSync(full)) throw new Error(`${from} not found`);
		if (full.startsWith(root + sep)) return relative(root, full).split(sep).join('/');
		const rel = `models/${as}${extname(full).toLowerCase()}`;
		copyFileSync(full, join(root, rel));
		return rel;
	};
	/** @type {Model} */
	const model = { ...(previous || {}), id: modelId, name: name || previous?.name || titleCase(basename(src, extname(src))), file: place(src, modelId) };
	if (group) model.group = group;
	const warnings = [];
	if (lod) {
		if (extname(lod).toLowerCase() !== '.glb') throw new Error(`${lod} is not a .glb file`);
		model.lod = place(lod, `${modelId}_lod`);
		const lodNodes = new Set(nodeNames(resolve(lod)));
		const missing = nodes.filter((n) => !lodNodes.has(n));
		if (missing.length) warnings.push(`the lighter version lacks nodes the full model has, so they won't move or take pins there: ${missing.slice(0, 8).join(', ')}`);
	}
	if (maps) {
		model.maps = { ...(previous?.maps || {}) };
		for (const kind of MAP_KINDS) {
			const map = maps[kind];
			if (!map) continue;
			if (!MAP_EXTENSIONS.includes(extname(map).toLowerCase())) throw new Error(`${map}: maps must be PNG, JPEG or WebP`);
			model.maps[kind] = place(map, `${modelId}_${kind}`);
		}
		if (maps.normalSpace) model.maps.normalSpace = maps.normalSpace;
	}
	if (parts) model.parts = { ...(previous?.parts || {}), ...parts };
	const known = new Set(nodes);
	const unknownParts = Object.keys(model.parts || {}).filter((p) => !known.has(p));
	if (unknownParts.length) warnings.push(`no nodes named ${unknownParts.map((p) => `"${p}"`).join(', ')} in the GLB (see its nodes with: model-review nodes ${file})`);
	const repeated = nodes.filter((n, i) => nodes.indexOf(n) !== i);
	if (repeated.length) warnings.push(`node names used more than once (pins and actions use the first): ${[...new Set(repeated)].slice(0, 8).join(', ')}`);
	const actionErrors = validateAction(model.action, nodes);
	if (actionErrors.length) warnings.push(`the model's action no longer fits the GLB: ${actionErrors.join('; ')}`);

	if (index >= 0) data.models[index] = model;
	else data.models.push(model);
	saveProject(dir, data);
	return { model, nodes, warnings, created: index < 0 };
}

/**
 * Change a model's description: its name, group, parts, action, info or views (null removes one). The action is
 * checked against the GLB's node names.
 * @param {string} dir @param {string} id @param {Partial<Record<'name' | 'group' | 'parts' | 'action' | 'info' | 'views' | 'maps', any>>} changes
 * @returns {{ model: Model, warnings: string[] }}
 */
export function updateModel(dir, id, changes) {
	const data = loadProject(dir);
	const model = data.models.find((m) => m.id === id);
	if (!model) throw new Error(`no model "${id}" in the project (it has: ${data.models.map((m) => m.id).join(', ') || 'none'})`);
	for (const key of /** @type {const} */ (['name', 'group', 'parts', 'action', 'info', 'views', 'maps'])) {
		if (!(key in changes)) continue;
		if (changes[key] === null) {
			if (key === 'name') throw new Error('a model must keep a name');
			delete model[key];
		} else model[key] = changes[key];
	}
	const nodes = nodeNames(inside(dir, model.file));
	const errors = validateAction(model.action, nodes);
	if (errors.length) throw new Error(`the action doesn't fit ${model.file}:\n  ${errors.join('\n  ')}`);
	const warnings = [];
	const unknownParts = Object.keys(model.parts || {}).filter((p) => !nodes.includes(p));
	if (unknownParts.length) warnings.push(`no nodes named ${unknownParts.map((p) => `"${p}"`).join(', ')} in ${model.file}`);
	saveProject(dir, data);
	return { model, warnings };
}

/** Every file a project's models use, relative to the project. @param {Project} data */
export function modelFiles(data) {
	return data.models.flatMap((m) => [m.file, m.lod, m.maps?.color, m.maps?.orm, m.maps?.normal].filter((f) => typeof f === 'string'));
}
