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
    throw new Error("La dirección autorizada de la imagen debe usar HTTPS.");
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
    throw new Error("La imagen debe pesar como máximo 8 MB.");
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
    throw new Error("La imagen nativa de la reacción debe usar HTTPS.");
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(NATIVE_REACTION_TIMEOUT_MS),
    redirect: "follow",
    headers: {
      accept: "image/webp,image/gif,image/png,image/jpeg;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`La imagen nativa respondió ${response.status}.`);
  }
  if (!canDownloadChatGptImage(new URL(response.url))) {
    throw new Error("La imagen nativa redirigió a una dirección no segura.");
  }

  const mimeType = String(response.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!/^image\/(?:gif|webp|png|jpeg)$/.test(mimeType)) {
    throw new Error("La reacción nativa no tiene un formato de imagen compatible.");
  }

  const announcedSize = Number(response.headers.get("content-length") || 0);
  if (announcedSize > MAX_NATIVE_REACTION_SOURCE_BYTES) {
    await response.body?.cancel();
    throw new Error("La reacción nativa supera el límite de entrada de 4 MiB.");
  }

  if (!response.body) {
    throw new Error("La reacción nativa llegó vacía.");
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
      throw new Error("La reacción nativa supera el límite de entrada de 4 MiB.");
    }
    chunks.push(Buffer.from(value));
  }
  if (!receivedBytes) {
    throw new Error("La reacción nativa llegó vacía.");
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
      throw new Error("No pude reducir la reacción nativa por debajo de 8 KiB.");
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
      .slice(0, 80) || "Reacción de GIPHY"
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
    throw new Error("GIPHY_API_KEY no está configurada.");
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
    throw new Error(`GIPHY respondió ${response.status}.`);
  }

  const payload = await response.json();
  const item = payload?.data;
  const imageUrl = giphyPreviewUrl(item) || giphyImageUrl(item);
  if (!item?.id || !imageUrl) {
    throw new Error("GIPHY no encontró una reacción animada.");
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
        "openai/toolInvocation/invoking": "Buscando una reacción bonita…",
        "openai/toolInvocation/invoked": "Reacción preparada ✨",
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
          ],
          structuredContent: {
            query,
            kind: selectedReaction.kind,
            mode: "direct",
            rating,
            selectedReaction,
            selectedGiphy: selectedReaction,
          },
          _meta: {
            reaction: selectedReaction,
          },
        };
        if (nativeReactionImage) {
          const resultWithNativeImage = {
            ...result,
            content: [...result.content, nativeReactionImage],
          };
          if (
            Buffer.byteLength(JSON.stringify(resultWithNativeImage), "utf8") <
            MAX_REACTION_RESULT_BYTES
          ) {
            return resultWithNativeImage;
          }
          console.warn(
            "Native reaction image omitted to keep the MCP result below 20 KB.",
          );
        }
        return result;
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "GIPHY no pudo preparar la reacción.",
            },
          ],
        };
      }
    },
  );

  registerAppTool(
    server,
    "open_giphy_picker",
    {
      title: "Let the user choose manually",
      description:
        "Manual picker only. Use this exclusively when the user explicitly asks to see a visible selector and choose a reaction. For ordinary requests to send or choose a reaction, call show_giphy_reaction directly.",
      inputSchema: {
        query: z.string().trim().min(1).max(50).default("abrazo tierno"),
        kind: kindSchema.default("sticker"),
        rating: ratingSchema.default("pg"),
      },
      outputSchema: pickerOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
      _meta: {
        securitySchemes: connectorSecurity,
        ui: { resourceUri: TEMPLATE_URI },
        "openai/outputTemplate": TEMPLATE_URI,
        "openai/toolInvocation/invoking": "Opening reactions…",
        "openai/toolInvocation/invoked": "Picker ready",
      },
    },
    async ({ query = "abrazo tierno", kind = "sticker", rating = "pg" }) =>
      widgetResult({
        query,
        kind,
        rating,
        message: `Opening ${kind} choices for “${query}”.`,
      }),
  );

  registerAppTool(
    server,
    "list_magic_collection",
    {
      title: "List the private collection",
      description:
        "Use this when the user wants to review saved GIFs and stickers, including their IDs and usage metadata.",
      inputSchema: {
        kind: kindSchema.optional(),
        limit: z.number().int().min(1).max(20).default(20),
      },
      outputSchema: { collection: pickerOutputSchema.collection },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: { securitySchemes: connectorSecurity },
    },
    async ({ kind, limit = 20 }) => {
      const collection = await searchCollection({ query: "", kind, limit }).catch(
        () => [],
      );
      return {
        content: [
          {
            type: "text",
            text: `The private collection has ${collection.length} visible reactions.`,
          },
        ],
        structuredContent: { collection },
      };
    },
  );

  registerAppTool(
    server,
    "search_magic_collection",
    {
      title: "Search the private collection",
      description:
        "Use this only when the user explicitly asks to search or review saved reactions. It returns up to three distinct matches. Never call it as a required step before show_giphy_reaction.",
      inputSchema: {
        query: z.string().trim().max(50).default(""),
        kind: kindSchema.optional(),
      },
      outputSchema: { collection: pickerOutputSchema.collection },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: {
        securitySchemes: connectorSecurity,
        ui: { visibility: ["app", "model"] },
        "openai/widgetAccessible": true,
      },
    },
    async ({ query = "", kind }) => {
      const ranked = await searchCollection({ query, kind, limit: 20 }).catch(
        () => [],
      );
      const collection = ranked
        .filter(
          (item, index, items) =>
            index === items.findIndex((candidate) => candidate.id === item.id),
        )
        .slice(0, 3);
      return {
        content: [
          {
            type: "text",
            text: `I found ${collection.length} distinct reactions in the private collection.`,
          },
        ],
        structuredContent: { collection },
      };
    },
  );

  registerAppTool(
    server,
    "add_magic_reaction",
    {
      title: "Save an image to the private collection",
      description:
        "Use this only when the user explicitly asks to save an image from the conversation as a sticker or GIF. Pass the exact conversation image through the authorized image parameter; never substitute a pasted URL.",
      inputSchema: {
        image: chatGptImageSchema.optional().describe(
          "The exact image file from the conversation that the user wants to save.",
        ),
        title: z.string().trim().min(1).max(100),
        description: z.string().trim().max(500).default(""),
        kind: kindSchema.default("sticker"),
        tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
        moods: z.array(z.string().trim().min(1).max(50)).max(8).default([]),
        useWhen: z.array(z.string().trim().min(1).max(140)).max(12).default([]),
        favorite: z.boolean().default(false),
        priority: z.number().int().min(0).max(100).default(0),
      },
      outputSchema: {
        item: z.object({
          id: z.string().uuid(),
          title: z.string(),
          kind: kindSchema,
          source: z.literal("custom"),
        }),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
      _meta: {
        securitySchemes: ownerSecurity,
        "openai/fileParams": ["image"],
        "openai/toolInvocation/invoking": "Guardando la nueva pegatina…",
        "openai/toolInvocation/invoked": "Reaction saved",
      },
    },
    async ({ image, ...details }, extra) => {
      if (!isCollectionOwner(extra.authInfo)) return oauthChallengeResult();
      if (!image) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Necesito la imagen autorizada de la conversación para guardarla.",
            },
          ],
        };
      }
      let uploadStage = "download";
      try {
        const { bytes, mimeType } = await downloadChatGptImage(image);
        uploadStage = "save";
        const item = await createCustomReaction({
          ...details,
          mimeType,
          base64: bytes.toString("base64"),
        });
        return {
          content: [
            {
              type: "text",
              text: `Saved “${item.title}” to the private collection.`,
            },
          ],
          structuredContent: {
            item: {
              id: item.id,
              title: item.title,
              kind: item.kind,
              source: item.source,
            },
          },
        };
      } catch (error) {
        console.error("Magic reaction upload failed", {
          stage: uploadStage,
          message: error instanceof Error ? error.message : String(error),
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "The image could not be saved to the private collection.",
            },
          ],
        };
      }
    },
  );

  registerAppTool(
    server,
    "update_magic_reaction",
    {
      title: "Edit a saved reaction",
      description:
        "Use this only when the user asks to edit a saved GIF or sticker. It can change its title, description, tags, moods, usage guidance, favorite status, and priority. It never replaces or deletes the image.",
      inputSchema: {
        id: z.string().uuid(),
        title: z.string().trim().min(1).max(100).optional(),
        description: z.string().trim().max(500).optional(),
        tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
        moods: z.array(z.string().trim().min(1).max(50)).max(8).optional(),
        useWhen: z.array(z.string().trim().min(1).max(140)).max(12).optional(),
        favorite: z.boolean().optional(),
        priority: z.number().int().min(0).max(100).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: {
        securitySchemes: ownerSecurity,
        "openai/toolInvocation/invoking": "Cuidando el tesorito…",
        "openai/toolInvocation/invoked": "Tesorito actualizado ✨",
      },
    },
    async ({ id, ...changes }, extra) => {
      if (!isCollectionOwner(extra.authInfo)) return oauthChallengeResult();
      if (!Object.keys(changes).length) {
        return {
          isError: true,
          content: [{ type: "text", text: "Dime al menos qué detalle quieres cambiar." }],
        };
      }
      try {
        const item = await updateReaction(id, changes);
        return {
          content: [{ type: "text", text: `Updated “${item.title}” in the private collection.` }],
          structuredContent: { item },
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : "No pude actualizar la reacción." }],
        };
      }
    },
  );

  registerAppTool(
    server,
    "deactivate_magic_reaction",
    {
      title: "Hide a saved reaction",
      description:
        "Use this only when the user explicitly asks to stop using a saved GIF or sticker. It hides the item reversibly and does not delete its record or image.",
      inputSchema: { id: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: {
        securitySchemes: ownerSecurity,
        "openai/toolInvocation/invoking": "Guardando el tesorito…",
        "openai/toolInvocation/invoked": "Tesorito guardado con cuidado",
      },
    },
    async ({ id }, extra) => {
      if (!isCollectionOwner(extra.authInfo)) return oauthChallengeResult();
      try {
        const item = await updateReaction(id, { active: false });
        return {
          content: [{ type: "text", text: `He dejado “${item.title}” fuera de las búsquedas, sin borrarlo.` }],
          structuredContent: { item },
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : "No pude desactivar la reacción." }],
        };
      }
    },
  );
}

