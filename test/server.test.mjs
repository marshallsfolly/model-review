import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.mjs';
import { Review } from '../lib/review.mjs';
import { demoProject, PNG, raw } from './fixtures.mjs';

/** @type {{ url: string, port: number, close: () => Promise<void> }} */
let server;
let dir = '';
/** @param {string} path @param {RequestInit & { json?: unknown }} [init] */
const call = async (path, init = {}) => {
	const { json, ...rest } = init;
	const res = await fetch(new URL(path, server.url), json === undefined ? rest : { ...rest, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) });
	const text = await res.text();
	return { status: res.status, type: res.headers.get('content-type') || '', body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
};
const upload = async (/** @type {Buffer} */ buf, type = 'image/png') => call('api/images', { method: 'POST', headers: { 'Content-Type': type }, body: buf });

before(async () => {
	dir = demoProject();
	server = await startServer({ dir, port: 0 });
});
after(() => server.close());

test('health, project and model files', async () => {
	assert.equal((await call('api/health')).body.ok, true);
	const { body } = await call('api/project');
	assert.deepEqual(body.project.models.map((/** @type {any} */ m) => m.id), ['case', 'crank']);
	assert.match(body.revs['models/case.glb'], /^\d+-\d+$/);
	const glb = await fetch(new URL('project/models/case.glb', server.url));
	assert.equal(glb.status, 200);
	assert.equal(glb.headers.get('content-type'), 'model/gltf-binary');
	// (only the files project.json lists are served)
	assert.equal((await call('project/project.json')).status, 404);
	assert.equal((await raw(`${server.url}project/..%2Fproject.json`)).status, 404);
	assert.equal((await call('index.html')).status, 200);
});

test('images: upload, fetch, type and size checks', async () => {
	const saved = await upload(PNG);
	assert.equal(saved.status, 201);
	assert.match(saved.body.id, /^[0-9a-f]{32}$/);
	const img = await fetch(new URL(`api/images/${saved.body.id}`, server.url));
	assert.equal(img.headers.get('content-type'), 'image/png');
	assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
	assert.equal((await upload(Buffer.from('not an image'))).status, 400, 'bytes that are not an image');
	assert.equal((await upload(PNG, 'text/plain')).status, 415, 'not sent as an image');
	assert.equal((await upload(Buffer.alloc(21 * 1024 * 1024))).status, 413, 'over 20 MB');
	assert.equal((await call('api/images/0123456789abcdef0123456789abcdef')).status, 404);
});

