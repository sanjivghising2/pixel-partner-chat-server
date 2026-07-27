import { timingSafeEqual } from "node:crypto";

export const USERS = Object.freeze(["snjv", "Debu"]);
export const MAX_MESSAGE_LENGTH = 2000;
export const MEDIA_TYPES = Object.freeze(["image", "video", "audio"]);

export function otherUser(user) {
  if (user === "snjv") return "Debu";
  if (user === "Debu") return "snjv";
  return null;
}

export function privateKeyMatches(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export function authenticatePair(credentials, secrets) {
  const user = credentials?.user;
  if (!USERS.includes(user)) return null;
  const expected = user === "snjv" ? secrets.snjv : secrets.Debu;
  return privateKeyMatches(credentials?.key, expected) ? user : null;
}

export function authenticateHeaders(headers, secrets) {
  return authenticatePair(
    {
      user: headers?.["x-pixel-user"],
      key: headers?.["x-pixel-key"],
    },
    secrets,
  );
}

export function validateOutgoingMessage(sender, payload) {
  const receiver = otherUser(sender);
  if (
    receiver === null ||
    payload?.receiver !== receiver ||
    typeof payload?.text !== "string"
  ) {
    return { ok: false, error: "Invalid message." };
  }
  const text = payload.text.trim();
  if (text.length === 0 || text.length > MAX_MESSAGE_LENGTH) {
    return {
      ok: false,
      error: `Messages must contain 1-${MAX_MESSAGE_LENGTH} characters.`,
    };
  }
  return { ok: true, receiver, text, type: "text" };
}

export function validateMediaMessage(sender, fields, file) {
  const receiver = otherUser(sender);
  const type = fields?.type;
  if (
    receiver === null ||
    fields?.receiver !== receiver ||
    !MEDIA_TYPES.includes(type) ||
    !file
  ) {
    return { ok: false, error: "Invalid media message." };
  }
  const allowedMime = {
    image: ["image/jpeg", "image/png", "image/webp", "image/gif"],
    video: ["video/mp4", "video/webm", "video/quicktime"],
    audio: [
      "audio/aac",
      "audio/mp4",
      "audio/m4a",
      "audio/mpeg",
      "audio/ogg",
      "audio/wav",
      "audio/x-wav",
    ],
  };
  if (!allowedMime[type].includes(file.mimetype)) {
    return { ok: false, error: `Unsupported ${type} format.` };
  }
  const maximum = type === "video" ? 40 * 1024 * 1024 : 12 * 1024 * 1024;
  if (file.size < 1 || file.size > maximum) {
    return {
      ok: false,
      error:
        type === "video"
          ? "Videos must be smaller than 40 MB."
          : "Photos and voice messages must be smaller than 12 MB.",
    };
  }
  const parsedDuration = Number.parseInt(fields?.durationMs ?? "0", 10);
  const durationMs =
    type === "audio" && Number.isFinite(parsedDuration)
      ? Math.min(Math.max(parsedDuration, 0), 10 * 60 * 1000)
      : null;
  return { ok: true, receiver, type, durationMs };
}

export function publicMessage(document) {
  return {
    messageId: document.messageId,
    sender: document.sender,
    receiver: document.receiver,
    text: document.text ?? "",
    type: document.type ?? "text",
    mediaId: document.mediaId ?? null,
    mediaUrl: document.mediaId ? `/media/${document.mediaId}` : null,
    mediaMimeType: document.mediaMimeType ?? null,
    mediaName: document.mediaName ?? null,
    mediaSize: document.mediaSize ?? null,
    mediaDurationMs: document.mediaDurationMs ?? null,
    time:
      document.time instanceof Date
        ? document.time.toISOString()
        : new Date(document.time).toISOString(),
    read: document.read === true,
  };
}
