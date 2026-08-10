import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import sharp from "sharp";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  collectionAdminConfigured,
  collectionAssetOrigins,
  collectionConfigured,
  createCustomReaction,
  createGiphyReaction,
  deleteReaction,
  getGiphyById,
  isCollectionAdmin,
  listCollection,
  searchCollection,
  updateReaction,
} from "./lib/collection-store.js";
import {
  authenticateMcpRequest,
  handleOAuthRequest,
  isCollectionOwner,
  oauthChallengeHeader,
  oauthChallengeResult,
  oauthConfigured,
  OAUTH_SCOPE,
  publicBaseUrl,
  protectedResourceMetadata,
} from "./lib/oauth.js";
import { memoryObject, storageDriver } from "./lib/object-store.js";

const APP_NAME = "Magic Reactions";
const APP_VERSION = "0.1.0";
const MCP_PATH = "/mcp";
const WIDGET_DIAGNOSTIC_PATH = "/api/widget-diagnostic";
const WIDGET_DIAGNOSTIC_PLACEHOLDER =
  "https://widget-diagnostic.invalid/api/widget-diagnostic";
const WIDGET_DIAGNOSTIC_STAGES = new Set([
  "widget-loaded",
  "bridge-initialized",
  "tool-result-received",
  "image-ready",
  "image-error",
]);
const WIDGET_DIAGNOSTIC_LOG_LIMIT = 60;
const DIAGNOSTIC_MCP_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
]);
const MAX_REJECTED_MCP_LOG_BODY_BYTES = 64 * 1024;
const MAX_REJECTED_MCP_LOG_WAIT_MS = 100;
const TEMPLATE_URI = "ui://widget/magic-reactions-picker-v1.html";
const REACTION_TEMPLATE_URI =
  "ui://widget/magic-reactions-direct-v1.html";
const LEGACY_REACTION_V1_URI =
  "ui://widget/magic-reactions-direct-legacy-v1.html";
const LEGACY_REACTION_TEMPLATE_URIS = [];
const LEGACY_TEMPLATE_URIS = [];
const PORT = Number(process.env.PORT ?? 8787);
const GIPHY_API_ORIGIN =
  process.env.GIPHY_API_ORIGIN?.trim() || "https://api.giphy.com";

const currentDir = dirname(fileURLToPath(import.meta.url));
const widgetTemplate = readFileSync(
  join(currentDir, "public", "sticker-widget.html"),
  "utf8",
);
const reactionTemplate = readFileSync(
  join(currentDir, "public", "reaction-widget.html"),
  "utf8",
);
const collectionAdminTemplate = readFileSync(
  join(currentDir, "public", "collection-admin.html"),
  "utf8",
);
const ownerSecurity = [{ type: "oauth2", scopes: [OAUTH_SCOPE] }];
const connectorSecurity = ownerSecurity;

const kindSchema = z.enum(["sticker", "gif"]);
const ratingSchema = z.enum(["g", "pg", "pg-13"]);
const chatGptImageSchema = z.object({
  download_url: z.string().url(),
  file_id: z.string().min(1),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});
const MAX_CHATGPT_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_NATIVE_REACTION_BYTES = 8 * 1024;
const MAX_NATIVE_REACTION_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_REACTION_RESULT_BYTES = 20_000;
const NATIVE_REACTION_TIMEOUT_MS = 2_000;
const NATIVE_REACTION_PROFILES = [
  { size: 160, quality: 55 },
  { size: 144, quality: 45 },
  { size: 128, quality: 38 },
  { size: 112, quality: 32 },
  { size: 96, quality: 26 },
  { size: 80, quality: 20 },
  { size: 64, quality: 16 },
];

function canDownloadChatGptImage(url) {
  if (url.protocol === "https:") return true;
  return (
    process.env.ALLOW_INSECURE_FILE_DOWNLOADS_FOR_TESTS === "true" &&
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname)
  );
}

async function downloadChatGptImage(image) {
  const url = new URL(image.download_url);
  if (!canDownloadChatGptImage(url)) {
    throw new Error("La direcciÃ³n autorizada de la imagen debe usar HTTPS.");
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`ChatGPT no pudo entregar la imagen (${response.status}).`);
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_CHATGPT_IMAGE_BYTES) {
    throw new Error("La imagen debe pesar como mÃ¡ximo 8 MB.");
  }
  const mimeType = String(
    image.mime_type || response.headers.get("content-type") || "",
  )
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!mimeType.startsWith("image/")) {
    throw new Error("El archivo autorizado debe ser una imagen.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > MAX_CHATGPT_IMAGE_BYTES) {
    throw new Error("La imagen debe pesar entre 1 byte y 8 MB.");
  }
  return { bytes, mimeType };
}

async function nativeReactionImageContent(imageUrl) {
  const url = new URL(imageUrl);
  if (!canDownloadChatGptImage(url)) {
    throw new Error("La imagen nativa de la reacciÃ³n debe usar HTTPS.");
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(NATIVE_REACTION_TIMEOUT_MS),
    redirect: "follow",
    headers: {
      accept: "image/webp,image/gif,image/png,image/jpeg;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`La imagen nativa respondiÃ³ ${response.status}.`);
  }
  if (!canDownloadChatGptImage(new URL(response.url))) {
    throw new Error("La imagen nativa redirigiÃ³ a una direcciÃ³n no segura.");
  }

  const mimeType = String(response.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!/^image\/(?:gif|webp|png|jpeg)$/.test(mimeType)) {
    throw new Error("La reacciÃ³n nativa no tiene un formato de imagen compatible.");
  }

  const announcedSize = Number(response.headers.get("content-length") || 0);
  if (announcedSize > MAX_NATIVE_REACTION_SOURCE_BYTES) {
    await response.body?.cancel();
    throw new Error("La reacciÃ³n nativa supera el lÃ­mite de entrada de 4 MiB.");
  }

  if (!response.body) {
    throw new Error("La reacciÃ³n nativa llegÃ³ vacÃ­a.");
  }
  const chunks = [];
  let receivedBytes = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > MAX_NATIVE_REACTION_SOURCE_BYTES) {
      await reader.cancel();
      throw new Error("La reacciÃ³n nativa supera el lÃ­mite de entrada de 4 MiB.");
    }
    chunks.push(Buffer.from(value));
  }
  if (!receivedBytes) {
    throw new Error("La reacciÃ³n nativa llegÃ³ vacÃ­a.");
  }
  let bytes = Buffer.concat(chunks, receivedBytes);
  let outputMimeType = mimeType;

  if (bytes.byteLength > MAX_NATIVE_REACTION_BYTES) {
    let compressed;
    for (const { size, quality } of NATIVE_REACTION_PROFILES) {
      const candidate = await sharp(bytes, {
        animated: false,
        page: 0,
        pages: 1,
        limitInputPixels: 16_777_216,
        sequentialRead: true,
      })
        .rotate()
        .resize({
          width: size,
          height: size,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({
          quality,
          alphaQuality: Math.max(quality, 35),
          effort: 4,
          smartSubsample: true,
        })
        .toBuffer();
      if (candidate.byteLength <= MAX_NATIVE_REACTION_BYTES) {
        compressed = candidate;
        break;
      }
    }
    if (!compressed?.byteLength) {
      throw new Error("No pude reducir la reacciÃ³n nativa por debajo de 8 KiB.");
    }
    bytes = compressed;
    outputMimeType = "image/webp";
  }

  console.info(
    `[MCP] native-image prepared sourceBytes=${receivedBytes} ` +
      `outputBytes=${bytes.byteLength} mime=${outputMimeType}`,
  );

  return {
    type: "image",
    data: bytes.toString("base64"),
    mimeType: outputMimeType,
    annotations: { audience: ["user"], priority: 1 },
  };
}

const pickerOutputSchema = {
  query: z.string(),
  kind: kindSchema,
  mode: z.literal("picker"),
  rating: ratingSchema,
  collection: z.array(z.object({
    id: z.string(),
    source: z.enum(["custom", "giphy"]),
    kind: kindSchema,
    title: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
    moods: z.array(z.string()),
    useWhen: z.array(z.string()),
    favorite: z.boolean(),
    priority: z.number().int().min(0).max(100),
    imageUrl: z.string().url(),
    previewUrl: z.string().url(),
    pageUrl: z.string(),
  })),
};

const selectedReactionOutputSchema = z.object({
  id: z.string(),
  source: z.enum(["custom", "giphy"]),
  kind: kindSchema,
  title: z.string(),
  imageUrl: z.string().url(),
  pageUrl: z.string(),
  markdownImage: z.string(),
});

const reactionOutputSchema = {
  query: z.string(),
  kind: kindSchema,
  mode: z.literal("direct"),
  rating: ratingSchema,
  selectedReaction: selectedReactionOutputSchema,
  selectedGiphy: selectedReactionOutputSchema,
};

function renderWidgetHtml() {
  return widgetTemplate;
}

function widgetDiagnosticEndpoint() {
  return new URL(WIDGET_DIAGNOSTIC_PATH, `${publicBaseUrl()}/`).toString();
}

function widgetDiagnosticOrigin() {
  return new URL(widgetDiagnosticEndpoint()).origin;
}

function renderReactionHtml() {
  return reactionTemplate.replaceAll(
    WIDGET_DIAGNOSTIC_PLACEHOLDER,
    widgetDiagnosticEndpoint(),
  );
}

async function widgetResult({ query, kind, rating, message }) {
  const collection = await searchCollection({ query, kind, limit: 8 }).catch(
    (error) => {
      console.warn("Collection search unavailable:", error.message);
      return [];
    },
  );
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { query, kind, mode: "picker", rating, collection },
    _meta: {
      giphy: {
        apiKey: process.env.GIPHY_API_KEY?.trim() ?? "",
      },
    },
  };
}

