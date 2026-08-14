import { randomUUID, timingSafeEqual } from "node:crypto";
import { databaseConfigured, databaseDriver, memoryTable, query } from "./db.js";
import {
  deleteObject,
  putObject,
  signedObjectUrl,
  storageConfigured,
  storageOrigins,
} from "./object-store.js";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MIN_OWNER_CODE_LENGTH = 24;
const SIGNED_ASSET_TTL_SECONDS = 3600;
const IMAGE_TYPES = new Map([
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
]);

function env(name) {
  return String(process.env[name] || "").trim();
}

export function collectionConfigured() {
  return databaseConfigured() && storageConfigured();
}

export function collectionAdminConfigured() {
  return collectionConfigured() && env("OWNER_CODE").length >= MIN_OWNER_CODE_LENGTH;
}

export function collectionAssetOrigins() {
  return storageOrigins();
}

export function isCollectionAdmin(req) {
  const expected = env("OWNER_CODE");
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (expected.length < MIN_OWNER_CODE_LENGTH || !supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cleanWords(value, max = 12) {
  const words = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(words.map((word) => String(word).trim()).filter(Boolean))]
    .slice(0, max)
    .map((word) => word.slice(0, 40));
}

function cleanPriority(value) {
  const priority = Number(value);
  if (!Number.isFinite(priority)) return 0;
  return Math.max(0, Math.min(Math.round(priority), 100));
}

function cleanReaction(input, { partial = false } = {}) {
  const result = {};
  const put = (key, value, sourceKey = key) => {
    if (!partial || Object.hasOwn(input, sourceKey)) result[key] = value;
  };
  put("title", String(input.title || "").trim().slice(0, 100));
  put("description", String(input.description || "").trim().slice(0, 500));
  put("kind", input.kind === "gif" ? "gif" : "sticker");
  put("tags", cleanWords(input.tags, 20));
  put("moods", cleanWords(input.moods, 8));
  put("use_when", cleanWords(input.useWhen, 12), "useWhen");
  put("favorite", Boolean(input.favorite));
  put("priority", cleanPriority(input.priority));
  if (input.active !== undefined) put("active", Boolean(input.active));
  return result;
}

function rowValue(row, snake, camel = snake) {
  return row?.[snake] ?? row?.[camel];
}

function mapReaction(row) {
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    title: row.title,
    description: row.description || "",
    tags: row.tags || [],
    moods: row.moods || [],
    useWhen: rowValue(row, "use_when", "useWhen") || [],
    favorite: row.favorite === true,
    priority: cleanPriority(row.priority),
    imageUrl: rowValue(row, "asset_url", "assetUrl") || "",
    previewUrl:
      rowValue(row, "preview_url", "previewUrl") ||
      rowValue(row, "asset_url", "assetUrl") ||
      "",
    pageUrl: rowValue(row, "giphy_page_url", "giphyPageUrl") || "",
    giphyId: rowValue(row, "giphy_id", "giphyId") || "",
    storagePath: rowValue(row, "storage_path", "storagePath") || "",
    active: row.active !== false,
    createdAt: rowValue(row, "created_at", "createdAt"),
  };
}

async function hydrateReaction(value) {
  const reaction = mapReaction(value);
  if (reaction.source !== "custom" || !reaction.storagePath) return reaction;
  const imageUrl = await signedObjectUrl(
    reaction.storagePath,
    SIGNED_ASSET_TTL_SECONDS,
  );
  return { ...reaction, imageUrl, previewUrl: imageUrl };
}

function memoryRows() {
  return [...memoryTable("reactions").values()];
}

export async function listCollection({ activeOnly = true } = {}) {
  let rows;
  if (databaseDriver() === "memory") {
    rows = memoryRows()
      .filter((row) => !activeOnly || row.active !== false)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  } else {
    const result = await query(
      `SELECT * FROM magic_reactions
       ${activeOnly ? "WHERE active = true" : ""}
       ORDER BY created_at DESC`,
    );
    rows = result.rows;
  }
  return Promise.all(rows.map(hydrateReaction));
}

function tokens(value) {
  return (
    String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) || []
  );
}

const SEARCH_WORD_FAMILIES = [
  ["kiss", "beso", "besos", "besito", "besitos", "besar", "muak", "kisses", "kissing"],
  ["hug", "abrazo", "abrazos", "abrazar", "apapacho", "mimo", "mimos", "hugs", "cuddle"],
  ["love", "amor", "carino", "romantico", "romantica", "loving"],
  ["happy", "alegria", "alegre", "feliz", "felicidad", "joy"],
  ["celebrate", "celebrar", "celebracion", "fiesta", "victoria", "celebration", "victory"],
  ["sad", "triste", "tristeza", "llorar", "llorando", "cry", "crying", "tears"],
  ["angry", "enfado", "enfadado", "enfadada", "rabia", "furia", "mad"],
  ["sleep", "cansancio", "cansado", "cansada", "sueno", "dormir", "tired", "sleepy"],
  ["laugh", "risa", "reir", "riendo", "gracioso", "jajaja", "laughing", "funny"],
];

const CANONICAL_WORD = new Map(
  SEARCH_WORD_FAMILIES.flatMap(([canonical, ...aliases]) =>
    [canonical, ...aliases].map((word) => [word, canonical]),
  ),
);

function searchTokens(value) {
  return [...new Set(tokens(value).map((word) => CANONICAL_WORD.get(word) || word))];
}

function fieldScore(values, wanted, weight) {
  const available = new Set(searchTokens(values));
  return wanted.reduce((sum, word) => sum + (available.has(word) ? weight : 0), 0);
}

