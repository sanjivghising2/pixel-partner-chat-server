import { timingSafeEqual } from "node:crypto";

export const USERS = Object.freeze(["snjv", "Debu"]);
export const MAX_MESSAGE_LENGTH = 2000;
export const MEDIA_TYPES = Object.freeze(["image", "video", "audio"]);
export const DRAWING_TOOLS = Object.freeze([
  "pencil",
  "pen",
  "marker",
  "brush",
  "highlighter",
  "neon",
  "eraser",
]);
export const MAX_DRAWING_STROKES = 300;
export const MAX_DRAWING_POINTS = 8000;

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

export function validateDrawingBoard(sender, payload) {
  const receiver = otherUser(sender);
  const board = payload?.board;
  if (
    receiver === null ||
    payload?.receiver !== receiver ||
    !board ||
    !Array.isArray(board.strokes) ||
    board.strokes.length > MAX_DRAWING_STROKES ||
    !Number.isInteger(board.backgroundColor) ||
    board.backgroundColor < 0 ||
    board.backgroundColor > 0xffffffff
  ) {
    return { ok: false, error: "Invalid drawing." };
  }

  let totalPoints = 0;
  const strokes = [];
  for (const raw of board.strokes) {
    if (
      !raw ||
      typeof raw.id !== "string" ||
      raw.id.length < 8 ||
      raw.id.length > 80 ||
      !USERS.includes(raw.owner) ||
      !DRAWING_TOOLS.includes(raw.tool) ||
      !Number.isInteger(raw.color) ||
      raw.color < 0 ||
      raw.color > 0xffffffff ||
      !Number.isFinite(raw.width) ||
      raw.width < 1 ||
      raw.width > 40 ||
      !Number.isFinite(raw.opacity) ||
      raw.opacity < 0.05 ||
      raw.opacity > 1 ||
      !Array.isArray(raw.points) ||
      raw.points.length < 1 ||
      raw.points.length > 600
    ) {
      return { ok: false, error: "Invalid drawing stroke." };
    }
    totalPoints += raw.points.length;
    if (totalPoints > MAX_DRAWING_POINTS) {
      return { ok: false, error: "The drawing is too detailed." };
    }
    const points = [];
    for (const point of raw.points) {
      if (
        !Array.isArray(point) ||
        point.length !== 2 ||
        !Number.isFinite(point[0]) ||
        !Number.isFinite(point[1]) ||
        point[0] < 0 ||
        point[0] > 1 ||
        point[1] < 0 ||
        point[1] > 1
      ) {
        return { ok: false, error: "Invalid drawing point." };
      }
      points.push([
        Math.round(point[0] * 10000) / 10000,
        Math.round(point[1] * 10000) / 10000,
      ]);
    }
    strokes.push({
      id: raw.id,
      owner: raw.owner,
      tool: raw.tool,
      color: raw.color,
      width: Math.round(raw.width * 10) / 10,
      opacity: Math.round(raw.opacity * 100) / 100,
      points,
    });
  }
  return {
    ok: true,
    receiver,
    board: {
      backgroundColor: board.backgroundColor,
      strokes,
    },
  };
}

export function publicDrawing(document) {
  return {
    boardId: "snjv-debu-shared-board",
    backgroundColor: document?.backgroundColor ?? 0xfffffcf4,
    strokes: Array.isArray(document?.strokes) ? document.strokes : [],
    revision: document?.revision ?? 0,
    updatedBy: document?.updatedBy ?? null,
    updatedAt: document?.updatedAt
      ? new Date(document.updatedAt).toISOString()
      : null,
  };
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
