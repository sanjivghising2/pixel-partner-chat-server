import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { MongoClient } from "mongodb";
import { Server } from "socket.io";

import {
  authenticatePair,
  otherUser,
  publicMessage,
  validateOutgoingMessage,
} from "./protocol.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const mongoUri = process.env.MONGODB_URI ?? "";
const databaseName = process.env.MONGODB_DATABASE ?? "pixel_partner";
const secrets = {
  snjv: process.env.SNJV_PRIVATE_KEY ?? "",
  Debu: process.env.DEBU_PRIVATE_KEY ?? "",
};

if (!mongoUri || secrets.snjv.length < 24 || secrets.Debu.length < 24) {
  throw new Error(
    "Set MONGODB_URI, SNJV_PRIVATE_KEY, and DEBU_PRIVATE_KEY. " +
      "Each private key must contain at least 24 characters.",
  );
}

const app = express();
app.disable("x-powered-by");
app.get("/health", (_request, response) => {
  response.json({ ok: true, service: "pixel-partner-private-chat" });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  serveClient: false,
  maxHttpBufferSize: 16 * 1024,
});
const mongo = new MongoClient(mongoUri);

await mongo.connect();
const messages = mongo.db(databaseName).collection("messages");
await messages.createIndex({ sender: 1, receiver: 1, time: -1 });
await messages.createIndex({ messageId: 1 }, { unique: true });

io.use((socket, next) => {
  const user = authenticatePair(socket.handshake.auth, secrets);
  if (user === null) {
    next(new Error("Not authorized."));
    return;
  }
  socket.data.user = user;
  next();
});

io.on("connection", (socket) => {
  const user = socket.data.user;
  const partner = otherUser(user);
  socket.join(`user:${user}`);

  socket.on("messages:history", async (_payload, acknowledge = () => {}) => {
    try {
      const history = await messages
        .find({
          $or: [
            { sender: user, receiver: partner },
            { sender: partner, receiver: user },
          ],
        })
        .sort({ time: -1 })
        .limit(200)
        .toArray();
      acknowledge({
        ok: true,
        messages: history.reverse().map(publicMessage),
      });
    } catch {
      acknowledge({ ok: false, error: "Could not load message history." });
    }
  });

  socket.on("message:send", async (payload, acknowledge = () => {}) => {
    const valid = validateOutgoingMessage(user, payload);
    if (!valid.ok) {
      acknowledge(valid);
      return;
    }
    const message = {
      messageId: randomUUID(),
      sender: user,
      receiver: valid.receiver,
      text: valid.text,
      time: new Date(),
      read: false,
    };
    try {
      await messages.insertOne(message);
      const outgoing = publicMessage(message);
      io.to(`user:${user}`)
        .to(`user:${valid.receiver}`)
        .emit("message:new", outgoing);
      acknowledge({ ok: true, message: outgoing });
    } catch {
      acknowledge({ ok: false, error: "Message was not saved." });
    }
  });

  socket.on("message:read", async (payload, acknowledge = () => {}) => {
    const messageId =
      typeof payload?.messageId === "string" ? payload.messageId : "";
    if (messageId.length < 8 || messageId.length > 80) {
      acknowledge({ ok: false, error: "Invalid message ID." });
      return;
    }
    try {
      const result = await messages.updateOne(
        { messageId, receiver: user, sender: partner },
        { $set: { read: true } },
      );
      if (result.matchedCount === 1) {
        io.to(`user:${partner}`).emit("message:read", { messageId });
      }
      acknowledge({ ok: result.matchedCount === 1 });
    } catch {
      acknowledge({ ok: false, error: "Read status was not saved." });
    }
  });
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Pixel Partner private chat listening on port ${port}.`);
});

async function shutdown() {
  io.close();
  httpServer.close();
  await mongo.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