test('notes: create, list, edit with a version check, reply, delete', async () => {
	const image = (await upload(PNG)).body.id;
	const fields = { model: 'case', text: 'The hinge pin sticks out', images: [image], node: 'lid', local: [0.1, 0, 0], world: [0.1, 0.12, -0.1], radius: 0.005, view: { pos: [0.4, 0.4, 0.5], target: [0, 0.08, 0] }, k: 0.25, author: 'Sam' };
	const created = await call('api/notes', { method: 'POST', json: fields });
	assert.equal(created.status, 201);
	const note = created.body;
	assert.equal(note.version, 1);
	assert.equal(note.status, 'open');
	assert.equal(note.author, 'Sam');
	assert.deepEqual(note.images, [image]);

	assert.equal((await call('api/notes', { method: 'POST', json: { ...fields, model: 'nope' } })).status, 400, 'unknown model');
	assert.equal((await call('api/notes', { method: 'POST', json: { model: 'case', text: '' } })).status, 400, 'no text or image');
	assert.equal((await call('api/notes', { method: 'POST', json: { model: 'case', text: 'x', images: ['ffffffffffffffffffffffffffffffff'] } })).status, 400, 'an image never uploaded');
	assert.equal((await call('api/notes', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415, 'not JSON');

	assert.equal((await call('api/notes')).body.notes.length, 1);
	assert.equal((await call('api/notes?state=open&model=case')).body.notes.length, 1);
	assert.equal((await call('api/notes?model=crank')).body.notes.length, 0);

	const edited = await call(`api/notes/${note.id}`, { method: 'PATCH', json: { version: 1, text: 'The hinge pin sticks out 2 mm' } });
	assert.equal(edited.status, 200);
	assert.equal(edited.body.version, 2);
	assert.ok(edited.body.edited);
	const stale = await call(`api/notes/${note.id}`, { method: 'PATCH', json: { version: 1, text: 'an older edit' } });
	assert.equal(stale.status, 409);
	assert.equal(stale.body.note.version, 2);
	assert.equal(stale.body.note.text, 'The hinge pin sticks out 2 mm');

	const replied = await call(`api/notes/${note.id}/replies`, { method: 'POST', json: { by: 'agent', name: 'Claude', text: 'Shortened the pin by 2 mm.' } });
	assert.equal(replied.body.replies[0].by, 'agent');
	assert.equal((await call('api/notes?state=addressed')).body.notes.length, 1);
	const fixed = await call(`api/notes/${note.id}`, { method: 'PATCH', json: { version: replied.body.version, status: 'resolved' } });
	assert.equal(fixed.body.status, 'resolved');
	assert.equal(fixed.body.edited, edited.body.edited, 'a status change is not an edit');

	// (an image on a note can't be deleted by itself; deleting the note takes its images with it)
	assert.equal((await call(`api/images/${image}`, { method: 'DELETE' })).status, 409);
	assert.equal((await call(`api/notes/${note.id}?version=1`, { method: 'DELETE' })).status, 409);
	assert.equal((await call(`api/notes/${note.id}?version=${fixed.body.version}`, { method: 'DELETE' })).status, 204);
	assert.equal((await call(`api/notes/${note.id}`)).status, 404);
	assert.equal((await call(`api/images/${image}`)).status, 404);
});

test('verdicts', async () => {
	assert.equal((await call('api/verdicts/case', { method: 'PUT', json: { state: 'approved', by: 'Sam' } })).body.verdicts.case.state, 'approved');
	assert.equal((await call('api/verdicts/case', { method: 'PUT', json: { state: 'maybe' } })).status, 400);
	assert.equal((await call('api/verdicts/nope', { method: 'PUT', json: { state: 'changes' } })).status, 400);
	assert.deepEqual(Object.keys((await call('api/verdicts')).body.verdicts), ['case']);
	assert.equal((await call('api/verdicts/case', { method: 'PUT', json: { state: null } })).body.verdicts.case, undefined);
});

test('events: a reply written straight to disk (as the CLI or MCP server does) reaches open pages', async () => {
	const note = (await call('api/notes', { method: 'POST', json: { model: 'crank', text: 'The rod is too thin', author: 'Sam' } })).body;
	const controller = new AbortController();
	const res = await fetch(new URL('api/events', server.url), { signal: controller.signal });
	assert.equal(res.headers.get('content-type'), 'text/event-stream');
	const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (res.body?.getReader());
	let stream = '';
	/** @param {string} event @param {(data: any) => boolean} [match] */
	const next = async (event, match = () => true) => {
		for (;;) {
			for (const frame of stream.split('\n\n').slice(0, -1)) {
				const name = /^event: (.*)$/m.exec(frame)?.[1];
				const data = /^data: (.*)$/m.exec(frame)?.[1];
				stream = stream.slice(stream.indexOf(frame) + frame.length + 2);
				if (name === event && match(JSON.parse(data || 'null'))) return JSON.parse(data || 'null');
			}
			const { value, done } = await reader.read();
			if (done) throw new Error('the stream ended');
			stream += Buffer.from(value).toString('utf8');
		}
	};
	try {
		await next('hello');
		new Review(dir).addReply(note.id, { by: 'agent', name: 'Claude', text: 'Thickened the rod to 8 mm.' });
		const pushed = await next('note', (n) => n.id === note.id);
		assert.equal(pushed.replies[0].text, 'Thickened the rod to 8 mm.');
		await call('api/verdicts/crank', { method: 'PUT', json: { state: 'changes' } });
		assert.equal((await next('verdicts')).crank.state, 'changes');
	} finally {
		controller.abort();
	}
});

test('guards: only localhost names without a token, no writes from other sites', async () => {
	assert.equal((await raw(`${server.url}api/health`, { headers: { Host: 'evil.example' } })).status, 421);
	const posted = await raw(`${server.url}api/notes`, { method: 'POST', headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'case', text: 'x' }) });
	assert.equal(posted.status, 403);
});

test('a token guards everything, and a ?token= link becomes a cookie', async () => {
	const guarded = await startServer({ dir, port: 0, token: 'open-sesame' });
	try {
		assert.equal((await fetch(new URL('api/health', guarded.url))).status, 401);
		assert.equal((await fetch(new URL('/', guarded.url))).status, 401);
		assert.equal((await fetch(new URL('api/health', guarded.url), { headers: { Authorization: 'Bearer wrong' } })).status, 401);
		assert.equal((await fetch(new URL('api/health', guarded.url), { headers: { Authorization: 'Bearer open-sesame' } })).status, 200);
		const link = await raw(`${guarded.url}?token=open-sesame`);
		assert.equal(link.status, 303);
		const cookie = String(link.headers['set-cookie']).split(';')[0];
		assert.match(String(link.headers['set-cookie']), /HttpOnly/);
		assert.equal((await raw(`${guarded.url}api/project`, { headers: { Cookie: cookie } })).status, 200);
		// (with a token, any host name may be used: a LAN address, a tunnel)
		assert.equal((await raw(`${guarded.url}api/health`, { headers: { Host: 'review.example', Cookie: cookie } })).status, 200);
	} finally {
		await guarded.close();
	}
});
