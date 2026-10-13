// Where the notes live. LocalStore talks to the REST API of `model-review serve` and hears changes over server-sent
// events; ArtifactStore uses the claude.ai Artifact runtime: `db` for notes and verdicts, `assets` for images, `user`
// for who is looking. The page calls the same methods on either.

/** @typedef {import('../lib/review.mjs').Note} Note */
/** @typedef {import('../lib/review.mjs').Verdict} Verdict */
/**
 * @typedef {object} Handlers
 * @property {(notes: Note[]) => void} notes          every note, whenever any changes
 * @property {(verdicts: Record<string, Verdict>) => void} verdicts
 * @property {(state: { project: any, revs: Record<string, string | null> }) => void} [project]  local mode: project.json or a model file changed
 * @property {(problem: string | null) => void} status  a connection problem, or null once it's fine again
 */

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** A note's state as people see it: resolved, addressed (an agent replied last) or open. @param {Note} note */
export function noteState(note) {
	if (note.status === 'resolved') return 'resolved';
	return note.replies?.at(-1)?.by === 'agent' ? 'addressed' : 'open';
}

/** Note ids sort by creation time: n + milliseconds in base 36 + 6 random hex digits (as lib/review.mjs mints them). */
function newNoteId() {
	const bytes = crypto.getRandomValues(new Uint8Array(3));
	return 'n' + Date.now().toString(36) + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A write refused because the note changed since it was read; `note` is how it is now. */
export class ConflictError extends Error {
	/** @param {Note} note */
	constructor(note) {
		super('The note changed meanwhile.');
		this.code = 'conflict';
		this.note = note;
	}
}

const NAME_KEY = 'model-review:name';

function storedName() {
	try {
		return localStorage.getItem(NAME_KEY) || '';
	} catch {
		return '';
	}
}

class LocalStore {
	constructor() {
		this.mode = 'local';
		/** @type {Map<string, Note>} */
		this.notes = new Map();
		this.me = { id: /** @type {string | null} */ (null), name: storedName() };
		this.emit = () => {};
	}

	async connect() {
		await this.request('api/health');
		return { canWrite: true, canUpload: true, me: this.me };
	}

	/** @returns {Promise<{ project: any, revs: Record<string, string | null> }>} */
	project() {
		return this.request('api/project');
	}

	/** @param {string} name */
	setName(name) {
		this.me.name = name;
		try {
			localStorage.setItem(NAME_KEY, name);
		} catch {
			// private window: the name lasts this visit
		}
	}

	/** @param {Handlers} on */
	subscribe(on) {
		this.emit = () => on.notes([...this.notes.values()]);
		const reload = async () => {
			const [{ notes }, { verdicts }] = await Promise.all([this.request('api/notes'), this.request('api/verdicts')]);
			this.notes = new Map(notes.map((/** @type {Note} */ n) => [n.id, n]));
			this.emit();
			on.verdicts(verdicts);
		};
		const events = new EventSource('api/events');
		// ('hello' comes on every connection, so after a reconnect the page catches up on what it missed)
		events.addEventListener('hello', () => reload().then(() => on.status(null), (e) => on.status(e.message)));
		events.addEventListener('note', (e) => {
			const note = JSON.parse(/** @type {MessageEvent} */ (e).data);
			this.notes.set(note.id, note);
			this.emit();
		});
		events.addEventListener('note-deleted', (e) => {
			this.notes.delete(JSON.parse(/** @type {MessageEvent} */ (e).data).id);
			this.emit();
		});
		events.addEventListener('verdicts', (e) => on.verdicts(JSON.parse(/** @type {MessageEvent} */ (e).data)));
		events.addEventListener('project', (e) => on.project?.(JSON.parse(/** @type {MessageEvent} */ (e).data)));
		events.onerror = () => on.status('Lost touch with the review server. Reconnecting…');
	}

	/**
	 * @param {string} path @param {{ method?: string, json?: unknown, blob?: Blob }} [options]
	 */
	async request(path, { method = 'GET', json, blob } = {}) {
		/** @type {Record<string, string>} */
		const headers = {};
		if (json !== undefined) headers['Content-Type'] = 'application/json';
		if (blob) headers['Content-Type'] = blob.type || 'image/jpeg';
		const res = await fetch(path, { method, headers, body: json !== undefined ? JSON.stringify(json) : blob });
		if (res.status === 204) return null;
		const data = await res.json().catch(() => ({}));
		if (res.status === 409 && data.note) throw new ConflictError(data.note);
		if (!res.ok) throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { status: res.status });
		return data;
	}

	/** @param {Note} note */
	keep(note) {
		this.notes.set(note.id, note);
		this.emit();
		return note;
	}

	/** @param {Partial<Note>} fields */
	async createNote(fields) {
		return this.keep(await this.request('api/notes', { method: 'POST', json: { ...fields, author: this.me.name } }));
	}

	/** @param {Note} note @param {Partial<Note>} changes */
	async updateNote(note, changes) {
		return this.keep(await this.request(`api/notes/${note.id}`, { method: 'PATCH', json: { ...changes, version: note.version } }));
	}

	/** @param {Note} note */
	async deleteNote(note) {
		await this.request(`api/notes/${note.id}?version=${note.version}`, { method: 'DELETE' });
		this.notes.delete(note.id);
		this.emit();
	}

	/** @param {Note} note @param {string} text */
	async reply(note, text) {
		return this.keep(await this.request(`api/notes/${note.id}/replies`, { method: 'POST', json: { by: 'human', name: this.me.name, text } }));
	}

	/** @param {Blob} blob @returns {Promise<string>} the image's id */
	async uploadImage(blob) {
		return (await this.request('api/images', { method: 'POST', blob })).id;
	}

	/** @param {string} id */
	async deleteImage(id) {
		await this.request(`api/images/${id}`, { method: 'DELETE' });
	}

	/** @param {string} id */
	imageUrl(id) {
		return `api/images/${id}`;
	}

	/** @param {string} model @param {'approved' | 'changes' | null} state */
	async setVerdict(model, state) {
		await this.request(`api/verdicts/${encodeURIComponent(model)}`, { method: 'PUT', json: { state, by: this.me.name } });
	}

	/** Display names for the people notes name; here a note keeps its writer's name as given. @param {string[]} ids */
	async names(ids) {
		return Object.fromEntries(ids.map((id) => [id, { name: id, isMe: !!id && id === this.me.name }]));
	}
}

