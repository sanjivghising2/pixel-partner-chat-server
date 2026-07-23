import { timingSafeEqual } from "node:crypto";

export const USERS = Object.freeze(["snjv", "Debu"]);
export const MAX_MESSAGE_LENGTH = 2000;

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
  return { ok: true, receiver, text };
}

export function publicMessage(document) {
  return {
    messageId: document.messageId,
    sender: document.sender,
    receiver: document.receiver,
    text: document.text,
    time:
      document.time instanceof Date
        ? document.time.toISOString()
        : new Date(document.time).toISOString(),
    read: document.read === true,
  };
}
