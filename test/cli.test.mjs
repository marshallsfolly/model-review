import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Review } from '../lib/review.mjs';
import { ROOT, DEMO, tempDir } from './fixtures.mjs';

const env = { ...process.env, XDG_CONFIG_HOME: tempDir('config') };
/** @param {...string} args */
const cli = (...args) => execFileSync(process.execPath, [join(ROOT, 'bin', 'model-review.mjs'), ...args], { env, encoding: 'utf8' });

test('init, add, notes, show, reply, status: the commands people and agents use', () => {
	const dir = join(tempDir('cli'), 'proj');
	assert.match(cli('init', dir, '--title', 'Workbench'), /Started "Workbench"/);
	assert.match(cli('nodes', join(DEMO, 'models', 'crank.glb')), /^frame\ncrank\nrod\npiston\n$/);
	const added = cli('add', dir, join(DEMO, 'models', 'crank.glb'), '--name', 'Crank', '--part', 'rod=Connecting rod', '--part', 'nope=Missing');
	assert.match(added, /Added "Crank" \(id crank\) as models\/crank\.glb; 4 nodes/);
	assert.match(added, /warning: no nodes named "nope"/);
	assert.throws(() => cli('add', dir, join(DEMO, 'models', 'crank.glb'), '--name', 'Crank'), /already has a model "crank"/);

	const note = new Review(dir).createNote({ model: 'crank', text: 'The rod looks thin', node: 'rod', local: [0.04, 0, 0], world: [0.07, 0.016, 0], radius: 0.003 }, { author: 'Sam' });
	assert.match(cli('notes', dir), new RegExp(`Crank #1  ${note.id}  \\[open\\]  Sam`));
	assert.equal(JSON.parse(cli('notes', dir, '--json')).notes[0].id, note.id);
	assert.match(cli('notes', dir, '--status', 'resolved'), /No resolved notes/);
	const shown = cli('show', dir, note.id.slice(0, 8));
	assert.match(shown, /Where: Connecting rod \(node rod\) at x 70 mm, y 16 mm, z 0 mm, 3 mm round/);
	assert.match(shown, /In node rod's own frame: \[0.04, 0, 0\]/);

	assert.match(cli('reply', dir, note.id, 'Made', 'the', 'rod', '8', 'mm', 'thick.', '--name', 'Claude'), /Replied under/);
	const after = new Review(dir).getNote(note.id);
	assert.deepEqual(after?.replies.map((r) => [r.by, r.name, r.text]), [['agent', 'Claude', 'Made the rod 8 mm thick.']]);
	assert.match(cli('status', dir), /crank\s+no verdict\s+0 open, 1 addressed, 0 resolved/);
	assert.throws(() => cli('show', dir, 'nzzzzzzz'), /no note "nzzzzzzz"/);
});
