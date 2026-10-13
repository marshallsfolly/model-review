// The local server: the review page, the project's model files and the review API, with live updates over
// server-sent events. It binds 127.0.0.1 unless told otherwise; a team on a LAN binds 0.0.0.0 and sets a token.
//
// Live updates come from review/events.jsonl, which every writer appends to (this server, the CLI, the MCP server),
// so a reply an agent writes straight to disk reaches open pages too. Changed model files are noticed by polling
// their modification times, so a GLB re-exported into the project reloads in the page.

import { createServer } from 'node:http';
import { readFileSync, statSync, watchFile, unwatchFile, rmSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { timingSafeEqual, createHash } from 'node:crypto';
import { loadProject, modelFiles, inside, writeAtomic, PROJECT_FILE } from './project.mjs';
import { Review, ReviewError, MAX_IMAGE_BYTES } from './review.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = join(ROOT, 'app');
export const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
export const DEFAULT_PORT = 8795;
const APP_FILES = new Set(['index.html', 'app.js', 'action.js', 'stores.js', 'style.css', 'favicon.svg']);
const TYPES = /** @type {Record<string, string>} */ ({
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.json': 'application/json',
	'.glb': 'model/gltf-binary',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
});
const COOKIE = 'model_review_token';
const MAX_JSON_BYTES = 1024 * 1024;

/** @param {string} host */
export const isLoopback = (host) => host === 'localhost' || host === '::1' || host.startsWith('127.');

/** @param {string} s */
const digest = (s) => createHash('sha256').update(s).digest();

/** The server's runtime file: where a running server says how to reach it. @param {string} dir */
export const serverFile = (dir) => join(resolve(dir), 'review', 'server.json');

/**
 * The addresses people on the network can open, for a server bound to every interface.
 * @param {number} port
 */
export function lanUrls(port) {
	return Object.values(networkInterfaces())
		.flat()
		.filter((i) => i && i.family === 'IPv4' && !i.internal)
		.map((i) => `http://${i?.address}:${port}/`);
}

/**
 * Serve a project.
 * @param {{ dir: string, port?: number, host?: string, token?: string | null, log?: (msg: string) => void }} options
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function startServer({ dir, port = DEFAULT_PORT, host = '127.0.0.1', token = null, log = () => {} }) {
	const root = resolve(dir);
	loadProject(root); // a broken project.json fails here, not on the first request
	const review = new Review(root);
	review.ensure();
	/** @type {Set<import('node:http').ServerResponse>} */
	const streams = new Set();

	// ---- who may ask ----
	const tokenMatches = (/** @type {string | null | undefined} */ given) => !!token && !!given && timingSafeEqual(digest(given), digest(token));
	const cookies = (/** @type {string | undefined} */ header) =>
		Object.fromEntries((header || '').split(';').map((c) => c.trim().split('=')).filter((kv) => kv.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]));
	/** @param {import('node:http').IncomingMessage} req */
	const authorized = (req) => {
		if (!token) return true;
		const auth = req.headers.authorization || '';
		return (auth.startsWith('Bearer ') && tokenMatches(auth.slice(7))) || tokenMatches(cookies(req.headers.cookie)[COOKIE]);
	};
	// (open on loopback without a token, only requests addressed to localhost: another site can't reach in by
	// pointing its own name at 127.0.0.1)
	/** @param {import('node:http').IncomingMessage} req */
	const hostAllowed = (req) => {
		if (token || !isLoopback(host)) return true;
		const name = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
		return name === 'localhost' || name === '::1' || name.startsWith('127.');
	};
	// (a write from a browser must come from this server's own page; a page elsewhere can't send JSON or an image
	// here without a preflight, which this server never answers)
	/** @param {import('node:http').IncomingMessage} req */
	const originAllowed = (req) => {
		const origin = req.headers.origin;
		if (!origin) return true;
		try {
			return new URL(origin).host === req.headers.host;
		} catch {
			return false;
		}
	};

	// ---- responses ----
	/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
	const json = (res, status, body) => {
		res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
		res.end(JSON.stringify(body));
	};
	/** @param {import('node:http').ServerResponse} res @param {number} status @param {string} message */
	const fail = (res, status, message, extra = {}) => json(res, status, { error: message, ...extra });
	/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {string} file @param {string} [type] */
	const sendFile = (req, res, file, type) => {
		let stat;
		try {
			stat = statSync(file);
		} catch {
			return fail(res, 404, 'not found');
		}
		const modified = stat.mtime.toUTCString();
		if (req.headers['if-modified-since'] === modified) {
			res.writeHead(304);
			return res.end();
		}
		res.writeHead(200, { 'Content-Type': type || TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'Last-Modified': modified, 'Cache-Control': 'no-cache' });
		res.end(readFileSync(file));
	};
	/** @param {import('node:http').IncomingMessage} req @param {number} limit @returns {Promise<Buffer>} */
	const body = (req, limit) =>
		new Promise((ok, no) => {
			const tooBig = new ReviewError(413, `the request is over ${Math.round(limit / 1024 / 1024)} MB`);
			// (an oversized body is read to its end and dropped, so the client gets the 413 rather than a reset)
			if (Number(req.headers['content-length']) > limit) {
				req.resume();
				return no(tooBig);
			}
			/** @type {Buffer[] | null} */
			let parts = [];
			let size = 0;
			req.on('data', (chunk) => {
				size += chunk.length;
				if (size <= limit) parts.push(chunk);
				else if (parts) {
					parts = null;
					no(tooBig);
				}
			});
			req.on('end', () => {
				if (parts) ok(Buffer.concat(parts));
			});
			req.on('error', no);
		});
	/** @param {import('node:http').IncomingMessage} req */
	const jsonBody = async (req) => {
		if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw new ReviewError(415, 'send JSON (Content-Type: application/json)');
		try {
			const value = JSON.parse((await body(req, MAX_JSON_BYTES)).toString('utf8') || '{}');
			if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
			return value;
		} catch (e) {
			if (e instanceof ReviewError) throw e;
			throw new ReviewError(400, 'the body is not a JSON object');
		}
	};

	// ---- the project and its files ----
	const projectState = () => {
		const project = loadProject(root);
		/** @type {Record<string, string | null>} */
		const revs = {};
		for (const rel of modelFiles(project)) {
			try {
				const s = statSync(inside(root, rel));
				revs[rel] = `${Math.round(s.mtimeMs)}-${s.size}`;
			} catch {
				revs[rel] = null;
			}
		}
		return { project, revs };
	};

	// ---- live updates ----
	/** @param {string} event @param {unknown} data */
	const broadcast = (event, data) => {
		const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const res of streams) res.write(frame);
	};
	let logAt = Number(review.cursor());
	// (the change log since we last looked, each note sent once as it is now)
	const pump = () => {
		const { events, cursor } = review.changesSince(String(logAt));
		logAt = Number(cursor);
		const notes = new Set();
		let verdicts = false;
		for (const e of events) {
			if (e.type === 'verdict') verdicts = true;
			else if (e.id) notes.add(e.id);
		}
		for (const id of notes) {
			const note = review.getNote(id);
			if (note) broadcast('note', note);
			else broadcast('note-deleted', { id });
		}
		if (verdicts) broadcast('verdicts', review.getVerdicts());
	};
	watchFile(review.eventsFile, { interval: 250 }, pump);

	/** @type {string[]} */
	let watched = [];
	/** @type {NodeJS.Timeout | undefined} */
	let settle;
	const modelChanged = () => {
		clearTimeout(settle);
		// (an exporter writes a file in pieces: wait for it to settle)
		settle = setTimeout(() => {
			try {
				broadcast('project', projectState());
				watchModels();
			} catch (e) {
				log(`project.json can't be read right now: ${/** @type {Error} */ (e).message}`);
			}
		}, 400);
	};
	const watchModels = () => {
		for (const f of watched) unwatchFile(f, modelChanged);
		let files = [];
		try {
			files = modelFiles(loadProject(root)).map((rel) => inside(root, rel));
		} catch {
			// a broken project.json: keep watching it alone until it is fixed
		}
		watched = [join(root, PROJECT_FILE), ...files];
		for (const f of watched) watchFile(f, { interval: 1000 }, modelChanged);
	};
	watchModels();
	const heartbeat = setInterval(() => {
		for (const res of streams) res.write(': still here\n\n');
	}, 25000);

	// ---- the API ----
	/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {URL} url */
	const api = async (req, res, url) => {
		const route = url.pathname.slice('/api/'.length).split('/').map(decodeURIComponent);
		const method = req.method || 'GET';
		const [what, id, sub] = route;

		if (what === 'health' && method === 'GET') return json(res, 200, { ok: true, name: 'model-review', version: VERSION, title: loadProject(root).title });
		if (what === 'project' && method === 'GET') return json(res, 200, projectState());

		if (what === 'events' && method === 'GET') {
			res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
			res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ cursor: review.cursor() })}\n\n`);
			streams.add(res);
			req.on('close', () => streams.delete(res));
			return;
		}

		if (what === 'notes') {
			if (!id && method === 'GET') {
				const state = url.searchParams.get('state') || 'all';
				return json(res, 200, { notes: review.listNotes({ model: url.searchParams.get('model') || undefined, state, since: url.searchParams.get('since') || undefined }), cursor: review.cursor() });
			}
			if (!id && method === 'POST') {
				const fields = await jsonBody(req);
				if (!loadProject(root).models.some((m) => m.id === fields.model)) throw new ReviewError(400, `the project has no model "${fields.model}"`);
				const note = review.createNote(fields, { author: typeof fields.author === 'string' ? fields.author : '', by: fields.by === 'agent' ? 'agent' : 'human' });
				pump();
				return json(res, 201, note);
			}
			if (id && !sub && method === 'GET') {
				const note = review.getNote(id);
				return note ? json(res, 200, note) : fail(res, 404, `no note "${id}"`);
			}
			if (id && !sub && method === 'PATCH') {
				const { version, by, ...changes } = await jsonBody(req);
				if (typeof version !== 'number') throw new ReviewError(400, 'send the version of the note you changed (409 tells you if it changed meanwhile)');
				const note = review.updateNote(id, changes, { version, by: by === 'agent' ? 'agent' : 'human' });
				pump();
				return json(res, 200, note);
			}
			if (id && !sub && method === 'DELETE') {
				const version = Number(url.searchParams.get('version'));
				if (!Number.isInteger(version)) throw new ReviewError(400, 'send ?version= of the note you are deleting');
				review.deleteNote(id, { version });
				pump();
				res.writeHead(204);
				return res.end();
			}
			if (id && sub === 'replies' && method === 'POST') {
				const { by, name, text, resolve: resolveIt } = await jsonBody(req);
				const note = review.addReply(id, { by, name, text }, { resolve: resolveIt === true });
				pump();
				return json(res, 200, note);
			}
		}

		if (what === 'images') {
			if (!id && method === 'POST') {
				if (!/^image\//.test(req.headers['content-type'] || '')) throw new ReviewError(415, 'send the image itself as the body, with its image/* Content-Type');
				const saved = review.saveImage(await body(req, MAX_IMAGE_BYTES));
				return json(res, 201, { id: saved.id, type: saved.type, size: saved.size, url: `api/images/${saved.id}` });
			}
			if (id && method === 'GET') {
				const file = review.imageFile(id);
				if (!file) return fail(res, 404, `no image "${id}"`);
				res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'" });
				return res.end(readFileSync(file.path));
			}
			if (id && method === 'DELETE') {
				review.deleteImage(id);
				res.writeHead(204);
				return res.end();
			}
		}

		if (what === 'verdicts') {
			if (!id && method === 'GET') return json(res, 200, { verdicts: review.getVerdicts() });
			if (id && method === 'PUT') {
				const { state, by } = await jsonBody(req);
				if (!loadProject(root).models.some((m) => m.id === id)) throw new ReviewError(400, `the project has no model "${id}"`);
				const verdicts = review.setVerdict(id, state ?? null, { by: typeof by === 'string' ? by : '' });
				pump();
				return json(res, 200, { verdicts });
			}
		}
		return fail(res, 404, `no such API route: ${method} ${url.pathname}`);
	};

	// ---- requests ----
	const server = createServer(async (req, res) => {
		res.setHeader('X-Content-Type-Options', 'nosniff');
		res.setHeader('Referrer-Policy', 'no-referrer');
		try {
			const url = new URL(req.url || '/', 'http://localhost');
			if (!hostAllowed(req)) return fail(res, 421, `open this page as http://127.0.0.1:${actualPort}/`);
			// (a link with ?token= is kept as a cookie and taken out of the address bar)
			if (token && url.searchParams.has('token')) {
				const given = url.searchParams.get('token');
				if (!tokenMatches(given)) return fail(res, 401, 'that token is wrong');
				res.writeHead(303, { 'Set-Cookie': `${COOKIE}=${encodeURIComponent(/** @type {string} */ (given))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`, Location: url.pathname });
				return res.end();
			}
			if (!authorized(req)) {
				if (url.pathname.startsWith('/api/')) return fail(res, 401, 'this server needs its token: Authorization: Bearer <token>, or open the page once with ?token=<token>');
				res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
				return res.end('<!doctype html><meta charset="utf-8"><title>Token needed</title><p style="font:16px system-ui;margin:2em">This review server needs a token. Open the link you were given, which ends in <code>?token=…</code>.</p>');
			}
			if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req)) return fail(res, 403, 'writes must come from this server’s own page');

			if (url.pathname.startsWith('/api/')) return await api(req, res, url);
			if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'not allowed');
			const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
			if (APP_FILES.has(name)) return sendFile(req, res, join(APP_DIR, name));
			// (only the files project.json lists: nothing else in the folder is served)
			if (name.startsWith('project/')) {
				const rel = decodeURIComponent(name.slice('project/'.length));
				if (!modelFiles(loadProject(root)).includes(rel)) return fail(res, 404, `${rel} is not a model file of this project`);
				return sendFile(req, res, inside(root, rel));
			}
			return fail(res, 404, 'not found');
		} catch (e) {
			if (e instanceof ReviewError) return fail(res, e.status, e.message, e.extra);
			log(`error: ${/** @type {Error} */ (e).stack || e}`);
			return fail(res, 500, /** @type {Error} */ (e).message || 'server error');
		}
	});

	let actualPort = port;
	await new Promise((ok, no) => {
		server.once('error', (e) => {
			const err = /** @type {NodeJS.ErrnoException} */ (e);
			no(err.code === 'EADDRINUSE' ? new Error(`port ${port} is in use: choose another with --port`) : err);
		});
		server.listen(port, host, () => ok(undefined));
	});
	actualPort = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
	const shown = isLoopback(host) ? host : host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
	const url = `http://${shown.includes(':') ? `[${shown}]` : shown}:${actualPort}/`;
	writeAtomic(serverFile(root), JSON.stringify({ pid: process.pid, url, host, port: actualPort, token: !!token, started: new Date().toISOString() }, null, '\t') + '\n');

	const close = async () => {
		clearInterval(heartbeat);
		clearTimeout(settle);
		unwatchFile(review.eventsFile, pump);
		for (const f of watched) unwatchFile(f, modelChanged);
		for (const res of streams) res.end();
		streams.clear();
		try {
			if (JSON.parse(readFileSync(serverFile(root), 'utf8')).pid === process.pid) rmSync(serverFile(root), { force: true });
		} catch {
			// already gone
		}
		await new Promise((ok) => {
			server.close(() => ok(undefined));
			server.closeAllConnections?.(); // (idle keep-alive connections would hold close() up; Node 18.2+)
		});
	};
	return { url, port: actualPort, close };
}
