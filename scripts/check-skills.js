#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const readline = require('readline/promises');

function usage() {
  return `Usage: check-skills.js [options]\n\nCheck options:\n  --agents-home DIR       Agents profile directory. Defaults to AGENTS_HOME or parent of scripts/.\n  --source-type TYPE      all, github, or well-known. Default: all.\n  --skill NAME            Check one skill. Can be repeated or comma-separated.\n  --json                  Emit machine-readable JSON.\n  --no-fetch              Do not access network. Use existing Git caches only; skip well-known fetches.\n\nRegistration options:\n  --register NAME=URL     Add/update one lock entry from a GitHub URL. Can be repeated.\n  --register-missing      Prompt for source URLs for local skills missing from .skill-lock.json.\n  --force-register        Allow --register to overwrite existing lock entries.\n\nOther:\n  --help                  Show this help.\n\nCheck mode is read-only for skills/. Registration mode only edits .skill-lock.json.`;
}

function parseArgs(argv) {
  const opts = {
    agentsHome: process.env.AGENTS_HOME || path.resolve(__dirname, '..'),
    sourceType: 'all',
    skills: [],
    json: false,
    noFetch: false,
    help: false,
    registerSpecs: [],
    registerMissing: false,
    forceRegister: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agents-home') opts.agentsHome = path.resolve(requireValue(argv, ++i, arg));
    else if (arg === '--source-type') opts.sourceType = requireValue(argv, ++i, arg);
    else if (arg === '--skill') opts.skills.push(...requireValue(argv, ++i, arg).split(',').map((s) => s.trim()).filter(Boolean));
    else if (arg === '--json') opts.json = true;
    else if (arg === '--no-fetch') opts.noFetch = true;
    else if (arg === '--register') opts.registerSpecs.push(requireValue(argv, ++i, arg));
    else if (arg === '--register-missing') opts.registerMissing = true;
    else if (arg === '--force-register') opts.forceRegister = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!['all', 'github', 'well-known'].includes(opts.sourceType)) {
    throw new Error(`--source-type must be one of: all, github, well-known`);
  }
  opts.skills = [...new Set(opts.skills)];
  return opts;
}

function requireValue(argv, index, option) {
  if (index >= argv.length || argv[index].startsWith('--')) throw new Error(`${option} requires a value`);
  return argv[index];
}

function log(opts, message) {
  if (opts.json) console.error(message);
  else console.log(message);
}

function warn(_opts, message) {
  console.error(`WARNING: ${message}`);
}

