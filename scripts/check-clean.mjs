import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = new URL("../", import.meta.url);
const forbidden = [
  /laura/i,
  /geppie/i,
  /chispita/i,
  /lilazul/i,
  /nuestra cajita/i,
  /un poquito de magia/i,
  /supabase/i,
  /xn[o0]str[a-z0-9]+\.supabase/i,
  /sb_(?:secret|publishable|service_role)_/i,
];
const textExtensions = new Set([
  ".js",
  ".mjs",
  ".json",
  ".md",
  ".html",
  ".sql",
  ".example",
  "",
]);

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result;
}

const rootPath = decodeURIComponent(root.pathname).replace(/^\/(?:([A-Za-z]):)/, "$1:");
const failures = [];
for (const path of await files(rootPath)) {
  if (path.endsWith("scripts\\check-clean.mjs") || path.endsWith("scripts/check-clean.mjs")) continue;
  if (!textExtensions.has(extname(path)) && !path.endsWith(".env.example")) continue;
  const text = await readFile(path, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(text)) failures.push(`${relative(rootPath, path)} matched ${pattern}`);
  }
}
if (failures.length) throw new Error(`Personal or provider-specific residue found:\n${failures.join("\n")}`);
console.log("Clean-template scan passed: no personal branding, personal data, or Supabase residue.");
