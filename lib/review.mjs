// A project's review data, on disk in <project>/review/:
//   notes/<id>.json    one note each
//   images/<id>.<ext>  reference images and view snapshots (PNG, JPEG, WebP, GIF)
//   verdicts.json      { <model id>: { state: 'approved' | 'changes', by, at } }
//   events.jsonl       one line per change, appended: the server streams it to open pages, agents wait on it
// Writes are atomic (a temporary file renamed over the old one) and each note, and the verdicts, change under a short
// lock, so the server, the CLI and the MCP server can all write to the same project at once.

import { readFileSync, readdirSync, mkdirSync, rmSync, statSync, existsSync, appendFileSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeAtomic, MODEL_ID } from './project.mjs';

export const IMAGE_TYPES = /** @type {Record<string, string>} */ ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' });
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const IMAGE_ID = /^[0-9a-f]{32}$/;
export const NOTE_ID = /^n[0-9a-z]{6,30}$/;
/** What a note-list filter can ask for: a note's state, or 'unresolved' (open or addressed), or 'all'. */
export const STATE_FILTERS = ['open', 'addressed', 'resolved', 'unresolved', 'all'];

/**
 * @typedef {[number, number, number]} Vec3
 * @typedef {{ by: 'agent' | 'human', name: string, text: string, at: string, user?: string }} Reply
 * @typedef {object} Note
 * @property {string} id
 * @property {string} model
 * @property {string} text
 * @property {string[]} images      reference image ids
 * @property {string | null} snapshot  the view as it was pinned, an image id
 * @property {string | null} node   the GLB node clicked, or null for a note on the whole model
 * @property {Vec3 | null} local    the spot in that node's own frame (it rides with the node)
 * @property {Vec3 | null} world    the spot in the model's frame, as posed when pinned
 * @property {number | null} radius the area round the spot, metres
 * @property {{ pos: Vec3, target: Vec3 } | null} view  the camera when pinned, model frame
 * @property {number | null} k      the action's pose when pinned, 0..1
 * @property {string[]} [hidden]    parts hidden when pinned
 * @property {'open' | 'resolved'} status
 * @property {Reply[]} replies
 * @property {string} author
 * @property {string} at
 * @property {string} updated      the last change of any kind
 * @property {string} [edited]     the last change to the note itself
 * @property {number} version      bumped on every change; a write naming an older one is refused
 * @typedef {{ state: 'approved' | 'changes', by: string, at: string }} Verdict
 * @typedef {{ at: string, type: 'note' | 'note-deleted' | 'verdict', id?: string, model: string, by: 'agent' | 'human', what: string }} ReviewEvent
 */

/** An error with the HTTP status it maps to: 400 bad input, 404 not found, 409 conflict, 413 too large, 503 busy. */
export class ReviewError extends Error {
	/** @param {number} status @param {string} message @param {Record<string, unknown>} [extra] */
	constructor(status, message, extra = {}) {
		super(message);
		this.status = status;
		this.extra = extra;
	}
}

/** A note's state as people see it: resolved, addressed (an agent replied last) or open. @param {Note} note */
export function noteState(note) {
	if (note.status === 'resolved') return 'resolved';
	return note.replies?.at(-1)?.by === 'agent' ? 'addressed' : 'open';
}

/** Note ids sort by creation time: n + milliseconds in base 36 + 6 random hex digits. */
export function newNoteId() {
	return 'n' + Date.now().toString(36) + randomBytes(3).toString('hex');
}