function giphyImageUrl(item) {
  const images = item?.images || {};
  return (
    images.downsized_medium?.url ||
    images.fixed_width?.url ||
    images.original?.url ||
    ""
  );
}

function giphyPreviewUrl(item) {
  const images = item?.images || {};
  return (
    images.fixed_width_small?.url ||
    images.fixed_width?.url ||
    giphyImageUrl(item)
  );
}

function markdownAlt(title, kind) {
  return (
    String(title || `${kind === "sticker" ? "Sticker" : "GIF"} de GIPHY`)
      .replaceAll("[", " ")
      .replaceAll("]", " ")
      .replaceAll("\r", " ")
      .replaceAll("\n", " ")
      .trim()
      .slice(0, 80) || "ReacciÃ³n de GIPHY"
  );
}

function asSelectedReaction(item) {
  const title = item.title || `${item.kind === "sticker" ? "Sticker" : "GIF"}`;
  const imageUrl = item.previewUrl || item.imageUrl;
  return {
    id: item.id,
    source: item.source,
    kind: item.kind,
    title,
    imageUrl,
    pageUrl: item.pageUrl || "",
    markdownImage: `![${markdownAlt(title, item.kind)}](${imageUrl})`,
  };
}

async function getGiphyReaction({ query, kind, rating }) {
  const apiKey = process.env.GIPHY_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GIPHY_API_KEY no estÃ¡ configurada.");
  }

  const url = new URL(
    `/v1/${kind === "sticker" ? "stickers" : "gifs"}/translate`,
    GIPHY_API_ORIGIN,
  );
  url.search = new URLSearchParams({
    api_key: apiKey,
    s: query,
    rating,
    lang: "es",
  }).toString();

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GIPHY respondiÃ³ ${response.status}.`);
  }

  const payload = await response.json();
  const item = payload?.data;
  const imageUrl = giphyPreviewUrl(item) || giphyImageUrl(item);
  if (!item?.id || !imageUrl) {
    throw new Error("GIPHY no encontrÃ³ una reacciÃ³n animada.");
  }

  const title =
    item.title || `${kind === "sticker" ? "Sticker" : "GIF"} de GIPHY`;
  const pageUrl = item.url || `https://giphy.com/gifs/${item.id}`;
  return {
    id: item.id,
    source: "giphy",
    kind,
    title,
    imageUrl,
    pageUrl,
    markdownImage: `![${markdownAlt(title, kind)}](${imageUrl})`,
  };
}

async function getMagicReaction({ query, kind, rating }) {
  const curated = await searchCollection({ query, kind, limit: 4 }).catch(
    (error) => {
      console.warn("Collection search unavailable:", error.message);
      return [];
    },
  );
  if (curated.length) {
    return asSelectedReaction(curated[0]);
  }
  return getGiphyReaction({ query, kind, rating });
}