function run(file, args, options = {}) {
  const result = cp.spawnSync(file, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
    timeout: options.timeout || 120000,
  });
  if (result.error) {
    if (options.ignoreFailure) return { ok: false, status: -1, stdout: result.stdout || '', stderr: String(result.error.message || result.error) };
    throw result.error;
  }
  if (result.status !== 0) {
    if (options.ignoreFailure) return { ok: false, status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
    throw new Error(`${file} ${args.join(' ')} exited with code ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  }
  return { ok: true, status: 0, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function listFilesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function sha1Buffer(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function hashFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  return sha1Buffer(fs.readFileSync(file));
}

function hashDir(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = listFilesRecursive(dir);
  const hash = crypto.createHash('sha1');
  for (const file of files) {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function safeRepoDirName(repoUrl) {
  let parsed;
  try { parsed = new URL(repoUrl); } catch (_) { parsed = null; }
  const base = parsed ? `${parsed.hostname}${parsed.pathname}` : repoUrl.replace(/^git@([^:]+):/, '$1/');
  const readable = base
    .replace(/\.git$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'repo';
  const suffix = crypto.createHash('sha1').update(repoUrl).digest('hex').slice(0, 10);
  return `${readable}-${suffix}`;
}

function ensureGithubRepo(opts, repoUrl) {
  const cacheRoot = path.join(opts.agentsHome, '.cache', 'skill-sources');
  const repoDir = path.join(cacheRoot, safeRepoDirName(repoUrl));
  const gitDir = path.join(repoDir, '.git');

  const cloneFresh = () => {
    fs.mkdirSync(cacheRoot, { recursive: true });
    log(opts, `Cloning ${repoUrl} -> ${repoDir}`);
    const clone = run('git', ['clone', '--depth', '1', String(repoUrl), repoDir], { ignoreFailure: true, timeout: 180000, capture: opts.json });
    if (!clone.ok) return { ok: false, error: compactError(clone.stderr) || compactError(clone.stdout) || `git clone exited with code ${clone.status}` };
    return { ok: true };
  };

  if (!fs.existsSync(gitDir)) {
    if (opts.noFetch) return { repoDir, ok: false, error: 'cache-missing-and-no-fetch' };
    const cloned = cloneFresh();
    if (!cloned.ok) return { repoDir, ok: false, error: cloned.error };
  } else {
    const validHead = run('git', ['-C', repoDir, 'rev-parse', '--verify', 'HEAD'], { capture: true, ignoreFailure: true });
    if (!validHead.ok) {
      if (opts.noFetch) return { repoDir, ok: false, error: 'cache-has-no-valid-head-and-no-fetch' };
      warn(opts, `Removing incomplete skill source cache: ${repoDir}`);
      fs.rmSync(repoDir, { recursive: true, force: true });
      const cloned = cloneFresh();
      if (!cloned.ok) return { repoDir, ok: false, error: cloned.error };
    }
  }

  if (!opts.noFetch) {
    log(opts, `Fetching ${repoUrl}`);
    const fetch = run('git', ['-C', repoDir, 'fetch', '--all', '--prune'], { ignoreFailure: true, capture: opts.json });
    if (!fetch.ok) return { repoDir, ok: false, error: compactError(fetch.stderr) || compactError(fetch.stdout) || `git fetch exited with code ${fetch.status}` };
    run('git', ['-C', repoDir, 'pull', '--ff-only'], { ignoreFailure: true, capture: opts.json });
  }

  const head = run('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { capture: true, ignoreFailure: true });
  return { repoDir, ok: head.ok, head: head.ok ? head.stdout.trim() : null, error: head.ok ? null : compactError(head.stderr) || 'failed to resolve cache HEAD' };
}

function lsRemoteHead(repoUrl) {
  const result = run('git', ['ls-remote', String(repoUrl), 'HEAD'], { capture: true, ignoreFailure: true, timeout: 60000 });
  if (!result.ok) return { ok: false, error: compactError(result.stderr) || compactError(result.stdout) || `git ls-remote exited with code ${result.status}` };
  const hash = result.stdout.trim().split(/\s+/)[0] || null;
  return { ok: Boolean(hash), head: hash, error: hash ? null : 'git ls-remote returned no HEAD' };
}

function compactError(value) {
  return String(value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-3).join(' | ');
}

function skillDirFromSkillPath(repoDir, skillPath, skillName) {
  if (skillPath) {
    const normalized = String(skillPath).replace(/\\/g, '/');
    const dirPart = normalized.endsWith('/SKILL.md') ? normalized.slice(0, -'/SKILL.md'.length) : path.posix.dirname(normalized);
    return path.join(repoDir, ...dirPart.split('/').filter(Boolean));
  }
  return path.join(repoDir, 'skills', skillName);
}

function fileFromRepoPath(repoDir, repoPath) {
  if (!repoPath) return null;
  return path.join(repoDir, ...String(repoPath).replace(/\\/g, '/').split('/').filter(Boolean));
}

function fetchUrlBuffer(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.get(parsed, {
      timeout: 15000,
      headers: { 'User-Agent': 'agents-profile-check-skills/1.0' },
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, parsed).toString();
        fetchUrlBuffer(next, redirects - 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

function classifyGithub(localHash, upstreamHash, lockHash) {
  if (!localHash) return 'missing-local';
  if (!upstreamHash) return 'missing-upstream';
  if (localHash === upstreamHash) return 'up-to-date';
  if (lockHash && localHash === lockHash && upstreamHash !== lockHash) return 'upstream-updated';
  if (lockHash && upstreamHash === lockHash && localHash !== lockHash) return 'local-modified';
  if (lockHash && localHash !== lockHash && upstreamHash !== lockHash) return 'local-and-upstream-differ-from-lock';
  return 'differs-from-upstream';
}

function classifySourceFile(localHash, upstreamHash) {
  if (!localHash) return 'missing-local-source';
  if (!upstreamHash) return 'missing-upstream';
  return localHash === upstreamHash ? 'up-to-date' : 'source-file-differs-from-upstream';
}

function makeResultBase(name, entry, localDir) {
  return {
    name,
    sourceType: entry.sourceType || 'unknown',
    checkMode: entry.checkMode || null,
    source: entry.source || null,
    sourceUrl: entry.sourceUrl || null,
    sourceRef: entry.sourceRef || null,
    sourceInputUrl: entry.sourceInputUrl || null,
    skillPath: entry.skillPath || null,
    localSourcePath: entry.localSourcePath || null,
    status: 'unknown',
    localDir,
    localHash: null,
    upstreamHash: null,
    localSourceHash: null,
    lockHash: entry.skillFolderHash || null,
    upstreamRef: null,
    note: null,
  };
}

function parseGithubUrl(input, skillName) {
  let url;
  try { url = new URL(input); } catch (error) { throw new Error(`Invalid URL for ${skillName}: ${input}`); }
  if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) {
    throw new Error(`Only github.com URLs are supported by --register for now: ${input}`);
  }
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2) throw new Error(`GitHub URL must include owner/repo: ${input}`);
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  const source = `${owner}/${repo}`;
  const sourceUrl = `https://github.com/${source}.git`;
  const tail = parts.slice(2);
  const entry = {
    source,
    sourceType: 'github',
    sourceUrl,
    sourceInputUrl: input,
  };

  if (tail[0] === 'blob' && tail.length >= 3) {
    entry.sourceRef = tail[1];
    entry.skillPath = tail.slice(2).join('/');
    entry.checkMode = entry.skillPath.endsWith('/SKILL.md') || entry.skillPath === 'SKILL.md' ? 'skill-folder' : 'source-file';
    return entry;
  }

  if (tail[0] === 'tree' && tail.length >= 2) {
    entry.sourceRef = tail[1];
    const treePath = tail.slice(2).join('/');
    entry.skillPath = treePath ? `${treePath.replace(/\/$/, '')}/SKILL.md` : 'SKILL.md';
    entry.checkMode = 'skill-folder';
    return entry;
  }

  entry.checkMode = 'metadata-only';
  return entry;
}

function findMatchingLocalSourceFile(localDir, remotePath) {
  if (!remotePath || !fs.existsSync(localDir)) return null;
  const normalizedRemote = String(remotePath).replace(/\\/g, '/');
  const basename = path.posix.basename(normalizedRemote);
  const files = listFilesRecursive(localDir);
  const candidates = files
    .map((file) => ({ file, rel: path.relative(localDir, file).split(path.sep).join('/') }))
    .filter((item) => path.posix.basename(item.rel) === basename);
  if (candidates.length === 0) return null;
  const exactSuffix = candidates.find((item) => normalizedRemote.endsWith(item.rel) || item.rel.endsWith(normalizedRemote));
  const chosen = exactSuffix || candidates.find((item) => item.rel.includes('/source/')) || candidates[0];
  return chosen.rel;
}

function buildLockEntryFromUrl(agentsHome, skillName, inputUrl, overrides = {}) {
  const skillsRoot = path.join(agentsHome, 'skills');
  const localDir = path.join(skillsRoot, skillName);
  if (!fs.existsSync(localDir)) throw new Error(`Local skill directory not found: ${localDir}`);
  const entry = { ...parseGithubUrl(inputUrl, skillName), ...overrides };
  const now = new Date().toISOString();
  entry.skillFolderHash = hashDir(localDir) || '';
  if (entry.checkMode === 'source-file') {
    entry.localSourcePath = entry.localSourcePath || findMatchingLocalSourceFile(localDir, entry.skillPath);
    if (entry.localSourcePath) entry.localSourceHash = hashFile(path.join(localDir, ...entry.localSourcePath.split('/')));
  }
  entry.installedAt = entry.installedAt || now;
  entry.updatedAt = now;
  return entry;
}

async function registerEntries(opts, lock, skillsRoot) {
  const registered = [];
  for (const spec of opts.registerSpecs) {
    const idx = spec.indexOf('=');
    if (idx <= 0) throw new Error(`--register must use NAME=URL format, got: ${spec}`);
    const name = spec.slice(0, idx).trim();
    const url = spec.slice(idx + 1).trim();
    if (!name || !url) throw new Error(`--register must use NAME=URL format, got: ${spec}`);
    if (lock.skills[name] && !opts.forceRegister) throw new Error(`Skill '${name}' already exists in lock. Use --force-register to overwrite.`);
    lock.skills[name] = buildLockEntryFromUrl(opts.agentsHome, name, url);
    registered.push({ name, sourceUrl: lock.skills[name].sourceUrl, checkMode: lock.skills[name].checkMode, skillPath: lock.skills[name].skillPath || null });
  }

  if (opts.registerMissing) {
    const lockedNames = new Set(Object.keys(lock.skills));
    const localNames = fs.readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    const missing = localNames.filter((name) => !lockedNames.has(name));
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      for (const name of missing) {
        const answer = (await rl.question(`Source URL for '${name}' (empty to skip): `)).trim();
        if (!answer) continue;
        lock.skills[name] = buildLockEntryFromUrl(opts.agentsHome, name, answer);
        registered.push({ name, sourceUrl: lock.skills[name].sourceUrl, checkMode: lock.skills[name].checkMode, skillPath: lock.skills[name].skillPath || null });
      }
    } finally {
      rl.close();
    }
  }

  return registered;
}

function writeLock(lockPath, lock) {
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return 0;
  }

  const lockPath = path.join(opts.agentsHome, '.skill-lock.json');
  const skillsRoot = path.join(opts.agentsHome, 'skills');
  if (!fs.existsSync(lockPath)) throw new Error(`Skill lock not found: ${lockPath}`);
  if (!fs.existsSync(skillsRoot)) throw new Error(`Skills directory not found: ${skillsRoot}`);

  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.skills = lock.skills || {};

  if (opts.registerSpecs.length || opts.registerMissing) {
    const registered = await registerEntries(opts, lock, skillsRoot);
    if (registered.length) writeLock(lockPath, lock);
    const payload = { updatedAt: new Date().toISOString(), lockPath, registered, skipped: registered.length === 0 ? 'no entries registered' : null };
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`Updated lock: ${lockPath}`);
      if (registered.length === 0) console.log('No entries registered.');
      for (const item of registered) console.log(`  ${item.name}: ${item.sourceUrl} [${item.checkMode}]${item.skillPath ? ` ${item.skillPath}` : ''}`);
    }
    return 0;
  }

  const lockedSkills = lock.skills || {};
  const requested = new Set(opts.skills);
  const shouldInclude = (name, entry) => {
    if (requested.size && !requested.has(name)) return false;
    const sourceType = entry.sourceType || 'unknown';
    return opts.sourceType === 'all' || sourceType === opts.sourceType;
  };

  const results = [];
  const repoStateByUrl = new Map();

  for (const [name, entry] of Object.entries(lockedSkills).sort(([a], [b]) => a.localeCompare(b))) {
    if (!shouldInclude(name, entry || {})) continue;
    const sourceType = entry.sourceType || 'unknown';
    const checkMode = entry.checkMode || 'skill-folder';
    const localDir = path.join(skillsRoot, name);
    const result = makeResultBase(name, entry || {}, localDir);
    result.checkMode = checkMode;

    if (sourceType === 'github') {
      result.localHash = hashDir(localDir);
      if (!entry.sourceUrl) {
        result.status = 'unchecked';
        result.note = 'missing sourceUrl in .skill-lock.json';
        results.push(result);
        continue;
      }

      if (checkMode === 'metadata-only') {
        if (opts.noFetch) {
          result.status = 'metadata-only';
          result.note = 'source metadata is registered; upstream HEAD not checked because --no-fetch was provided';
        } else {
          const remote = lsRemoteHead(entry.sourceUrl);
          result.upstreamRef = remote.head || null;
          result.status = remote.ok ? 'metadata-only' : 'unchecked';
          result.note = remote.ok ? 'source metadata is registered; no skill content path is configured for comparison' : remote.error;
        }
        results.push(result);
        continue;
      }

      if (!repoStateByUrl.has(entry.sourceUrl)) repoStateByUrl.set(entry.sourceUrl, ensureGithubRepo(opts, entry.sourceUrl));
      const repoState = repoStateByUrl.get(entry.sourceUrl);
      result.upstreamRef = repoState.head || null;
      if (!repoState.ok) {
        result.status = 'unchecked';
        result.note = repoState.error;
        results.push(result);
        continue;
      }

      if (checkMode === 'source-file') {
        const localSourceFile = entry.localSourcePath ? path.join(localDir, ...String(entry.localSourcePath).replace(/\\/g, '/').split('/').filter(Boolean)) : path.join(localDir, 'SKILL.md');
        const upstreamFile = fileFromRepoPath(repoState.repoDir, entry.skillPath);
        result.localSourceHash = hashFile(localSourceFile);
        result.upstreamHash = hashFile(upstreamFile);
        result.status = classifySourceFile(result.localSourceHash, result.upstreamHash);
        result.note = `Source-file mode compares upstream ${entry.skillPath || '(missing skillPath)'} to local ${entry.localSourcePath || 'SKILL.md'}.`;
        results.push(result);
        continue;
      }

      const upstreamDir = skillDirFromSkillPath(repoState.repoDir, entry.skillPath, name);
      result.upstreamDir = upstreamDir;
      result.upstreamHash = hashDir(upstreamDir);
      result.status = classifyGithub(result.localHash, result.upstreamHash, result.lockHash);
      if (result.lockHash && result.localHash !== result.lockHash && result.upstreamHash !== result.lockHash) {
        result.note = 'The lock hash does not match this checker hash for local or upstream content; use local/upstream comparison as the first-version signal.';
      }
      results.push(result);
      continue;
    }

    if (sourceType === 'well-known') {
      const localSkillMd = path.join(localDir, 'SKILL.md');
      result.scope = 'SKILL.md only';
      result.localHash = hashFile(localSkillMd);
      if (!result.localHash) {
        result.status = 'missing-local';
        results.push(result);
        continue;
      }
      if (opts.noFetch) {
        result.status = 'unchecked';
        result.note = 'well-known checks require network; skipped because --no-fetch was provided';
        results.push(result);
        continue;
      }
      if (!entry.sourceUrl) {
        result.status = 'unchecked';
        result.note = 'missing sourceUrl in .skill-lock.json';
        results.push(result);
        continue;
      }
      try {
        const buffer = await fetchUrlBuffer(entry.sourceUrl);
        result.upstreamHash = sha1Buffer(buffer);
        result.status = result.localHash === result.upstreamHash ? 'up-to-date' : 'skill-md-differs-from-upstream';
        result.note = 'Only SKILL.md is checked for well-known sources; local references/ assets are not verified.';
      } catch (error) {
        result.status = 'unchecked';
        result.note = `failed to fetch well-known URL: ${error.message}`;
      }
      results.push(result);
      continue;
    }

    result.localHash = hashDir(localDir);
    result.status = 'unchecked';
    result.note = `unsupported sourceType: ${sourceType}`;
    results.push(result);
  }

  if (opts.sourceType === 'all') {
    const lockedNames = new Set(Object.keys(lockedSkills));
    const localNames = fs.readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of localNames) {
      if (lockedNames.has(name)) continue;
      if (requested.size && !requested.has(name)) continue;
      const localDir = path.join(skillsRoot, name);
      results.push({
        name,
        sourceType: 'local-untracked',
        checkMode: null,
        source: null,
        sourceUrl: null,
        skillPath: null,
        status: 'untracked-local',
        localDir,
        localHash: hashDir(localDir),
        upstreamHash: null,
        lockHash: null,
        upstreamRef: null,
        note: 'Present under skills/ but not recorded in .skill-lock.json. Use --register NAME=URL or --register-missing to add provenance.',
      });
    }
  }

  const summary = results.reduce((acc, item) => {
    acc.total += 1;
    acc.byStatus[item.status] = (acc.byStatus[item.status] || 0) + 1;
    acc.bySourceType[item.sourceType] = (acc.bySourceType[item.sourceType] || 0) + 1;
    return acc;
  }, { total: 0, byStatus: {}, bySourceType: {} });

  const payload = {
    checkedAt: new Date().toISOString(),
    agentsHome: opts.agentsHome,
    lockPath,
    skillsRoot,
    options: { sourceType: opts.sourceType, skills: opts.skills, noFetch: opts.noFetch },
    summary,
    results,
  };

  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else printHumanReport(payload);

  return 0;
}