function createMagicServer() {
  const widgetDomain = new URL(publicBaseUrl()).origin;
  const collectionResourceDomains = collectionAssetOrigins();
  const reactionConnectDomains = [widgetDiagnosticOrigin()];
  const widgetConnectDomains = [
    "https://api.giphy.com",
    "https://giphy-analytics.giphy.com",
  ];
  const widgetResourceDomains = [
    "https://media.giphy.com",
    "https://media0.giphy.com",
    "https://media1.giphy.com",
    "https://media2.giphy.com",
    "https://media3.giphy.com",
    "https://media4.giphy.com",
    "https://i.giphy.com",
    ...collectionResourceDomains,
  ];
  const server = new McpServer(
    { name: "magic-reactions", version: APP_VERSION },
    {
      instructions:
        "PRIVATE CONNECTION: OAuth protects the complete MCP. Use show_giphy_reaction directly whenever the user asks you to send, choose, or surprise them with a GIF or sticker. That one call searches the private collection first and falls back to GIPHY. Never require an exact ID or a separate search step. Only open the picker when the user explicitly asks to browse and choose manually. Save, edit, and hide reactions only on explicit request.",
    },
  );

  function registerWidgetResource(name, uri) {
    registerAppResource(server, name, uri, {}, async () => ({
      contents: [
        {
          uri,
          mimeType: RESOURCE_MIME_TYPE,
          text: renderWidgetHtml(),
          _meta: {
            ui: {
              domain: widgetDomain,
              prefersBorder: true,
              csp: {
                connectDomains: widgetConnectDomains,
                resourceDomains: widgetResourceDomains,
              },
            },
            "openai/widgetCSP": {
              connect_domains: widgetConnectDomains,
              resource_domains: widgetResourceDomains,
            },
            "openai/widgetDomain": widgetDomain,
            "openai/widgetDescription":
              "A warm lilac picker for searching, previewing, and choosing GIPHY stickers and GIFs.",
            "openai/widgetPrefersBorder": true,
          },
        },
      ],
    }));
  }

  registerWidgetResource("magic-reactions-picker-v1", TEMPLATE_URI);
  LEGACY_TEMPLATE_URIS.forEach((uri, index) => {
    registerWidgetResource(`magic-reactions-picker-legacy-v${index + 1}`, uri);
  });
  function registerReactionResource(name, uri) {
    registerAppResource(server, name, uri, {}, async () => ({
      contents: [
        {
          uri,
          mimeType: RESOURCE_MIME_TYPE,
          text: renderReactionHtml(),
          _meta: {
            ui: {
              domain: widgetDomain,
              prefersBorder: false,
              csp: {
                connectDomains: reactionConnectDomains,
                resourceDomains: widgetResourceDomains,
              },
            },
            "openai/widgetCSP": {
              connect_domains: reactionConnectDomains,
              resource_domains: widgetResourceDomains,
            },
            "openai/widgetDomain": widgetDomain,
            "openai/widgetDescription":
              "A single animated reaction selected from a private collection or GIPHY.",
            "openai/widgetPrefersBorder": false,
          },
        },
      ],
    }));
  }

  registerReactionResource(
    "magic-reactions-direct-v1",
    REACTION_TEMPLATE_URI,
  );
  registerReactionResource(
    "magic-reactions-direct-legacy-v1",
    LEGACY_REACTION_V1_URI,
  );
  LEGACY_REACTION_TEMPLATE_URIS.forEach((uri, index) => {
    registerReactionResource(`magic-reactions-direct-legacy-v${index + 2}`, uri);
  });

  registerMagicTools(server);
  exposeStandardSecuritySchemes(server);
  return server;
}