class ArtifactStore {
	constructor() {
		this.mode = 'artifact';
		this.me = { id: /** @type {string | null} */ (null), name: '' };
		/** @type {any} */ this.db = null;
		/** @type {any} */ this.assets = null;
		/** @type {any} */ this.user = null;
	}

	/** Null when this view can't keep notes (opened outside claude.ai, or signed out). */
	async connect() {
		const claude = /** @type {any} */ (window).claude;
		if (!claude?.use) return null;
		const [db, assets, user] = await Promise.all([claude.use('db'), claude.use('assets'), claude.use('user')]);
		if (!db) return null;
		Object.assign(this, { db, assets, user });
		const me = user ? await user.me() : null;
		const canWrite = user ? await user.can('data.write') : null;
		this.me = { id: me?.id || null, name: me?.name || '' };
		// (null means the platform said nothing: offer writing and let a refused write decide)
		return { canWrite: canWrite !== false, canUpload: !!assets, me: this.me };
	}

	/** @param {Handlers} on */
	subscribe(on) {
		this.db.collection('notes').onSnapshot(
			(/** @type {any} */ snap) => on.notes(snap.docs.map((/** @type {any} */ d) => ({ ...d.data(), id: d.id }))),
			(/** @type {any} */ e) => on.status(`The notes stopped updating (${e.code}). Reload the page to reconnect.`),
		);
		this.db.collection('verdicts').onSnapshot(
			(/** @type {any} */ snap) => on.verdicts(Object.fromEntries(snap.docs.map((/** @type {any} */ d) => [d.id, d.data()]))),
			() => {},
		);
	}

