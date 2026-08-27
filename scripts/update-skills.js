#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

function usage() {
  return `用法: update-skills.js [options]\n\n更新选项:\n  --agents-home DIR       agents profile 目录。默认使用 AGENTS_HOME，或 scripts/ 的父目录。\n  --skill NAME            只更新指定 skill；可重复使用，也可用逗号分隔。未指定时更新全部可更新 skills。\n  --all                   显式更新全部可更新 skills；未指定 --skill 时默认等价于 --all。\n  --source-type TYPE      all、github 或 well-known。默认: all。\n  --dry-run               只展示将要更新的内容，不写入 skills/ 或 .skill-lock.json。\n  --no-fetch              不访问网络；仅使用已有 Git 缓存。well-known 更新会被跳过。\n  --json                  输出机器可读 JSON。\n\n其他:\n  --help                  显示本帮助。\n\n说明:\n  - 这是显式更新器，会写入 skills/，并在成功后更新 .skill-lock.json 中的 hash/updatedAt。\n  - github skill-folder 会用 upstream skill 目录替换本地 skills/<name>/。\n  - github source-file 只更新 lock 中登记的 localSourcePath，不自动改写本地 SKILL.md。\n  - well-known 只更新本地 SKILL.md，不处理 references/assets。\n  - metadata-only 只登记来源，缺少内容路径，因此不会被更新。`;
}

