// server.js
// Realtime-like Twilio <-> OpenAI Responses bridge
// - receives Twilio <Stream> JSON messages via WebSocket
// - uses OpenAI Responses API to produce audio responses
// - sends JSON events back to Twilio stream (assistant_audio / assistant_text)
// Note: Twilio can also send binary audio frames; this example expects JSON messages
// shaped like { event: "user_speech", text, isFinal, emotion? } from any upstream client
// (or code that decodes Twilio's media frames to text before sending to this service.)

import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const PORT = parseInt(process.env.PORT || "10000", 10) || 10000;
const HOSTNAME = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${PORT}`;
const MEMORY_PATH = process.env.MEMORY_PATH || "./memory";
const LOG_PATH = process.env.CALL_LOG_PATH || "./call_logs";

if (!fs.existsSync(MEMORY_PATH)) fs.mkdirSync(MEMORY_PATH, { recursive: true });
if (!fs.existsSync(LOG_PATH)) fs.mkdirSync(LOG_PATH, { recursive: true });

const app = express();
app.use(express.json());

// OpenAI client
if (!process.env.OPENAI_API_KEY) {
  console.error("ERROR: OPENAI_API_KEY not set in environment!");
}
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- small file-backed memory/log helpers ---
function writeCallLog(callId, obj) {
  const file = path.join(LOG_PATH, `${callId}.log`);
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}
function saveMemory(callId, obj) {
  const file = path.join(MEMORY_PATH, `${callId}.json`);
  let mem = [];
  if (fs.existsSync(file)) {
    try { mem = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { mem = []; }
  }
  mem.push(obj);
  fs.writeFileSync(file, JSON.stringify(mem, null, 2));
}
function getMemory(callId) {
  const file = path.join(MEMORY_PATH, `${callId}.json`);
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return []; }
}

// tiny intent classifier (replace with model call if desired)
function classifyIntent(text = "") {
  const t = (text || "").toLowerCase();
  if (/\b(schedule|interview|book|appointment)\b/.test(t)) return "schedule_interview";
  if (/\b(hours|when|open|close|location|address)\b/.test(t)) return "info";
  if (/\b(hi|hello|hey)\b/.test(t)) return "greeting";
  return "unknown";
}
function emotionToTone(e) {
  switch ((e || "").toLowerCase()) {
    case "angry": return "firm and calm";
    case "sad": return "soft and empathetic";
    case "excited": return "upbeat and energetic";
    default: return "friendly and conversational";
  }
}

// Twilio TWiML endpoint: Twilio will POST here when a call arrives.
// It responds with TwiML that connects the call to a WebSocket stream pointing to this service.
app.post("/incoming", (req, res) => {
  // Twilio posts CallSid and other metadata
  const callId = req.body.CallSid || uuidv4();
  console.log("Incoming call:", callId, req.body?.From);
  writeCallLog(callId, { event: "incoming", ts: Date.now(), body: req.body });
  saveMemory(callId, { role: "system", content: "call started", ts: Date.now() });

  // Twilio will open a WebSocket Stream to the URL you give (use wss:// with your Render host)
  const wssUrl = `wss://${HOSTNAME}`; // don't include https://
  // If Twilio requires path or query, include it: wss://host/path
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${wssUrl}" />
      </Connect>
    </Response>
  `;
  res.set("Content-Type", "text/xml");
  res.send(twiml);
});

app.get("/", (req, res) => res.send("Realtime-style Twilio/OpenAI bridge running"));

// Start server and WS server
const server = app.listen(PORT, () => {
  console.log("Server live on port", PORT);
});
const wss = new WebSocketServer({ server, path: "/" });

wss.on("connection", (ws, req) => {
  const callId = uuidv4();
  console.log("WebSocket connected:", callId, "remote:", req.socket.remoteAddress);
  writeCallLog(callId, { event: "ws_connect", ts: Date.now(), remote: req.socket.remoteAddress });

  // per-connection state
  let lastEmotion = "neutral";
  let receivedAudioChunks = []; // place-holder if you want to buffer raw audio frames
  let partialTextBuffer = "";

  // Core: handle user speech events (an incoming JSON event containing text)
  async function handleUserSpeech(payload) {
    const text = (payload.text || "").trim();
    if (!text) return;

    console.log(`[${callId}] user_speech ->`, text, "isFinal:", !!payload.isFinal);
    saveMemory(callId, { role: "user", content: text, ts: Date.now() });
    writeCallLog(callId, { event: "user_speech", text, isFinal: !!payload.isFinal, ts: Date.now() });

    // update emotion if present
    if (payload.emotion) lastEmotion = payload.emotion;

    // NLU & memory read
    const intent = classifyIntent(text);
    const memory = getMemory(callId) || [];

    // Build system prompt with tone
    const tone = emotionToTone(lastEmotion);
    let systemPrompt = `You are Jessica, an exceptionally natural human receptionist. Keep sentences short and conversational. Adapt your voice to the caller's emotion. Tone: ${tone}. Avoid robotic disclaimers. Allow interruptions by the caller.`;

    if (intent === "schedule_interview") {
      systemPrompt += " The caller wants to schedule. Ask for name, availability, and phone if needed, and confirm.";
    } else if (intent === "info") {
      systemPrompt += " Provide concise factual information (hours, location, or address).";
    }

    // Use OpenAI Responses API to produce an audio reply.
    try {
      // Create response with audio (wav)
      const resp = await client.responses.create({
        model: "gpt-4o-realtime-preview", // realtime-style model supporting audio output
        modalities: ["text", "audio"],
        audio: { voice: "alloy", format: "wav" }, // tweak voice/format if other backends exist
        input: [
          { role: "system", content: systemPrompt },
          // append memory as previous messages
          ...memory.map(m => {
            // memory items saved with role 'assistant'|'user'|'system'
            return { role: m.role === "system" ? "system" : (m.role || "user"), content: m.content };
          }),
          { role: "user", content: text }
        ],
        temperature: 0.7,
        top_p: 0.95
      });

      // Extract assistant text & audio
      const assistantText = (resp.output || [])
        .map(o => (o.content ? o.content : (o.type === "output_text" ? o.text : "")))
        .join(" ")
        .trim();

      // Save assistant reply to memory/log
      if (assistantText) {
        saveMemory(callId, { role: "assistant", content: assistantText, ts: Date.now() });
        writeCallLog(callId, { event: "assistant_text", text: assistantText, ts: Date.now() });
      }

      // Try to find audio content in the response
      // The exact shape can vary; we try common fields
      let audioBlob = null;
      if (Array.isArray(resp.output)) {
        for (const part of resp.output) {
          if (part.type === "audio") {
            audioBlob = part.content; // may already be base64/audio binary representation
            break;
          }
          // some SDKs return audio under .audio or .content[0].audio etc.
          if (part.audio) {
            audioBlob = part.audio;
            break;
          }
        }
      }
      // fallback: resp.output[0].audio (older shapes)
      if (!audioBlob && resp.output && resp.output[0] && resp.output[0].audio) {
        audioBlob = resp.output[0].audio;
      }

      if (audioBlob) {
        // We send back a JSON event with base64 audio (Twilio can accept such JSON events if your code on Twilio side knows how to
        // extract and play them, or you can adapt this to stream binary PCM frames to Twilio).
        // We attempt to send the audio as base64 in a JSON event Twilio/your client understands:
        ws.send(JSON.stringify({ event: "assistant_audio", audio: audioBlob }));
        writeCallLog(callId, { event: "sent_audio", ts: Date.now(), size: (typeof audioBlob === "string" ? audioBlob.length : 0) });
      } else {
        // fallback to text-only
        ws.send(JSON.stringify({ event: "assistant_text", text: assistantText || "Sorry, I'm having trouble producing audio." }));
      }

    } catch (err) {
      console.error("OpenAI error:", err?.message || err);
      writeCallLog(callId, { event: "openai_error", err: String(err), ts: Date.now() });
      ws.send(JSON.stringify({ event: "assistant_text", text: "Sorry — I'm having trouble responding right now." }));
    }
  }

  // When messages arrive from Twilio's Stream, they may be JSON like:
  // { event:'start' } / { event:'media', media:{ payload:'BASE64...' } } / { event:'stop' }
  // Or you might route already transcribed text with a JSON shape like { event:'user_speech', text, isFinal, emotion }
  ws.on("message", async (raw) => {
    // Try parse JSON first
    let parsed = null;
    try {
      parsed = JSON.parse(raw.toString());
    } catch (e) {
      // Not JSON (likely binary audio frame) — we ignore here, or you could buffer audio for STT
      // If you want to support raw audio frames, decode here and perform STT, then call handleUserSpeech(...)
      // For now we log that we received binary data.
      writeCallLog(callId, { event: "binary_audio", note: "non-json message ignored", ts: Date.now() });
      return;
    }

    // Handle Twilio <Stream> JSON control events or your own JSON speech events
    const evt = parsed.event;
    if (!evt) {
      writeCallLog(callId, { event: "unknown_json", data: parsed, ts: Date.now() });
      return;
    }

    if (evt === "start") {
      writeCallLog(callId, { event: "stream_start", ts: Date.now(), data: parsed });
      console.log(`[${callId}] Stream started`);
      // Respond with initial greeting optionally
      // (We could proactively call OpenAI here and send greeting audio.)
      return;
    }

    if (evt === "media") {
      // Twilio sends audio frames inside parsed.media.payload (base64). We could decode & run STT here.
      // This server expects *transcribed text* messages (user_speech). If you want STT in this service,
      // implement decoding here and call a speech-to-text model (not included).
      writeCallLog(callId, { event: "media", ts: Date.now(), size: parsed.media?.payload?.length || 0 });
      // Optionally forward media to an STT service and then call handleUserSpeech(transcription)
      return;
    }

    if (evt === "stop") {
      writeCallLog(callId, { event: "stream_stop", ts: Date.now(), data: parsed });
      console.log(`[${callId}] Stream stopped`);
      return;
    }

    // If upstream sends transcript JSON (convenient for this bridge), handle user speech directly:
    if (evt === "user_speech") {
      await handleUserSpeech(parsed);
      return;
    }

    // custom "call_end" event
    if (evt === "call_end") {
      writeCallLog(callId, { event: "call_end", ts: Date.now(), data: parsed });
      console.log(`[${callId}] call_end`);
      return;
    }

    // any other events — log
    writeCallLog(callId, { event: "other_event", name: evt, data: parsed, ts: Date.now() });
  });

  ws.on("close", () => {
    writeCallLog(callId, { event: "ws_close", ts: Date.now() });
    console.log("WebSocket closed:", callId);
  });

  ws.on("error", (err) => {
    writeCallLog(callId, { event: "ws_error", err: String(err), ts: Date.now() });
    console.error("WS error for", callId, err);
  });
});
