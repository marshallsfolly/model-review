// A project's server, found if it is running or started in the background if not. A running server writes
// review/server.json; a stale one (its process gone) is ignored.

import { readFileSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { serverFile, DEFAULT_PORT } from './server.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'model-review.mjs');

/**
 * The project's running server, or null.
 * @param {string} dir @returns {Promise<{ url: string, pid: number, port: number, token: boolean } | null>}
 */
export async function runningServer(dir) {
	let info;
	try {
		info = JSON.parse(readFileSync(serverFile(dir), 'utf8'));
		process.kill(info.pid, 0);
	} catch {
		return null;
	}
	try {
		// (any answer will do: a server with a token answers 401)
		await fetch(new URL('api/health', info.url), { signal: AbortSignal.timeout(1500) });
		return info;
	} catch {
		return null;
	}
}

/** @param {number} port */
const free = (port) =>
	new Promise((ok) => {
		const probe = createServer();
		probe.once('error', () => ok(false));
		probe.listen(port, '127.0.0.1', () => probe.close(() => ok(true)));
	});

/**
 * Start the project's server in the background on 127.0.0.1 unless one is running. Its output goes to
 * review/server.log.
 * @param {string} dir @param {{ port?: number }} [options]  port: else the first free one from 8795
 * @returns {Promise<{ url: string, started: boolean }>}
 */
export async function ensureServer(dir, { port } = {}) {
	const full = resolve(dir);
	const running = await runningServer(full);
	if (running) return { url: running.url, started: false };
	let chosen = port;
	for (let p = DEFAULT_PORT; !chosen && p < DEFAULT_PORT + 40; p++) if (await free(p)) chosen = p;
	if (!chosen) throw new Error(`no free port from ${DEFAULT_PORT} to ${DEFAULT_PORT + 39}`);
	mkdirSync(join(full, 'review'), { recursive: true });
	const logFd = openSync(join(full, 'review', 'server.log'), 'a');
	const child = spawn(process.execPath, [CLI, 'serve', full, '--port', String(chosen)], { detached: true, stdio: ['ignore', logFd, logFd] });
	child.unref();
	closeSync(logFd);
	const giveUp = Date.now() + 10000;
	while (Date.now() < giveUp) {
		await new Promise((ok) => setTimeout(ok, 200));
		const info = await runningServer(full);
		if (info) return { url: info.url, started: true };
		if (child.exitCode !== null) break;
	}
	throw new Error(`the server didn't start; see ${join(full, 'review', 'server.log')}`);
}