function parseArgs(argv) {
  const opts = {
    agentsHome: process.env.AGENTS_HOME || path.resolve(__dirname, '..'),
    skills: [],
    all: false,
    sourceType: 'all',
    dryRun: false,
    noFetch: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agents-home') opts.agentsHome = path.resolve(requireValue(argv, ++i, arg));
    else if (arg === '--skill') opts.skills.push(...requireValue(argv, ++i, arg).split(',').map((s) => s.trim()).filter(Boolean));
    else if (arg === '--all') opts.all = true;
    else if (arg === '--source-type') opts.sourceType = requireValue(argv, ++i, arg);
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--no-fetch') opts.noFetch = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`未知选项: ${arg}`);
  }

  if (!['all', 'github', 'well-known'].includes(opts.sourceType)) {
    throw new Error(`--source-type 必须是以下之一: all, github, well-known`);
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

function compactError(value) {
  return String(value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-3).join(' | ');
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

function checkoutRef(opts, repoDir, sourceRef) {
  if (!sourceRef) {
    if (!opts.noFetch) run('git', ['-C', repoDir, 'pull', '--ff-only'], { ignoreFailure: true, capture: opts.json });
    return;
  }

  const targets = [String(sourceRef), `origin/${sourceRef}`];
  for (const target of targets) {
    const checkout = run('git', ['-C', repoDir, 'checkout', '--detach', target], { ignoreFailure: true, capture: true });
    if (checkout.ok) return;
  }

  if (!opts.noFetch) {
    const fetched = run('git', ['-C', repoDir, 'fetch', 'origin', String(sourceRef), '--depth', '1'], { ignoreFailure: true, capture: true, timeout: 180000 });
    if (fetched.ok) {
      const checkout = run('git', ['-C', repoDir, 'checkout', '--detach', 'FETCH_HEAD'], { ignoreFailure: true, capture: true });
      if (checkout.ok) return;
    }
  }

  throw new Error(`无法 checkout sourceRef '${sourceRef}'，repo: ${repoDir}`);
}

function ensureGithubRepo(opts, repoUrl, sourceRef) {
  const cacheRoot = path.join(opts.agentsHome, '.cache', 'skill-sources');
  const repoDir = path.join(cacheRoot, safeRepoDirName(repoUrl));
  const gitDir = path.join(repoDir, '.git');

  if (!fs.existsSync(gitDir)) {
    if (opts.noFetch) return { repoDir, ok: false, error: '缓存不存在，且指定了 --no-fetch' };
    fs.mkdirSync(cacheRoot, { recursive: true });
    log(opts, `Cloning ${repoUrl} -> ${repoDir}`);
    const clone = run('git', ['clone', '--depth', '1', String(repoUrl), repoDir], { ignoreFailure: true, timeout: 180000, capture: opts.json });
    if (!clone.ok) return { repoDir, ok: false, error: compactError(clone.stderr) || compactError(clone.stdout) || `git clone 退出码为 ${clone.status}` };
  } else {
    const validHead = run('git', ['-C', repoDir, 'rev-parse', '--verify', 'HEAD'], { capture: true, ignoreFailure: true });
    if (!validHead.ok) {
      if (opts.noFetch) return { repoDir, ok: false, error: '缓存没有有效 HEAD，且指定了 --no-fetch' };
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.mkdirSync(cacheRoot, { recursive: true });
      const clone = run('git', ['clone', '--depth', '1', String(repoUrl), repoDir], { ignoreFailure: true, timeout: 180000, capture: opts.json });
      if (!clone.ok) return { repoDir, ok: false, error: compactError(clone.stderr) || compactError(clone.stdout) || `git clone 退出码为 ${clone.status}` };
    }
  }

  if (!opts.noFetch) {
    log(opts, `Fetching ${repoUrl}`);
    const fetch = run('git', ['-C', repoDir, 'fetch', '--all', '--tags', '--prune', '--depth', '1'], { ignoreFailure: true, capture: opts.json, timeout: 180000 });
    if (!fetch.ok) return { repoDir, ok: false, error: compactError(fetch.stderr) || compactError(fetch.stdout) || `git fetch 退出码为 ${fetch.status}` };
  }

  try {
    checkoutRef(opts, repoDir, sourceRef);
  } catch (error) {
    return { repoDir, ok: false, error: error.message };
  }

  const head = run('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { capture: true, ignoreFailure: true });
  return { repoDir, ok: head.ok, head: head.ok ? head.stdout.trim() : null, error: head.ok ? null : compactError(head.stderr) || '无法解析缓存 HEAD' };
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
      headers: { 'User-Agent': 'agents-profile-update-skills/1.0' },
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

function assertInside(parent, child) {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  const rel = path.relative(parentResolved, childResolved);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return;
  throw new Error(`目标路径越界，拒绝写入: ${childResolved}`);
}

function copyDirClean(srcDir, destDir) {
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) throw new Error(`upstream skill 目录不存在: ${srcDir}`);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(srcDir, destDir, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== '.git' && base !== '.DS_Store' && base !== 'Thumbs.db';
    },
  });
}

function ensureParentDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
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

function summarize(results) {
  return results.reduce((acc, item) => {
    acc.total += 1;
    acc.byStatus[item.status] = (acc.byStatus[item.status] || 0) + 1;
    acc.bySourceType[item.sourceType] = (acc.bySourceType[item.sourceType] || 0) + 1;
    return acc;
  }, { total: 0, byStatus: {}, bySourceType: {} });
}

function printHumanReport(payload) {
  console.log('\nSkill 显式更新报告');
  console.log(`Agents home : ${payload.agentsHome}`);
  console.log(`更新时间    : ${payload.updatedAt}`);
  console.log(`Dry run     : ${payload.options.dryRun ? 'yes' : 'no'}`);
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
    mode: item.checkMode || '-',
    status: item.status,
    note: item.note || item.sourceUrl || '-',
  }));
  const widths = {
    name: Math.max(displayWidth('Skill'), ...rows.map((r) => displayWidth(r.name))),
    type: Math.max(displayWidth('来源类型'), ...rows.map((r) => displayWidth(r.type))),
    mode: Math.max(displayWidth('checkMode'), ...rows.map((r) => displayWidth(r.mode))),
    status: Math.max(displayWidth('状态'), ...rows.map((r) => displayWidth(r.status))),
  };
  console.log(`${padDisplay('Skill', widths.name)}  ${padDisplay('来源类型', widths.type)}  ${padDisplay('checkMode', widths.mode)}  ${padDisplay('状态', widths.status)}  备注`);
  console.log(`${'-'.repeat(widths.name)}  ${'-'.repeat(widths.type)}  ${'-'.repeat(widths.mode)}  ${'-'.repeat(widths.status)}  ${'-'.repeat(40)}`);
  for (const row of rows) {
    console.log(`${padDisplay(row.name, widths.name)}  ${padDisplay(row.type, widths.type)}  ${padDisplay(row.mode, widths.mode)}  ${padDisplay(row.status, widths.status)}  ${row.note}`);
  }
  console.log('');
  console.log('说明:');
  console.log('  - updated 表示已用 upstream 内容写入本地 skills/，并更新 lock hash。');
  console.log('  - up-to-date 表示本地内容已经与 upstream 一致，未写入。');
  console.log('  - skipped-metadata-only 表示该 skill 只有来源元数据，没有可更新的内容路径。');
  console.log('  - source-file 只更新 localSourcePath，不自动改写 SKILL.md。');
}