/** The image type a file's first bytes say it is, or null. @param {Buffer} buf */
export function sniffImage(buf) {
	if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
	if (buf.length >= 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
	if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
	return null;
}

const vec3 = (/** @type {any} */ v) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const now = () => new Date().toISOString();
const wait = new Int32Array(new SharedArrayBuffer(4));

/**
 * Check a note's fields as a client sends them; returns the cleaned fields that were given.
 * @param {Record<string, any>} f @returns {Partial<Note>}
 */
export function cleanFields(f) {
	/** @type {Record<string, any>} */
	const out = {};
	const bad = (/** @type {string} */ msg) => {
		throw new ReviewError(400, msg);
	};
	if ('model' in f) {
		if (typeof f.model !== 'string' || !MODEL_ID.test(f.model)) bad('model must be a model id');
		out.model = f.model;
	}
	if ('text' in f) {
		if (typeof f.text !== 'string' || f.text.length > 20000) bad('text must be a string of at most 20,000 characters');
		out.text = f.text.trim();
	}
	if ('images' in f) {
		if (!Array.isArray(f.images) || f.images.length > 24 || !f.images.every((/** @type {any} */ i) => typeof i === 'string' && IMAGE_ID.test(i))) bad('images must be a list of at most 24 image ids');
		out.images = [...new Set(/** @type {string[]} */ (f.images))];
	}
	if ('snapshot' in f) {
		if (f.snapshot !== null && !(typeof f.snapshot === 'string' && IMAGE_ID.test(f.snapshot))) bad('snapshot must be an image id or null');
		out.snapshot = f.snapshot;
	}
	if ('node' in f) {
		if (f.node !== null && (typeof f.node !== 'string' || f.node.length > 500)) bad('node must be a node name or null');
		out.node = f.node;
	}
	for (const key of ['local', 'world']) {
		if (!(key in f)) continue;
		if (f[key] !== null && !vec3(f[key])) bad(`${key} must be [x, y, z] or null`);
		out[key] = f[key];
	}
	if ('radius' in f) {
		if (f.radius !== null && !(typeof f.radius === 'number' && f.radius > 0 && Number.isFinite(f.radius))) bad('radius must be a positive number (metres) or null');
		out.radius = f.radius;
	}
	if ('view' in f) {
		if (f.view !== null && !(f.view && vec3(f.view.pos) && vec3(f.view.target))) bad('view must be { pos: [x, y, z], target: [x, y, z] } or null');
		out.view = f.view && { pos: f.view.pos, target: f.view.target };
	}
	if ('k' in f) {
		if (f.k !== null && !(typeof f.k === 'number' && f.k >= 0 && f.k <= 1)) bad('k must be a number from 0 to 1, or null');
		out.k = f.k;
	}
	if ('hidden' in f) {
		if (!Array.isArray(f.hidden) || f.hidden.length > 500 || !f.hidden.every((/** @type {any} */ h) => typeof h === 'string')) bad('hidden must be a list of node names');
		out.hidden = f.hidden;
	}
	if ('status' in f) {
		if (f.status !== 'open' && f.status !== 'resolved') bad("status must be 'open' or 'resolved'");
		out.status = f.status;
	}
	return out;
}

/** The review data of one project. */
export class Review {
	/** @param {string} projectDir */
	constructor(projectDir) {
		this.dir = join(projectDir, 'review');
		this.notesDir = join(this.dir, 'notes');
		this.imagesDir = join(this.dir, 'images');
		this.verdictsFile = join(this.dir, 'verdicts.json');
		this.eventsFile = join(this.dir, 'events.jsonl');
	}

	/** Make the folders and the change log, so they can be watched before the first change. */
	ensure() {
		mkdirSync(this.notesDir, { recursive: true });
		mkdirSync(this.imagesDir, { recursive: true });
		if (!existsSync(this.eventsFile)) appendFileSync(this.eventsFile, '');
	}

	/**
	 * Run fn holding a lock named `name`: a directory made atomically, waited for briefly, broken if left stale.
	 * @template T @param {string} name @param {() => T} fn @returns {T}
	 */
	locked(name, fn) {
		const locks = join(this.dir, '.locks');
		const lock = join(locks, name);
		mkdirSync(locks, { recursive: true });
		const giveUp = Date.now() + 5000;
		for (;;) {
			try {
				mkdirSync(lock);
				break;
			} catch (e) {
				if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
				try {
					if (Date.now() - statSync(lock).mtimeMs > 10000) rmSync(lock, { recursive: true, force: true });
				} catch {
					// it went away while we looked
				}
				if (Date.now() > giveUp) throw new ReviewError(503, `${name} is being changed by another writer; try again`);
				Atomics.wait(wait, 0, 0, 10);
			}
		}
		try {
			return fn();
		} finally {
			rmSync(lock, { recursive: true, force: true });
		}
	}

	// ---- notes ----

	/** @param {string} id @returns {Note | null} */
	getNote(id) {
		if (typeof id !== 'string' || !NOTE_ID.test(id)) return null;
		try {
			return JSON.parse(readFileSync(join(this.notesDir, `${id}.json`), 'utf8'));
		} catch {
			return null;
		}
	}

	/**
	 * A note by its id or the start of it (at least 4 characters, matching one note).
	 * @param {string} ref @returns {Note}
	 */
	findNote(ref) {
		const exact = this.getNote(ref);
		if (exact) return exact;
		const matches = ref && ref.length >= 4 ? this.listNotes().filter((n) => n.id.startsWith(ref)) : [];
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) throw new ReviewError(400, `"${ref}" matches ${matches.length} notes: ${matches.map((n) => n.id).join(', ')}`);
		throw new ReviewError(404, `no note "${ref}"`);
	}

	/**
	 * Notes, oldest first.
	 * @param {{ model?: string, state?: string, since?: string }} [filter]  state: one of STATE_FILTERS (default all);
	 *   since: only notes changed at or after this time (ISO 8601)
	 * @returns {Note[]}
	 */
	listNotes({ model, state = 'all', since } = {}) {
		if (!STATE_FILTERS.includes(state)) throw new ReviewError(400, `state must be one of ${STATE_FILTERS.join(', ')}`);
		const after = since ? Date.parse(since) : NaN;
		if (since && Number.isNaN(after)) throw new ReviewError(400, `since must be a date and time, like 2026-01-31T09:00:00Z`);
		let files = [];
		try {
			files = readdirSync(this.notesDir).filter((f) => f.endsWith('.json'));
		} catch {
			return [];
		}
		return files
			.map((f) => this.getNote(f.slice(0, -5)))
			.filter((/** @type {Note | null} */ n) => {
				if (!n) return false;
				if (model && n.model !== model) return false;
				if (since && Date.parse(n.updated) < after) return false;
				const s = noteState(n);
				return state === 'all' || s === state || (state === 'unresolved' && s !== 'resolved');
			})
			.sort((/** @type {Note} */ a, /** @type {Note} */ b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
	}

	/** @param {Note} note */
	writeNote(note) {
		mkdirSync(this.notesDir, { recursive: true });
		writeAtomic(join(this.notesDir, `${note.id}.json`), JSON.stringify(note, null, '\t') + '\n');
	}

	/** @param {string[]} ids */
	assertImages(ids) {
		const missing = ids.filter((id) => !this.imageFile(id));
		if (missing.length) throw new ReviewError(400, `no such image: ${missing.join(', ')} (upload images first)`);
	}

	/**
	 * Pin a new note. Needs a model and some text or an image.
	 * @param {Record<string, any>} fields  model, text, images, snapshot, node, local, world, radius, view, k, hidden
	 * @param {{ author?: string, by?: 'human' | 'agent' }} [who]
	 * @returns {Note}
	 */
	createNote(fields, { author = '', by = 'human' } = {}) {
		const f = cleanFields(fields);
		if (!f.model) throw new ReviewError(400, 'a note needs the model it is about');
		if (!f.text && !f.images?.length) throw new ReviewError(400, 'write a note or attach an image');
		this.assertImages([...(f.images || []), ...(f.snapshot ? [f.snapshot] : [])]);
		const at = now();
		/** @type {Note} */
		const note = {
			id: newNoteId(),
			model: f.model,
			text: f.text || '',
			images: f.images || [],
			snapshot: f.snapshot ?? null,
			node: f.node ?? null,
			local: f.local ?? null,
			world: f.world ?? null,
			radius: f.radius ?? null,
			view: f.view ?? null,
			k: f.k ?? null,
			...(f.hidden?.length ? { hidden: f.hidden } : {}),
			status: 'open',
			replies: [],
			author: String(author).slice(0, 100),
			at,
			updated: at,
			version: 1,
		};
		this.writeNote(note);
		this.log({ type: 'note', id: note.id, model: note.model, by, what: 'created' });
		return note;
	}

	/**
	 * Change a note. With `version`, the change applies only if the note is still at that version (409 otherwise).
	 * @param {string} id @param {Record<string, any>} changes @param {{ version?: number, by?: 'human' | 'agent' }} [options]
	 * @returns {Note}
	 */
	updateNote(id, changes, { version, by = 'human' } = {}) {
		const f = cleanFields(changes);
		delete f.model;
		const { note, dropped } = this.locked(id, () => {
			const old = this.getNote(id);
			if (!old) throw new ReviewError(404, `no note "${id}"`);
			if (version !== undefined && version !== old.version) throw new ReviewError(409, `note ${id} has changed (it is at version ${old.version}, not ${version}); reload it and try again`, { note: old });
			this.assertImages([...(f.images || []), ...(f.snapshot ? [f.snapshot] : [])]);
			const at = now();
			const edits = Object.keys(f).some((key) => key !== 'status');
			const next = { ...old, ...f, updated: at, version: old.version + 1, ...(edits ? { edited: at } : {}) };
			if (next.hidden && !next.hidden.length) delete next.hidden;
			if (!next.text && !next.images.length) throw new ReviewError(400, 'a note needs some text or an image');
			this.writeNote(next);
			const kept = new Set([...next.images, next.snapshot]);
			return { note: next, dropped: [...old.images, old.snapshot].filter((i) => i && !kept.has(i)) };
		});
		for (const img of dropped) this.deleteImageIfUnused(img);
		this.log({ type: 'note', id, model: note.model, by, what: Object.keys(f).length === 1 && f.status ? 'status' : 'edited' });
		return note;
	}

	/**
	 * Delete a note and the images only it used.
	 * @param {string} id @param {{ version?: number, by?: 'human' | 'agent' }} [options]
	 */
	deleteNote(id, { version, by = 'human' } = {}) {
		const note = this.locked(id, () => {
			const old = this.getNote(id);
			if (!old) throw new ReviewError(404, `no note "${id}"`);
			if (version !== undefined && version !== old.version) throw new ReviewError(409, `note ${id} has changed since you read it; reload it and try again`, { note: old });
			unlinkSync(join(this.notesDir, `${id}.json`));
			return old;
		});
		for (const img of [...note.images, note.snapshot]) if (img) this.deleteImageIfUnused(img);
		this.log({ type: 'note-deleted', id, model: note.model, by, what: 'deleted' });
	}

	/**
	 * Add a reply under a note (no version needed: replies only ever append).
	 * @param {string} id @param {{ by: 'agent' | 'human', name?: string, text: string, user?: string }} reply
	 * @param {{ resolve?: boolean }} [options]  resolve: also mark the note resolved
	 * @returns {Note}
	 */
	addReply(id, { by, name, text, user }, { resolve = false } = {}) {
		if (by !== 'agent' && by !== 'human') throw new ReviewError(400, "a reply's by must be 'agent' or 'human'");
		if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw new ReviewError(400, 'a reply needs text (at most 20,000 characters)');
		const note = this.locked(id, () => {
			const old = this.getNote(id);
			if (!old) throw new ReviewError(404, `no note "${id}"`);
			const at = now();
			/** @type {Reply} */
			const reply = { by, name: String(name ?? (by === 'agent' ? 'Agent' : '')).slice(0, 100), text: text.trim(), at };
			if (user) reply.user = String(user);
			const next = { ...old, replies: [...(old.replies || []), reply], updated: at, version: old.version + 1, ...(resolve ? { status: /** @type {const} */ ('resolved') } : {}) };
			this.writeNote(next);
			return next;
		});
		this.log({ type: 'note', id, model: note.model, by, what: resolve ? 'reply+resolved' : 'reply' });
		return note;
	}

	// ---- images ----

	/**
	 * Keep an image; its type comes from its bytes.
	 * @param {Buffer} buf @returns {{ id: string, type: string, size: number, path: string }}
	 */
	saveImage(buf) {
		if (buf.length > MAX_IMAGE_BYTES) throw new ReviewError(413, `images can be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
		const type = sniffImage(buf);
		if (!type) throw new ReviewError(400, 'that is not a PNG, JPEG, WebP or GIF image');
		const id = randomBytes(16).toString('hex');
		const path = join(this.imagesDir, `${id}.${IMAGE_TYPES[type]}`);
		mkdirSync(this.imagesDir, { recursive: true });
		writeAtomic(path, buf);
		return { id, type, size: buf.length, path };
	}

	/** @param {string} id @returns {{ path: string, type: string } | null} */
	imageFile(id) {
		if (typeof id !== 'string' || !IMAGE_ID.test(id)) return null;
		for (const [type, ext] of Object.entries(IMAGE_TYPES)) {
			const path = join(this.imagesDir, `${id}.${ext}`);
			if (existsSync(path)) return { path, type };
		}
		return null;
	}

	/** @param {string} id */
	imageInUse(id) {
		return this.listNotes().some((n) => n.images.includes(id) || n.snapshot === id);
	}

	/** Delete an image no note uses (an image attached to a draft, then taken off). @param {string} id */
	deleteImage(id) {
		const file = this.imageFile(id);
		if (!file) throw new ReviewError(404, `no image "${id}"`);
		if (this.imageInUse(id)) throw new ReviewError(409, 'that image is on a note; take it off the note instead');
		unlinkSync(file.path);
	}

	/** @param {string} id */
	deleteImageIfUnused(id) {
		const file = this.imageFile(id);
		if (file && !this.imageInUse(id)) unlinkSync(file.path);
	}

	// ---- verdicts ----

	/** @returns {Record<string, Verdict>} */
	getVerdicts() {
		try {
			return JSON.parse(readFileSync(this.verdictsFile, 'utf8'));
		} catch {
			return {};
		}
	}

	/**
	 * @param {string} model @param {'approved' | 'changes' | null} state  null clears it
	 * @param {{ by?: string, actor?: 'human' | 'agent' }} [who]  by: the name kept with it
	 */
	setVerdict(model, state, { by = '', actor = 'human' } = {}) {
		if (typeof model !== 'string' || !MODEL_ID.test(model)) throw new ReviewError(400, 'verdicts need a model id');
		if (state !== null && state !== 'approved' && state !== 'changes') throw new ReviewError(400, "a verdict is 'approved', 'changes' or null");
		const verdicts = this.locked('verdicts', () => {
			const all = this.getVerdicts();
			if (state) all[model] = { state, by: String(by).slice(0, 100), at: now() };
			else delete all[model];
			mkdirSync(this.dir, { recursive: true });
			writeAtomic(this.verdictsFile, JSON.stringify(all, null, '\t') + '\n');
			return all;
		});
		this.log({ type: 'verdict', model, by: actor, what: state || 'cleared' });
		return verdicts;
	}

	// ---- the change log ----

	/** @param {Omit<ReviewEvent, 'at'>} event */
	log(event) {
		mkdirSync(this.dir, { recursive: true });
		appendFileSync(this.eventsFile, JSON.stringify({ at: now(), ...event }) + '\n');
	}

	/** Where the change log ends now: a cursor for changes after this moment. */
	cursor() {
		try {
			return String(statSync(this.eventsFile).size);
		} catch {
			return '0';
		}
	}

	/**
	 * The changes after a cursor, and the cursor after them. Without a cursor, none (and the end of the log).
	 * @param {string | undefined} since @returns {{ events: ReviewEvent[], cursor: string }}
	 */
	changesSince(since) {
		const end = Number(this.cursor());
		let from = Number(since);
		if (since === undefined || since === '' || !Number.isInteger(from) || from < 0) return { events: [], cursor: String(end) };
		if (from > end) from = 0; // the log was replaced: read it all again
		if (from === end) return { events: [], cursor: String(end) };
		const buf = Buffer.alloc(end - from);
		const fd = openSync(this.eventsFile, 'r');
		try {
			readSync(fd, buf, 0, buf.length, from);
		} finally {
			closeSync(fd);
		}
		// (only whole lines: a writer may be halfway through one)
		const text = buf.toString('utf8');
		const whole = text.lastIndexOf('\n') + 1;
		const events = text
			.slice(0, whole)
			.split('\n')
			.filter(Boolean)
			.flatMap((line) => {
				try {
					return [JSON.parse(line)];
				} catch {
					return [];
				}
			});
		return { events, cursor: String(from + Buffer.byteLength(text.slice(0, whole))) };
	}
}
