import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { databaseConfigured, databaseDriver, memoryTable, query } from "./db.js";

export const OAUTH_SCOPE = "reactions:manage";
export const MIN_OWNER_CODE_LENGTH = 24;
const OWNER_SUBJECT = "template-owner";
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_BODY_TOO_LARGE = "OAUTH_REQUEST_BODY_TOO_LARGE";
const CHATGPT_CALLBACK_HOST = "chatgpt.com";
const CHATGPT_CALLBACK_PREFIX = "/connector/oauth/";
const CHATGPT_LEGACY_CALLBACK = "/connector_platform_oauth_redirect";
const attempts = new Map();

function env(name) {
  return String(process.env[name] || "").trim();
}

export function publicBaseUrl() {
  return (env("PUBLIC_BASE_URL") || `http://localhost:${env("PORT") || "8787"}`).replace(/\/+$/, "");
}

export function mcpResourceUrl() {
  return `${publicBaseUrl()}/mcp`;
}

export function resourceMetadataUrl() {
  return `${publicBaseUrl()}/.well-known/oauth-protected-resource/mcp`;
}

export function oauthIssuer() {
  return publicBaseUrl();
}

export function oauthConfigured() {
  return Boolean(
    env("OWNER_CODE").length >= MIN_OWNER_CODE_LENGTH &&
      env("OAUTH_SIGNING_SECRET").length >= 32 &&
      env("PUBLIC_BASE_URL") &&
      databaseConfigured(),
  );
}

export function protectedResourceMetadata() {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [oauthIssuer()],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Magic Reactions private collection",
  };
}

export function oauthAuthorizationServerMetadata() {
  return {
    issuer: oauthIssuer(),
    authorization_endpoint: `${publicBaseUrl()}/oauth/authorize`,
    token_endpoint: `${publicBaseUrl()}/oauth/token`,
    registration_endpoint: `${publicBaseUrl()}/oauth/register`,
    scopes_supported: [OAUTH_SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

function signingKey() {
  return new TextEncoder().encode(env("OAUTH_SIGNING_SECRET"));
}

function tokenHash(value) {
  return createHash("sha256").update(String(value)).digest("base64url");
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue));
  const right = Buffer.from(String(rightValue));
  return left.length === right.length && timingSafeEqual(left, right);
}

function validRedirectUri(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;

    const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if (loopback) return ["http:", "https:"].includes(url.protocol);

    if (
      url.protocol !== "https:" ||
      url.hostname !== CHATGPT_CALLBACK_HOST ||
      url.port ||
      url.search
    ) {
      return false;
    }

    if (url.pathname === CHATGPT_LEGACY_CALLBACK) return true;
    const callbackId = url.pathname.startsWith(CHATGPT_CALLBACK_PREFIX)
      ? url.pathname.slice(CHATGPT_CALLBACK_PREFIX.length)
      : "";
    return /^[A-Za-z0-9_-]+$/.test(callbackId);
  } catch {
    return false;
  }
}

function oauthClientPresentation(redirectUri) {
  const url = new URL(redirectUri);
  if (url.hostname === CHATGPT_CALLBACK_HOST) {
    return { name: "ChatGPT", destination: "https://chatgpt.com" };
  }
  return { name: "Local development client", destination: url.origin };
}

async function saveClient(client) {
  if (databaseDriver() === "memory") {
    memoryTable("clients").set(client.client_id, client);
    return;
  }
  await query(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (client_id) DO NOTHING`,
    [client.client_id, client.client_name, JSON.stringify(client.redirect_uris)],
  );
}

async function findClient(clientId) {
  if (databaseDriver() === "memory") return memoryTable("clients").get(clientId);
  const result = await query(
    "SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = $1",
    [clientId],
  );
  return result.rows[0];
}

async function saveCode(code, record) {
  const code_hash = tokenHash(code);
  if (databaseDriver() === "memory") {
    memoryTable("codes").set(code_hash, { ...record, code_hash, used: false });
    return;
  }
  await query(
    `INSERT INTO oauth_codes
      (code_hash, client_id, redirect_uri, code_challenge, scope, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      code_hash,
      record.client_id,
      record.redirect_uri,
      record.code_challenge,
      record.scope,
      record.expires_at,
    ],
  );
}

