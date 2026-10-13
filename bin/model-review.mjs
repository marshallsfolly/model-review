#!/usr/bin/env node
// model-review: review 3D models with notes pinned to them. Commands for people and for agents; run with no
// arguments for help.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readGlb, listNodes } from '../lib/glb.mjs';
import { initProject, addModel, loadProject } from '../lib/project.mjs';
import { Review, STATE_FILTERS, noteState } from '../lib/review.mjs';
import { startServer, isLoopback, lanUrls, DEFAULT_PORT, VERSION } from '../lib/server.mjs';
import { runningServer } from '../lib/running.mjs';
import { registerProject } from '../lib/registry.mjs';
import { noteSummary, noteDetail, numbers } from '../lib/describe.mjs';
import { exportArtifact, importArtifact } from '../lib/artifact.mjs';

const HELP = `model-review ${VERSION}: pin notes on 3D models; agents read them, fix the model and reply.

Usage: model-review <command> <project folder> [options]

People
  init <dir> [--title T] [--description D]       start a project in a folder
  add <dir> <model.glb> [options]                copy a GLB in and list it (again with --replace)
      --id ID  --name NAME  --group GROUP  --lod light.glb
      --color F --orm F --normal F [--normal-space tangent|object]   external maps
      --part node=Label (repeat)                 name the parts reviewers may hide
  serve <dir> [--port ${DEFAULT_PORT}] [--host 127.0.0.1] [--token T|auto]
                                                 the review page at http://127.0.0.1:${DEFAULT_PORT}/
  nodes <model.glb> [--json]                     a GLB's node names, for parts and actions

Agents (and people)
  notes <dir> [--model ID] [--status open|addressed|resolved|unresolved|all] [--since ISO] [--json]
  show <dir> <note> [--json]                     a note in full, with its images' paths
  reply <dir> <note> <text…> [--name N] [--human] [--resolve]
                                                 reply under a note ('-' reads the text from stdin)
  status <dir> [--json]                          models, verdicts, note counts, the running server
  verdicts <dir> [--json]

claude.ai
  export-artifact <dir> [--out DIR]              a page and files to publish as a claude.ai Artifact
  import-artifact <dir> --from SAVED [--images DIR]
                                                 merge the artifact's notes and images into the project

A note can be named by the start of its id (at least 4 characters).`;

const BOOLEAN = new Set(['json', 'replace', 'resolve', 'human', 'help', 'version']);
const REPEATABLE = new Set(['part']);

/** @param {string[]} argv */
function parse(argv) {
	/** @type {string[]} */
	const positional = [];
	/** @type {Record<string, any>} */
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--') {
			positional.push(...argv.slice(i + 1));
			break;
		}
		if (arg === '-h') flags.help = true;
		else if (arg.startsWith('--')) {
			const eq = arg.indexOf('=');
			const key = arg.slice(2, eq > 0 ? eq : undefined);
			const value = eq > 0 ? arg.slice(eq + 1) : BOOLEAN.has(key) ? true : argv[++i];
			if (value === undefined) throw new Error(`--${key} needs a value`);
			if (REPEATABLE.has(key)) (flags[key] ||= []).push(value);
			else flags[key] = value;
		} else positional.push(arg);
	}
	return { positional, flags };
}

/** @param {unknown} value */
const printJson = (value) => console.log(JSON.stringify(value, null, 2));

/** @param {string | undefined} dir */
function needDir(dir) {
	if (!dir) throw new Error('say which project folder');
	return resolve(dir);
}

/** @param {string} text */
function readStdin(text) {
	return text === '-' ? readFileSync(0, 'utf8') : text;
}