export async function searchCollection({ query: phrase, kind, limit = 8 }) {
  const reactions = await listCollection({ activeOnly: true });
  const wanted = searchTokens(phrase);
  return reactions
    .filter((item) => !kind || item.kind === kind)
    .map((item) => ({
      item,
      match:
        fieldScore(item.title, wanted, 5) +
        fieldScore(item.tags.join(" "), wanted, 4) +
        fieldScore(item.useWhen.join(" "), wanted, 4) +
        fieldScore(item.moods.join(" "), wanted, 3) +
        fieldScore(item.description, wanted, 2),
      preference: item.priority / 20 + (item.favorite ? 2 : 0),
    }))
    .filter(({ match }) => wanted.length === 0 || match > 0)
    .sort((a, b) => b.match - a.match || b.preference - a.preference)
    .slice(0, Math.max(1, Math.min(Number(limit) || 8, 20)))
    .map(({ item }) => item);
}

async function insertReaction(row) {
  const complete = {
    id: row.id || randomUUID(),
    source: row.source,
    kind: row.kind,
    title: row.title,
    description: row.description || "",
    tags: row.tags || [],
    moods: row.moods || [],
    use_when: row.use_when || [],
    favorite: row.favorite === true,
    priority: cleanPriority(row.priority),
    storage_path: row.storage_path || "",
    asset_url: row.asset_url || "",
    preview_url: row.preview_url || "",
    giphy_id: row.giphy_id || "",
    giphy_page_url: row.giphy_page_url || "",
    active: row.active !== false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (databaseDriver() === "memory") {
    memoryTable("reactions").set(complete.id, complete);
    return hydrateReaction(complete);
  }
  const result = await query(
    `INSERT INTO magic_reactions
      (id, source, kind, title, description, tags, moods, use_when, favorite,
       priority, storage_path, asset_url, preview_url, giphy_id,
       giphy_page_url, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      complete.id,
      complete.source,
      complete.kind,
      complete.title,
      complete.description,
      complete.tags,
      complete.moods,
      complete.use_when,
      complete.favorite,
      complete.priority,
      complete.storage_path,
      complete.asset_url,
      complete.preview_url,
      complete.giphy_id,
      complete.giphy_page_url,
      complete.active,
    ],
  );
  return hydrateReaction(result.rows[0]);
}

export async function createCustomReaction(input) {
  const mimeType = String(input.mimeType || "").toLowerCase();
  const extension = IMAGE_TYPES.get(mimeType);
  if (!extension) throw new Error("The file must be GIF, WebP, PNG, or JPG.");
  const bytes = Buffer.from(String(input.base64 || ""), "base64");
  if (!bytes.byteLength || bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("The file must be between 1 byte and 8 MB.");
  }
  const storagePath = `reactions/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${extension}`;
  await putObject({ key: storagePath, bytes, contentType: mimeType });
  try {
    return await insertReaction({
      ...cleanReaction(input),
      source: "custom",
      storage_path: storagePath,
      active: true,
    });
  } catch (error) {
    await deleteObject(storagePath).catch(() => {});
    throw error;
  }
}

export async function createGiphyReaction(input) {
  if (!input.giphyId || !input.imageUrl) {
    throw new Error("The GIPHY ID and image URL are required.");
  }
  return insertReaction({
    ...cleanReaction(input),
    source: "giphy",
    giphy_id: String(input.giphyId).slice(0, 100),
    giphy_page_url: String(input.pageUrl || "").slice(0, 500),
    asset_url: String(input.imageUrl).slice(0, 1000),
    preview_url: String(input.previewUrl || input.imageUrl).slice(0, 1000),
    active: true,
  });
}

export async function updateReaction(id, input) {
  const changes = cleanReaction(input, { partial: true });
  if (databaseDriver() === "memory") {
    const table = memoryTable("reactions");
    const row = table.get(id);
    if (!row) throw new Error("Reaction not found.");
    const updated = { ...row, ...changes, updated_at: new Date().toISOString() };
    table.set(id, updated);
    return hydrateReaction(updated);
  }
  const allowed = new Map([
    ["title", "title"],
    ["description", "description"],
    ["kind", "kind"],
    ["tags", "tags"],
    ["moods", "moods"],
    ["use_when", "use_when"],
    ["favorite", "favorite"],
    ["priority", "priority"],
    ["active", "active"],
  ]);
  const entries = Object.entries(changes).filter(([key]) => allowed.has(key));
  if (!entries.length) throw new Error("No editable fields were supplied.");
  const values = [id, ...entries.map(([, value]) => value)];
  const assignments = entries.map(
    ([key], index) => `${allowed.get(key)} = $${index + 2}`,
  );
  const result = await query(
    `UPDATE magic_reactions SET ${assignments.join(", ")}, updated_at = now()
     WHERE id = $1 RETURNING *`,
    values,
  );
  if (!result.rows.length) throw new Error("Reaction not found.");
  return hydrateReaction(result.rows[0]);
}

// Admin removal is deliberately recoverable: the object and row remain stored.
export async function deleteReaction(id) {
  const item = await updateReaction(id, { active: false });
  return { id: item.id, active: false };
}

export async function getGiphyById({ id }) {
  const apiKey = env("GIPHY_API_KEY");
  if (!apiKey) throw new Error("GIPHY_API_KEY is not configured.");
  const url = new URL(
    `/v1/gifs/${encodeURIComponent(id)}`,
    env("GIPHY_API_ORIGIN") || "https://api.giphy.com",
  );
  url.searchParams.set("api_key", apiKey);
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GIPHY returned ${response.status}.`);
  return response.json();
}
