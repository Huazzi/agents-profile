# Agents Profile

This repository is the portable source of truth for agent-facing assets that should survive provider/device switches.

Remote repository intended for this profile:

```text
https://github.com/Huazzi/agents-profile
```

## Layout

```text
.agents/
  skills/                 # Full skill contents are versioned here.
  plugins/registry.json   # Portable plugin source/install metadata.
  mcp/registry.json       # Portable MCP source/build/launch metadata.
  scripts/bootstrap.ps1   # Restore plugins and MCP registrations on a device.
  scripts/install-plugins.ps1
  scripts/install-mcp.ps1
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

## Bootstrap on a new Windows device

1. Install prerequisites:
   - Git
   - Node.js 20+
   - npm
   - Codex CLI

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

3. Create the local MCP env file. The current MCP command templates expect:

```text
$HOME\.agents\mcp\env\graylog43-query-mcp.env
```

Do not commit this file. Populate it with the variables required by `graylog43-query-mcp`.

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

# Dry-ish run for metadata/source preparation without provider registration
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\bootstrap.ps1 -NoInstallPlugins -NoRegisterMcp
```

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
$HOME\.agents\mcp-sources\graylog43-query-mcp
```

Then it runs:

```powershell
npm install
npm run build
```

Finally it recreates Codex MCP registrations using `codex mcp remove` followed by `codex mcp add`.

## Git hygiene

Recommended first commit:

```powershell
cd $HOME\.agents
git init
git remote add origin https://github.com/Huazzi/agents-profile.git
git add skills plugins mcp scripts .gitignore README.md .skill-lock.json
git commit -m "Initialize portable agents profile"
git branch -M main
git push -u origin main
```

Before committing, inspect staged files carefully and ensure no secrets are included:

```powershell
git status --short
git diff --cached --stat
git diff --cached
```
