import { readFile } from "node:fs/promises";
import sharp from "sharp";

const root = new URL("../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

const [packageText, lockText, server, oauth, railwayText, readme, envExample] =
  await Promise.all([
    text("package.json"),
    text("package-lock.json"),
    text("server.js"),
    text("lib/oauth.js"),
    text("railway.json"),
    text("README.md"),
    text(".env.example"),
  ]);

const packageJson = JSON.parse(packageText);
const packageLock = JSON.parse(lockText);
const railway = JSON.parse(railwayText);
const icon = await readFile(new URL("public/assets/magic-reactions-template-icon.png", root));
const iconMetadata = await sharp(icon).metadata();
const failures = [];
const requireCondition = (condition, message) => {
  if (!condition) failures.push(message);
};

requireCondition(
  server.includes(`const APP_VERSION = "${packageJson.version}";`),
  "server APP_VERSION must match package.json",
);
requireCondition(
  packageLock.version === packageJson.version &&
    packageLock.packages?.[""]?.version === packageJson.version,
  "package-lock versions must match package.json",
);
requireCondition(
  railway.deploy?.healthcheckPath === "/ready",
  "Railway must use the configuration-aware /ready healthcheck",
);

for (const heading of [
  "## About Hosting",
  "## Why Deploy",
  "## Common Use Cases",
  "## Dependencies for Hosting",
  "### Deployment Dependencies",
]) {
  requireCondition(readme.includes(heading), `README is missing ${heading}`);
}

for (const name of [
  "PUBLIC_BASE_URL",
  "GIPHY_API_KEY",
  "OWNER_CODE",
  "OAUTH_SIGNING_SECRET",
  "DATABASE_URL",
  "BUCKET",
  "ACCESS_KEY_ID",
  "SECRET_ACCESS_KEY",
  "REGION",
  "ENDPOINT",
]) {
  requireCondition(
    new RegExp(`^${name}=`, "m").test(envExample),
    `.env.example is missing ${name}`,
  );
}

for (const contract of [
  "Only `GIPHY_API_KEY` is requested from the installer.",
  "`${{ secret(32) }}`",
  "`${{ secret(64) }}`",
  "`https://${{RAILWAY_PUBLIC_DOMAIN}}`",
  "`${{Postgres Live.DATABASE_URL}}`",
  "`${{Reactions Bucket.BUCKET}}`",
]) {
  requireCondition(readme.includes(contract), `README is missing template contract: ${contract}`);
}

requireCondition(
  server.includes('url.pathname === "/ready"'),
  "server must expose /ready",
);
requireCondition(
  oauth.includes("env(\"OWNER_CODE\").length >= MIN_OWNER_CODE_LENGTH"),
  "OAuth must enforce the documented owner-code length",
);
requireCondition(
  icon.length <= 100 * 1024 &&
    iconMetadata.format === "png" &&
    iconMetadata.hasAlpha &&
    iconMetadata.width === iconMetadata.height &&
    iconMetadata.width >= 256,
  "template icon must be a compact square PNG with transparency",
);

if (failures.length) {
  throw new Error(`Railway template contract failed:\n${failures.join("\n")}`);
}

console.log("Railway template contract passed: version, readiness, variables, and docs are aligned.");
