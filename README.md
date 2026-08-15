# Deploy and Host Magic Reactions on Railway

Magic Reactions is a private ChatGPT app for keeping a personal collection of
GIFs and stickers. It can send a reaction in one tool call, fall back to GIPHY,
save an image from a ChatGPT conversation, edit its metadata, and hide it
without deleting the stored file.

This repository is intentionally empty of personal reactions, branding,
account identifiers, provider keys, and deployment history.

## About Hosting

The Railway project uses three pieces:

1. This Node.js web service for MCP, OAuth, the widget, and the private admin page.
2. Railway PostgreSQL for reaction metadata and OAuth records.
3. A private Railway Bucket for GIF and image files.

The Bucket is S3-compatible. Files remain private and the server gives ChatGPT
short-lived signed URLs. PostgreSQL never stores raw image bytes.

## Why Deploy

- Keep the collection under the deployer's control.
- Use one private OAuth connection across ChatGPT desktop and mobile.
- Avoid putting images or secrets in the Git repository.
- Preserve a native MCP image fallback when a host does not mount the widget.
- Start with an empty collection and add only the deployer's own content.

## Common Use Cases

- Send a GIF or sticker automatically from a private collection.
- Fall back to GIPHY when the collection has no relevant match.
- Save an image from the current ChatGPT conversation.
- Edit titles, tags, moods, usage guidance, favorites, and priority.
- Hide a reaction reversibly without deleting its object.
- Open a manual picker only when the user explicitly asks to browse.

## Dependencies for Hosting

### Deployment Dependencies

- A Railway account.
- A Railway PostgreSQL service.
- A Railway Bucket.
- A free GIPHY developer API key.
- ChatGPT Developer Mode for installing the private MCP URL.

No OpenAI API key is required.

## Railway services and variables

Create a project with the app service, PostgreSQL, and a Bucket. Configure the
app service with these variables:

| Variable | Railway source | Required |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | Public app URL, for example `https://...up.railway.app` | yes |
| `GIPHY_API_KEY` | User-provided secret | yes |
| `OWNER_CODE` | Generated private secret, at least 24 random characters | yes |
| `OAUTH_SIGNING_SECRET` | Generated private secret, at least 32 random characters | yes |
| `DATABASE_URL` | Reference to PostgreSQL `DATABASE_URL` | yes |
| `BUCKET` | Reference to the Bucket variable | yes |
| `ACCESS_KEY_ID` | Reference to the Bucket variable | yes |
| `SECRET_ACCESS_KEY` | Reference to the Bucket variable | yes |
| `REGION` | Reference to the Bucket variable | yes |
| `ENDPOINT` | Reference to the Bucket variable | yes |

The private Railway template draft has been checked against a real deployment.
It creates the web service, PostgreSQL with its persistent volume, and one
private Bucket. Only `GIPHY_API_KEY` is requested from the installer. The draft
uses these preconfigured values:

| Variable | Template value |
| --- | --- |
| `PUBLIC_BASE_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
| `OWNER_CODE` | `${{ secret(32) }}` |
| `OAUTH_SIGNING_SECRET` | `${{ secret(64) }}` |
| `DATABASE_URL` | `${{Postgres Live.DATABASE_URL}}` |
| Bucket credentials | References to the matching `Reactions Bucket` variables |
| `DATABASE_DRIVER` / `STORAGE_DRIVER` | `postgres` / `s3` |
| `S3_FORCE_PATH_STYLE` | `false` |

For example, the Bucket name is referenced as
`${{Reactions Bucket.BUCKET}}`; the access key, secret, region, and endpoint use
the same service-reference pattern. Generated secrets are unique to every
deployment and are not copied from the prototype.

## Connect to ChatGPT

1. Deploy and wait for Railway's `GET /ready` check to pass. `GET /health`
   remains available for configuration diagnostics.
2. In ChatGPT Developer Mode, add `https://YOUR-DOMAIN/mcp`.
3. Choose OAuth when prompted.
4. The consent page opens on this service. Enter `OWNER_CODE`.
5. Start a new chat and ask ChatGPT to send a GIF or sticker.

The direct tool is intentionally a one-call flow. Do not add an exact
`reactionId` parameter or make `search_magic_collection` a required first step;
that breaks the mobile-safe behavior this template preserves.

## Private collection panel

Open `https://YOUR-DOMAIN/coleccion` and enter `OWNER_CODE`. The code is kept in
the current browser tab only. From there you can upload, review, edit, and hide
reactions.

## Local test mode

Local tests use in-memory PostgreSQL and Bucket adapters, so no cloud resources
are required:

```powershell
npm.cmd install
npm.cmd run check
npm.cmd run smoke
```

For manual local development, copy `.env.example` to `.env`, load its variables
in your shell, and run `npm.cmd run dev`.

## Security notes

- OAuth uses dynamic client registration, authorization code flow, PKCE S256,
  short-lived access tokens, expiring single-use codes, and rotating hashed
  refresh tokens.
- Dynamic registration accepts only ChatGPT's current or legacy callback URI;
  loopback HTTP(S) callbacks remain available for local development.
- OAuth POST bodies are capped at 64 KiB and oversized requests fail cleanly
  without stopping the service.
- The owner code is compared in constant time and authorization attempts are
  rate-limited per process.
- Never put `OWNER_CODE`, `OAUTH_SIGNING_SECRET`, database credentials, or Bucket
  credentials in Git.
- The `/api/collection` admin routes require `OWNER_CODE`; the `/mcp` route
  requires a valid owner OAuth token.
- Hiding is soft deletion. Export/restore tooling is a sensible next step before
  a public template release because Railway Buckets do not currently promise
  object versioning.

## Project layout

```text
server.js                 MCP, HTTP routes, widgets, and admin API
lib/oauth.js              self-hosted owner OAuth
lib/db.js                 PostgreSQL and local memory adapter
lib/object-store.js       Railway Bucket and local memory adapter
lib/collection-store.js   collection, search, upload, edit, and hide
public/                   vanilla ChatGPT widgets and admin page
scripts/                  clean-template scan and end-to-end smoke test
migrations/               explicit PostgreSQL schema reference
```

## Validation reached

The repository includes static/syntax checks and a local runtime smoke test that
exercises OAuth discovery, client registration, PKCE consent, token rotation,
anonymous rejection, tool listing, empty-collection GIPHY fallback, native image
fallback, chat upload, edit, hide, and widget resource metadata.

The private prototype has completed the real ChatGPT loop on desktop and mobile:
OAuth connection, collection reactions, GIPHY fallback, chat upload, edit, and
hide. The Railway composer also preserves the single private Bucket and
PostgreSQL volume.

Before marketplace publication, perform one final clean deployment from the
private template, enter a fresh GIPHY key, connect its new `/mcp` URL in ChatGPT,
and repeat the mobile send-and-upload check. Keep the template private until
that acceptance test passes.

## License

Magic Reactions for ChatGPT is available under the [MIT License](LICENSE).
