// Artifact mode: the same review page published on claude.ai, its notes kept by the Artifact runtime (db, assets,
// user). exportArtifact builds the page and its files for the Artifact tool's publish; importArtifact merges what
// the artifact's database and assets held back into the project.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, inside, writeAtomic, MAP_KINDS, MODEL_ID } from './project.mjs';
import { Review, cleanFields, sniffImage, IMAGE_TYPES, NOTE_ID, IMAGE_ID } from './review.mjs';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
/** What the page asks of the claude.ai runtime: a database for notes and verdicts, images, and who is looking. */
export const ARTIFACT_CAPABILITIES = { db: {}, assets: {}, user: { scopes: ['profile'] } };
const FILE_LIMIT = 16 * 1024 * 1024; // the Artifact tool's limit for the page and for each text file
const PUBLISH_FILES = 255; // files one publish can send

const IMPORT = /^import\s*\{([^}]*)\}\s*from\s*'\.\/([\w.-]+\.js)';?[ \t]*$/gm;
const EXPORT = /^export\s+(?:async\s+)?(?:function\*?|class|const|let)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * The page's ES modules as one classic script. Each module's body runs in its own function scope and returns its
 * exports; each import becomes a destructuring of the module it names. It understands the two forms the page uses:
 * `import { a, b as c } from './x.js';` and `export function|class|const|let name`.
 * @param {string} entry @param {string} [dir]
 */
export function bundle(entry, dir = APP_DIR) {
	/** @type {{ file: string, src: string }[]} */
	const order = [];
	const seen = new Set();
	const visit = (/** @type {string} */ file) => {
		if (seen.has(file)) return;
		seen.add(file);
		const src = readFileSync(join(dir, file), 'utf8');
		for (const m of src.matchAll(IMPORT)) visit(m[2]);
		order.push({ file, src });
	};
	visit(entry);
	const scope = (/** @type {string} */ file) => `module_${file.replace(/\W/g, '_')}`;
	const modules = order.map(({ file, src }) => {
		const exported = [...src.matchAll(EXPORT)].map((m) => m[1]);
		const body = src
			.replace(IMPORT, (_, names, from) => `const { ${names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': ')).join(', ')} } = ${scope(from)};`)
			.replace(/^export\s+/gm, '');
		return `const ${scope(file)} = (() => {\n${body}\nreturn { ${exported.join(', ')} };\n})();`;
	});
	return `(() => {\n'use strict';\n${modules.join('\n')}\n})();`;
}

/** @param {string} s */
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * The review page as an Artifact page: no document skeleton (the publish adds it), the title first, the styles and
 * scripts inline, the project embedded.
 * @param {{ mode: 'artifact', project: any }} config
 */
