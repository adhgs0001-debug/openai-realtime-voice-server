// server.js — FINAL FULL VERSION
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
app.use(express.json());

// ----- Config -----
const PORT = process.env.PORT || 3000;
const HOSTNAME = process.env.RENDER_EXTERNAL_HOSTNAME || "localhost:3000";

const MEMORY_PATH = process.env.MEMORY_PATH || "./memory";
const LOG_PATH = process.env.CALL_LOG_PATH || "./call_logs";

if (!fs.existsSync(MEMORY_PATH)) fs.mkdirSync(MEMORY_PATH, { recursive: true });
if (!fs.existsSync(LOG_PATH)) fs.mkdirSync(LOG_PATH, { recursive: true });

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ----- Helpers -----
function writeCallLog(callId, obj) {
  const file = path.join(LOG_PATH, `${callId}.json`);
  fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), ...obj }) + "\n");
}
function saveMemory(callId, obj) {
  const file = path.join(MEMORY_PATH, `${callId}.json`);
  let mem = [];
  if (fs.existsSync(file)) mem = JSON.parse(fs.readFileSync(file));
  mem.push(obj);
  fs.writeFileSync(file, JSON.stringify(mem, null, 2));
}
function getMemory(callId) {
  const file = path.join(MEMORY_PATH, `${callId}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file));
}

function classifyIntent(text) {
  const t = text.toLowerCase();
  if (/\b(schedule|interview|book|appointment)\b/.test(t)) return "schedule_interview";
  if (/\b(hours|when|open|close|location|address)\b/.test(t)) return "info";
  if (/\b(hi|hello|hey)\b/.test(t)) return "greeting";
  return "unknown";
}

function emotionToTone(emotion) {
  switch ((emotion || "").toLowerCase()) {
    case "angry": return "calm and steady";
    case "sad": return "soft and caring";
    case "excited": return "upbeat and energetic";
    default: return "friendly and natural";
  }
}

// =========== TWILIO WEBHOOK (incoming call) ==========
app.post("/incoming", (req, res) => {
  const callId = req.body.CallSid || uuidv4();
  writeCallLog(callId, { event: "incoming_call", from: req.body.From });

  saveMemory(callId, { role: "system", content: "Call started" });

  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${HOSTNAME}/stream"/>
      </Start>
      <Say>Hello! Connecting you now.</Say>
    </Response>
  `;

  res.set("Content-Type", "text/xml");
  res.send(twiml);
});

app.get("/", (req, res) => res.send("Realtime AI Voice Server is Running"));

// ------- START HTTP SERVER -------
const server = app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

// -----------------------------------------------------------
// WEBSOCKET UPGRADE — REQUIRED FOR RENDER + TWILIO <Stream>
// -----------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// -----------------------------------------------------------
// WEBSOCKET CONNECTION HANDLER
// -----------------------------------------------------------
wss.on("connection", (ws, req) => {
  const callId = uuidv4();
  console.log("WS connected", callId);

  writeCallLog(callId, { event: "ws_connect" });

  let lastEmotion = "neutral";

  async function handleUserSpeech(text, isFinal, emotion) {
    if (emotion) lastEmotion = emotion;
    const memory = getMemory(callId);

    const intent = classifyIntent(text);
    const tone = emotionToTone(lastEmotion);

    saveMemory(callId, { role: "user", content: text });
    writeCallLog(callId, { event: "user_speech", text, isFinal });

    const systemPrompt = `
You are Jessica, a warm, human-sounding receptionist.
Speak in short natural sentences.
Tone style: ${tone}.
If caller wants to schedule, guide them to provide:
- full name
- availability
- phone number.
If caller wants info, answer concisely.
Never say you're an AI.
Allow interruptions, stay conversational.
`;

    try {
      const resp = await client.responses.create({
        model: "gpt-4o-realtime-preview",
        modalities: ["audio", "text"],
        audio: { voice: "alloy", format: "wav" },
        input: [
          { role: "system", content: systemPrompt },
          ...memory.map(m => ({ role: m.role, content: m.content })),
          { role: "user", content: text }
        ]
      });

      const assistantText = resp.output
        ?.filter(o => o.type === "output_text")
        ?.map(o => o.content)
        ?.join(" ") || "";

      saveMemory(callId, { role: "assistant", content: assistantText });
      writeCallLog(callId, { event: "assistant_text", assistantText });

      // Extract audio response
      const audioItem = resp.output.find(o => o.type === "output_audio");
      if (audioItem?.audio) {
        ws.send(JSON.stringify({
          event: "assistant_audio",
          audio: audioItem.audio
        }));
      }

    } catch (err) {
      console.error("OpenAI error:", err);
      writeCallLog(callId, { event: "openai_error", error: String(err) });

      ws.send(JSON.stringify({
        event: "assistant_text",
        text: "Sorry — I'm having trouble responding."
      }));
    }
  }

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "media") {
        // Twilio sends audio bytes, but your setup requires text-only.
        // Ignore raw audio if present.
      }

      if (data.event === "user_speech") {
        await handleUserSpeech(data.text, data.isFinal, data.emotion);
      }

      if (data.event === "stop") {
        writeCallLog(callId, { event: "call_end" });
      }

    } catch (err) {
      console.warn("WS parse error", err);
    }
  });

  ws.on("close", () => {
    writeCallLog(callId, { event: "ws_disconnect" });
    console.log("WS closed", callId);
  });
});
