'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const script = path.resolve(__dirname, '../update-skills.js');
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function fixture(t, ref) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-cache-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'upstream');
  const home = path.join(root, 'agents');
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(home, 'skills'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'SKILL.md'), 'old\n');
  git(repo, 'add', 'SKILL.md');
  git(repo, 'commit', '-m', 'old');
  git(repo, 'tag', 'v1');
  fs.writeFileSync(path.join(home, '.skill-lock.json'), JSON.stringify({ skills: { demo: {
    sourceType: 'github', sourceUrl: repo, sourceRef: ref, skillPath: 'SKILL.md', checkMode: 'skill-folder',
  } } }));
  const update = (...args) => JSON.parse(execFileSync(process.execPath, [script, '--agents-home', home, '--skill', 'demo', '--json', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).results[0];
  update();
  fs.writeFileSync(path.join(repo, 'SKILL.md'), 'new\n');
  git(repo, 'commit', '-am', 'new');
  return { repo, home, update, content: () => fs.readFileSync(path.join(home, 'skills', 'demo', 'SKILL.md'), 'utf8') };
}

test('updates from remote branch rather than stale cached local branch', (t) => {
  const f = fixture(t, 'main');
  const result = f.update();
  assert.equal(result.status, 'updated');
  assert.equal(f.content(), 'new\n');
  assert.equal(result.upstreamRef, git(f.repo, 'rev-parse', 'HEAD'));
  const lock = JSON.parse(fs.readFileSync(path.join(f.home, '.skill-lock.json'), 'utf8'));
  assert.equal(lock.skills.demo.skillFolderHash, result.upstreamHash);
  assert.ok(lock.skills.demo.updatedAt);
});

test('updates the default branch after a detached cache checkout', (t) => {
  const f = fixture(t, undefined);
  const cache = path.join(f.home, '.cache', 'skill-sources');
  git(path.join(cache, fs.readdirSync(cache)[0]), 'checkout', '--detach');
  const result = f.update();
  assert.equal(result.status, 'updated');
  assert.equal(f.content(), 'new\n');
});

test('preserves a pinned tag', (t) => {
  const f = fixture(t, 'v1');
  assert.equal(f.update().status, 'up-to-date');
  assert.equal(f.content(), 'old\n');
});

test('no-fetch uses the last fetched remote branch', (t) => {
  const f = fixture(t, 'main');
  assert.equal(f.update('--no-fetch').status, 'up-to-date');
  assert.equal(f.content(), 'old\n');
  assert.equal(f.update().status, 'updated');
  assert.equal(f.content(), 'new\n');
});