export function artifactPage(config) {
	const html = readFileSync(join(APP_DIR, 'index.html'), 'utf8');
	const head = /<head>([\s\S]*)<\/head>/.exec(html)?.[1];
	const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1];
	const styleLink = '<link rel="stylesheet" href="style.css">';
	const appScript = '<script type="module" src="app.js"></script>';
	if (!head || !body || !head.includes(styleLink) || !body.includes(appScript)) throw new Error('app/index.html is not laid out as export-artifact expects (a head with style.css, a body ending with app.js)');
	const pageHead = head
		.replace(/<meta [^>]*>\s*/g, '') // (the publish's skeleton brings the charset and viewport)
		.replace(/<link rel="icon"[^>]*>\s*/, '')
		.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(config.project.title)}</title>`)
		.replace(styleLink, () => `<style>\n${readFileSync(join(APP_DIR, 'style.css'), 'utf8')}</style>`);
	const json = JSON.stringify(config).replace(/</g, '\\u003c');
	const pageBody = body.replace(appScript, () => `<script type="application/json" id="model-review-config">${json}</script>\n<script>\n${bundle('app.js')}\n</script>`);
	return `${pageHead.trim()}\n${pageBody.trim()}\n`;
}

/**
 * Build the page and its files, ready for the Artifact tool's publish: the page as index.html, each GLB wrapped as
 * base64 in JSON (an artifact serves only standard web types), maps as they are, and publish.json with the publish
 * call's arguments.
 * @param {string} dir @param {{ out?: string }} [options]  out: default <project>/artifact
 */
export function exportArtifact(dir, { out } = {}) {
	const root = resolve(dir);
	const project = loadProject(root);
	const outDir = resolve(out || join(root, 'artifact'));
	mkdirSync(join(outDir, 'models'), { recursive: true });
	/** @type {Record<string, string>} */
	const files = {};
	const warnings = [];
	const keep = (/** @type {string} */ published) => {
		const full = join(outDir, published);
		files[published] = full;
		const size = statSync(full).size;
		if (size > FILE_LIMIT) warnings.push(`${published} is ${(size / 1048576).toFixed(1)} MB; an artifact's files can be at most 16 MB (use a lighter mesh or compress it, e.g. with gltf-transform's meshopt)`);
		return published;
	};
	const wrap = (/** @type {string} */ rel, /** @type {string} */ as) => {
		writeFileSync(join(outDir, `models/${as}.json`), JSON.stringify({ glb: readFileSync(inside(root, rel)).toString('base64') }));
		return keep(`models/${as}.json`);
	};
	const copy = (/** @type {string} */ rel, /** @type {string} */ as) => {
		const published = `models/${as}${extname(rel).toLowerCase()}`;
		copyFileSync(inside(root, rel), join(outDir, published));
		return keep(published);
	};
	const models = project.models.map((m) => {
		const entry = { ...m, file: wrap(m.file, m.id) };
		if (m.lod) entry.lod = wrap(m.lod, `${m.id}_lod`);
		if (m.maps) {
			entry.maps = { ...m.maps };
			for (const kind of MAP_KINDS) if (m.maps[kind]) entry.maps[kind] = copy(/** @type {string} */ (m.maps[kind]), `${m.id}_${kind}`);
		}
		return entry;
	});
	const page = join(outDir, 'index.html');
	const html = artifactPage({ mode: 'artifact', project: { ...project, models } });
	writeFileSync(page, html);
	if (Buffer.byteLength(html) > FILE_LIMIT) warnings.push('the page is over 16 MB');
	if (Object.keys(files).length > PUBLISH_FILES) warnings.push(`${Object.keys(files).length} files: one publish sends at most ${PUBLISH_FILES}, so publish the rest to the same url in further calls`);
	const publish = {
		file_path: page,
		files,
		capabilities: ARTIFACT_CAPABILITIES,
		icon: 'cube',
		description: `${project.title}: 3D models for review, with notes pinned to them.`,
	};
	writeFileSync(join(outDir, 'publish.json'), JSON.stringify(publish, null, 2) + '\n');
	const bytes = Buffer.byteLength(html) + Object.values(files).reduce((sum, f) => sum + statSync(f).size, 0);
	return { out: outDir, page, files, publish, warnings, bytes };
}

// ---- import ----

/**
 * A saved document's body: ArtifactData may save the body itself or wrap it with its id and version.
 * @param {any} doc
 */
const bodyOf = (doc) => (doc && typeof doc.data === 'object' && doc.data && ('version' in doc || 'id' in doc) && !('model' in doc) ? doc.data : doc);

/**
 * Notes and verdicts as saved from an artifact: the folder ArtifactData's out_dir wrote (notes/<id>.json and
 * verdicts/<model>.json), or one JSON file holding { notes, verdicts } or a list of notes.
 * @param {string} from @returns {{ notes: any[], verdicts: Record<string, any> }}
 */
function readSaved(from) {
	const full = resolve(from);
	if (!existsSync(full)) throw new Error(`${from} not found`);
	const docs = (/** @type {string} */ folder) =>
		existsSync(folder)
			? readdirSync(folder)
					.filter((f) => f.endsWith('.json'))
					.map((f) => ({ id: basename(f, '.json'), ...bodyOf(JSON.parse(readFileSync(join(folder, f), 'utf8'))) }))
			: [];
	if (statSync(full).isDirectory()) {
		return { notes: docs(join(full, 'notes')), verdicts: Object.fromEntries(docs(join(full, 'verdicts')).map(({ id, ...v }) => [id, v])) };
	}
	const data = JSON.parse(readFileSync(full, 'utf8'));
	const list = (/** @type {any} */ v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.entries(v).map(([id, d]) => ({ id, ...bodyOf(d) })) : []);
	if (Array.isArray(data)) return { notes: data.map(bodyOf), verdicts: {} };
	const verdicts = Array.isArray(data.verdicts) ? Object.fromEntries(data.verdicts.map((/** @type {any} */ v) => [v.id, bodyOf(v)])) : data.verdicts || {};
	return { notes: list(data.notes).map(bodyOf), verdicts };
}

/**
 * A stored note checked field by field, with defaults where the artifact left a field out.
 * @param {any} doc @returns {import('./review.mjs').Note}
 */
function checkNote(doc) {
	if (!doc || typeof doc.id !== 'string' || !NOTE_ID.test(doc.id)) throw new Error(`a note has no valid id (${JSON.stringify(doc?.id)})`);
	const { status, ...rest } = doc;
	const fields = cleanFields({ ...rest, status: status === 'resolved' ? 'resolved' : 'open' });
	if (!fields.model) throw new Error(`note ${doc.id} names no model`);
	const at = typeof doc.at === 'string' && !Number.isNaN(Date.parse(doc.at)) ? doc.at : new Date().toISOString();
	const replies = (Array.isArray(doc.replies) ? doc.replies : [])
		.filter((/** @type {any} */ r) => r && (r.by === 'agent' || r.by === 'human') && typeof r.text === 'string' && r.text.trim())
		.map((/** @type {any} */ r) => ({ by: r.by, name: String(r.name || '').slice(0, 100), text: r.text, at: typeof r.at === 'string' ? r.at : at, ...(r.user ? { user: String(r.user) } : {}) }));
	return {
		id: doc.id,
		model: fields.model,
		text: fields.text || '',
		images: fields.images || [],
		snapshot: fields.snapshot ?? null,
		node: fields.node ?? null,
		local: fields.local ?? null,
		world: fields.world ?? null,
		radius: fields.radius ?? null,
		view: fields.view ?? null,
		k: fields.k ?? null,
		...(fields.hidden?.length ? { hidden: fields.hidden } : {}),
		status: fields.status || 'open',
		replies,
		author: String(doc.author || '').slice(0, 100),
		at,
		updated: typeof doc.updated === 'string' ? doc.updated : at,
		...(typeof doc.edited === 'string' ? { edited: doc.edited } : {}),
		version: Number.isInteger(doc.version) && doc.version > 0 ? doc.version : 1,
	};
}

/**
 * One note from two copies: the replies of both, every other field from whichever changed last.
 * @param {import('./review.mjs').Note} local @param {import('./review.mjs').Note} remote
 */
function mergeNotes(local, remote) {
	const newer = Date.parse(remote.updated) > Date.parse(local.updated) ? remote : local;
	/** @type {Map<string, import('./review.mjs').Reply>} */
	const replies = new Map();
	for (const r of [...local.replies, ...remote.replies]) replies.set(`${r.at}|${r.by}|${r.text}`, r);
	const merged = { ...newer, replies: [...replies.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)) };
	const changed = JSON.stringify({ ...merged, version: 0 }) !== JSON.stringify({ ...local, version: 0 });
	return { note: { ...merged, version: Math.max(local.version, remote.version) + (changed ? 1 : 0) }, changed };
}

/**
 * Merge an artifact's notes, verdicts and images into the project.
 * @param {string} dir @param {{ from: string, images?: string }} options
 *   from: what ArtifactData saved (a folder, or one JSON file); images: a folder of the artifact's assets saved as <id>.<ext>
 */
export function importArtifact(dir, { from, images }) {
	const project = loadProject(dir);
	const review = new Review(dir);
	review.ensure();
	const saved = readSaved(from);
	const report = { added: /** @type {string[]} */ ([]), updated: /** @type {string[]} */ ([]), unchanged: 0, skipped: /** @type {string[]} */ ([]), images: 0, missingImages: /** @type {string[]} */ ([]), verdicts: 0 };
	const known = new Set(project.models.map((m) => m.id));
	for (const doc of saved.notes) {
		let note;
		try {
			note = checkNote(doc);
			if (!known.has(note.model)) throw new Error(`note ${note.id} is about "${note.model}", which this project doesn't have`);
		} catch (e) {
			report.skipped.push(/** @type {Error} */ (e).message);
			continue;
		}
		const incoming = note;
		const outcome = review.locked(incoming.id, () => {
			const local = review.getNote(incoming.id);
			if (!local) {
				review.writeNote(incoming);
				return 'added';
			}
			const { note: merged, changed } = mergeNotes(local, incoming);
			if (changed) review.writeNote(merged);
			return changed ? 'updated' : 'unchanged';
		});
		if (outcome === 'unchanged') report.unchanged++;
		else {
			report[outcome].push(incoming.id);
			review.log({ type: 'note', id: incoming.id, model: incoming.model, by: 'human', what: `imported (${outcome})` });
		}
	}
	// (the images the notes point at, from the folder the artifact's assets were saved to)
	const wanted = new Set(review.listNotes().flatMap((n) => [...n.images, ...(n.snapshot ? [n.snapshot] : [])]).filter((id) => !review.imageFile(id)));
	const available = images && existsSync(images) ? readdirSync(images) : [];
	for (const id of wanted) {
		const file = available.find((f) => f === id || f.startsWith(`${id}.`));
		const buf = file ? readFileSync(join(/** @type {string} */ (images), file)) : null;
		const type = buf && sniffImage(buf);
		if (!buf || !type || !IMAGE_ID.test(id)) {
			report.missingImages.push(id);
			continue;
		}
		mkdirSync(review.imagesDir, { recursive: true });
		writeAtomic(join(review.imagesDir, `${id}.${IMAGE_TYPES[type]}`), buf);
		report.images++;
	}
	for (const [model, v] of Object.entries(saved.verdicts)) {
		if (!MODEL_ID.test(model) || !known.has(model) || (v?.state !== 'approved' && v?.state !== 'changes')) continue;
		const mine = review.getVerdicts()[model];
		if (mine && Date.parse(mine.at) >= Date.parse(v.at || 0)) continue;
		review.locked('verdicts', () => {
			const all = review.getVerdicts();
			all[model] = { state: v.state, by: String(v.by || ''), at: typeof v.at === 'string' ? v.at : new Date().toISOString() };
			writeAtomic(review.verdictsFile, JSON.stringify(all, null, '\t') + '\n');
		});
		review.log({ type: 'verdict', model, by: 'human', what: 'imported' });
		report.verdicts++;
	}
	return report;
}
