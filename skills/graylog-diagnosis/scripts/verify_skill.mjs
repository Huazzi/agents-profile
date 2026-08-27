import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const requiredFiles = [
  "SKILL.md",
  "manifest.json",
  "agents/openai.yaml",
  "references/mcp-integration.md",
];
const requiredSkillTerms = [
  "graylog43-query-mcp",
  "get_system_info",
  "list_allowed_streams",
  "search_stream",
  "search_stream_absolute",
  "不得使用旧脚本",
];

const results = await Promise.all(
  requiredFiles.map(async (relativePath) => {
    try {
      await readFile(join(root, relativePath), "utf8");
      return null;
    } catch {
      return relativePath;
    }
  }),
);
const missingFiles = results.filter(Boolean);
const skill = missingFiles.length === 0 ? await readFile(join(root, "SKILL.md"), "utf8") : "";
const manifest = missingFiles.length === 0 ? JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) : {};
const missingSkillTerms = requiredSkillTerms.filter((term) => !skill.includes(term));
const validManifest =
  manifest.runtime === "mcp" &&
  manifest.query_mcp === "graylog43-query-mcp" &&
  manifest.read_only === true;
const result = {
  valid: missingFiles.length === 0 && missingSkillTerms.length === 0 && validManifest,
  missingFiles,
  missingSkillTerms,
  manifest,
  nodeVersion: process.version,
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.valid ? 0 : 1;
