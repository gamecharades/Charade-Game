import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 4174;
const rooms = new Map();

app.use(express.json({ limit: "15mb" }));

function cleanRoomCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

function phaseRank(phase) {
  const ranks = {
    lobby: 0,
    "turn-ready": 1,
    acting: 2,
    "turn-result": 3,
    "game-over": 4,
  };
  return ranks[phase] ?? -1;
}

function shouldStoreState(existing, incoming) {
  if (!incoming || typeof incoming !== "object") {
    return false;
  }
  if (!existing) {
    return true;
  }
  if (phaseRank(incoming.phase) > phaseRank(existing.phase)) {
    return true;
  }
  const incomingRevision = Number(incoming.revision ?? 0);
  const existingRevision = Number(existing.revision ?? 0);
  if (incomingRevision > existingRevision) {
    return true;
  }
  if (incomingRevision < existingRevision) {
    return false;
  }
  return phaseRank(incoming.phase) >= phaseRank(existing.phase);
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/rooms/:roomCode/state", (request, response) => {
  const roomCode = cleanRoomCode(request.params.roomCode);
  const state = rooms.get(roomCode);
  if (!state) {
    response.status(404).json({ error: "Room state not found." });
    return;
  }
  response.json({ state });
});

app.put("/api/rooms/:roomCode/state", (request, response) => {
  const roomCode = cleanRoomCode(request.params.roomCode);
  const incoming = request.body?.state;
  if (!roomCode || !incoming) {
    response.status(400).json({ error: "Missing room state." });
    return;
  }

  const state = { ...incoming, roomCode };
  const existing = rooms.get(roomCode);
  if (shouldStoreState(existing, state)) {
    rooms.set(roomCode, state);
  }

  response.json({ state: rooms.get(roomCode) });
});

app.get("/api/image-search", async (request, response) => {
  const query = String(request.query.q ?? "").trim();
  if (!query) {
    response.status(400).json({ error: "Missing search query." });
    return;
  }

  const key = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_ENGINE_ID;
  if (!key || !cx) {
    response.status(503).json({ error: "Image search is not configured on this server." });
    return;
  }

  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", key);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", query);
  url.searchParams.set("searchType", "image");
  url.searchParams.set("safe", "active");
  url.searchParams.set("imgSize", "medium");
  url.searchParams.set("num", "8");

  try {
    const googleResponse = await fetch(url);
    const data = await googleResponse.json();
    if (!googleResponse.ok) {
      response.status(googleResponse.status).json({
        error: data.error?.message ?? "Google image search failed.",
      });
      return;
    }

    response.json({
      results:
        data.items?.map((item) => ({
          title: item.title,
          url: item.link,
          thumbnail: item.image?.thumbnailLink ?? item.link,
          source: item.displayLink,
          context: item.image?.contextLink,
        })) ?? [],
    });
  } catch {
    response.status(500).json({ error: "Image search request failed." });
  }
});

app.use(express.static(path.join(__dirname, "dist")));

app.use((_request, response) => {
  response.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(port, () => {
  console.log(`Charades server listening on ${port}`);
});