async function main() {
	const { positional, flags } = parse(process.argv.slice(2));
	const [command, ...args] = positional;
	if (flags.version) return console.log(VERSION);
	if (!command || flags.help || command === 'help') return console.log(HELP);

	switch (command) {
		case 'init': {
			const dir = needDir(args[0]);
			const project = initProject(dir, { title: flags.title, description: flags.description });
			registerProject(dir);
			console.log(`Started "${project.title}" in ${dir}. Add a model: model-review add ${args[0]} model.glb`);
			return;
		}
		case 'add': {
			const dir = needDir(args[0]);
			if (!args[1]) throw new Error('say which .glb to add');
			/** @type {Record<string, string>} */
			const parts = {};
			for (const p of flags.part || []) {
				const eq = p.indexOf('=');
				if (eq < 1) throw new Error(`--part takes node=Label, not "${p}"`);
				parts[p.slice(0, eq)] = p.slice(eq + 1);
			}
			const maps = flags.color || flags.orm || flags.normal ? { color: flags.color, orm: flags.orm, normal: flags.normal, normalSpace: flags['normal-space'] } : undefined;
			const { model, nodes, warnings, created } = addModel(dir, { file: args[1], id: flags.id, name: flags.name, group: flags.group, lod: flags.lod, maps, parts: flags.part ? parts : undefined, replace: !!flags.replace });
			if (flags.json) return printJson({ model, nodes, warnings });
			console.log(`${created ? 'Added' : 'Replaced the files of'} "${model.name}" (id ${model.id}) as ${model.file}; ${nodes.length} node${nodes.length === 1 ? '' : 's'}.`);
			for (const w of warnings) console.log(`warning: ${w}`);
			return;
		}
		case 'nodes': {
			if (!args[0]) throw new Error('say which .glb');
			const nodes = listNodes(readGlb(readFileSync(args[0])).json);
			if (flags.json) return printJson(nodes);
			for (const n of nodes) console.log(`${'  '.repeat(n.depth)}${n.name}${n.mesh ? '' : '  (no mesh)'}`);
			return;
		}
		case 'serve': {
			const dir = needDir(args[0]);
			const host = flags.host || '127.0.0.1';
			const token = flags.token === 'auto' ? randomBytes(16).toString('hex') : flags.token || null;
			const port = flags.port === undefined ? DEFAULT_PORT : Number(flags.port);
			if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a port number');
			registerProject(dir);
			const server = await startServer({ dir, port, host, token, log: (m) => console.error(m) });
			const withToken = (/** @type {string} */ url) => (token ? `${url}?token=${token}` : url);
			console.log(`Reviewing "${loadProject(dir).title}" at ${withToken(server.url)}`);
			if (!isLoopback(host)) {
				for (const url of lanUrls(server.port)) console.log(`  on the network: ${withToken(url)}`);
				if (!token) {
					console.error(`
  ┌──────────────────────────────────────────────────────────────────────┐
  │ WARNING: bound to ${host.padEnd(15)} with no token.                        │
  │ Anyone who can reach this machine can read and change the notes and  │
  │ see the models. Use --token auto (or your own) for a shared server.  │
  └──────────────────────────────────────────────────────────────────────┘`);
				}
			}
			console.log('Press Ctrl+C to stop.');
			const stop = async () => {
				await server.close();
				process.exit(0);
			};
			process.on('SIGINT', stop);
			process.on('SIGTERM', stop);
			return;
		}
		case 'notes': {
			const dir = needDir(args[0]);
			const project = loadProject(dir);
			const review = new Review(dir);
			const state = flags.status || 'unresolved';
			if (!STATE_FILTERS.includes(state)) throw new Error(`--status is one of ${STATE_FILTERS.join(', ')}`);
			const all = review.listNotes();
			const notes = review.listNotes({ model: flags.model, state, since: flags.since });
			if (flags.json) return printJson({ notes, cursor: review.cursor() });
			const no = numbers(all);
			if (!notes.length) return console.log(`No ${state === 'all' ? '' : `${state} `}notes${flags.model ? ` on ${flags.model}` : ''}.`);
			console.log(notes.map((n) => noteSummary(n, project.models.find((m) => m.id === n.model), no.get(n.id))).join('\n\n'));
			return;
		}
		case 'show': {
			const dir = needDir(args[0]);
			if (!args[1]) throw new Error('say which note');
			const project = loadProject(dir);
			const review = new Review(dir);
			const note = review.findNote(args[1]);
			const imagePath = (/** @type {string} */ id) => review.imageFile(id)?.path || null;
			if (flags.json) return printJson({ ...note, state: noteState(note), imagePaths: Object.fromEntries([...note.images, ...(note.snapshot ? [note.snapshot] : [])].map((id) => [id, imagePath(id)])) });
			console.log(noteDetail(note, project.models.find((m) => m.id === note.model), imagePath, numbers(review.listNotes()).get(note.id)));
			return;
		}
		case 'reply': {
			const dir = needDir(args[0]);
			const [, ref, ...words] = args;
			if (!ref || !words.length) throw new Error('usage: model-review reply <dir> <note> <text…>');
			const review = new Review(dir);
			const id = review.findNote(ref).id;
			const by = flags.human ? 'human' : 'agent';
			const name = flags.name || process.env.MODEL_REVIEW_NAME || (by === 'agent' ? 'Agent' : '');
			const note = review.addReply(id, { by, name, text: readStdin(words.join(' ')) }, { resolve: !!flags.resolve });
			if (flags.json) return printJson(note);
			console.log(`Replied under ${note.id}${flags.resolve ? ' and marked it resolved' : ''}.`);
			return;
		}
		case 'status': {
			const dir = needDir(args[0]);
			const project = loadProject(dir);
			const review = new Review(dir);
			const verdicts = review.getVerdicts();
			const notes = review.listNotes();
			const server = await runningServer(dir);
			const models = project.models.map((m) => {
				const mine = notes.filter((n) => n.model === m.id);
				const count = (/** @type {string} */ s) => mine.filter((n) => noteState(n) === s).length;
				return { id: m.id, name: m.name, verdict: verdicts[m.id]?.state || null, open: count('open'), addressed: count('addressed'), resolved: count('resolved') };
			});
			if (flags.json) return printJson({ title: project.title, dir, server: server?.url || null, models });
			console.log(`${project.title}  (${dir})`);
			console.log(server ? `Served at ${server.url}${server.token ? ' (needs its token)' : ''}` : `Not being served (model-review serve ${args[0]})`);
			for (const m of models) console.log(`  ${m.id.padEnd(16)} ${(m.verdict === 'approved' ? 'approved' : m.verdict === 'changes' ? 'needs changes' : 'no verdict').padEnd(14)} ${m.open} open, ${m.addressed} addressed, ${m.resolved} resolved  ${m.name}`);
			return;
		}
		case 'verdicts': {
			const dir = needDir(args[0]);
			const project = loadProject(dir);
			const verdicts = new Review(dir).getVerdicts();
			if (flags.json) return printJson(verdicts);
			for (const m of project.models) {
				const v = verdicts[m.id];
				console.log(`  ${m.id.padEnd(16)} ${v ? `${v.state === 'approved' ? 'approved' : 'needs changes'} (${v.by || 'someone'}, ${v.at.slice(0, 16).replace('T', ' ')})` : 'no verdict'}`);
			}
			return;
		}
		case 'export-artifact': {
			const dir = needDir(args[0]);
			const result = exportArtifact(dir, { out: flags.out });
			if (flags.json) return printJson(result);
			console.log(`Built ${result.page} and ${Object.keys(result.files).length} files (${(result.bytes / 1048576).toFixed(1)} MB).`);
			for (const w of result.warnings) console.log(`warning: ${w}`);
			console.log(`Publish it with the Artifact tool using the arguments in ${resolve(result.out, 'publish.json')}:\n  file_path, files, capabilities (db, assets, user) and icon.`);
			return;
		}
		case 'import-artifact': {
			const dir = needDir(args[0]);
			if (!flags.from) throw new Error('--from: the folder (or JSON file) the artifact\'s notes were saved to');
			const report = importArtifact(dir, { from: flags.from, images: flags.images });
			if (flags.json) return printJson(report);
			console.log(`Notes: ${report.added.length} added, ${report.updated.length} updated, ${report.unchanged} unchanged. Images: ${report.images} copied. Verdicts: ${report.verdicts} taken.`);
			for (const s of report.skipped) console.log(`skipped: ${s}`);
			if (report.missingImages.length) console.log(`missing images (save these assets from the artifact, then import again with --images): ${report.missingImages.join(', ')}`);
			return;
		}
		default:
			throw new Error(`no command "${command}" (run model-review --help)`);
	}
}

main().catch((e) => {
	console.error(`model-review: ${e.message}`);
	process.exit(1);
});
