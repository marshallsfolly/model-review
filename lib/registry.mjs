// The projects this user has opened, so agents can name a project by its title instead of a path. Kept in
// $XDG_CONFIG_HOME/model-review/projects.json (by default ~/.config/model-review/projects.json).

import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { isProject, loadProject, writeAtomic } from './project.mjs';

/** @typedef {{ dir: string, added: string }} Entry */

export function registryFile() {
	return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'model-review', 'projects.json');
}

/** @returns {Entry[]} */
function read() {
	try {
		const data = JSON.parse(readFileSync(registryFile(), 'utf8'));
		return Array.isArray(data.projects) ? data.projects.filter((/** @type {any} */ p) => p && typeof p.dir === 'string') : [];
	} catch {
		return [];
	}
}

/** @param {Entry[]} projects */
function write(projects) {
	mkdirSync(join(registryFile(), '..'), { recursive: true });
	writeAtomic(registryFile(), JSON.stringify({ projects }, null, '\t') + '\n');
}

/** Remember a project folder. @param {string} dir */
export function registerProject(dir) {
	const full = resolve(dir);
	if (!isProject(full)) throw new Error(`${full} has no project.json`);
	const projects = read();
	if (!projects.some((p) => p.dir === full)) {
		projects.push({ dir: full, added: new Date().toISOString() });
		write(projects);
	}
	return full;
}

/** The remembered projects, with their titles as project.json has them now. */
export function listProjects() {
	return read().map((p) => {
		try {
			return { ...p, title: loadProject(p.dir).title, ok: true };
		} catch (e) {
			return { ...p, title: basename(p.dir), ok: false, problem: /** @type {Error} */ (e).message };
		}
	});
}

/**
 * A project folder from what an agent calls it: a path to a folder with project.json, or a remembered project's
 * title or folder name. With nothing given and one project remembered, that one.
 * @param {string | undefined} ref
 */
export function resolveProject(ref) {
	if (ref && isProject(resolve(ref))) return resolve(ref);
	const known = listProjects();
	if (!ref) {
		if (known.length === 1) return known[0].dir;
		throw new Error(known.length ? `say which project: ${known.map((p) => `"${p.title}" (${p.dir})`).join(', ')}` : 'no projects yet: create one with create_project, or register a folder with open_project');
	}
	const wanted = ref.toLowerCase();
	const match = known.filter((p) => p.title.toLowerCase() === wanted || basename(p.dir).toLowerCase() === wanted || p.dir === ref);
	if (match.length === 1) return match[0].dir;
	if (match.length > 1) throw new Error(`"${ref}" names more than one project: ${match.map((p) => p.dir).join(', ')}; give its path`);
	throw new Error(`no project "${ref}"${known.length ? `; known: ${known.map((p) => `"${p.title}"`).join(', ')}` : ''} (a path to a folder with project.json also works)`);
}
