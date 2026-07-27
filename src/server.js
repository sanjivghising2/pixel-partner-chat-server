import "dotenv/config";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import express from "express";
import { GridFSBucket, MongoClient, ObjectId } from "mongodb";
import multer from "multer";
import { Server } from "socket.io";

import {
  authenticateHeaders,
  authenticatePair,
  otherUser,
  publicDrawing,
  publicMessage,
  validateDrawingBoard,
  validateMediaMessage,
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
  maxHttpBufferSize: 512 * 1024,
});
const mongo = new MongoClient(mongoUri);

await mongo.connect();
const database = mongo.db(databaseName);
const messages = database.collection("messages");
const drawings = database.collection("drawings");
const media = new GridFSBucket(database, { bucketName: "private_media" });
const mediaFiles = database.collection("private_media.files");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 40 * 1024 * 1024 },
});
await messages.createIndex({ sender: 1, receiver: 1, time: -1 });
await messages.createIndex({ messageId: 1 }, { unique: true });
await drawings.createIndex({ boardId: 1 }, { unique: true });

function requireHttpUser(request, response, next) {
  const user = authenticateHeaders(request.headers, secrets);
  if (user === null) {
    response.status(401).json({ ok: false, error: "Not authorized." });
    return;
  }
  request.pixelUser = user;
  next();
}

app.post(
  "/media/messages",
  requireHttpUser,
  upload.single("file"),
  async (request, response) => {
    const sender = request.pixelUser;
    const valid = validateMediaMessage(sender, request.body, request.file);
    if (!valid.ok) {
      response.status(400).json(valid);
      return;
    }
    const file = request.file;
    const uploadStream = media.openUploadStream(file.originalname, {
      contentType: file.mimetype,
      metadata: {
        sender,
        receiver: valid.receiver,
        type: valid.type,
      },
    });
    try {
      const finished = once(uploadStream, "finish");
      uploadStream.end(file.buffer);
      await finished;
      const mediaId = uploadStream.id.toString();
      const labels = {
        image: "Sent a photo",
        video: "Sent a video",
        audio: "Sent a voice message",
      };
      const message = {
        messageId: randomUUID(),
        sender,
        receiver: valid.receiver,
        text: labels[valid.type],
        type: valid.type,
        mediaId,
        mediaMimeType: file.mimetype,
        mediaName: file.originalname.slice(0, 180),
        mediaSize: file.size,
        mediaDurationMs: valid.durationMs,
        time: new Date(),
        read: false,
      };
      await messages.insertOne(message);
      const outgoing = publicMessage(message);
      io.to(`user:${sender}`)
        .to(`user:${valid.receiver}`)
        .emit("message:new", outgoing);
      response.status(201).json({ ok: true, message: outgoing });
    } catch {
      if (uploadStream.id) {
        await media.delete(uploadStream.id).catch(() => {});
      }
      response.status(500).json({ ok: false, error: "Media was not saved." });
    }
  },
);

app.get("/media/:id", requireHttpUser, async (request, response) => {
  if (!ObjectId.isValid(request.params.id)) {
    response.status(404).end();
    return;
  }
  const id = new ObjectId(request.params.id);
  const file = await mediaFiles.findOne({ _id: id });
  if (!file) {
    response.status(404).end();
    return;
  }
  const user = request.pixelUser;
  const metadata = file.metadata ?? {};
  if (metadata.sender !== user && metadata.receiver !== user) {
    response.status(403).end();
    return;
  }

  const length = Number(file.length);
  const contentType = file.contentType ?? "application/octet-stream";
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Type", contentType);
  response.setHeader(
    "Content-Disposition",
    `inline; filename="${String(file.filename).replaceAll('"', "")}"`,
  );

  const range = request.headers.range;
  let start = 0;
  let end = length - 1;
  if (typeof range === "string") {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      response.status(416).setHeader("Content-Range", `bytes */${length}`);
      response.end();
      return;
    }
    start = match[1] ? Number.parseInt(match[1], 10) : 0;
    end = match[2] ? Number.parseInt(match[2], 10) : length - 1;
    if (start < 0 || end < start || start >= length) {
      response.status(416).setHeader("Content-Range", `bytes */${length}`);
      response.end();
      return;
    }
    end = Math.min(end, length - 1);
    response.status(206);
    response.setHeader("Content-Range", `bytes ${start}-${end}/${length}`);
  }
  response.setHeader("Content-Length", end - start + 1);
  media
    .openDownloadStream(id, { start, end: end + 1 })
    .on("error", () => {
      if (!response.headersSent) response.status(404);
      response.end();
    })
    .pipe(response);
});

app.use((error, _request, response, next) => {
  if (error instanceof multer.MulterError) {
    response.status(400).json({
      ok: false,
      error:
        error.code === "LIMIT_FILE_SIZE"
          ? "This file is too large."
          : "Could not accept this file.",
    });
    return;
  }
  next(error);
});

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
      type: "text",
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

  socket.on("drawing:load", async (_payload, acknowledge = () => {}) => {
    try {
      const board = await drawings.findOne({
        boardId: "snjv-debu-shared-board",
      });
      acknowledge({ ok: true, board: publicDrawing(board) });
    } catch {
      acknowledge({ ok: false, error: "Could not load the shared drawing." });
    }
  });

  socket.on("drawing:replace", async (payload, acknowledge = () => {}) => {
    const valid = validateDrawingBoard(user, payload);
    if (!valid.ok) {
      acknowledge(valid);
      return;
    }
    try {
      await drawings.updateOne(
        { boardId: "snjv-debu-shared-board" },
        {
          $set: {
            backgroundColor: valid.board.backgroundColor,
            strokes: valid.board.strokes,
            updatedBy: user,
            updatedAt: new Date(),
          },
          $inc: { revision: 1 },
          $setOnInsert: { boardId: "snjv-debu-shared-board" },
        },
        { upsert: true },
      );
      const saved = await drawings.findOne({
        boardId: "snjv-debu-shared-board",
      });
      const outgoing = publicDrawing(saved);
      io.to(`user:${user}`)
        .to(`user:${valid.receiver}`)
        .emit("drawing:updated", outgoing);
      acknowledge({ ok: true, board: outgoing });
    } catch {
      acknowledge({ ok: false, error: "The drawing was not saved." });
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