function registerMagicTools(server) {
  registerAppTool(
    server,
    "show_giphy_reaction",
    {
      title: "Show a GIF or sticker reaction",
      description:
        "Use this when you decide to include one animated reaction directly in your reply, without asking the user to choose. It searches the private collection first and uses GIPHY only as a fallback. Call it directly with one short, literal search phrase. Do not require a separate search or an exact reaction ID first.",
      inputSchema: {
        query: z.string().trim().min(1).max(50),
        kind: kindSchema.default("sticker"),
        rating: ratingSchema.default("pg"),
      },
      outputSchema: reactionOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
      _meta: {
        securitySchemes: connectorSecurity,
        ui: { resourceUri: REACTION_TEMPLATE_URI },
        "openai/outputTemplate": REACTION_TEMPLATE_URI,
        "openai/toolInvocation/invoking": "Buscando una reacciÃ³n bonitaâ€¦",
        "openai/toolInvocation/invoked": "ReacciÃ³n preparada âœ¨",
      },
    },
    async ({ query, kind = "sticker", rating = "pg" }) => {
      try {
        const selectedReaction = await getMagicReaction({
          query,
          kind,
          rating,
        });
        let nativeReactionImage;
        try {
          nativeReactionImage = await nativeReactionImageContent(
            selectedReaction.imageUrl,
          );
        } catch (error) {
          console.warn(
            "Native reaction image unavailable:",
            error instanceof Error ? error.message : error,
          );
        }
        const result = {
          content: [
            {
              type: "text",
              text:
                "The animated reaction is displayed in the attached " +
                "widget. Accompany it with at most one brief phrase and do not " +
                "repeat the image URL.",
            },
          ],ç}û¶‰žËkºwµçD°…Íå¹Œ€¡É•ÅÕ•ÍÐ°•áÑÉ„¤€ôøì4(€€€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥Ð½É¥¥¹…±1¥ÍÑQ½½±Ì¡É•ÅÕ•ÍÐ°•áÑÉ„¤ì4(€€€É•ÑÕÉ¸ì4(€€€€€€¸¸¹É•ÍÕ±Ð°4(€€€€€Ñ½½±ÌèÉ•ÍÕ±Ð¹Ñ½½±Ì¹µ…À ¡Ñ½½°¤€ôøì4(€€€€€€€½¹ÍÐÍ•ÕÉ¥ÑåM¡•µ•Ì€ôÑ½½°ü¹}µ•Ñ„ü¹Í•ÕÉ¥ÑåM¡•µ•Ìì4(€€€€€€€É•ÑÕÉ¸ÉÉ…ä¹¥ÍÉÉ…ä¡Í•ÕÉ¥ÑåM¡•µ•Ì¤4(€€€€€€€€€€üì€¸¸¹Ñ½½°°Í•ÕÉ¥ÑåM¡•µ•Ìô4(€€€€€€€€€€èÑ½½°ì4(€€€€€ô¤°4(€€€ôì4(€ô¤ì4)ô4(4)™Õ¹Ñ¥½¸ÝÉ¥Ñ•½ÉÍ!•…‘•ÉÌ¡É•Ì¤ì4(€É•Ì¹Í•Ñ!•…‘•È ‰•ÍÌµ½¹ÑÉ½°µ±±½Üµ=É¥¥¸ˆ°€ˆ¨ˆ¤ì4(€É•Ì¹Í•Ñ!•…‘•È 4(€€€€‰•ÍÌµ½¹ÑÉ½°µ±±½Üµ!•…‘•ÉÌˆ°4(€€€€‰…ÕÑ¡½É¥é…Ñ¥½¸°½¹Ñ•¹ÐµÑåÁ”°µÀµÍ•ÍÍ¥½¸µ¥°µÀµÁÉ½Ñ½½°µÙ•ÉÍ¥½¸ˆ°4(€€¤ì4(€É•Ì¹Í•Ñ!•…‘•È 4(€€€€‰•ÍÌµ½¹ÑÉ½°µáÁ½Í”µ!•…‘•ÉÌˆ°4(€€€€‰5ÀµM•ÍÍ¥½¸µ%°5@µAÉ½Ñ½½°µY•ÉÍ¥½¸ˆ°4(€€¤ì4)ô4(4)™Õ¹Ñ¥½¸©Í½¸¡É•Ì°ÍÑ…ÑÕÌ°Ù…±Õ”¤ì(€É•Ì4(€€€€¹ÝÉ¥Ñ•!•…¡ÍÑ…ÑÕÌ°ì4(€€€€€€‰½¹Ñ•¹ÐµÑåÁ”ˆè€‰…ÁÁ±¥…Ñ¥½¸½©Í½¸ì¡…ÉÍ•ÐõÕÑ˜´àˆ°4(€€€€€€‰…¡”µ½¹ÑÉ½°ˆè€‰¹¼µÍÑ½É”ˆ°4(€€€ô¤4(€€€€¹•¹¡)M=8¹ÍÑÉ¥¹¥™ä¡Ù…±Õ”¤¤ì4)ô4(4)…Íå¹Œ™Õ¹Ñ¥½¸É•…‘)Í½¸¡É•Ä°µ…á	åÑ•Ì€ô€ÄÈ€¨€ÄÀÈÐ€¨€ÄÀÈÐ¤ì(€½¹ÍÐ¡Õ¹­Ì€ômtì4(€±•ÐÍ¥é”€ô€Àì4(€™½È…Ý…¥Ð€¡½¹ÍÐ¡Õ¹¬½˜É•Ä¤ì4(€€€Í¥é”€¬ô¡Õ¹¬¹‰åÑ•1•¹Ñ ì4(€€€¥˜€¡Í¥é”€øµ…á	åÑ•Ì¤Ñ¡É½Ü¹•ÜÉÉ½È ‰1„Á•Ñ¥§Í¸•Ì‘•µ…Í¥…‘¼É…¹‘”¸ˆ¤ì4(€€€¡Õ¹­Ì¹ÁÕÍ ¡¡Õ¹¬¤ì4(€ô4(€¥˜€ …¡Õ¹­Ì¹±•¹Ñ ¤É•ÑÕÉ¸íôì4(€ÑÉäì4(€€€É•ÑÕÉ¸)M=8¹Á…ÉÍ”¡	Õ™™•È¹½¹…Ð¡¡Õ¹­Ì¤¹Ñ½MÑÉ¥¹œ ‰ÕÑ˜àˆ¤¤ì4(€ô…Ñ ì4(€€€Ñ¡É½Ü¹•ÜÉÉ½È ‰°½¹Ñ•¹¥‘¼•¹Ù¥…‘¼¹¼•Ì)M=8Û…±¥‘¼¸ˆ¤ì4(€ô4)ô()™Õ¹Ñ¥½¸ÝÉ¥Ñ•]¥‘•Ñ¥…¹½ÍÑ¥!•…‘•ÉÌ¡É•Ì¤ì(€É•Ì¹Í•Ñ!•…‘•È ‰•ÍÌµ½¹ÑÉ½°µ±±½Üµ=É¥¥¸ˆ°€ˆ¨ˆ¤ì(€É•Ì¹Í•Ñ!•…‘•È ‰•ÍÌµ½¹ÑÉ½°µ±±½Üµ5•Ñ¡½‘Ìˆ°€‰A=MP°=AQ%=9Lˆ¤ì(€É•Ì¹Í•Ñ!•…‘•È ‰…¡”µ½¹ÑÉ½°ˆ°€‰¹¼µÍÑ½É”ˆ¤ì(€É•Ì¹Í•Ñ!•…‘•È ‰É½ÍÌµ=É¥¥¸µI•Í½ÕÉ”µA½±¥äˆ°€‰É½ÍÌµ½É¥¥¸ˆ¤ì)ô()™Õ¹Ñ¥½¸Ý¥‘•Ñ¥…¹½ÍÑ¥!…Í	½‘ä¡É•Ä¤ì(€½¹ÍÐ½¹Ñ•¹Ñ1•¹Ñ €ôMÑÉ¥¹œ¡É•Ä¹¡•…‘•ÉÍl‰½¹Ñ•¹Ðµ±•¹Ñ ‰tñð€ˆÀˆ¤ì(€¥˜€¡½¹Ñ•¹Ñ1•¹Ñ €„ôô€ˆÀˆ¤ì(€€€É•Ä¹É•ÍÕµ” ¤ì(€€€É•ÑÕÉ¸AÉ½µ¥Í”¹É•Í½±Ù”¡ÑÉÕ”¤ì(€ô(€¥˜€ …É•Ä¹¡•…‘•ÉÍl‰ÑÉ…¹Í™•Èµ•¹½‘¥¹œ‰t¤É•ÑÕÉ¸AÉ½µ¥Í”¹É•Í½±Ù”¡™…±Í”¤ì((€É•ÑÕÉ¸¹•ÜAÉ½µ¥Í” ¡É•Í½±Ù”¤€ôøì(€€€±•ÐÍ•ÑÑ±•€ô™…±Í”ì(€€€±•ÐÑ¥µ•½ÕÐì(€€€½¹ÍÐ™¥¹¥Í €ô€¡¡…Í	½‘ä¤€ôøì(€€€€€¥˜€¡Í•ÑÑ±•¤É•ÑÕÉ¸ì(€€€€€Í•ÑÑ±•€ôÑÉÕ”ì(€€€€€±•…ÉQ¥µ•½ÕÐ¡Ñ¥µ•½ÕÐ¤ì(€€€€€É•Ä¹É•µ½Ù•1¥ÍÑ•¹•È ‰‘…Ñ„ˆ°½¹…Ñ„¤ì(€€€€€É•Ä¹É•µ½Ù•1¥ÍÑ•¹•È ‰•¹ˆ°½¹¹¤ì(€€€€€É•Ä¹É•µ½Ù•1¥ÍÑ•¹•È ‰•ÉÉ½Èˆ°½¹ÉÉ½È¤ì(€€€€€É•Í½±Ù”¡¡…Í	½‘ä¤ì(€€€ôì(€€€½¹ÍÐ½¹…Ñ„€ô€¡¡Õ¹¬¤€ôøì(€€€€€¥˜€ …¡Õ¹¬¹‰åÑ•1•¹Ñ ¤É•ÑÕÉ¸ì(€€€€€™¥¹¥Í ¡ÑÉÕ”¤ì(€€€€€É•Ä¹É•ÍÕµ” ¤ì(€€€ôì(€€€½¹ÍÐ½¹¹€ô€ ¤€ôø™¥¹¥Í ¡™…±Í”¤ì(€€€½¹ÍÐ½¹ÉÉ½È€ô€ ¤€ôø™¥¹¥Í ¡ÑÉÕ”¤ì(€€€É•Ä¹½¸ ‰‘…Ñ„ˆ°½¹…Ñ„¤ì(€€€É•Ä¹½¸ ‰•¹ˆ°½¹¹¤ì(€€€É•Ä¹½¸ ‰•ÉÉ½Èˆ°½¹ÉÉ½È¤ì(€€€Ñ¥µ•½ÕÐ€ôÍ•ÑQ¥µ•½ÕÐ  ¤€ôøì(€€€€€™¥¹¥Í ¡ÑÉÕ”¤ì(€€€€€É•Ä¹É•ÍÕµ” ¤ì(€€€ô°€ÄÀÀ¤ì(€ô¤ì)ô()±•ÐÝ¥‘•Ñ¥…¹½ÍÑ¥]¥¹‘½ÝMÑ…ÉÑ•‘Ð€ô€Àì)±•ÐÝ¥‘•Ñ¥…¹½ÍÑ¥1½½Õ¹Ð€ô€Àì()™Õ¹Ñ¥½¸±½]¥‘•Ñ¥…¹½ÍÑ¥Œ¡ÍÑ…”¤ì(€½¹ÍÐ¹½Ü€ô…Ñ”¹¹½Ü ¤ì(€¥˜€¡¹½Ü€´Ý¥‘•Ñ¥…¹½ÍÑ¥]¥¹‘½ÝMÑ…ÉÑ•‘Ð€øô€ØÁ|ÀÀÀ¤ì(€€€Ý¥‘•Ñ¥…¹½ÍÑ¥]¥¹‘½ÝMÑ…ÉÑ•‘Ð€ô¹½Üì(€€€Ý¥‘•Ñ¥…¹½ÍÑ¥1½½Õ¹Ð€ô€Àì(€ô(€¥˜€¡Ý¥‘•Ñ¥…¹½ÍÑ¥1½½Õ¹Ð€øô]%Q}%9=MQ%}1=}1%5%P¤É•ÑÕÉ¸ì(€Ý¥‘•Ñ¥…¹½ÍÑ¥1½½Õ¹Ð€¬ô€Äì(€½¹Í½±”¹¥¹™¼¡m]%QtØôÄÍÑ…”ô‘íÍÑ…•õ€¤ì)ô()™Õ¹Ñ¥½¸Í…™•5Á5•Ñ¡½‘½É1½œ¡µ•ÍÍ…”°¡ÑÑÁ5•Ñ¡½¤ì(€¥˜€¡¡ÑÑÁ5•Ñ¡½€ôôô€‰Pˆ¤É•ÑÕÉ¸€‰¡ÑÑÀµ•Ðˆì(€¥˜€¡¡ÑÑÁ5•Ñ¡½€ôôô€‰1Qˆ¤É•ÑÕÉ¸€‰¡ÑÑÀµ‘•±•Ñ”ˆì(€¥˜€¡¡ÑÑÁ5•Ñ¡½€„ôô€‰A=MPˆ¤É•ÑÕÉ¸€‰½Ñ¡•Èˆì(€¥˜€¡ÉÉ…ä¹¥ÍÉÉ…ä¡µ•ÍÍ…”¤¤É•ÑÕÉ¸€‰‰…Ñ ˆì((€½¹ÍÐµ•Ñ¡½€ôÑåÁ•½˜µ•ÍÍ…”ü¹µ•Ñ¡½€ôôô€‰ÍÑÉ¥¹œˆ€üµ•ÍÍ…”¹µ•Ñ¡½€è€ˆˆì(€¥˜€ …µ•Ñ¡½¤É•ÑÕÉ¸€‰Õ¹­¹½Ý¸ˆì(€É•ÑÕÉ¸%9=MQ%}5A}5Q!=L¹¡…Ì¡µ•Ñ¡½¤€üµ•Ñ¡½€è€‰½Ñ¡•Èˆì)ô()™Õ¹Ñ¥½¸‰•¥¹5ÁI•ÅÕ•ÍÑ1½œ¡É•Ä°É•Ì°…ÕÑ¡MÑ…Ñ”¤ì(€½¹ÍÐÍÑ…ÉÑ•‘Ð€ô…Ñ”¹¹½Ü ¤ì(€½¹ÍÐÍÑ…Ñ”€ôì(€€€ÉÁ5•Ñ¡½èÍ…™•5Á5•Ñ¡½‘½É1½œ¡Õ¹‘•™¥¹•°É•Ä¹µ•Ñ¡½¤°(€€€…ÕÑ¡I•ÍÕ±Ðè€‰¡•­¥¹œˆ°(€ôì(€±•Ð•µ¥ÑÑ•€ô™…±Í”ì((€½¹ÍÐ•µ¥Ð€ô€¡ÍÑ…ÑÕÌ°½ÕÑ½µ”¤€ôøì(€€€¥˜€¡•µ¥ÑÑ•¤É•ÑÕÉ¸ì(€€€•µ¥ÑÑ•€ôÑÉÕ”ì(€€€½¹Í½±”¹¥¹™¼ (€€€€€m5AtÉ•ÅÕ•ÍÐÉÁŒô‘íÍÑ…Ñ”¹ÉÁ5•Ñ¡½‘ô¡ÑÑÀô‘íÉ•Ä¹µ•Ñ¡½ñð€‰U9-9=]8‰ô€€¬(€€€€€€€…ÕÑ ô‘í…ÕÑ¡MÑ…Ñ•ô…ÕÑ¡I•ÍÕ±Ðô‘íÍÑ…Ñ”¹…ÕÑ¡I•ÍÕ±ÑôÍÑ…ÑÕÌô‘íÍÑ…ÑÕÍô€€¬(€€€€€€€½ÕÑ½µ”ô‘í½ÕÑ½µ•ô‘ÕÉ…Ñ¥½¹5Ìô‘í…Ñ”¹¹½Ü ¤€´ÍÑ…ÉÑ•‘Ñõ€°(€€€€¤ì(€ôì((€É•Ì¹½¹” ‰™¥¹¥Í ˆ°€ ¤€ôø•µ¥Ð¡É•Ì¹ÍÑ…ÑÕÍ½‘”°€‰™¥¹¥Í¡•ˆ¤¤ì(€É•Ì¹½¹” ‰±½Í”ˆ°€ ¤€ôøì(€€€¥˜€ …É•Ì¹ÝÉ¥Ñ…‰±•¥¹¥Í¡•¤•µ¥Ð ‰¥¹Ñ•ÉÉÕÁÑ•ˆ°€‰¥¹Ñ•ÉÉÕÁÑ•ˆ¤ì(€ô¤ì((€É•ÑÕÉ¸ÍÑ…Ñ”ì)ô()™Õ¹Ñ¥½¸É•©•Ñ•‘5Á5•Ñ¡½‘½É1½œ¡É•Ä¤ì(€¥˜€¡É•Ä¹µ•Ñ¡½€„ôô€‰A=MPˆ¤ì(€€€É•ÑÕÉ¸AÉ½µ¥Í”¹É•Í½±Ù”¡Í…™•5Á5•Ñ¡½‘½É1½œ¡Õ¹‘•™¥¹•°É•Ä¹µ•Ñ¡½¤¤ì(€ô((€É•ÑÕÉ¸¹•ÜAÉ½µ¥Í” ¡É•Í½±Ù”¤€ôøì(€€€½¹ÍÐ¡Õ¹­Ì€ômtì(€€€±•ÐÍ¥é”€ô€Àì(€€€±•ÐÍ•ÑÑ±•€ô™…±Í”ì(€€€±•ÐÑ¥µ•Èì((€€€½¹ÍÐ±•…¹ÕÀ€ô€ ¤€ôøì(€€€€€¥˜€¡Ñ¥µ•È¤±•…ÉQ¥µ•½ÕÐ¡Ñ¥µ•È¤ì(€€€€€É•Ä¹É•µ½Ù•1¥ÍÑ•¹•È ‰‘…Ñ„ˆ°½¹…Ñ„¤ì(€€€€€É•Ä¹É•µ½Ù•1¥ÍÑ•¹•È ‰•¹ˆ°½¹¹¤ì(€€€€€É•Ä¹É•µ½Ù•1¥ÍÑ•¹•È ‰•ÉÉ½Èˆ°½¹ÉÉ½È¤ì(€€€€€É•Ä¹É•µ½Ù•1¥ÍÑ•¹•È ‰…‰½ÉÑ•ˆ°½¹‰½ÉÑ•¤ì(€€€ôì((€€€½¹ÍÐ™¥¹¥Í €ô€¡ÉÁ5•Ñ¡½°‘É…¥¸€ô™…±Í”¤€ôøì(€€€€€¥˜€¡Í•ÑÑ±•¤É•ÑÕÉ¸ì(€€€€€Í•ÑÑ±•€ôÑÉÕ”ì(€€€€€±•…¹ÕÀ ¤ì(€€€€€¥˜€¡‘É…¥¸€˜˜€…É•Ä¹‘•ÍÑÉ½å•¤É•Ä¹É•ÍÕµ” ¤ì(€€€€€É•Í½±Ù”¡ÉÁ5•Ñ¡½¤ì(€€€ôì((€€€½¹ÍÐ½¹…Ñ„€ô€¡¡Õ¹¬¤€ôøì(€€€€€Í¥é”€¬ô¡Õ¹¬¹‰åÑ•1•¹Ñ ì(€€€€€¥˜€¡Í¥é”€ø5a}I)Q}5A}1=}	=e}	eQL¤ì(€€€€€€€™¥¹¥Í  ‰Õ¹­¹½Ý¸ˆ°ÑÉÕ”¤ì(€€€€€€€É•ÑÕÉ¸ì(€€€€€ô(€€€€€¡Õ¹­Ì¹ÁÕÍ ¡	Õ™™•È¹¥Í	Õ™™•È¡¡Õ¹¬¤€ü¡Õ¹¬€è	Õ™™•È¹™É½´¡¡Õ¹¬¤¤ì(€€€ôì((€€€½¹ÍÐ½¹¹€ô€ ¤€ôøì(€€€€€ÑÉäì(€€€€€€€½¹ÍÐ‰½‘ä€ô¡Õ¹­Ì¹±•¹Ñ (€€€€€€€€€€ü)M=8¹Á…ÉÍ”¡	Õ™™•È¹½¹…Ð¡¡Õ¹­Ì¤¹Ñ½MÑÉ¥¹œ ‰ÕÑ˜àˆ¤¤(€€€€€€€€€€èíôì(€€€€€€€™¥¹¥Í ¡Í…™•5Á5•Ñ¡½‘½É1½œ¡‰½‘ä°É•Ä¹µ•Ñ¡½¤¤ì(€€€€€ô…Ñ ì(€€€€€€€™¥¹¥Í  ‰Õ¹­¹½Ý¸ˆ¤ì(€€€€€ô(€€€ôì((€€€½¹ÍÐ½¹ÉÉ½È€ô€ ¤€ôø™¥¹¥Í  ‰Õ¹­¹½Ý¸ˆ¤ì(€€€½¹ÍÐ½¹‰½ÉÑ•€ô€ ¤€ôø™¥¹¥Í  ‰Õ¹­¹½Ý¸ˆ¤ì((€€€Ñ¥µ•È€ôÍ•ÑQ¥µ•½ÕÐ (€€€€€€ ¤€ôø™¥¹¥Í  ‰Õ¹­¹½Ý¸ˆ°ÑÉÕ”¤°(€€€€€5a}I)Q}5A}1=}]%Q}5L°(€€€€¤ì(€€€Ñ¥µ•È¹Õ¹É•˜ü¸ ¤ì(€€€É•Ä¹½¸ ‰‘…Ñ„ˆ°½¹…Ñ„¤ì(€€€É•Ä¹½¹” ‰•¹ˆ°½¹¹¤ì(€€€É•Ä¹½¹” ‰•ÉÉ½Èˆ°½¹ÉÉ½È¤ì(€€€É•Ä¹½¹” ‰…‰½ÉÑ•ˆ°½¹‰½ÉÑ•¤ì(€ô¤ì)ô(4)™Õ¹Ñ¥½¸É•ÅÕ¥É•½±±•Ñ¥½¹‘µ¥¸¡É•Ä°É•Ì¤ì(€¥˜€¡¥Í½±±•Ñ¥½¹‘µ¥¸¡É•Ä¤¤É•ÑÕÉ¸ÑÉÕ”ì(€©Í½¸¡É•Ì°€ÐÀÄ°ì•ÉÉ½Èè€‰Q¡”½Ý¹•È½‘”¥Ì¹½Ð½ÉÉ•Ð¸ˆô¤ì(€É•ÑÕÉ¸™…±Í”ì4)ô4(4)™Õ¹Ñ¥½¸¥Á¡å%‘É½´¡Ù…±Õ”¤ì4(€½¹ÍÐÉ…Ü€ôMÑÉ¥¹œ¡Ù…±Õ”ñð€ˆˆ¤¹ÑÉ¥´ ¤ì4(€¥˜€ ½ym„µéµhÀ´å|µuìÌ°ÄÀÁô¼¹Ñ•ÍÐ¡É…Ü¤¤É•ÑÕÉ¸É…Üì4(€ÑÉäì4(€€€½¹ÍÐÕÉ°€ô¹•ÜUI0¡É…Ü¤ì4(€€€½¹ÍÐ±…ÍÐ€ôÕÉ°¹Á…Ñ¡¹…µ”¹ÍÁ±¥Ð ˆ´ˆ¤¹…Ð ´Ä¤ü¹ÍÁ±¥Ð ˆ¼ˆ¤¹™¥±Ñ•È¡	½½±•…¸¤¹…Ð ´Ä¤ì4(€€€É•ÑÕÉ¸€½ym„µéµhÀ´å|µuìÌ°ÄÀÁô¼¹Ñ•ÍÐ¡±…ÍÐñð€ˆˆ¤€ü±…ÍÐ€è€ˆˆì4(€ô…Ñ ì4(€€€É•ÑÕÉ¸€ˆˆì4(€ô4)ô4(4)…Íå¹Œ™Õ¹Ñ¥½¸¥µÁ½ÉÑ¥Á¡åI•…Ñ¥½¸¡¥¹ÁÕÐ¤ì4(€½¹ÍÐ­¥¹€ô¥¹ÁÕÐ¹­¥¹€ôôô€‰ÍÑ¥­•Èˆ€ü€‰ÍÑ¥­•Èˆ€è€‰¥˜ˆì4(€½¹ÍÐ¥€ô¥Á¡å%‘É½´¡¥¹ÁÕÐ¹¥Á¡å%ñð¥¹ÁÕÐ¹ÕÉ°¤ì4(€¥˜€ …¥¤Ñ¡É½Ü¹•ÜÉÉ½È ‰9¼ÁÕ‘”É•½¹½•È•°%¼•¹±…”‘”%A!d¸ˆ¤ì4(€½¹ÍÐÁ…å±½…€ô…Ý…¥Ð•Ñ¥Á¡å	å%¡ì¥°­¥¹ô¤ì4(€½¹ÍÐ¥Ñ•´€ôÁ…å±½…ü¹‘…Ñ„ì4(€½¹ÍÐ¥µ…•UÉ°€ô¥Á¡å%µ…•UÉ°¡¥Ñ•´¤ì4(€¥˜€ …¥Ñ•´ü¹¥ñð€…¥µ…•UÉ°¤Ñ¡É½Ü¹•ÜÉÉ½È ‰%A!d¹¼‘•Ù½±Ù§Ì•Í„É•…§Í¸¸ˆ¤ì4(€É•ÑÕÉ¸É•…Ñ•¥Á¡åI•…Ñ¥½¸¡ì4(€€€€¸¸¹¥¹ÁÕÐ°4(€€€­¥¹°4(€€€¥Á¡å%è¥Ñ•´¹¥°4(€€€Ñ¥Ñ±”è¥¹ÁÕÐ¹Ñ¥Ñ±”ñð¥Ñ•´¹Ñ¥Ñ±”ñð€‘í­¥¹‘ô‘”%A!e€°4(€€€¥µ…•UÉ°°4(€€€ÁÉ•Ù¥•ÝUÉ°è¥Á¡åAÉ•Ù¥•ÝUÉ°¡¥Ñ•´¤ñð¥µ…•UÉ°°4(€€€Á…•UÉ°è¥Ñ•´¹ÕÉ°ñð¡ÑÑÁÌè¼½¥Á¡ä¹½´½¥™Ì¼‘í¥Ñ•´¹¥‘õ€°4(€ô¤ì4)ô4(4)½¹ÍÐ¡ÑÑÁM•ÉÙ•È€ôÉ•…Ñ•M•ÉÙ•È¡…Íå¹Œ€¡É•Ä°É•Ì¤€ôøì4(€¥˜€ …É•Ä¹ÕÉ°¤ì4(€€€É•Ì¹ÝÉ¥Ñ•!•… ÐÀÀ¤¹•¹ ‰5¥ÍÍ¥¹œUI0ˆ¤ì4(€€€É•ÑÕÉ¸ì4(€ô4(4(€½¹ÍÐÕÉ°€ô¹•ÜUI0¡É•Ä¹ÕÉ°°¡ÑÑÀè¼¼‘íÉ•Ä¹¡•…‘•ÉÌ¹¡½ÍÐ€üü€‰±½…±¡½ÍÐ‰õ€¤ì((€¥˜€¡…Ý…¥Ð¡…¹‘±•=ÕÑ¡I•ÅÕ•ÍÐ¡É•Ä°É•Ì°ÕÉ°¤¤É•ÑÕÉ¸ì(4(€¥˜€¡É•Ä¹µ•Ñ¡½€ôôô€‰=AQ%=9Lˆ€˜˜ÕÉ°¹Á…Ñ¡¹…µ”€ôôô5A}AQ ¤ì(€€€ÝÉ¥Ñ•½ÉÍ!•…‘•ÉÌ¡É•Ì¤ì4(€€€É•Ì¹Í•Ñ!•…‘•È ‰•ÍÌµ½¹ÑÉ½°µ±±½Üµ5•Ñ¡½‘Ìˆ°€‰A=MP°P°1Q°=AQ%=9Lˆ¤ì4(€€€É•Ì¹ÝÉ¥Ñ•!•… ÈÀÐ¤¹•¹ ¤ì4(€€€É•ÑÕÉ¸ì(€ô((€¥˜€ (€€€É•Ä¹µ•Ñ¡½€ôôô€‰=AQ%=9Lˆ€˜˜(€€€ÕÉ°¹Á…Ñ¡¹…µ”€ôôô]%Q}%9=MQ%}AQ (€€¤ì(€€€ÝÉ¥Ñ•]¥‘•Ñ¥…¹½ÍÑ¥!•…‘•ÉÌ¡É•Ì¤ì(€€€É•Ì¹ÝÉ¥Ñ•!•… ÈÀÐ¤¹•¹ ¤ì(€€€É•ÑÕÉ¸ì(€ô((€¥˜€ (€€€É•Ä¹µ•Ñ¡½€ôôô€‰A=MPˆ€˜˜(€€€ÕÉ°¹Á…Ñ¡¹…µ”€ôôô]%Q}%9=MQ%}AQ (€€¤ì(€€€ÝÉ¥Ñ•]¥‘•Ñ¥…¹½ÍÑ¥!•…‘•ÉÌ¡É•Ì¤ì(€€€½¹ÍÐÅÕ•Éä€ôl¸¸¹ÕÉ°¹Í•…É¡A…É…µÌ¹•¹ÑÉ¥•Ì ¥tì(€€€½¹ÍÐÍÑ…”€ôÅÕ•Éä¹±•¹Ñ €ôôô€Ä€˜˜ÅÕ•ÉålÁulÁt€ôôô€‰ÍÑ…”ˆ(€€€€€€üÅÕ•ÉålÁulÅt(€€€€€€è€ˆˆì(€€€¥˜€¡…Ý…¥ÐÝ¥‘•Ñ¥…¹½ÍÑ¥!…Í	½‘ä¡É•Ä¤¤ì(€€€€€É•Ì¹ÝÉ¥Ñ•!•… ÐÄÌ¤¹•¹ ¤ì(€€€€€É•ÑÕÉ¸ì(€€€ô(€€€¥˜€ …]%Q}%9=MQ%}MQL¹¡…Ì¡ÍÑ…”¤¤ì(€€€€€É•Ì¹ÝÉ¥Ñ•!•… ÐÀÀ¤¹•¹ ¤ì(€€€€€É•ÑÕÉ¸ì(€€€ô(€€€±½]¥‘•Ñ¥…¹½ÍÑ¥Œ¡ÍÑ…”¤ì(€€€É•Ì¹ÝÉ¥Ñ•!•… ÈÀÐ¤¹•¹ ¤ì(€€€É•ÑÕÉ¸ì(€ô(4(€¥˜€ 4(€€€É•Ä¹µ•Ñ¡½€ôôô€‰Pˆ€˜˜4(€€€€¡ÕÉ°¹Á…Ñ¡¹…µ”€ôôô€ˆ¼ˆñðÕÉ°¹Á…Ñ¡¹…µ”€ôôô€ˆ½¡•…±Ñ ˆ¤4(€€¤ì4(€€€½¹ÍÐ‰½‘ä€ô)M=8¹ÍÑÉ¥¹¥™ä¡ì4(€€€€€¹…µ”èAA}95°4(€€€€€Ù•ÉÍ¥½¸èAA}YIM%=8°4(€€€€€ÍÑ…ÑÕÌè€‰½¬ˆ°4(€€€€€¥Á¡å½¹™¥ÕÉ•è	½½±•…¸¡ÁÉ½•ÍÌ¹•¹Ø¹%A!e}A%}-dü¹ÑÉ¥´ ¤¤°4(€€€€€½±±•Ñ¥½¹½¹™¥ÕÉ•è½±±•Ñ¥½¹½¹™¥ÕÉ• ¤°4(€€€€€½±±•Ñ¥½¹‘µ¥¹½¹™¥ÕÉ•è½±±•Ñ¥½¹‘µ¥¹½¹™¥ÕÉ• ¤°4(€€€€€½…ÕÑ¡½¹™¥ÕÉ•è½…ÕÑ¡½¹™¥ÕÉ• ¤°4(€€€€€µÀè5A}AQ °4(€€€ô¤ì4(€€€É•Ì4(€€€€€€¹ÝÉ¥Ñ•!•… ÈÀÀ°ì€‰½¹Ñ•¹ÐµÑåÁ”ˆè€‰…ÁÁ±¥…Ñ¥½¸½©Í½¸ì¡…ÉÍ•ÐõÕÑ˜´àˆô¤4(€€€€€€¹•¹¡‰½‘ä¤ì4(€€€É•ÑÕÉ¸ì4(€ô4(4(€¥˜€¡É•Ä¹µ•Ñ¡½€ôôô€‰Pˆ€˜˜ÕÉ°¹Á…Ñ¡¹…µ”€ôôô€ˆ½ÁÉ•Ù¥•Üˆ¤ì4(€€€É•Ì4(€€€€€€¹ÝÉ¥Ñ•!•… ÈÀÀ°ì€‰½¹Ñ•¹ÐµÑåÁ”ˆè€‰Ñ•áÐ½¡Ñµ°ì¡…ÉÍ•ÐõÕÑ˜´àˆô¤4(€€€€€€¹•¹¡É•¹‘•É]¥‘•Ñ!Ñµ° ¤¤ì4(€€€É•ÑÕÉ¸ì4(€ô4(4(€¥˜€¡É•Ä¹µ•Ñ¡½€ôôô€‰Pˆ€˜˜ÕÉ°¹Á…Ñ¡¹…µ”€ôôô€ˆ½ÁÉ•Ù¥•Ü½É•…Ñ¥½¸ˆ¤ì(€€€É•Ì(€€€€€€¹ÝÉ¥Ñ•!•… ÈÀÀ°ì€‰½¹Ñ•¹ÐµÑåÁ”ˆè€‰Ñ•áÐ½¡Ñµ°ì¡…ÉÍ•ÐõÕÑ˜´àˆô¤(€€€€€€¹•¹¡É•¹‘•ÉI•…Ñ¥½¹!Ñµ° ¤¤ì(€€€É•ÑÕÉ¸ì(€ô((€¥˜€¡É•Ä¹µ•Ñ¡½€ôôô€‰Pˆ€˜˜ÕÉ°¹Á…Ñ¡¹…µ”¹ÍÑ…ÉÑÍ]¥Ñ  ˆ½…Á¤½‘•Øµ…ÍÍ•ÑÌ¼ˆ¤¤ì(€€€¥˜€¡ÍÑ½É…•É¥Ù•È ¤€„ôô€‰µ•µ½Éäˆ¤ì(€€€€€É•Ì¹ÝÉ¥Ñ•!•… ÐÀÐ¤¹•¹ ‰9½Ð½Õ¹ˆ¤ì(€€€€€É•ÑÕÉ¸ì(€€€ô(€€€½¹ÍÐ­•ä€ô‘•½‘•UI%½µÁ½¹•¹Ð¡ÕÉ°¹Á…Ñ¡¹…µ”¹Í±¥” ˆ½…Á¤½‘•Øµ…ÍÍ•ÑÌ¼ˆ¹±•¹Ñ ¤¤ì(€€€½¹ÍÐ½‰©•Ð€ôµ•µ½Éå=‰©•Ð¡­•ä¤ì(€€€¥˜€ …½‰©•Ð¤ì(€€€€€É•Ì¹ÝÉ¥Ñ•!•… ÐÀÐ¤¹•¹ ‰9½Ð½Õ¹ˆ¤ì(€€€€€É•ÑÕÉ¸ì(€€€ô(€€€É•Ì(€€€€€€¹ÝÉ¥Ñ•!•… ÈÀÀ°ì(€€€€€€€€‰½¹Ñ•¹ÐµÑåÁ”ˆè½‰©•Ð¹½¹Ñ•¹ÑQåÁ”°(€€€€€€€€‰…¡”µ½¹ÑÉ½°ˆè€‰ÁÉ¥Ù…Ñ”°µ…àµ…”ôØÀˆ°(€€€€€ô¤(€€€€€€¹•¹¡½‰©•Ð¹‰åÑ•Ì¤ì(€€€É•ÑÕÉ¸ì(€ô(4(€¥˜€¡É•Ä¹µ•Ñ¡½€ôôô€‰Pˆ€˜˜ÕÉ°¹Á…Ñ¡¹…µ”€ôôô€ˆ½½±•¥½¸ˆ¤ì4(€€€É•Ì4(€€€€€€¹ÝÉ¥Ñ•!•… ÈÀÀ°ì4(€€€€€€€€‰½¹Ñ•¹ÐµÑåÁ”ˆè€‰Ñ•áÐ½¡Ñµ°ì¡…ÉÍ•ÐõÕÑ˜´àˆ°4(€€€€€€€€‰…¡”µ½¹ÑÉ½°ˆè€‰¹¼µÍÑ½É”ˆ°4(€€€€€€€€‰½¹Ñ•¹ÐµÍ•ÕÉ¥ÑäµÁ½±¥äˆè4(€€€€€€€€€€‰‘•™…Õ±ÐµÍÉŒ€Í•±˜œì¥µœµÍÉŒ€Í•±˜œ‘…Ñ„è‰±½ˆè¡ÑÑÁÌèì€ˆ€¬4(€€€€€€€€€€‰ÍÑå±”µÍÉŒ€Í•±˜œ€Õ¹Í…™”µ¥¹±¥¹”œìÍÉ¥ÁÐµÍÉŒ€Í•±˜œ€Õ¹Í…™”µ¥¹±¥¹”œì€ˆ€¬4(€€€€€€€€€€‰½¹¹•ÐµÍÉŒ€Í•±˜œì‰…Í”µÕÉ¤€¹½¹”œì™É…µ”µ…¹•ÍÑ½ÉÌ€¹½¹”œˆ°4(€€€€€ô¤4(€€€€€€¹•¹¡½±±•Ñ¥½¹‘µ¥¹Q•µÁ±…Ñ”¤ì4(€€€É•ÑÕÉ¸ì4(€ô4(4(€¥˜€ 4(€€€É•Ä¹µ•Ñ¡½€ôôô€‰Pˆ€˜˜4(€€€€¡ÕÉ°¹Á…Ñ¡¹…µ”€ôôô€ˆ¼¹Ý•±°µ­¹½Ý¸½½…ÕÑ µÁÉ½Ñ•Ñ•µÉ•Í½ÕÉ”ˆñð4(€€€€€ÕÉ°¹Á…Ñ¡¹…µ”€ôôô€ˆ¼¹Ý•±°µ­¹½Ý¸½½…ÕÑ µÁÉ½Ñ•Ñ•µÉ•Í½ÕÉ”½µÀˆ¤4(€€¤ì4(€€€©Í½¸¡É•Ì°€ÈÀÀ°ÁÉ½Ñ•Ñ•‘I•Í½ÕÉ•5•Ñ…‘…Ñ„ ¤¤ì4(€€€É•ÑÕÉ¸ì4(€ô4(4(€¥˜€¡É•Ä¹µ•Ñ¡½€ôôô€‰Pˆ€˜˜ÕÉ°¹Á…Ñ¡¹…µ”€ôôô€ˆ½…Á¤½½±±•Ñ¥½¸ˆ¤ì(€€€¥˜€ …É•ÅÕ¥É•½±±•Ñ¥½¹‘µ¥¸¡É•Ä°É•Ì¤¤É•ÑÕÉ¸ì(€€€ÑÉäì(€€€€€½¹ÍÐ¥Ñ•µÌ€ôÕÉ°¹Í•…É¡A…É…µÌ¹•Ð ‰…±°ˆ¤€ôôô€ˆÄˆ(€€€€€€€€ü…Ý…¥Ð±¥ÍÑ½±±•Ñ¥½¸¡ì…Ñ¥Ù•=¹±äè™…±Í”ô¤(€€€€€€€€è…Ý…¥ÐÍ•…É¡½±±•Ñ¥½¸¡ì4(€€€€€€€€€€€ÅÕ•ÉäèÕÉ°¹Í•…É¡A…É…µÌ¹•Ð ‰ÅÕ•Éäˆ¤ñð€ˆˆ°4(€€€€€€€€€€€­¥¹èÕÉ°¹Í•…É¡A…É…µÌ¹•Ð ‰­¥¹ˆ¤ñðÕ¹‘•™¥¹•°4(€€€€€€€€€€€±¥µ¥Ðè9Õµ‰•È¡ÕÉ°¹Í•…É¡A…É…µÌ¹•Ð ‰±¥µ¥Ðˆ¤ñð€ÈÀ¤°4(€€€€€€€€€ô¤ì4(€€€€€©Í½¸¡É•Ì°€ÈÀÀ°ì¥Ñ•µÌ°½¹™¥ÕÉ•è½±±•Ñ¥½¹½¹™¥ÕÉ• ¤ô¤ì4(€€€ô…Ñ €¡•ÉÉ½È¤ì4(€€€€€©Í½¸¡É•Ì°€ÔÀÌ°ì•ÉÉ½Èè•ÉÉ½È¹µ•ÍÍ…”ô¤ì4(€€€ô4(€€€É•ÑÕÉ¸ì4(€ô4(4(€¥˜€¡É•Ä¹µ•Ñ¡½€ôôô€‰A=MPˆ€˜˜ÕÉ°¹Á…Ñ¡¹…µ”€ôôô€ˆ½…Á¤½½±±•Ñ¥½¸½ÕÍÑ½´ˆ¤ì4(€€€¥˜€ …É•ÅÕ¥É•½±±•Ñ¥½¹‘µ¥¸¡É•Ä°É•Ì¤¤É•ÑÕÉ¸ì4(€€€ÑÉäì4(€€€€€©Í½¸¡É•Ì°€ÈÀÄ°ì¥Ñ•´è…Ý…¥ÐÉ•…Ñ•ÕÍÑ½µI•…Ñ¥½¸¡…Ý…¥ÐÉ•…‘)Í½¸¡É•Ä¤¤ô¤ì4(€€€ô…Ñ €¡•ÉÉ½È¤ì4(€€€€€©Í½¸¡É•Ì°€ÐÀÀ°ì•ÉÉ½Èè•ÉÉ½È¹µ•ÍÍ…”ô¤ì4(€€€ô4(€€€É•ÑÕÉ¸ì4(€ô4(4(€¥˜€¡É•Ä¹µ•Ñ¡½€ôôô€‰A=MPˆ€˜˜ÕÉ°¹Á…Ñ¡¹…µ”€ôôô€ˆ½…Á¤½½±±•Ñ¥½¸½¥Á¡äˆ¤ì4(€€€¥˜€ …É•ÅÕ¥É•½±±•Ñ¥½¹‘µ¥¸¡É•Ä°É•Ì¤¤É•ÑÕÉ¸ì4(€€€ÑÉäì4(€€€€€©Í½¸¡É•Ì°€ÈÀÄ°ì¥Ñ•´è…Ý…¥Ð¥µÁ½ÉÑ¥Á¡åI•…Ñ¥½¸¡…Ý…¥ÐÉ•…‘)Í½¸¡É•Ä¤¤ô¤ì4(€€€ô…Ñ €¡•ÉÉ½È¤ì4(€€€€€©Í½¸¡É•Ì°€ÐÀÀ°ì•ÉÉ½Èè•ÉÉ½È¹µ•ÍÍ…”ô¤ì4(€€€ô4(€€€É•ÑÕÉ¸ì4(€ô4(4(€½¹ÍÐ½±±•Ñ¥½¹%Ñ•µ5…Ñ €ôÕÉ°¹Á…Ñ¡¹…µ”¹µ…Ñ  ½yp½…Á¥p½½±±•Ñ¥½¹p¼¡lÀ´å„µ˜µt¬¤½¤¤ì4(€¥˜€¡½±±•Ñ¥½¹%Ñ•µ5…Ñ €˜˜É•Ä¹µ•Ñ¡½€ôôô€‰AQ ˆ¤ì4(€€€¥˜€ …É•ÅÕ¥É•½±±•Ñ¥½¹‘µ¥¸¡É•Ä°É•Ì¤¤É•ÑÕÉ¸ì4(€€€ÑÉäì4(€€€€€©Í½¸¡É•Ì°€ÈÀÀ°ì4(€€€€€€€¥Ñ•´è…Ý…¥ÐÕÁ‘…Ñ•I•…Ñ¥½¸¡½±±•Ñ¥½¹%Ñ•µ5…Ñ¡lÅt°…Ý…¥ÐÉ•…‘)Í½¸¡É•Ä¤¤°4(€€€€€ô¤ì4(€€€ô…Ñ €¡•ÉÉ½È¤ì4(€€€€€©Í½¸¡É•Ì°€ÐÀÀ°ì•ÉÉ½Èè•ÉÉ½È¹µ•ÍÍ…”ô¤ì4(€€€ô4(€€€É•ÑÕÉ¸ì4(€ô4(4(€¥˜€¡½±±•Ñ¥½¹%Ñ•µ5…Ñ €˜˜É•Ä¹µ•Ñ¡½€ôôô€‰1Qˆ¤ì4(€€€¥˜€ …É•ÅÕ¥É•½±±•Ñ¥½¹‘µ¥¸¡É•Ä°É•Ì¤¤É•ÑÕÉ¸ì4(€€€ÑÉäì4(€€€€€©Í½¸¡É•Ì°€ÈÀÀ°…Ý…¥Ð‘•±•Ñ•I•…Ñ¥½¸¡½±±•Ñ¥½¹%Ñ•µ5…Ñ¡lÅt¤¤ì4(€€€ô…Ñ €¡•ÉÉ½È¤ì4(€€€€€©Í½¸¡É•Ì°€ÐÀÀ°ì•ÉÉ½Èè•ÉÉ½È¹µ•ÍÍ…”ô¤ì4(€€€ô4(€€€É•ÑÕÉ¸ì4(€ô4(4(€½¹ÍÐµÁ5•Ñ¡½‘Ì€ô¹•ÜM•Ð¡l‰A=MPˆ°€‰Pˆ°€‰1Q‰t¤ì(€¥˜€¡É•Ä¹µ•Ñ¡½€˜˜ÕÉ°¹Á…Ñ¡¹…µ”€ôôô5A}AQ €˜˜µÁ5•Ñ¡½‘Ì¹¡…Ì¡É•Ä¹µ•Ñ¡½¤¤ì(€€€ÝÉ¥Ñ•½ÉÍ!•…‘•ÉÌ¡É•Ì¤ì(€€€¥˜€ …½…ÕÑ¡½¹™¥ÕÉ• ¤¤ì(€€€€€©Í½¸¡É•Ì°€ÔÀÌ°ì(€€€€€€€•ÉÉ½Èè€‰Í•ÉÙ•É}¹½Ñ}½¹™¥ÕÉ•ˆ°(€€€€€€€•ÉÉ½É}‘•ÍÉ¥ÁÑ¥½¸è€‰=]9I}=°=UQ!}M%9%9}MIP°AU	1%}	M}UI0°…¹Q	M}UI0µÕÍÐ‰”½¹™¥ÕÉ•¸ˆ°(€€€€€ô¤ì(€€€€€É•ÑÕÉ¸ì(€€€ô(€€€½¹ÍÐ…ÕÑ¡MÑ…Ñ”€ôÉ•Ä¹¡•…‘•ÉÌ¹…ÕÑ¡½É¥é…Ñ¥½¸€ü€‰ÁÉ•Í•¹Ðˆ€è€‰µ¥ÍÍ¥¹œˆì(€€€½¹ÍÐÉ•ÅÕ•ÍÑ1½œ€ô‰•¥¹5ÁI•ÅÕ•ÍÑ1½œ¡É•Ä°É•Ì°…ÕÑ¡MÑ…Ñ”¤ì(€€€½¹Í½±”¹¥¹™¼¡m5At€‘íÉ•Ä¹µ•Ñ¡½‘ô…ÕÑ ô‘í…ÕÑ¡MÑ…Ñ•õ€¤ì((€€€ÑÉäì(€€€€€É•Ä¹…ÕÑ €ô…Ý…¥Ð…ÕÑ¡•¹Ñ¥…Ñ•5ÁI•ÅÕ•ÍÐ¡É•Ä¤ì(€€€€€¥˜€¡½…ÕÑ¡½¹™¥ÕÉ• ¤€˜˜€…¥Í½±±•Ñ¥½¹=Ý¹•È¡É•Ä¹…ÕÑ ¤¤ì(€€€€€€€Ñ¡É½Ü¹•ÜÉÉ½È ‰Q¡¥ÌÁÉ¥Ù…Ñ”½¹¹•Ñ¥½¸É•ÅÕ¥É•Ì½Ý¹•È…ÕÑ¡½É¥é…Ñ¥½¸¸ˆ¤ì(€€€€€ô(€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€É•ÅÕ•ÍÑ1½œ¹…ÕÑ¡I•ÍÕ±Ð€ô€‰É•ÅÕ¥É•ˆì(€€€€€É•ÅÕ•ÍÑ1½œ¹ÉÁ5•Ñ¡½€ô…Ý…¥ÐÉ•©•Ñ•‘5Á5•Ñ¡½‘½É1½œ¡É•Ä¤ì(€€€€€½¹Í½±”¹¥¹™¼¡m5At€‘íÉ•Ä¹µ•Ñ¡½‘ô…ÕÑ¡½É¥é…Ñ¥½¸µÉ•ÅÕ¥É•‘€¤ì(€€€€€É•Ì¹Í•Ñ!•…‘•È (€€€€€€€€‰]]\µÕÑ¡•¹Ñ¥…Ñ”ˆ°(€€€€€€€½…ÕÑ¡¡…±±•¹•!•…‘•È ¤°4(€€€€€€¤ì4(€€€€€©Í½¸¡É•Ì°€ÐÀÄ°ì4(€€€€€€€•ÉÉ½Èè€‰¥¹Ù…±¥‘}Ñ½­•¸ˆ°4(€€€€€€€•ÉÉ½É}‘•ÍÉ¥ÁÑ¥½¸è•ÉÉ½È¥¹ÍÑ…¹•½˜ÉÉ½È€ü•ÉÉ½È¹µ•ÍÍ…”€è€‰Q½­•¸=ÕÑ ¹¼Û…±¥‘¼¸ˆ°4(€€€€€ô¤ì4(€€€€€É•ÑÕÉ¸ì(€€€ô(€€€É•ÅÕ•ÍÑ1½œ¹…ÕÑ¡I•ÍÕ±Ð€ô½…ÕÑ¡½¹™¥ÕÉ• ¤€ü€‰…ÕÑ¡½É¥é•ˆ€è€‰¹½ÐµÉ•ÅÕ¥É•ˆì(€€€½¹Í½±”¹¥¹™¼¡m5At€‘íÉ•Ä¹µ•Ñ¡½‘ô…ÕÑ¡½É¥é•‘€¤ì(4(€€€½¹ÍÐÍ•ÉÙ•È€ôÉ•…Ñ•5…¥M•ÉÙ•È ¤ì4(€€€½¹ÍÐÑÉ…¹ÍÁ½ÉÐ€ô¹•ÜMÑÉ•…µ…‰±•!QQAM•ÉÙ•ÉQÉ…¹ÍÁ½ÉÐ¡ì4(€€€€€Í•ÍÍ¥½¹%‘•¹•É…Ñ½ÈèÕ¹‘•™¥¹•°4(€€€€€•¹…‰±•)Í½¹I•ÍÁ½¹Í”èÑÉÕ”°4(€€€ô¤ì4(4(€€€É•Ì¹½¸ ‰±½Í”ˆ°€ ¤€ôøì4(€€€€€ÑÉ…¹ÍÁ½ÉÐ¹±½Í” ¤ì4(€€€€€Í•ÉÙ•È¹±½Í” ¤ì4(€€€ô¤ì4(4(€€€ÑÉäì(€€€€€…Ý…¥ÐÍ•ÉÙ•È¹½¹¹•Ð¡ÑÉ…¹ÍÁ½ÉÐ¤ì(€€€€€½¹ÍÐ¡…¹‘±•5•ÍÍ…”€ôÑÉ…¹ÍÁ½ÉÐ¹½¹µ•ÍÍ…”ì(€€€€€ÑÉ…¹ÍÁ½ÉÐ¹½¹µ•ÍÍ…”€ô€¡µ•ÍÍ…”°•áÑÉ„¤€ôøì(€€€€€€€É•ÅÕ•ÍÑ1½œ¹ÉÁ5•Ñ¡½€ôÍ…™•5Á5•Ñ¡½‘½É1½œ¡µ•ÍÍ…”°É•Ä¹µ•Ñ¡½¤ì(€€€€€€€É•ÑÕÉ¸¡…¹‘±•5•ÍÍ…”ü¸¡µ•ÍÍ…”°•áÑÉ„¤ì(€€€€€ôì(€€€€€…Ý…¥ÐÑÉ…¹ÍÁ½ÉÐ¹¡…¹‘±•I•ÅÕ•ÍÐ¡É•Ä°É•Ì¤ì(€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€½¹Í½±”¹•ÉÉ½È ‰m5AtÑÉ…¹ÍÁ½ÉÐµ•ÉÉ½Èˆ¤ì(€€€€€¥˜€ …É•Ì¹¡•…‘•ÉÍM•¹Ð¤ì(€€€€€€€É•Ì¹ÝÉ¥Ñ•!•… ÔÀÀ¤¹•¹ ‰%¹Ñ•É¹…°Í•ÉÙ•È•ÉÉ½Èˆ¤ì(€€€€€ô(€€€ô4(€€€É•ÑÕÉ¸ì4(€ô4(4(€É•Ì¹ÝÉ¥Ñ•!•… ÐÀÐ¤¹•¹ ‰9½Ð½Õ¹ˆ¤ì4)ô¤ì4(4)¡ÑÑÁM•ÉÙ•È¹±¥ÍÑ•¸¡A=IP°€ ¤€ôøì4(€½¹Í½±”¹±½œ¡€‘íAA}95ô±¥ÍÑ•¹¥¹œ½¸¡ÑÑÀè¼½±½…±¡½ÍÐè‘íA=IQô‘í5A}AQ!õ€¤ì4)ô¤ì4