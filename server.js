// /mnt/data/openai-realtime-voice-server/server.js
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

// ----- Configuration & simple memory/log backends -----
const PORT = process.env.PORT || 3000;
const HOSTNAME = process.env.RENDER_EXTERNAL_HOSTNAME || "localhost:3000";
const MEMORY_PATH = process.env.MEMORY_PATH || "./call_memory";
const LOG_PATH = process.env.CALL_LOG_PATH || "./call_logs";
if (!fs.existsSync(MEMORY_PATH)) fs.mkdirSync(MEMORY_PATH, { recursive: true });
if (!fs.existsSync(LOG_PATH)) fs.mkdirSync(LOG_PATH, { recursive: true });

// OpenAI client
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Helpers ---
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

// Utility: small NLU classifier (simple patterns, replace with model when ready)
function classifyIntent(text) {
  const t = text.toLowerCase();
  if (/\b(schedule|interview|book|appointment)\b/.test(t)) return "schedule_interview";
  if (/\b(hours|when|open|close|location|address)\b/.test(t)) return "info";
  if (/\b(hi|hello|hey)\b/.test(t)) return "greeting";
  return "unknown";
}

// Map emotion scores to tone instructions
function emotionToTone(emotionLabel) {
  // example mapping - your app can replace with a real emotion detector
  switch ((emotionLabel || "").toLowerCase()) {
    case "angry": return "firm and calm";
    case "sad": return "soft and empathetic";
    case "excited": return "upbeat and energetic";
    default: return "friendly and conversational";
  }
}

// ========== TWILIO INCOMING (TWiML) ==========
app.post("/incoming", (req, res) => {
  // Twilio will POST call metadata here: CallSid, From, To, etc.
  const callId = req.body.CallSid || uuidv4();
  console.log("Incoming call:", callId, req.body?.From);

  // Log and create memory seed
  writeCallLog(callId, { event: "incoming", timestamp: Date.now(), body: req.body });
  saveMemory(callId, { role: "system", content: "Call started" });

  // Respond with TwiML instructing Twilio to open a WebSocket stream to our server
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

// Start server
const server = app.listen(PORT, () => {
  console.log("Server live on port", PORT);
  console.log("Detected service running on port", PORT);
});

// ========== WEBSOCKET SERVER: Twilio <-> our logic ==========

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  // Each connection represents one Twilio stream / call
  const callId = uuidv4();
  console.log("WebSocket connection open for call:", callId);
  writeCallLog(callId, { event: "ws_connect", timestamp: Date.now(), remote: req.socket.remoteAddress });

  // Per-connection state
  let partialTranscript = "";
  let lastEmotion = "neutral";
  let interrupting = false; // whether assistant already started speaking

  async function handleUserSpeech(data) {
    // data.text = recognized speech
    const text = data.text || "";
    console.log(`[${callId}] user speech (partial?)`, text);

    // Save transcript to memory/log
    saveMemory(callId, { role: "user", content: text, ts: Date.now() });
    writeCallLog(callId, { event: "user_speech", text, ts: Date.now() });

    // Basic NLU routing & memory read
    const intent = classifyIntent(text);
    const memory = getMemory(callId);

    // Emotion detection hint (if Twilio or client supplies), else preserve last emotion
    if (data.emotion) lastEmotion = data.emotion;

    // If the user has paused or we detect key routing words, we may "interrupt"
    const shouldInterrupt = (data.isFinal === false && text.length > 20) || /\b(wait|hold|actually)\b/.test(text.toLowerCase());

    // Compose the assistant prompt with memory + tone
    const tone = emotionToTone(lastEmotion);
    let systemPrompt = `You are Jessica, a warm human receptionist. Speak in short friendly sentences, use natural conversational timing, and adapt to the caller's emotion. Tone: ${tone}. If caller asks to schedule, follow scheduling flow. Keep responses natural—no robotic phrases like "As an AI." Allow interruptions when the caller is still speaking.`;

    // Add NLU-specific preface
    if (intent === "schedule_interview") systemPrompt += " The caller intends to schedule an interview. Ask for full name, availability, and phone number if not already provided.";
    if (intent === "info") systemPrompt += " The caller asks for information such as hours or location. Provide concise details.";

    // Build input for the Realtime Responses API
    // We'll create a short response; if shouldInterrupt is true we stream earlier
    try {
      // Create response (audio) via OpenAI
      const resp = await client.responses.create({
        model: "gpt-4o-realtime-preview",
        modalities: ["text","audio"],
        audio: { voice: "alloy", format: "wav" },
        input: [
          { role: "system", content: systemPrompt },
          ...memory.map(m => ({ role: m.role === "system" ? "system" : (m.role || "user"), content: m.content })),
          { role: "user", content: text }
        ],
        // You can tweak temperature/empathy parameters for human-like style
        temperature: 0.7,
        top_p: 0.95,
        // custom "emotional_tone" is simulated via system prompt; some voice backends may support pitch/rate
      });

      // Save assistant message to memory
      const assistantText = resp.output?.map(o => o.content).join(" ") || "";
      saveMemory(callId, { role: "assistant", content: assistantText, ts: Date.now() });
      writeCallLog(callId, { event: "assistant_response", intent, ts: Date.now(), text: assistantText });

      // Send audio back to Twilio stream
      // resp.output may include audio fields depending on the model result shape:
      const audioBlob = resp.output?.find(o => o.type === "audio")?.content || resp.output?.[0]?.audio || null;
      if (audioBlob) {
        ws.send(JSON.stringify({ event: "assistant_audio", audio: audioBlob }));
      } else {
        // fallback: send text event if audio not present
        ws.send(JSON.stringify({ event: "assistant_text", text: assistantText }));
      }

    } catch (err) {
      console.error("OpenAI error", err);
      writeCallLog(callId, { event: "openai_error", err: String(err), ts: Date.now() });
      ws.send(JSON.stringify({ event: "assistant_text", text: "Sorry — I'm having trouble responding right now." }));
    }
  }

  ws.on("message", async (msg) => {
    // Twilio's <Stream> protocol sends audio frames and JSON events.
    // For simplicity, we expect JSON messages with structure { event: "user_speech", text, isFinal, emotion? }
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "user_speech") {
        await handleUserSpeech(data);
      } else if (data.event === "call_end") {
        writeCallLog(callId, { event: "call_end", ts: Date.now(), details: data });
        console.log(`[${callId}] call ended`);
      } else {
        writeCallLog(callId, { event: "ws_message", data, ts: Date.now() });
      }
    } catch (e) {
      // Some messages may be binary audio frames — ignore here or implement demuxing
      console.warn("Non-JSON WS message or parse error", e?.message || e);
    }
  });

  ws.on("close", () => {
    writeCallLog(callId, { event: "ws_close", ts: Date.now() });
    console.log("WebSocket closed for call:", callId);
  });
});