function writeLock(lockPath, lock) {
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

async function updateGithubSkill(opts, context, name, entry) {
  const { skillsRoot, repoStateByKey } = context;
  const checkMode = entry.checkMode || 'skill-folder';
  const localDir = path.join(skillsRoot, name);
  assertInside(skillsRoot, localDir);

  const result = {
    name,
    sourceType: 'github',
    checkMode,
    sourceUrl: entry.sourceUrl || null,
    status: 'unknown',
    localDir,
    upstreamRef: null,
    note: null,
  };

  if (!entry.sourceUrl) {
    result.status = 'skipped-unsupported';
    result.note = '缺少 .skill-lock.json 中的 sourceUrl';
    return result;
  }

  if (checkMode === 'metadata-only') {
    result.status = 'skipped-metadata-only';
    result.note = '只登记来源元数据；没有可更新的内容路径。';
    return result;
  }

  const key = `${entry.sourceUrl}#${entry.sourceRef || ''}`;
  if (!repoStateByKey.has(key)) repoStateByKey.set(key, ensureGithubRepo(opts, entry.sourceUrl, entry.sourceRef));
  const repoState = repoStateByKey.get(key);
  result.upstreamRef = repoState.head || null;
  if (!repoState.ok) {
    result.status = 'skipped-error';
    result.note = repoState.error;
    return result;
  }

  if (checkMode === 'source-file') {
    const upstreamFile = fileFromRepoPath(repoState.repoDir, entry.skillPath);
    if (!upstreamFile || !fs.existsSync(upstreamFile)) {
      result.status = 'missing-upstream';
      result.note = `upstream 文件不存在: ${entry.skillPath || '(缺少 skillPath)'}`;
      return result;
    }
    const localRel = entry.localSourcePath || entry.skillPath || 'SKILL.md';
    const localSourceFile = path.join(localDir, ...String(localRel).replace(/\\/g, '/').split('/').filter(Boolean));
    assertInside(localDir, localSourceFile);

    const upstreamHash = hashFile(upstreamFile);
    const localHash = hashFile(localSourceFile);
    result.upstreamHash = upstreamHash;
    result.localSourceHash = localHash;
    if (localHash === upstreamHash) {
      result.status = 'up-to-date';
      result.note = `${localRel} 已与 upstream 一致。`;
      return result;
    }
    if (opts.dryRun) {
      result.status = 'dry-run-update';
      result.note = `将更新 ${localRel}。`;
      return result;
    }

    ensureParentDir(localSourceFile);
    fs.copyFileSync(upstreamFile, localSourceFile);
    entry.localSourcePath = String(localRel).replace(/\\/g, '/');
    entry.localSourceHash = hashFile(localSourceFile);
    entry.skillFolderHash = hashDir(localDir) || '';
    entry.updatedAt = new Date().toISOString();
    result.status = 'updated-source-file';
    result.localSourceHash = entry.localSourceHash;
    result.skillFolderHash = entry.skillFolderHash;
    result.note = `已更新 ${entry.localSourcePath}；如 SKILL.md 由该源文件改写而来，请手动同步。`;
    return result;
  }

  if (checkMode !== 'skill-folder') {
    result.status = 'skipped-unsupported';
    result.note = `不支持的 checkMode: ${checkMode}`;
    return result;
  }

  const upstreamDir = skillDirFromSkillPath(repoState.repoDir, entry.skillPath, name);
  if (!fs.existsSync(upstreamDir) || !fs.statSync(upstreamDir).isDirectory()) {
    result.status = 'missing-upstream';
    result.note = `upstream skill 目录不存在: ${entry.skillPath || `skills/${name}/SKILL.md`}`;
    return result;
  }

  const upstreamHash = hashDir(upstreamDir);
  const localHash = hashDir(localDir);
  result.upstreamHash = upstreamHash;
  result.localHash = localHash;
  if (localHash === upstreamHash) {
    result.status = 'up-to-date';
    result.note = '本地 skill 目录已与 upstream 一致。';
    if (!opts.dryRun && entry.skillFolderHash !== localHash) {
      entry.skillFolderHash = localHash || '';
      entry.updatedAt = new Date().toISOString();
      result.lockAdjusted = true;
    }
    return result;
  }
  if (opts.dryRun) {
    result.status = 'dry-run-update';
    result.note = `将用 upstream 目录替换 ${path.relative(opts.agentsHome, localDir).split(path.sep).join('/')}。`;
    return result;
  }

  copyDirClean(upstreamDir, localDir);
  entry.skillFolderHash = hashDir(localDir) || '';
  entry.updatedAt = new Date().toISOString();
  result.status = 'updated';
  result.localHash = entry.skillFolderHash;
  result.skillFolderHash = entry.skillFolderHash;
  result.note = '已用 upstream skill 目录替换本地 skill。';
  return result;
}

async function updateWellKnownSkill(opts, context, name, entry) {
  const { skillsRoot } = context;
  const localDir = path.join(skillsRoot, name);
  assertInside(skillsRoot, localDir);
  const result = {
    name,
    sourceType: 'well-known',
    checkMode: entry.checkMode || 'skill-md',
    sourceUrl: entry.sourceUrl || null,
    status: 'unknown',
    localDir,
    note: null,
  };

  if (opts.noFetch) {
    result.status = 'skipped-error';
    result.note = 'well-known 更新需要网络；由于指定 --no-fetch，已跳过。';
    return result;
  }
  if (!entry.sourceUrl) {
    result.status = 'skipped-unsupported';
    result.note = '缺少 .skill-lock.json 中的 sourceUrl';
    return result;
  }

  let buffer;
  try {
    buffer = await fetchUrlBuffer(entry.sourceUrl);
  } catch (error) {
    result.status = 'skipped-error';
    result.note = `获取 well-known URL 失败: ${error.message}`;
    return result;
  }

  const localSkillMd = path.join(localDir, 'SKILL.md');
  const upstreamHash = sha1Buffer(buffer);
  const localHash = hashFile(localSkillMd);
  result.upstreamHash = upstreamHash;
  result.localHash = localHash;
  if (localHash === upstreamHash) {
    result.status = 'up-to-date';
    result.note = '本地 SKILL.md 已与 upstream 一致。';
    if (!opts.dryRun && entry.skillFolderHash !== hashDir(localDir)) {
      entry.skillFolderHash = hashDir(localDir) || '';
      entry.updatedAt = new Date().toISOString();
      result.lockAdjusted = true;
    }
    return result;
  }
  if (opts.dryRun) {
    result.status = 'dry-run-update';
    result.note = '将更新本地 SKILL.md。';
    return result;
  }

  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(localSkillMd, buffer);
  entry.skillFolderHash = hashDir(localDir) || '';
  entry.updatedAt = new Date().toISOString();
  result.status = 'updated';
  result.localHash = hashFile(localSkillMd);
  result.skillFolderHash = entry.skillFolderHash;
  result.note = '已更新本地 SKILL.md；references/assets 未处理。';
  return result;
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
  const requested = new Set(opts.skills);
  const results = [];
  const context = { skillsRoot, repoStateByKey: new Map() };

  const shouldInclude = (name, entry) => {
    if (requested.size && !requested.has(name)) return false;
    const sourceType = entry.sourceType || 'unknown';
    return opts.sourceType === 'all' || sourceType === opts.sourceType;
  };

  for (const name of requested) {
    if (!lock.skills[name]) {
      results.push({ name, sourceType: 'unknown', checkMode: null, status: 'not-in-lock', note: '未在 .skill-lock.json 中登记。' });
    }
  }

  for (const [name, entry] of Object.entries(lock.skills).sort(([a], [b]) => a.localeCompare(b))) {
    if (!shouldInclude(name, entry || {})) continue;
    const sourceType = entry.sourceType || 'unknown';
    if (sourceType === 'github') results.push(await updateGithubSkill(opts, context, name, entry || {}));
    else if (sourceType === 'well-known') results.push(await updateWellKnownSkill(opts, context, name, entry || {}));
    else results.push({ name, sourceType, checkMode: entry.checkMode || null, status: 'skipped-unsupported', note: `不支持的 sourceType: ${sourceType}` });
  }

  if (!opts.dryRun) {
    const changed = results.some((item) => ['updated', 'updated-source-file'].includes(item.status) || item.lockAdjusted);
    if (changed) writeLock(lockPath, lock);
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    agentsHome: opts.agentsHome,
    lockPath,
    skillsRoot,
    options: { skills: opts.skills, all: opts.all || opts.skills.length === 0, sourceType: opts.sourceType, dryRun: opts.dryRun, noFetch: opts.noFetch },
    summary: summarize(results),
    results,
  };

  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else printHumanReport(payload);
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(`错误: ${error.stack || error.message || error}`);
  process.exit(1);
});