function exposeStandardSecuritySchemes(server) {
  const protocol = server.server;
  const originalListTools = protocol?._requestHandlers?.get("tools/list");
  if (typeof originalListTools !== "function") {
    throw new Error("No pude ampliar el descriptor de las herramientas MCP.");
  }

  // SDK 1.30 preserves the compatibility mirror in `_meta` but omits the
  // standard top-level field required by ChatGPT's OAuth tool discovery.
  protocol.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await originalListTools(request, extra);
    return {
      ...result,
      tools: result.tools.map((tool) => {
        const securitySchemes = tool?._meta?.securitySchemes;
        return Array.isArray(securitySchemes)
          ? { ...tool, securitySchemes }
          : tool;
      }),
    };
  });
}

function writeCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "authorization, content-type, mcp-session-id, mcp-protocol-version",
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Mcp-Session-Id, MCP-Protocol-Version",
  );
}

function json(res, status, value) {
  res
    .writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    })
    .end(JSON.stringify(value));
}

async function readJson(req, maxBytes = 12 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error("La petición es demasiado grande.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("El contenido enviado no es JSON válido.");
  }
}

function writeWidgetDiagnosticHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

function widgetDiagnosticHasBody(req) {
  const contentLength = String(req.headers["content-length"] || "0");
  if (contentLength !== "0") {
    req.resume();
    return Promise.resolve(true);
  }
  if (!req.headers["transfer-encoding"]) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    let timeout;
    const finish = (hasBody) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      resolve(hasBody);
    };
    const onData = (chunk) => {
      if (!chunk.byteLength) return;
      finish(true);
      req.resume();
    };
    const onEnd = () => finish(false);
    const onError = () => finish(true);
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    timeout = setTimeout(() => {
      finish(true);
      req.resume();
    }, 100);
  });
}

