import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { exportArtifact, importArtifact, ARTIFACT_CAPABILITIES } from '../lib/artifact.mjs';
import { Review } from '../lib/review.mjs';
import { demoProject, PNG, tempDir } from './fixtures.mjs';

test('export builds a self-contained Artifact page and its files', () => {
	const dir = demoProject();
	const result = exportArtifact(dir, { out: join(tempDir('export'), 'artifact') });
	const html = readFileSync(result.page, 'utf8');
	// (no document skeleton of its own: the publish adds one; the title first, within the first 8 KB)
	assert.match(html.slice(0, 200), /^<title>Model review demo<\/title>/);
	assert.doesNotMatch(html, /<!doctype|<html|<head>|<body>/i);
	assert.doesNotMatch(html, /src="app\.js"|href="style\.css"/);
	for (const url of html.match(/<script src="([^"]+)"/g) || []) assert.match(url, /cdn\.jsdelivr\.net\/npm\/three@0\.147\.0\//, 'scripts only from the allowed CDN, pinned');

	const config = JSON.parse(/<script type="application\/json" id="model-review-config">(.*?)<\/script>/s.exec(html)?.[1] || '{}');
	assert.equal(config.mode, 'artifact');
	assert.deepEqual(config.project.models.map((/** @type {any} */ m) => m.file), ['models/case.json', 'models/crank.json']);
	assert.equal(config.project.models[0].lod, 'models/case_lod.json');

	// (each GLB is base64 in JSON, byte for byte)
	const wrapped = JSON.parse(readFileSync(join(result.out, 'models/case.json'), 'utf8'));
	assert.deepEqual(Buffer.from(wrapped.glb, 'base64'), readFileSync(join(dir, 'models/case.glb')));
	assert.deepEqual(Object.keys(result.files).sort(), ['models/case.json', 'models/case_lod.json', 'models/crank.json']);
	assert.deepEqual(result.publish.capabilities, ARTIFACT_CAPABILITIES);
	assert.deepEqual(JSON.parse(readFileSync(join(result.out, 'publish.json'), 'utf8')).files, result.files);

	// (the bundled modules compile as one classic script)
	const inline = [...html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].map((m) => m[1]);
	const bundle = inline.find((s) => s.includes('module_app_js'));
	assert.ok(bundle, 'the page carries the bundled app');
	assert.doesNotThrow(() => new Script(bundle));
	assert.doesNotMatch(bundle, /^\s*(import|export)\s/m);
});

test('import merges notes, replies, images and verdicts saved from an artifact', () => {
	const dir = demoProject();
	const saved = tempDir('saved');
	const assets = tempDir('assets');
	mkdirSync(join(saved, 'notes'));
	mkdirSync(join(saved, 'verdicts'));
	const image = 'abcdefabcdefabcdefabcdefabcdef12';
	writeFileSync(join(assets, `${image}.png`), PNG);
	const at = '2026-01-02T10:00:00.000Z';
	const note = { id: 'nabc123def456', model: 'case', text: 'The knob is too big', images: [image], snapshot: null, node: 'drawer_knob', local: [0, 0, 0.01], world: [0, 0.028, 0.11], radius: 0.004, view: { pos: [0.3, 0.2, 0.4], target: [0, 0.03, 0.1] }, k: 0.8, status: 'open', replies: [], author: 'u_someone', at, updated: at, version: 1 };
	// (ArtifactData may save a document wrapped with its id and version)
	writeFileSync(join(saved, 'notes', `${note.id}.json`), JSON.stringify({ id: note.id, version: 3, data: note }));
	writeFileSync(join(saved, 'verdicts', 'case.json'), JSON.stringify({ state: 'changes', by: 'u_someone', at }));
	writeFileSync(join(saved, 'notes', 'nbad000000.json'), JSON.stringify({ model: 'nope', text: 'about a model this project lacks' }));

	const first = importArtifact(dir, { from: saved, images: assets });
	assert.deepEqual(first.added, [note.id]);
	assert.equal(first.images, 1);
	assert.equal(first.verdicts, 1);
	assert.equal(first.skipped.length, 1);
	const review = new Review(dir);
	assert.equal(review.getNote(note.id)?.text, 'The knob is too big');
	assert.ok(existsSync(join(review.imagesDir, `${image}.png`)));
	assert.equal(review.getVerdicts().case.state, 'changes');

	assert.equal(importArtifact(dir, { from: saved, images: assets }).unchanged, 1, 'importing again changes nothing');

	// a reply added on each side: both are kept
	review.addReply(note.id, { by: 'agent', name: 'Claude', text: 'Made the knob 20% smaller.' });
	const later = '2026-01-03T09:00:00.000Z';
	writeFileSync(join(saved, 'notes', `${note.id}.json`), JSON.stringify({ ...note, replies: [{ by: 'human', name: '', user: 'u_someone', text: 'Also round its edge', at: later }], updated: later, version: 2 }));
	const second = importArtifact(dir, { from: saved, images: assets });
	assert.deepEqual(second.updated, [note.id]);
	// (in time order: the artifact's reply is dated before the agent's, which was written just now)
	assert.deepEqual(review.getNote(note.id)?.replies.map((r) => r.text), ['Also round its edge', 'Made the knob 20% smaller.']);
});
