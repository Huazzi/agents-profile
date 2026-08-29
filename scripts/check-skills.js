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
  return `用法: check-skills.js [options]\n\n检查选项:\n  --agents-home DIR       agents profile 目录。默认使用 AGENTS_HOME，或 scripts/ 的父目录。\n  --source-type TYPE      all、github、well-known、lark-cli 或 codex-plugin。默认: all。\n  --skill NAME            只检查指定 skill；可重复使用，也可用逗号分隔。\n  --json                  输出机器可读 JSON。\n  --no-fetch              不访问网络；仅使用已有 Git 缓存，并跳过 well-known 远程获取。\n\n登记选项:\n  --register NAME=URL     从 GitHub URL 新增/更新一条 lock 记录；可重复使用。\n  --register-missing      对 .skill-lock.json 中缺失的本地 skills 逐个提示输入来源 URL。\n  --force-register        允许 --register 覆盖已有 lock 记录。\n\n其他:\n  --help                  显示本帮助。\n\n检查模式不会修改 skills/。登记模式只会修改 .skill-lock.json。`;
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
    else throw new Error(`未知选项: ${arg}`);
  }

  if (!['all', 'github', 'well-known', 'lark-cli', 'codex-plugin'].includes(opts.sourceType)) {
    throw new Error(`--source-type 必须是以下之一: all, github, well-known, lark-cli, codex-plugin`);
  }
  opts.skills = [...new Set(opts.skills)];
  return opts;
}

function requireValue(argv, index, option) {
  if (index >= argv.length || argv[index].startsWith('--')) throw new Error(`${option} 需要提供值`);
  return argv[index];
}

function log(opts, message) {
  if (opts.json) console.error(message);
  else console.log(message);
}