	/** The note as stored now. @param {string} id @returns {Promise<Note>} */
	async current(id) {
		const snap = await this.db.doc(`notes/${id}`).get();
		if (!snap.exists) throw Object.assign(new Error('That note was deleted meanwhile.'), { status: 404 });
		return { ...snap.data(), id };
	}

	/** @param {Partial<Note>} fields */
	async createNote(fields) {
		const at = new Date().toISOString();
		const note = { ...fields, id: newNoteId(), status: 'open', replies: [], author: this.me.id || '', at, updated: at, version: 1 };
		await this.db.doc(`notes/${note.id}`).set(note);
		return note;
	}

	/** @param {Note} note @param {Partial<Note>} changes */
	async updateNote(note, changes) {
		const old = await this.current(note.id);
		if (old.version !== note.version) throw new ConflictError(old);
		const at = new Date().toISOString();
		const edits = Object.keys(changes).some((key) => key !== 'status');
		const next = { ...changes, updated: at, version: old.version + 1, ...(edits ? { edited: at } : {}) };
		await this.db.doc(`notes/${note.id}`).update(next);
		const merged = { ...old, ...next };
		const kept = new Set([...(merged.images || []), merged.snapshot]);
		for (const id of [...(old.images || []), old.snapshot]) if (id && !kept.has(id)) this.assets?.delete(id).catch(() => {});
		return merged;
	}

	/** @param {Note} note */
	async deleteNote(note) {
		const old = await this.current(note.id);
		if (old.version !== note.version) throw new ConflictError(old);
		await this.db.doc(`notes/${note.id}`).delete();
		for (const id of [...(old.images || []), old.snapshot]) if (id) this.assets?.delete(id).catch(() => {});
	}

	/** @param {Note} note @param {string} text */
	async reply(note, text) {
		const old = await this.current(note.id);
		const at = new Date().toISOString();
		const replies = [...(old.replies || []), { by: 'human', name: '', user: this.me.id || '', text, at }];
		await this.db.doc(`notes/${note.id}`).update({ replies, updated: at, version: old.version + 1 });
		return { ...old, replies, updated: at, version: old.version + 1 };
	}

	/** @param {Blob} blob @returns {Promise<string>} */
	async uploadImage(blob) {
		if (!this.assets) throw Object.assign(new Error('Only people who can edit this page can attach images.'), { code: 'not_granted' });
		const saved = await this.assets.upload(blob, IMAGE_TYPES.includes(blob.type) ? undefined : { type: 'image/jpeg' });
		return saved.id;
	}

	/** @param {string} id */
	async deleteImage(id) {
		await this.assets?.delete(id);
	}

	/** @param {string} id */
	imageUrl(id) {
		return `/_blob/${id}`;
	}

	/** @param {string} model @param {'approved' | 'changes' | null} state */
	async setVerdict(model, state) {
		const ref = this.db.doc(`verdicts/${model}`);
		if (state) await ref.set({ state, by: this.me.id || '', at: new Date().toISOString() });
		else await ref.delete();
	}

	/** Display names for user ids, as this viewer may see them. @param {string[]} ids */
	async names(ids) {
		const list = ids.filter(Boolean);
		if (!this.user || !list.length) return {};
		const people = await this.user.profiles(list);
		return Object.fromEntries(list.map((id) => [id, { name: people[id]?.name || '', isMe: !!people[id]?.isMe }]));
	}
}

/** @param {{ mode: string }} config */
export function openStore(config) {
	return config.mode === 'artifact' ? new ArtifactStore() : new LocalStore();
}