let widgetDiagnosticWindowStartedAt = 0;
let widgetDiagnosticLogCount = 0;

function logWidgetDiagnostic(stage) {
  const now = Date.now();
  if (now - widgetDiagnosticWindowStartedAt >= 60_000) {
    widgetDiagnosticWindowStartedAt = now;
    widgetDiagnosticLogCount = 0;
  }
  if (widgetDiagnosticLogCount >= WIDGET_DIAGNOSTIC_LOG_LIMIT) return;
  widgetDiagnosticLogCount += 1;
  console.info(`[WIDGET] v=1 stage=${stage}`);
}

function safeMcpMethodForLog(message, httpMethod) {
  if (httpMethod === "GET") return "http-get";
  if (httpMethod === "DELETE") return "http-delete";
  if (httpMethod !== "POST") return "other";
  if (Array.isArray(message)) return "batch";

  const method = typeof message?.method === "string" ? message.method : "";
  if (!method) return "unknown";
  return DIAGNOSTIC_MCP_METHODS.has(method) ? method : "other";
}

function beginMcpRequestLog(req, res, authState) {
  const startedAt = Date.now();
  const state = {
    rpcMethod: safeMcpMethodForLog(undefined, req.method),
    authResult: "checking",
  };
  let emitted = false;

  const emit = (status, outcome) => {
    if (emitted) return;
    emitted = true;
    console.info(
      `[MCP] request rpc=${state.rpcMethod} http=${req.method || "UNKNOWN"} ` +
        `auth=${authState} authResult=${state.authResult} status=${status} ` +
        `outcome=${outcome} durationMs=${Date.now() - startedAt}`,
    );
  };

  res.once("finish", () => emit(res.statusCode, "finished"));
  res.once("close", () => {
    if (!res.writableFinished) emit("interrupted", "interrupted");
  });

  return state;
}

