import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXsAAAAASUVORK5CYII=",
  "base64",
);

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

const mockPort = await freePort();
const appPort = await freePort();
const mockOrigin = `http://127.0.0.1:${mockPort}`;
const appOrigin = `http://127.0.0.1:${appPort}`;

const upstream = createServer((req, res) => {
  if (req.url.startsWith("/image.png")) {
    res.writeHead(200, { "content-type": "image/png", "content-length": png.length });
    res.end(png);
    return;
  }
  if (req.url.startsWith("/v1/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: {
          id: "mock-giphy-id",
          title: "Friendly wave",
          url: "https://giphy.com/gifs/mock-giphy-id",
          images: {
            fixed_width_small: { url: `${mockOrigin}/image.png` },
            downsized_medium: { url: `${mockOrigin}/image.png` },
          },
        },
      }),
    );
    return;
  }
  res.writeHead(404).end();
});
upstream.listen(mockPort, "127.0.0.1");
await once(upstream, "listening");

const child = spawn(process.execPath, ["server.js"], {
  cwd: new URL("../", import.meta.url),
  env: {
    ...process.env,
    PORT: String(appPort),
    PUBLIC_BASE_URL: appOrigin,
    OWNER_CODE: "owner-code-for-local-smoke",
    OAUTH_SIGNING_SECRET: "smoke-signing-secret-that-is-longer-than-thirty-two-characters",
    DATABASE_DRIVER: "memory",
    STORAGE_DRIVER: "memory",
    GIPHY_API_KEY: "giphy-smoke-key",
    GIPHY_API_ORIGIN: mockOrigin,
    ALLOW_INSECURE_FILE_DOWNLOADS_FOR_TESTS: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let logs = "";
child.stdout.on("data", (chunk) => (logs += chunk));
child.stderr.on("data", (chunk) => (logs += chunk));

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${appOrigin}/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become healthy.\n${logs}`);
}

async function postForm(path, values) {
  return fetch(`${appOrigin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
    redirect: "manual",
  });
}

let rpcId = 0;
async function rpc(method, params, token) {
  const response = await fetch(`${appOrigin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(`${method} failed: ${JSON.stringify(body)}`);
  return body.result;
}

try {
  const health = await waitForHealth();
  if (
    health.name !== "Magic Reactions" ||
    health.version !== "0.1.2" ||
    !health.oauthConfigured ||
    !health.collectionConfigured
  ) {
    throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
  }

  const anonymous = await fetch(`${appOrigin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  if (anonymous.status !== 401 || !anonymous.headers.get("www-authenticate")) {
    throw new Error("Anonymous MCP requests must receive an OAuth challenge.");
  }
  const anonymousCollection = await fetch(`${appOrigin}/api/collection`);
  if (anonymousCollection.status !== 401) {
    throw new Error("The private collection API must reject anonymous reads.");
  }

  for (const path of ["/oauth/authorize", "/oauth/token"]) {
    const oversized = await fetch(`${appOrigin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=${"x".repeat(70 * 1024)}`,
    });
    const oversizedBody = await oversized.json();
    if (
      oversized.status !== 413 ||
      oversizedBody.error !== "invalid_request"
    ) {
      throw new Error(`${path} did not reject an oversized body safely.`);
    }
  }
  const oversizedRegistration = await fetch(`${appOrigin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(70 * 1024) }),
  });
  if (
    oversizedRegistration.status !== 413 ||
    (await oversizedRegistration.json()).error !== "invalid_request"
  ) {
    throw new Error("Dynamic registration did not reject an oversized body safely.");
  }
  const healthAfterOversizedOAuth = await fetch(`${appOrigin}/health`);
  if (!healthAfterOversizedOAuth.ok) {
    throw new Error("The service stopped responding after an oversized OAuth body.");
  }
  const oversizedChunked = await fetch(`${appOrigin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(`grant_type=${"x".repeat(70 * 1024)}`));
        controller.close();
      },
    }),
    duplex: "half",
  });
  if (
    oversizedChunked.status !== 413 ||
    (await oversizedChunked.json()).error !== "invalid_request"
  ) {
    throw new Error("Chunked OAuth input did not respect the body-size limit.");
  }

  for (const redirectUri of [
    "https://example.org/callback",
    "https://chatgpt.com.evil.example/connector/oauth/smoke-callback",
  ]) {
    const unsafeRegistration = await fetch(`${appOrigin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Pretend ChatGPT client",
        redirect_uris: [redirectUri],
      }),
    });
    const unsafeBody = await unsafeRegistration.json();
    if (
      unsafeRegistration.status !== 400 ||
      unsafeBody.error !== "invalid_redirect_uri"
    ) {
      throw new Error(`Unsafe OAuth callback was accepted: ${redirectUri}`);
    }
  }

  for (const redirectUri of [
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "http://127.0.0.1:54321/oauth/callback",
  ]) {
    const compatibleRegistration = await fetch(`${appOrigin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Compatible smoke client",
        redirect_uris: [redirectUri],
      }),
    });
    if (compatibleRegistration.status !== 201) {
      throw new Error(`Supported OAuth callback was rejected: ${redirectUri}`);
    }
  }

  const registration = await fetch(`${appOrigin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Smoke client",
      redirect_uris: ["https://chatgpt.com/connector/oauth/smoke-callback"],
    }),
  }).then((response) => response.json());
  if (!registration.client_id) throw new Error("Dynamic client registration failed.");

  const verifier = "local-smoke-verifier-abcdefghijklmnopqrstuvwxyz-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${appOrigin}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: "https://chatgpt.com/connector/oauth/smoke-callback",
    scope: "reactions:manage",
    state: "smoke-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const consent = await fetch(authorize);
  const consentCsp = consent.headers.get("content-security-policy") || "";
  const consentHtml = await consent.text();
  if (
    !consent.ok ||
    !consentHtml.includes("Owner code") ||
    !consentHtml.includes("Requested by ChatGPT") ||
    !consentHtml.includes("Callback: https://chatgpt.com")
  ) {
    throw new Error("OAuth consent page did not render.");
  }
  if (
    !consentCsp.includes("form-action 'self' https://chatgpt.com") ||
    consent.headers.get("referrer-policy") !== "no-referrer"
  ) {
    throw new Error(`OAuth consent page does not allow the registered ChatGPT callback safely: ${consentCsp}`);
  }
  const rejectedAuthorization = await postForm("/oauth/authorize", {
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: "https://chatgpt.com/connector/oauth/smoke-callback",
    scope: "reactions:manage",
    state: "smoke-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    owner_code: "incorrect-owner-code",
  });
  if (
    rejectedAuthorization.status !== 401 ||
    !rejectedAuthorization.headers
      .get("content-security-policy")
      ?.includes("form-action 'self' https://chatgpt.com")
  ) {
    throw new Error("Rejected OAuth consent did not preserve its callback security policy.");
  }
  const authorization = await postForm("/oauth/authorize", {
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: "https://chatgpt.com/connector/oauth/smoke-callback",
    scope: "reactions:manage",
    state: "smoke-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    owner_code: "owner-code-for-local-smoke",
  });
  if (authorization.status !== 303) throw new Error("Owner authorization failed.");
  const callback = new URL(authorization.headers.get("location"));
  if (callback.searchParams.get("state") !== "smoke-state") throw new Error("OAuth state was not preserved.");
  const tokens = await postForm("/oauth/token", {
    grant_type: "authorization_code",
    client_id: registration.client_id,
    redirect_uri: "https://chatgpt.com/connector/oauth/smoke-callback",
    code: callback.searchParams.get("code"),
    code_verifier: verifier,
  }).then((response) => response.json());
  if (!tokens.access_token || !tokens.refresh_token) throw new Error(`Token exchange failed: ${JSON.stringify(tokens)}`);

  await rpc(
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "template-smoke", version: "1.0.0" },
    },
    tokens.access_token,
  );
  const listed = await rpc("tools/list", {}, tokens.access_token);
  const direct = listed.tools.find((tool) => tool.name === "show_giphy_reaction");
  const names = listed.tools.map((tool) => tool.name);
  for (const name of [
    "show_giphy_reaction",
    "open_giphy_picker",
    "list_magic_collection",
    "search_magic_collection",
    "add_magic_reaction",
    "update_magic_reaction",
    "deactivate_magic_reaction",
  ]) {
    if (!names.includes(name)) throw new Error(`Missing tool: ${name}`);
  }
  if (!direct || JSON.stringify(direct.inputSchema).includes("reactionId")) {
    throw new Error("The direct mobile tool must remain a one-call query flow.");
  }

  const firstReaction = await rpc(
    "tools/call",
    { name: "show_giphy_reaction", arguments: { query: "hello", kind: "sticker", rating: "pg" } },
    tokens.access_token,
  );
  if (
    firstReaction.structuredContent?.selectedReaction?.source !== "giphy" ||
    !firstReaction.content?.some((item) => item.type === "image")
  ) {
    throw new Error(`Empty collection did not fall back to GIPHY with a native image: ${JSON.stringify(firstReaction)}`);
  }

  const saved = await rpc(
    "tools/call",
    {
      name: "add_magic_reaction",
      arguments: {
        image: {
          download_url: `${mockOrigin}/image.png`,
          file_id: "smoke-file-id",
          mime_type: "image/png",
          file_name: "friendly.png",
        },
        title: "Friendly hello",
        description: "A small friendly greeting",
        kind: "sticker",
        tags: ["hello", "friendly"],
        moods: ["happy"],
        useWhen: ["when saying hello"],
        favorite: true,
        priority: 70,
      },
    },
    tokens.access_token,
  );
  const savedId = saved.structuredContent?.item?.id;
  if (!savedId) throw new Error(`Chat upload did not save a reaction: ${JSON.stringify(saved)}`);

  const customReaction = await rpc(
    "tools/call",
    { name: "show_giphy_reaction", arguments: { query: "hello", kind: "sticker", rating: "pg" } },
    tokens.access_token,
  );
  if (customReaction.structuredContent?.selectedReaction?.id !== savedId) {
    throw new Error("The direct tool did not prefer the matching private reaction.");
  }

  const updated = await rpc(
    "tools/call",
    { name: "update_magic_reaction", arguments: { id: savedId, title: "Warm hello", priority: 80 } },
    tokens.access_token,
  );
  if (updated.structuredContent?.item?.title !== "Warm hello") throw new Error("Edit tool failed.");

  const hidden = await rpc(
    "tools/call",
    { name: "deactivate_magic_reaction", arguments: { id: savedId } },
    tokens.access_token,
  );
  if (hidden.structuredContent?.item?.active !== false) throw new Error("Hide tool failed.");

  const refreshed = await postForm("/oauth/token", {
    grant_type: "refresh_token",
    client_id: registration.client_id,
    refresh_token: tokens.refresh_token,
  }).then((response) => response.json());
  if (!refreshed.access_token || refreshed.refresh_token === tokens.refresh_token) {
    throw new Error("Refresh-token rotation failed.");
  }

  const directResource = await rpc(
    "resources/read",
    { uri: "ui://widget/magic-reactions-direct-v1.html" },
    refreshed.access_token,
  );
  const resource = directResource.contents?.[0];
  if (
    !resource?.text?.includes("magic-reactions-direct") ||
    resource?._meta?.ui?.domain !== appOrigin
  ) {
    throw new Error("Versioned widget resource or domain metadata is invalid.");
  }

  if (logs.includes("owner-code-for-local-smoke") || logs.includes(tokens.access_token)) {
    throw new Error("A secret leaked into server logs.");
  }
  console.log("OAuth callback allowlist, oversized-body resilience, GIPHY fallback, mobile image, upload, edit, hide, refresh rotation, and widget resource are valid.");
} finally {
  const childExit = child.exitCode === null ? once(child, "exit") : Promise.resolve();
  const upstreamClosed = upstream.listening
    ? new Promise((resolve) => upstream.close(resolve))
    : Promise.resolve();
  child.kill();
  await Promise.allSettled([childExit, upstreamClosed]);
}
