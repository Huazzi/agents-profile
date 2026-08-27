# Agents Profile

This repository is the portable source of truth for agent-facing assets that should survive provider and device switches.

Remote repository intended for this profile:

```text
https://github.com/Huazzi/agents-profile
```

## Layout

```text
.agents/
  skills/                         # Full skill contents are versioned here.
  plugins/registry.json           # Portable plugin source/install metadata.
  mcp/registry.json               # Portable MCP source/build/launch metadata.
  mcp/env.example/                # Example env files only; no secrets.
  scripts/bootstrap.ps1           # Cross-platform PowerShell bootstrap.
  scripts/install-plugins.ps1
  scripts/install-mcp.ps1
  scripts/check-skills.ps1        # Read-only skill upstream/local drift report.
  scripts/bootstrap.sh            # macOS/Linux bash bootstrap.
  scripts/install-plugins.sh
  scripts/install-mcp.sh
  scripts/check-skills.sh         # macOS/Linux wrapper for skill checks.
  scripts/check-skills.js         # Shared checker implementation.
```

## Design

- `skills/` is tracked as full content.
- Plugins are tracked as metadata only: name, marketplace, Git repository, ref, and install selector.
- MCP servers are tracked as metadata only: name, Git repository, ref, setup commands, launch command template, and environment file names.
- Runtime caches and generated provider state are not tracked. For Codex, those belong under `~/.codex/`.
- Secrets are not tracked. Put real MCP credentials under `mcp/env/` locally; that directory is ignored by Git.

## Current registered assets

### Plugins

- `feature-dev-codex@huazzi-plugins`
  - Repository: `https://github.com/Huazzi/feature-dev-codex.git`
  - Ref: `master`

### MCP servers

- `graylog_tst`
- `graylog_prd`

Both use:

```text
https://github.com/Huazzi/graylog43-query-mcp.git
```

with ref `main` and profiles `tst` / `prd`.

## Bootstrap on Windows

1. Install prerequisites:
   - Git
   - Node.js 20+
   - npm
   - Codex CLI
   - PowerShell 7+ recommended, though Windows PowerShell may also work for basic usage

2. Clone this profile to the user home directory:

```powershell
git clone https://github.com/Huazzi/agents-profile.git $HOME\.agents
```

If the directory already exists, initialize it and connect the remote instead:

```powershell
cd $HOME\.agents
git init
git remote add origin https://github.com/Huazzi/agents-profile.git
git pull origin main
```

3. Create the local MCP env file:

```powershell
New-Item -ItemType Directory -Force -Path $HOME\.agents\mcp\env
Copy-Item $HOME\.agents\mcp\env.example\graylog43-query-mcp.env.example $HOME\.agents\mcp\env\graylog43-query-mcp.env
notepad $HOME\.agents\mcp\env\graylog43-query-mcp.env
```

Do not commit files under `mcp/env/`.

4. Run bootstrap:

```powershell
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\bootstrap.ps1
```

Useful variants:

```powershell
# Only install/register plugins
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\bootstrap.ps1 -SkipMcp

# Only clone/build/register MCP servers
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\bootstrap.ps1 -SkipPlugins

# Download/register MCP without running npm install/build
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\bootstrap.ps1 -SkipMcpSetup

# Prepare metadata/sources without provider registration
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\bootstrap.ps1 -NoInstallPlugins -NoRegisterMcp
```

## Bootstrap on macOS

1. Install prerequisites:

```bash
# If you use Homebrew:
brew install git node
npm install -g @openai/codex
```

If `codex` is installed another way, make sure it is available on `PATH`:

```bash
codex --version
```

2. Clone this profile to your macOS home directory:

```bash
git clone https://github.com/Huazzi/agents-profile.git ~/.agents
```

If `~/.agents` already exists:

```bash
cd ~/.agents
git init
git remote add origin https://github.com/Huazzi/agents-profile.git 2>/dev/null || true
git pull origin main
```

3. Create the local MCP env file:

```bash
mkdir -p ~/.agents/mcp/env
cp ~/.agents/mcp/env.example/graylog43-query-mcp.env.example ~/.agents/mcp/env/graylog43-query-mcp.env
${EDITOR:-vi} ~/.agents/mcp/env/graylog43-query-mcp.env
```

Do not commit files under `mcp/env/`.

4. Run bootstrap with the bash scripts:

```bash
bash ~/.agents/scripts/bootstrap.sh
```

Useful variants:

```bash
# Only install/register plugins
bash ~/.agents/scripts/bootstrap.sh --skip-mcp

# Only clone/build/register MCP servers
bash ~/.agents/scripts/bootstrap.sh --skip-plugins

# Download/register MCP without running npm install/build
bash ~/.agents/scripts/bootstrap.sh --skip-mcp-setup

# Prepare metadata/sources without provider registration
bash ~/.agents/scripts/bootstrap.sh --no-install-plugins --no-register-mcp
```