function rejectedMcpMethodForLog(req) {
  if (req.method !== "POST") {
    return Promise.resolve(safeMcpMethodForLog(undefined, req.method));
  }

  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let timer;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAborted);
    };

    const finish = (rpcMethod, drain = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain && !req.destroyed) req.resume();
      resolve(rpcMethod);
    };

    const onData = (chunk) => {
      size += chunk.byteLength;
      if (size > MAX_REJECTED_MCP_LOG_BODY_BYTES) {
        finish("unknown", true);
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };

    const onEnd = () => {
      try {
        const body = chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
          : {};
        finish(safeMcpMethodForLog(body, req.method));
      } catch {
        finish("unknown");
      }
    };

    const onError = () => finish("unknown");
    const onAborted = () => finish("unknown");

    timer = setTimeout(
      () => finish("unknown", true),
      MAX_REJECTED_MCP_LOG_WAIT_MS,
    );
    timer.unref?.();
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

function requireCollectionAdmin(req, res) {
  if (isCollectionAdmin(req)) return true;
  json(res, 401, { error: "The owner code is not correct." });
  return false;
}

function giphyIdFrom(value) {
  const raw = String(value || "").trim();
  if (/^[a-zA-Z0-9_-]{3,100}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const last = url.pathname.split("-").at(-1)?.split("/").filter(Boolean).at(-1);
    return /^[a-zA-Z0-9_-]{3,100}$/.test(last || "") ? last : "";
  } catch {
    return "";
  }
}

async function importGiphyReaction(input) {
  const kind = input.kind === "sticker" ? "sticker" : "gif";
  const id = giphyIdFrom(input.giphyId || input.url);
  if (!id) throw new Error("No pude reconocer el ID o enlace de GIPHY.");
  const payload = await getGiphyById({ id, kind });
  const item = payload?.data;
  const imageUrl = giphyImageUrl(item);
  if (!item?.id || !imageUrl) throw new Error("GIPHY no devolvió esa reacción.");
  return createGiphyReaction({
    ...input,
    kind,
    giphyId: item.id,
    title: input.title || item.title || `${kind} de GIPHY`,
    imageUrl,
    previewUrl: giphyPreviewUrl(item) || imageUrl,
    pageUrl: item.url || `https://giphy.com/gifs/${item.id}`,
  });
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (await handleOAuthRequest(req, res, url)) return;

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    writeCorsHeaders(res);
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.writeHead(204).end();
    return;
  }

  if (
    req.method === "OPTIONS" &&
    url.pathname === WIDGET_DIAGNOSTIC_PATH
  ) {
    writeWidgetDiagnosticHeaders(res);
    res.writeHead(204).end();
    return;
  }

  if (
    req.method === "POST" &&
    url.pathname === WIDGET_DIAGNOSTIC_PATH
  ) {
    writeWidgetDiagnosticHeaders(res);
    const query = [...url.searchParams.entries()];
    const stage = query.length === 1 && query[0][0] === "stage"
      ? query[0][1]
      : "";
    if (await widgetDiagnosticHasBody(req)) {
      res.writeHead(413).end();
      return;
    }
    if (!WIDGET_DIAGNOSTIC_STAGES.has(stage)) {
      res.writeHead(400).end();
      return;
    }
    logWidgetDiagnostic(stage);
    res.writeHead(204).end();
    return;
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/" || url.pathname === "/health")
  ) {
    const body = JSON.stringify({
      name: APP_NAME,
      version: APP_VERSION,
      status: "ok",
      giphyConfigured: Boolean(process.env.GIPHY_API_KEY?.trim()),
      collectionConfigured: collectionConfigured(),
      collectionAdminConfigured: collectionAdminConfigured(),
      oauthConfigured: oauthConfigured(),
      mcp: MCP_PATH,
    });
    res
      .writeHead(200, { "content-type": "application/json; charset=utf-8" })
      .end(body);
    return;
  }

  if (req.method === "GET" && url.pathname === "/preview") {
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(renderWidgetHtml());
    return;
  }

  if (req.method === "GET" && url.pathname === "/preview/reaction") {
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(renderReactionHtml());
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/dev-assets/")) {
    if (storageDriver() !== "memory") {
      res.writeHead(404).end("Not Found");
      return;
    }
    const key = decodeURIComponent(url.pathname.slice("/api/dev-assets/".length));
    const object = memoryObject(key);
    if (!object) {
      res.writeHead(404).end("Not Found");
      return;
    }
    res
      .writeHead(200, {
        "content-type": object.contentType,
        "cache-control": "private, max-age=60",
      })
      .end(object.bytes);
    return;
  }

  if (req.method === "GET" && url.pathname === "/coleccion") {
    res
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'self'; img-src 'self' data: blob: https:; " +
          "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
          "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      })
      .end(collectionAdminTemplate);
    return;
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp")
  ) {
    json(res, 200, protectedResourceMetadata());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/collection") {
    if (!requireCollectionAdmin(req, res)) return;
    try {
      const items = url.searchParams.get("all") === "1"
        ? await listCollection({ activeOnly: false })
        : await searchCollection({
            query: url.searchParams.get("query") || "",
            kind: url.searchParams.get("kind") || undefined,
            limit: Number(url.searchParams.get("limit") || 20),
          });
      json(res, 200, { items, configured: collectionConfigured() });
    } catch (error) {
      json(res, 503, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/collection/custom") {
    if (!requireCollectionAdmin(req, res)) return;
    try {
      json(res, 201, { item: await createCustomReaction(await readJson(req)) });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/collection/giphy") {
    if (!requireCollectionAdmin(req, res)) return;
    try {
      json(res, 201, { item: await importGiphyReaction(await readJson(req)) });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

  const collectionItemMatch = url.pathname.match(/^\/api\/collection\/([0-9a-f-]+)$/i);
  if (collectionItemMatch && req.method === "PATCH") {
    if (!requireCollectionAdmin(req, res)) return;
    try {
      json(res, 200, {
        item: await updateReaction(collectionItemMatch[1], await readJson(req)),
      });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

  if (collectionItemMatch && req.method === "DELETE") {
    if (!requireCollectionAdmin(req, res)) return;
    try {
      json(res, 200, await deleteReaction(collectionItemMatch[1]));
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

  const mcpMethods = new Set(["POST", "GET", "DELETE"]);
  if (req.method && url.pathname === MCP_PATH && mcpMethods.has(req.method)) {
    writeCorsHeaders(res);
    if (!oauthConfigured()) {
      json(res, 503, {
        error: "server_not_configured",
        error_description: "OWNER_CODE, OAUTH_SIGNING_SECRET, PUBLIC_BASE_URL, and DATABASE_URL must be configured.",
      });
      return;
    }
    const authState = req.headers.authorization ? "present" : "missing";
    const requestLog = beginMcpRequestLog(req, res, authState);
    console.info(`[MCP] ${req.method} auth=${authState}`);

    try {
      req.auth = await authenticateMcpRequest(req);
      if (oauthConfigured() && !isCollectionOwner(req.auth)) {
        throw new Error("This private connection requires owner authorization.");
      }
    } catch (error) {
      requestLog.authResult = "required";
      requestLog.rpcMethod = await rejectedMcpMethodForLog(req);
      console.info(`[MCP] ${req.method} authorization-required`);
      res.setHeader(
        "WWW-Authenticate",
        oauthChallengeHeader(),
      );
      json(res, 401, {
        error: "invalid_token",
        error_description: error instanceof Error ? error.message : "Token OAuth no válido.",
      });
      return;
    }
    requestLog.authResult = oauthConfigured() ? "authorized" : "not-required";
    console.info(`[MCP] ${req.method} authorized`);

    const server = createMagicServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      const handleMessage = transport.onmessage;
      transport.onmessage = (message, extra) => {
        requestLog.rpcMethod = safeMcpMethodForLog(message, req.method);
        return handleMessage?.(message, extra);
      };
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("[MCP] transport-error");
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(PORT, () => {
  console.log(`${APP_NAME} listening on http://localhost:${PORT}${MCP_PATH}`);
});