function printHumanReport(payload) {
  console.log('\nSkill update check report');
  console.log(`Agents home: ${payload.agentsHome}`);
  console.log(`Checked at : ${payload.checkedAt}`);
  console.log(`Total      : ${payload.summary.total}`);
  console.log('');
  console.log('Status summary:');
  for (const [status, count] of Object.entries(payload.summary.byStatus).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${status.padEnd(36)} ${count}`);
  }
  console.log('');

  const rows = payload.results.map((item) => ({
    name: item.name,
    type: item.sourceType,
    status: item.status,
    source: item.sourceUrl || item.source || '-',
    note: item.note || '',
  }));
  const widths = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    type: Math.max(4, ...rows.map((r) => r.type.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
  };
  console.log(`${'Skill'.padEnd(widths.name)}  ${'Type'.padEnd(widths.type)}  ${'Status'.padEnd(widths.status)}  Source / note`);
  console.log(`${'-'.repeat(widths.name)}  ${'-'.repeat(widths.type)}  ${'-'.repeat(widths.status)}  ${'-'.repeat(40)}`);
  for (const row of rows) {
    const detail = row.note ? `${row.source} | ${row.note}` : row.source;
    console.log(`${row.name.padEnd(widths.name)}  ${row.type.padEnd(widths.type)}  ${row.status.padEnd(widths.status)}  ${detail}`);
  }
  console.log('');
  console.log('Notes:');
  console.log('  - This checker does not update skills/. It only reports differences.');
  console.log('  - GitHub skill-folder mode compares local folder hash vs cached upstream folder hash.');
  console.log('  - GitHub source-file mode compares one upstream source file to the recorded local source file.');
  console.log('  - GitHub metadata-only mode records provenance and checks remote HEAD only, without cloning content.');
  console.log('  - well-known skills are checked against remote SKILL.md only; references/assets are not verified.');
  console.log('  - untracked-local means the skill exists locally but is not recorded in .skill-lock.json; use --register or --register-missing.');
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(`ERROR: ${error.stack || error.message || error}`);
  process.exit(1);
});