Optional: if your Git checkout preserves executable bits or you set them locally, you can run:

```bash
chmod +x ~/.agents/scripts/*.sh
~/.agents/scripts/bootstrap.sh
```


## Checking skill updates

`skills/` is versioned as full content, while `.skill-lock.json` records provenance for many externally sourced skills. Use the checker before deciding whether to refresh any external skill.

Windows:

```powershell
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\check-skills.ps1

# Check only GitHub-sourced skills
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\check-skills.ps1 -SourceType github

# Check one skill without network access, using existing caches only
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\check-skills.ps1 -Skill code-review -NoFetch

# Machine-readable output
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\check-skills.ps1 -Json
```

macOS/Linux:

```bash
bash ~/.agents/scripts/check-skills.sh

# Check only GitHub-sourced skills
bash ~/.agents/scripts/check-skills.sh --source-type github

# Check one skill without network access, using existing caches only
bash ~/.agents/scripts/check-skills.sh --skill code-review --no-fetch

# Machine-readable output
bash ~/.agents/scripts/check-skills.sh --json
```

The first version is intentionally read-only for `skills/`:

- GitHub skills are compared by hashing the local skill folder and the upstream skill folder from a cached clone under `.cache/skill-sources/`.
- `well-known` skills are checked against the remote `SKILL.md` only; local `references/` and other assets are not verified in this first version.
- `untracked-local` means a directory exists under `skills/` but is not recorded in `.skill-lock.json`.
- `up-to-date` means local content currently matches the upstream content according to the configured check mode (`skill-folder`, `source-file`, or `well-known` `SKILL.md` check). The report intentionally does not split these into separate up-to-date status names.


To register provenance for a local skill that appears as `untracked-local`:

Windows:

```powershell
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\check-skills.ps1 -Register "my-skill=https://github.com/owner/repo/blob/main/skills/my-skill/SKILL.md"

# Interactive prompt for every local skill missing from .skill-lock.json
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\check-skills.ps1 -RegisterMissing
```

macOS/Linux:

```bash
bash ~/.agents/scripts/check-skills.sh --register "my-skill=https://github.com/owner/repo/blob/main/skills/my-skill/SKILL.md"

# Interactive prompt for every local skill missing from .skill-lock.json
bash ~/.agents/scripts/check-skills.sh --register-missing
```

Registration edits only `.skill-lock.json`; it does not download, update, or overwrite files under `skills/`. GitHub `blob/.../SKILL.md` and `tree/.../<skill-dir>` URLs are registered as `skill-folder` checks. GitHub `blob/.../<other-file>.md` URLs are registered as `source-file` checks. Plain repository URLs are registered as `metadata-only` unless you later add a `skillPath` manually.
Recommended workflow:

```bash
bash ~/.agents/scripts/check-skills.sh
# inspect the report
# if you manually update any skill, review with git diff before committing
```
## Cross-platform path conventions

Registries should use placeholders instead of hard-coded machine paths:

```text
${AGENTS_HOME}
${HOME}
${USERPROFILE}
```

Prefer forward slashes in registry paths, for example:

```json
"${AGENTS_HOME}/mcp-sources/graylog43-query-mcp/dist/index.js"
```

The install scripts expand these placeholders on both Windows and macOS.

## How the scripts work

### Plugins

`plugins/registry.json` currently records `feature-dev-codex` as a `codex-marketplace-repo`. The install script runs commands equivalent to:

```powershell
codex plugin marketplace add https://github.com/Huazzi/feature-dev-codex.git --ref master
codex plugin add feature-dev-codex@huazzi-plugins
```

`codex plugin add` writes installed plugin state into the active Codex home/config and cache. It does not write back into this registry.

### MCP

`mcp/registry.json` records `graylog_tst` and `graylog_prd`. The install script clones or updates the MCP repo under:

```text
~/.agents/mcp-sources/graylog43-query-mcp
```

Then it runs:

```bash
npm install
npm run build
```

Finally it recreates Codex MCP registrations using `codex mcp remove` followed by `codex mcp add`.

## Git hygiene

Recommended first commit:

```bash
cd ~/.agents
git init
git remote add origin https://github.com/Huazzi/agents-profile.git
git add skills plugins mcp scripts .gitignore README.md .skill-lock.json
git commit -m "Initialize portable agents profile"
git branch -M main
git push -u origin main
```

Before committing, inspect staged files carefully and ensure no secrets are included:

```bash
git status --short
git diff --cached --stat
git diff --cached
```