function warn(_opts, message) {
  console.error(`警告: ${message}`);
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
    throw new Error(`${file} ${args.join(' ')} 退出码为 ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  }
  return { ok: true, status: 0, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function listFilesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
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
    if (!clone.ok) return { ok: false, error: compactError(clone.stderr) || compactError(clone.stdout) || `git clone 退出码为 ${clone.status}` };
    return { ok: true };
  };

  if (!fs.existsSync(gitDir)) {
    if (opts.noFetch) return { repoDir, ok: false, error: '缓存不存在，且指定了 --no-fetch' };
    const cloned = cloneFresh();
    if (!cloned.ok) return { repoDir, ok: false, error: cloned.error };
  } else {
    const validHead = run('git', ['-C', repoDir, 'rev-parse', '--verify', 'HEAD'], { capture: true, ignoreFailure: true });
    if (!validHead.ok) {
      if (opts.noFetch) return { repoDir, ok: false, error: '缓存没有有效 HEAD，且指定了 --no-fetch' };
      warn(opts, `正在移除不完整的 skill source 缓存: ${repoDir}`);
      fs.rmSync(repoDir, { recursive: true, force: true });
      const cloned = cloneFresh();
      if (!cloned.ok) return { repoDir, ok: false, error: cloned.error };
    }
  }

  if (!opts.noFetch) {
    log(opts, `Fetching ${repoUrl}`);
    const fetch = run('git', ['-C', repoDir, 'fetch', '--all', '--prune'], { ignoreFailure: true, capture: opts.json });
    if (!fetch.ok) return { repoDir, ok: false, error: compactError(fetch.stderr) || compactError(fetch.stdout) || `git fetch 退出码为 ${fetch.status}` };
    run('git', ['-C', repoDir, 'pull', '--ff-only'], { ignoreFailure: true, capture: opts.json });
  }

  const head = run('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { capture: true, ignoreFailure: true });
  return { repoDir, ok: head.ok, head: head.ok ? head.stdout.trim() : null, error: head.ok ? null : compactError(head.stderr) || '无法解析缓存 HEAD' };
}

function lsRemoteHead(repoUrl) {
  const result = run('git', ['ls-remote', String(repoUrl), 'HEAD'], { capture: true, ignoreFailure: true, timeout: 60000 });
  if (!result.ok) return { ok: false, error: compactError(result.stderr) || compactError(result.stdout) || `git ls-remote 退出码为 ${result.status}` };
  const hash = result.stdout.trim().split(/\s+/)[0] || null;
  return { ok: Boolean(hash), head: hash, error: hash ? null : 'git ls-remote 未返回 HEAD' };
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
    req.on('timeout', () => req.destroy(new Error('请求超时')));
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

function virtualHash(files) {
  const root = new Map();
  for (const [rel, content] of files) {
    const parts = String(rel).split('/').filter(Boolean);
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      if (!dir.has(part)) dir.set(part, new Map());
      dir = dir.get(part);
    }
    dir.set(parts[parts.length - 1], content);
  }

  const ordered = [];
  const walk = (prefix, dir) => {
    for (const [name, value] of [...dir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (value instanceof Map) walk(rel, value);
      else ordered.push([rel, value]);
    }
  };
  walk('', root);

  const hash = crypto.createHash('sha1');
  for (const [rel, content] of ordered) {
    hash.update(rel);
    hash.update('\0');
    hash.update(Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function runJson(file, args, env = {}) {
  const result = cp.spawnSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    timeout: 120000,
    env: { ...process.env, ...env },
  });
  if (result.error) return { ok: false, error: String(result.error.message || result.error) };
  if (result.status !== 0) return { ok: false, error: compactError(result.stderr) || compactError(result.stdout) || `${file} ${args.join(' ')} 退出码为 ${result.status}` };
  try { return { ok: true, data: JSON.parse(result.stdout), stdout: result.stdout }; }
  catch (error) { return { ok: false, error: `无法解析 JSON 输出: ${error.message}` }; }
}

function runText(file, args, env = {}) {
  const result = cp.spawnSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    timeout: 120000,
    env: { ...process.env, ...env },
  });
  if (result.error) return { ok: false, error: String(result.error.message || result.error) };
  if (result.status !== 0) return { ok: false, error: compactError(result.stderr) || compactError(result.stdout) || `${file} ${args.join(' ')} 退出码为 ${result.status}` };
  return { ok: true, stdout: result.stdout };
}

function larkCliEnv() {
  return { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' };
}

function getLarkCliVersion() {
  const result = runText('lark-cli', ['--version'], larkCliEnv());
  if (!result.ok) return { ok: false, error: result.error };
  const version = (result.stdout.match(/(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/) || [])[1] || result.stdout.trim();
  return { ok: Boolean(version), version, error: version ? null : '无法解析 lark-cli 版本' };
}

function listLarkCliSkillFiles(skillName) {
  const files = [];
  const pending = [skillName];
  while (pending.length) {
    const current = pending.shift();
    const listed = runJson('lark-cli', ['skills', 'list', current], larkCliEnv());
    if (!listed.ok) return { ok: false, error: listed.error };
    const entries = Array.isArray(listed.data.entries) ? listed.data.entries : [];
    for (const entry of entries) {
      if (!entry || !entry.path) continue;
      if (entry.is_dir) pending.push(entry.path);
      else files.push(entry.path);
    }
  }
  return { ok: true, files: [...new Set(files)].sort((a, b) => a.localeCompare(b)) };
}

function hashLarkCliSkill(skillName) {
  const listed = listLarkCliSkillFiles(skillName);
  if (!listed.ok) return { ok: false, error: listed.error };
  const files = [];
  for (const cliPath of listed.files) {
    const read = runText('lark-cli', ['skills', 'read', cliPath], larkCliEnv());
    if (!read.ok) return { ok: false, error: `${cliPath}: ${read.error}` };
    const prefix = `${skillName}/`;
    const rel = cliPath.startsWith(prefix) ? cliPath.slice(prefix.length) : cliPath;
    files.push([rel, read.stdout]);
  }
  return { ok: true, hash: virtualHash(files), fileCount: files.length };
}

function findPluginSkillDir(entry, skillName) {
  const home = os.homedir();
  const marketplaceName = entry.marketplaceName || 'huazzi-plugins';
  const pluginName = entry.pluginName || path.basename(String(entry.sourceInputUrl || '')).split('@')[0] || entry.source || 'feature-dev-codex';
  const candidates = [];
  candidates.push(path.join(home, '.codex', '.tmp', 'marketplaces', marketplaceName, 'plugins', pluginName, 'skills', skillName));
  if (entry.pluginVersion) candidates.push(path.join(home, '.codex', 'plugins', 'cache', marketplaceName, pluginName, String(entry.pluginVersion), 'skills', skillName));
  const cacheRoot = path.join(home, '.codex', 'plugins', 'cache', marketplaceName, pluginName);
  if (fs.existsSync(cacheRoot)) {
    for (const version of fs.readdirSync(cacheRoot).sort((a, b) => b.localeCompare(a))) {
      candidates.push(path.join(cacheRoot, version, 'skills', skillName));
    }
  }
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) || null;
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
  try { url = new URL(input); } catch (error) { throw new Error(`URL 无效（${skillName}）: ${input}`); }
  if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) {
    throw new Error(`目前 --register 只支持 github.com URL: ${input}`);
  }
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2) throw new Error(`GitHub URL 必须包含 owner/repo: ${input}`);
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
  if (!fs.existsSync(localDir)) throw new Error(`未找到本地 skill 目录: ${localDir}`);
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
    if (idx <= 0) throw new Error(`--register 必须使用 NAME=URL 格式，当前为: ${spec}`);
    const name = spec.slice(0, idx).trim();
    const url = spec.slice(idx + 1).trim();
    if (!name || !url) throw new Error(`--register 必须使用 NAME=URL 格式，当前为: ${spec}`);
    if (lock.skills[name] && !opts.forceRegister) throw new Error(`Skill '${name}' 已存在于 lock 中。若要覆盖，请使用 --force-register。`);
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
        const answer = (await rl.question(`请输入 '${name}' 的来源 URL（留空跳过）: `)).trim();
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
  if (!fs.existsSync(lockPath)) throw new Error(`未找到 skill lock: ${lockPath}`);
  if (!fs.existsSync(skillsRoot)) throw new Error(`未找到 skills 目录: ${skillsRoot}`);

  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.skills = lock.skills || {};

  if (opts.registerSpecs.length || opts.registerMissing) {
    const registered = await registerEntries(opts, lock, skillsRoot);
    if (registered.length) writeLock(lockPath, lock);
    const payload = { updatedAt: new Date().toISOString(), lockPath, registered, skipped: registered.length === 0 ? '没有登记任何条目' : null };
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`已更新 lock: ${lockPath}`);
      if (registered.length === 0) console.log('没有登记任何条目。');
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
        result.note = '缺少 .skill-lock.json 中的 sourceUrl';
        results.push(result);
        continue;
      }

      if (checkMode === 'metadata-only') {
        if (opts.noFetch) {
          result.status = 'metadata-only';
          result.note = '已登记来源元数据；由于指定 --no-fetch，未检查 upstream HEAD';
        } else {
          const remote = lsRemoteHead(entry.sourceUrl);
          result.upstreamRef = remote.head || null;
          result.status = remote.ok ? 'metadata-only' : 'unchecked';
          result.note = remote.ok ? '已登记来源元数据；未配置 skill 内容路径，因此不做内容比较' : remote.error;
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
        result.note = `source-file 模式会比较 upstream ${entry.skillPath || '(缺少 skillPath)'} 与本地 ${entry.localSourcePath || 'SKILL.md'}。`;
        results.push(result);
        continue;
      }

      const upstreamDir = skillDirFromSkillPath(repoState.repoDir, entry.skillPath, name);
      result.upstreamDir = upstreamDir;
      result.upstreamHash = hashDir(upstreamDir);
      result.status = classifyGithub(result.localHash, result.upstreamHash, result.lockHash);
      if (result.lockHash && result.localHash !== result.lockHash && result.upstreamHash !== result.lockHash) {
        result.note = 'lock hash 与本检查器计算的本地/上游 hash 不一致；第一版请优先参考 local/upstream 对比结果。';
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
        result.note = 'well-known 检查需要网络；由于指定 --no-fetch，已跳过';
        results.push(result);
        continue;
      }
      if (!entry.sourceUrl) {
        result.status = 'unchecked';
        result.note = '缺少 .skill-lock.json 中的 sourceUrl';
        results.push(result);
        continue;
      }
      try {
        const buffer = await fetchUrlBuffer(entry.sourceUrl);
        result.upstreamHash = sha1Buffer(buffer);
        result.status = result.localHash === result.upstreamHash ? 'up-to-date' : 'skill-md-differs-from-upstream';
        result.note = 'well-known 来源仅检查 SKILL.md；不会验证本地 references/ 或其他 assets。';
      } catch (error) {
        result.status = 'unchecked';
        result.note = `获取 well-known URL 失败: ${error.message}`;
      }
      results.push(result);
      continue;
    }

    if (sourceType === 'lark-cli') {
      result.localHash = hashDir(localDir);
      const version = getLarkCliVersion();
      if (!version.ok) {
        result.status = 'unchecked';
        result.note = `无法运行 lark-cli: ${version.error}`;
        results.push(result);
        continue;
      }
      result.upstreamRef = `v${version.version}`;
      const upstream = hashLarkCliSkill(name);
      if (!upstream.ok) {
        result.status = 'unchecked';
        result.note = `读取 lark-cli 内置 skill 失败: ${upstream.error}`;
        results.push(result);
        continue;
      }
      result.upstreamHash = upstream.hash;
      result.status = classifyGithub(result.localHash, result.upstreamHash, result.lockHash);
      result.note = `lark-cli ${version.version} 内置 skill，共 ${upstream.fileCount} 个文件。`;
      if (entry.cliVersion && entry.cliVersion !== version.version) result.note += ` lock 登记 cliVersion=${entry.cliVersion}。`;
      if (result.lockHash && result.localHash !== result.lockHash) result.note += ' lock hash 与本地目录不一致。';
      results.push(result);
      continue;
    }

    if (sourceType === 'codex-plugin') {
      result.localHash = hashDir(localDir);
      const upstreamDir = findPluginSkillDir(entry || {}, name);
      result.upstreamDir = upstreamDir;
      if (!upstreamDir) {
        result.status = 'unchecked';
        result.note = '未找到本地 Codex plugin marketplace/cache 中的 skill 来源目录；可先运行 codex plugin marketplace upgrade / codex plugin add。';
        results.push(result);
        continue;
      }
      result.upstreamHash = hashDir(upstreamDir);
      result.status = classifyGithub(result.localHash, result.upstreamHash, result.lockHash);
      result.note = `Codex plugin skill 来源: ${upstreamDir}`;
      if (result.lockHash && result.localHash !== result.lockHash) result.note += ' lock hash 与本地目录不一致。';
      results.push(result);
      continue;
    }

    result.localHash = hashDir(localDir);
    result.status = 'unchecked';
    result.note = `不支持的 sourceType: ${sourceType}`;
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
        note: '存在于 skills/ 下，但未记录到 .skill-lock.json。可使用 --register NAME=URL 或 --register-missing 补充来源。',
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

function displayWidth(value) {
  let width = 0;
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    width += (
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) ? 2 : 1;
  }
  return width;
}

function padDisplay(value, width) {
  const text = String(value);
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function printHumanReport(payload) {
  console.log('\nSkill 更新检查报告');
  console.log(`Agents home : ${payload.agentsHome}`);
  console.log(`检查时间    : ${payload.checkedAt}`);
  console.log(`总计        : ${payload.summary.total}`);
  console.log('');
  console.log('状态汇总:');
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
    name: Math.max(displayWidth('Skill'), ...rows.map((r) => displayWidth(r.name))),
    type: Math.max(displayWidth('来源类型'), ...rows.map((r) => displayWidth(r.type))),
    status: Math.max(displayWidth('状态'), ...rows.map((r) => displayWidth(r.status))),
  };
  console.log(`${padDisplay('Skill', widths.name)}  ${padDisplay('来源类型', widths.type)}  ${padDisplay('状态', widths.status)}  来源 / 备注`);
  console.log(`${'-'.repeat(widths.name)}  ${'-'.repeat(widths.type)}  ${'-'.repeat(widths.status)}  ${'-'.repeat(40)}`);
  for (const row of rows) {
    const detail = row.note ? `${row.source} | ${row.note}` : row.source;
    console.log(`${padDisplay(row.name, widths.name)}  ${padDisplay(row.type, widths.type)}  ${padDisplay(row.status, widths.status)}  ${detail}`);
  }
  console.log('');
  console.log('说明:');
  console.log('  - 本检查器不会更新 skills/，只报告差异。');
  console.log('  - GitHub skill-folder 模式会比较本地目录 hash 与缓存的 upstream 目录 hash。');
  console.log('  - GitHub source-file 模式会比较一个 upstream 源文件与 lock 记录的本地源文件。');
  console.log('  - GitHub metadata-only 模式只记录来源并检查远程 HEAD，不做内容克隆或内容比较。');
  console.log('  - well-known skills 只检查远程 SKILL.md；不会验证 references/assets。');
  console.log('  - lark-cli 模式会比较本地目录与当前 lark-cli 内置 skill 文件。');
  console.log('  - codex-plugin 模式会比较本地目录与本机 Codex plugin marketplace/cache 中的 skill 文件。');
  console.log('  - untracked-local 表示本地存在该 skill，但 .skill-lock.json 未登记；可使用 --register 或 --register-missing。');
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(`错误: ${error.stack || error.message || error}`);
  process.exit(1);
});