async function consumeCode(code, { clientId, redirectUri, challenge }) {
  const codeHash = tokenHash(code);
  if (databaseDriver() === "memory") {
    const row = memoryTable("codes").get(codeHash);
    if (
      !row ||
      row.used ||
      row.client_id !== clientId ||
      row.redirect_uri !== redirectUri ||
      !safeEqual(row.code_challenge, challenge) ||
      new Date(row.expires_at).getTime() <= Date.now()
    ) return null;
    row.used = true;
    return row;
  }
  const result = await query(
    `UPDATE oauth_codes SET used = true
     WHERE code_hash = $1 AND client_id = $2 AND redirect_uri = $3
       AND code_challenge = $4 AND used = false AND expires_at > now()
     RETURNING *`,
    [codeHash, clientId, redirectUri, challenge],
  );
  return result.rows[0] || null;
}

async function saveRefreshToken(token, record) {
  const token_hash = tokenHash(token);
  if (databaseDriver() === "memory") {
    memoryTable("refreshTokens").set(token_hash, {
      ...record,
      token_hash,
      revoked: false,
    });
    return;
  }
  await query(
    `INSERT INTO oauth_refresh_tokens
      (token_hash, client_id, subject, scope, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [token_hash, record.client_id, record.subject, record.scope, record.expires_at],
  );
}

async function rotateRefreshToken(token, clientId) {
  const tokenHashValue = tokenHash(token);
  if (databaseDriver() === "memory") {
    const row = memoryTable("refreshTokens").get(tokenHashValue);
    if (
      !row ||
      row.revoked ||
      row.client_id !== clientId ||
      new Date(row.expires_at).getTime() <= Date.now()
    ) return null;
    row.revoked = true;
    return row;
  }
  const result = await query(
    `UPDATE oauth_refresh_tokens SET revoked = true
     WHERE token_hash = $1 AND client_id = $2 AND revoked = false AND expires_at > now()
     RETURNING *`,
    [tokenHashValue, clientId],
  );
  return result.rows[0] || null;
}

async function issueTokens({ clientId, scope = OAUTH_SCOPE }) {
  const accessToken = await new SignJWT({
    client_id: clientId,
    scope,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(oauthIssuer())
    .setAudience(mcpResourceUrl())
    .setSubject(OWNER_SUBJECT)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(signingKey());
  const refreshToken = randomToken(48);
  await saveRefreshToken(refreshToken, {
    client_id: clientId,
    subject: OWNER_SUBJECT,
    scope,
    expires_at: new Date(Date.now() + REFRESH_TTL_MS),
  });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refreshToken,
    scope,
  };
}

function tokenScopes(payload) {
  return String(payload.scope || "").split(/\s+/).filter(Boolean);
}

export async function authenticateMcpRequest(req) {
  const header = String(req.headers.authorization || "").trim();
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("Authorization must use the Bearer scheme.");
  const { payload } = await jwtVerify(match[1], signingKey(), {
    issuer: oauthIssuer(),
    audience: mcpResourceUrl(),
    algorithms: ["HS256"],
  });
  const scopes = tokenScopes(payload);
  if (
    payload.sub !== OWNER_SUBJECT ||
    !payload.client_id ||
    !scopes.includes(OAUTH_SCOPE)
  ) {
    throw new Error("The OAuth token does not grant owner access.");
  }
  return {
    token: match[1],
    clientId: String(payload.client_id),
    scopes,
    expiresAt: Number(payload.exp),
    resource: new URL(mcpResourceUrl()),
    extra: { subject: OWNER_SUBJECT },
  };
}

export function isCollectionOwner(authInfo) {
  return Boolean(
    authInfo?.extra?.subject === OWNER_SUBJECT &&
      authInfo?.clientId &&
      authInfo?.scopes?.includes(OAUTH_SCOPE),
  );
}

export function oauthChallengeHeader({
  error = "invalid_token",
  errorDescription = "The OAuth session is missing, invalid, or expired.",
} = {}) {
  const escape = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return (
    `Bearer resource_metadata="${escape(resourceMetadataUrl())}", ` +
    `scope="${escape(OAUTH_SCOPE)}", error="${escape(error)}", ` +
    `error_description="${escape(errorDescription)}"`
  );
}

export function oauthChallengeResult(
  message = "Connect the private collection before using this tool.",
) {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    _meta: { "mcp/www_authenticate": [oauthChallengeHeader()] },
  };
}

async function readBody(req, maxBytes = 64 * 1024) {
  const declaredSize = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    const error = new Error("Request body is too large.");
    error.code = REQUEST_BODY_TOO_LARGE;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      const error = new Error("Request body is too large.");
      error.code = REQUEST_BODY_TOO_LARGE;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function oauthError(res, status, error, description) {
  json(res, status, { error, error_description: description });
}

function oauthRouteError(res, error, fallbackError) {
  if (error?.code === REQUEST_BODY_TOO_LARGE) {
    oauthError(res, 413, "invalid_request", "Request body is too large.");
    return;
  }
  oauthError(res, 400, fallbackError, error?.message || "OAuth request failed.");
}

function ownerAttemptAllowed(req) {
  const key = String(req.socket?.remoteAddress || "unknown");
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter((at) => now - at < 60_000);
  if (recent.length >= 10) return false;
  recent.push(now);
  attempts.set(key, recent);
  return true;
}

function authorizePage(params, request, error = "") {
  const hidden = [...params.entries()]
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`,
    )
    .join("");
  const client = oauthClientPresentation(request.redirectUri);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Magic Reactions</title><style>body{margin:0;background:#f7f2ff;color:#261a35;font:16px system-ui;display:grid;place-items:center;min-height:100vh}.card{width:min(420px,calc(100% - 32px));background:white;border:1px solid #dfd1f1;border-radius:28px;padding:28px;box-sizing:border-box;box-shadow:0 18px 60px #6a429426}h1{margin:0 0 8px}p{line-height:1.5}.client{background:#f7f2ff;border:1px solid #dfd1f1;border-radius:14px;padding:12px 14px}.client strong,.client span{display:block}.client span{font-size:13px;margin-top:3px;overflow-wrap:anywhere}label{display:block;font-weight:700;margin:22px 0 8px}input[type=password]{width:100%;box-sizing:border-box;border:1px solid #ccb7e6;border-radius:14px;padding:13px;font:inherit}button{width:100%;margin-top:18px;border:0;border-radius:14px;padding:14px;background:#7651a8;color:white;font:inherit;font-weight:800}.error{color:#9d2649}</style><main class="card"><h1>Magic Reactions</h1><p>Enter the private owner code generated for this deployment to approve this connection.</p><p class="client"><strong>Requested by ${escapeHtml(client.name)}</strong><span>Callback: ${escapeHtml(client.destination)}</span></p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}<form method="post" action="/oauth/authorize">${hidden}<label for="owner_code">Owner code</label><input id="owner_code" name="owner_code" type="password" autocomplete="current-password" required><button type="submit">Authorize ${escapeHtml(client.name)}</button></form></main></html>`;
}

function authorizePageHeaders(redirectUri) {
  const redirectOrigin = new URL(redirectUri).origin;
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}; base-uri 'none'; frame-ancestors 'none'`,
    "referrer-policy": "no-referrer",
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function validateAuthorizeParams(params) {
  const clientId = params.get("client_id") || "";
  const redirectUri = params.get("redirect_uri") || "";
  const responseType = params.get("response_type") || "";
  const codeChallenge = params.get("code_challenge") || "";
  const codeChallengeMethod = params.get("code_challenge_method") || "";
  const requestedScope = params.get("scope") || OAUTH_SCOPE;
  const client = await findClient(clientId);
  if (!client) throw new Error("Unknown OAuth client.");
  const redirectUris = Array.isArray(client.redirect_uris)
    ? client.redirect_uris
    : JSON.parse(client.redirect_uris || "[]");
  if (!redirectUris.includes(redirectUri)) throw new Error("Redirect URI is not registered.");
  if (responseType !== "code") throw new Error("Only authorization code flow is supported.");
  if (codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    throw new Error("PKCE S256 is required.");
  }
  if (!requestedScope.split(/\s+/).includes(OAUTH_SCOPE)) {
    throw new Error(`Scope ${OAUTH_SCOPE} is required.`);
  }
  return { clientId, redirectUri, codeChallenge, scope: OAUTH_SCOPE };
}

export async function handleOAuthRequest(req, res, url) {
  if (
    req.method === "GET" &&
    ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"].includes(url.pathname)
  ) {
    json(res, 200, oauthAuthorizationServerMetadata());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/oauth/register") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const redirectUris = Array.isArray(body.redirect_uris)
        ? [...new Set(body.redirect_uris.map(String))]
        : [];
      if (!redirectUris.length || !redirectUris.every(validRedirectUri)) {
        return oauthError(res, 400, "invalid_redirect_uri", "At least one safe redirect URI is required."), true;
      }
      const client = {
        client_id: randomToken(24),
        client_name: String(body.client_name || "ChatGPT").slice(0, 100),
        redirect_uris: redirectUris,
      };
      await saveClient(client);
      json(res, 201, {
        ...client,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    } catch (error) {
      oauthRouteError(res, error, "invalid_client_metadata");
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/oauth/authorize") {
    try {
      const request = await validateAuthorizeParams(url.searchParams);
      res.writeHead(200, authorizePageHeaders(request.redirectUri));
      res.end(authorizePage(url.searchParams, request));
    } catch (error) {
      oauthError(res, 400, "invalid_request", error.message);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/oauth/authorize") {
    try {
      const body = new URLSearchParams(await readBody(req));
      const ownerCode = body.get("owner_code") || "";
      body.delete("owner_code");
      const request = await validateAuthorizeParams(body);
      if (!ownerAttemptAllowed(req)) throw new Error("Too many attempts. Wait one minute.");
      if (!safeEqual(ownerCode, env("OWNER_CODE"))) {
        res.writeHead(401, authorizePageHeaders(request.redirectUri));
        res.end(authorizePage(body, request, "The owner code is not correct."));
        return true;
      }
      const code = randomToken(32);
      await saveCode(code, {
        client_id: request.clientId,
        redirect_uri: request.redirectUri,
        code_challenge: request.codeChallenge,
        scope: request.scope,
        expires_at: new Date(Date.now() + CODE_TTL_MS),
      });
      const redirect = new URL(request.redirectUri);
      redirect.searchParams.set("code", code);
      const state = body.get("state");
      if (state) redirect.searchParams.set("state", state);
      res.writeHead(303, { location: redirect.toString(), "cache-control": "no-store" }).end();
    } catch (error) {
      oauthRouteError(res, error, "invalid_request");
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/oauth/token") {
    try {
      const body = new URLSearchParams(await readBody(req));
      const grantType = body.get("grant_type") || "";
      if (grantType === "authorization_code") {
        const verifier = body.get("code_verifier") || "";
        const clientId = body.get("client_id") || "";
        const redirectUri = body.get("redirect_uri") || "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        const code = await consumeCode(body.get("code") || "", {
          clientId,
          redirectUri,
          challenge,
        });
        if (!code || new Date(code.expires_at).getTime() <= Date.now()) {
          throw new Error("Authorization code is invalid or expired.");
        }
        json(res, 200, await issueTokens({ clientId, scope: code.scope }));
        return true;
      }
      if (grantType === "refresh_token") {
        const clientId = body.get("client_id") || "";
        const record = await rotateRefreshToken(
          body.get("refresh_token") || "",
          clientId,
        );
        if (!record) {
          throw new Error("Refresh token is invalid or expired.");
        }
        json(res, 200, await issueTokens({ clientId, scope: record.scope }));
        return true;
      }
      throw new Error("Unsupported grant type.");
    } catch (error) {
      oauthRouteError(res, error, "invalid_grant");
    }
    return true;
  }

  return false;
}
