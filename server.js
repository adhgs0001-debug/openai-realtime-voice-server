// server.js
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

// ----- CONFIG -----
const PORT = process.env.PORT || 3000;
const HOSTNAME = process.env.RENDER_EXTERNAL_HOSTNAME || "localhost:3000";
const MEMORY_PATH = process.env.MEMORY_PATH || "./memory";
const LOG_PATH = process.env.CALL_LOG_PATH || "./call_logs";

// Ensure folders exist
if (!fs.existsSync(MEMORY_PATH)) fs.mkdirSync(MEMORY_PATH, { recursive: true });
if (!fs.existsSync(LOG_PATH)) fs.mkdirSync(LOG_PATH, { recursive: true });

// ----- OPENAI CLIENT -----
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// =======================================
//               HELPERS
// =======================================

function writeCallLog(callId, obj) {
  const file = path.join(LOG_PATH, `${callId}.json`);
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
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

// SIMPLE NLU
function classifyIntent(text) {
  const t = text.toLowerCase();
  if (/\b(schedule|interview|book|appointment)\b/.test(t)) return "schedule_interview";
  if (/\b(hours|when|open|close|location|address)\b/.test(t)) return "info";
  if (/\b(hi|hello|hey)\b/.test(t)) return "greeting";
  return "unknown";
}

// EMOTION → TONE MAP
function emotionToTone(emotionLabel) {
  switch ((emotionLabel || "").toLowerCase()) {
    case "angry": return "firm and calm";
    case "sad": return "soft and empathetic";
    case "excited": return "upbeat and energetic";
    default: return "friendly and conversational";
  }
}

// =======================================
//         TWILIO -> /incoming
// =======================================
app.post("/incoming", (req, res) => {
  const callId = req.body.CallSid || uuidv4();

  console.log("Incoming call:", callId, req.body?.From);
  writeCallLog(callId, { event: "incoming", ts: Date.now(), body: req.body });

  saveMemory(callId, { role: "system", content: "Call started" });

  // 🔥 IMPORTANT FIX — MUST END WITH "/" 🔥
  const twiml = `
    <Response>
      <Connect>
        <Stream url="wss://${HOSTNAME}/" />
      </Connect>
    </Response>
  `;

  res.set("Content-Type", "text/xml");
  res.send(twiml);
});

app.get("/", (req, res) => res.send("Realtime AI Voice Server is Running"));

const server = app.listen(PORT, () => {
  console.log("Server live on port", PORT);
  console.log("WebSocket URL will be: wss://" + HOSTNAME + "/");
});

// =======================================
//       WEBSOCKET (Twilio ↔ Server)
// =======================================

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const callId = uuidv4();
  console.log("WebSocket connected:", callId);

  writeCallLog(callId, { event: "ws_connect", ts: Date.now() });

  let lastEmotion = "neutral";

  async function handleUserSpeech(data) {
    const text = data.text || "";

    console.log(`[${callId}] user:`, text);
    saveMemory(callId, { role: "user", content: text, ts: Date.now() });
    writeCallLog(callId, { event: "user_speech", text, ts: Date.now() });

    const intent = classifyIntent(text);
    const memory = getMemory(callId);

    if (data.emotion) lastEmotion = data.emotion;

    const tone = emotionToTone(lastEmotion);

    let systemPrompt = `
      You are Jessica, a real human-sounding receptionist.
      Speak naturally, conversationally, and with warmth.
      Tone: ${tone}.
      Keep responses short and human, not robotic.
      Allow interruptions. Avoid phrases like "As an AI model."
    `;

    if (intent === "schedule_interview")
      systemPrompt += " Ask for their name, availability, and phone number.";
    if (intent === "info")
      systemPrompt += " Provide clear short business info.";

    try {
      const resp = await client.responses.create({
        model: "gpt-4o-realtime-preview",
        modalities: ["text", "audio"],
        audio: { voice: "alloy", format: "wav" },
        input: [
          { role: "system", content: systemPrompt },
          ...memory.map(m => ({ role: m.role, content: m.content })),
          { role: "user", content: text }
        ],
        temperature: 0.7,
        top_p: 0.95
      });

      const assistantText = resp.output?.map(o => o.content).join(" ") || "";
      saveMemory(callId, { role: "assistant", content: assistantText, ts: Date.now() });
      writeCallLog(callId, { event: "assistant_response", text: assistantText, ts: Date.now() });

      const audioBlob =
        resp.output?.find(o => o.type === "audio")?.content ||
        resp.output?.[0]?.audio ||
        null;

      if (audioBlob) {
        ws.send(JSON.stringify({ event: "assistant_audio", audio: audioBlob }));
      } else {
        ws.send(JSON.stringify({ event: "assistant_text", text: assistantText }));
      }
    } catch (e) {
      console.error("OpenAI error:", e);
      ws.send(JSON.stringify({ event: "assistant_text", text: "Sorry, I'm having trouble responding." }));
    }
  }

  ws.on("message", async msg => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "user_speech") {
        await handleUserSpeech(data);
      }
    } catch (err) {
      console.log("Non-JSON frame received");
    }
  });

  ws.on("close", () => {
    writeCallLog(callId, { event: "ws_close", ts: Date.now() });
    console.log("WS closed:", callId);
  });
});
