import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const memoryObjects = new Map();
let client;

function env(name) {
  return String(process.env[name] || "").trim();
}

export function storageDriver() {
  return env("STORAGE_DRIVER") || "s3";
}

export function storageConfigured() {
  if (storageDriver() === "memory") return true;
  return Boolean(
    env("BUCKET") &&
      env("ACCESS_KEY_ID") &&
      env("SECRET_ACCESS_KEY") &&
      env("REGION") &&
      env("ENDPOINT"),
  );
}

export function storageOrigin() {
  try {
    return storageDriver() === "s3" ? new URL(env("ENDPOINT")).origin : "";
  } catch {
    return "";
  }
}

export function storageOrigins() {
  if (storageDriver() !== "s3") return [];
  const origins = new Set();
  try {
    const endpoint = new URL(env("ENDPOINT"));
    origins.add(endpoint.origin);
    if (env("S3_FORCE_PATH_STYLE") !== "true" && env("BUCKET")) {
      const virtualHosted = new URL(endpoint);
      virtualHosted.hostname = `${env("BUCKET")}.${endpoint.hostname}`;
      origins.add(virtualHosted.origin);
    }
    if (env("STORAGE_PUBLIC_ORIGIN")) {
      origins.add(new URL(env("STORAGE_PUBLIC_ORIGIN")).origin);
    }
  } catch {}
  return [...origins];
}

function s3() {
  if (!storageConfigured()) throw new Error("Railway Bucket is not configured.");
  if (!client) {
    client = new S3Client({
      endpoint: env("ENDPOINT"),
      region: env("REGION"),
      credentials: {
        accessKeyId: env("ACCESS_KEY_ID"),
        secretAccessKey: env("SECRET_ACCESS_KEY"),
      },
      forcePathStyle: env("S3_FORCE_PATH_STYLE") === "true",
    });
  }
  return client;
}

export async function putObject({ key, bytes, contentType }) {
  if (storageDriver() === "memory") {
    memoryObjects.set(key, { bytes: Buffer.from(bytes), contentType });
    return;
  }
  await s3().send(
    new PutObjectCommand({
      Bucket: env("BUCKET"),
      Key: key,
      Body: bytes,
      ContentType: contentType,
      CacheControl: "private, max-age=3600",
    }),
  );
}

export async function deleteObject(key) {
  if (!key) return;
  if (storageDriver() === "memory") {
    memoryObjects.delete(key);
    return;
  }
  await s3().send(new DeleteObjectCommand({ Bucket: env("BUCKET"), Key: key }));
}

export async function signedObjectUrl(key, expiresIn = 3600) {
  if (!key) return "";
  if (storageDriver() === "memory") {
    return `http://127.0.0.1:${env("PORT") || "8787"}/api/dev-assets/${encodeURIComponent(key)}`;
  }
  return getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: env("BUCKET"), Key: key }),
    { expiresIn },
  );
}

export function memoryObject(key) {
  return storageDriver() === "memory" ? memoryObjects.get(key) : undefined;
}
