import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json({ limit: "50mb" }));

// Ensure memory + logging folders exist
const CALL_LOG_PATH = process.env.CALL_LOG_PATH || "./call_logs";
const MEMORY_PATH = process.env.MEMORY_PATH || "./memory";

if (!fs.existsSync(CALL_LOG_PATH)) fs.mkdirSync(CALL_LOG_PATH);
if (!fs.existsSync(MEMORY_PATH)) fs.mkdirSync(MEMORY_PATH);

// ========= OpenAI Client ==========
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ========= Server Boot ============
const PORT = process.env.PORT || 10000;

const httpServer = app.listen(PORT, () => {
  console.log(`Realtime AI Voice Server running on port ${PORT}`);
});

// ========= WebSocket Bridge =========
import { WebSocketServer } from "ws";
const wss = new WebSocketServer({ server: httpServer });

// Store memory in RAM (persisted after each turn)
let memory = [];

// ========= Helper Functions ==========

function logCallEvent(callId, event) {
  const logFile = path.join(CALL_LOG_PATH, `${callId}.json`);

  let existing = [];
  if (fs.existsSync(logFile)) {
    existing = JSON.parse(fs.readFileSync(logFile));
  }

  existing.push(event);
  fs.writeFileSync(logFile, JSON.stringify(existing, null, 2));
}

function saveMemory() {
  fs.writeFileSync(
    path.join(MEMORY_PATH, "memory.json"),
    JSON.stringify(memory, null, 2)
  );
}

// ========= Twilio Incoming Call (returns TwiML) =========
app.post("/incoming", (req, res) => {
  const HOST = process.env.RENDER_EXTERNAL_HOSTNAME;

  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${HOST}" />
      </Start>
      <Say>Hello! Connecting you now.</Say>
    </Response>
  `;

  res.set("Content-Type", "text/xml");
  return res.send(twiml);
});

// ========= WebSocket Handling (Twilio <Stream>) ==========

wss.on("connection", async (ws) => {
  console.log("📞 Twilio connected to WebSocket stream.");

  let callId = `call_${Date.now()}`;

  // Each call gets a dedicated OpenAI Realtime session
  const session = await client.realtime.sessions.create({
    modalities: ["audio", "text"],
    audio: {
      voice: "alloy",
      format: "wav",
    },
    instructions: `
      You are Jessica, a friendly real human receptionist.
      • Speak naturally
      • Interrupt when the user interrupts
      • Match the user's tone (emotional tuning)
      • Keep track of memory details: name, appointment, reason for calling
      • Route calls when needed (booking, support, emergencies)
    `,
  });

  // Stream audio from OpenAI → Twilio WebSocket
  session.on("audio.delta", (delta) => {
    ws.send(
      JSON.stringify({
        event: "assistant_audio",
        audio: delta,
      })
    );
  });

  ws.on("message", async (msg) => {
    let data;

    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      console.log("❌ Bad JSON from Twilio:", msg.toString());
      return;
    }

    // ========== Twilio EVENT HANDLING ==========

    if (data.event === "start") {
      console.log("▶️ Stream started.");
      logCallEvent(callId, { type: "call_started", ts: Date.now() });
    }

    if (data.event === "stop") {
      console.log("⏹ Stream stopped.");
      logCallEvent(callId, { type: "call_ended", ts: Date.now() });
      saveMemory();
    }

    // Twilio sends audio packets as base64 — we forward to OpenAI
    if (data.event === "media") {
      const audio_b64 = data.media.payload;

      session.input_audio.send({
        audio: audio_b64,
      });
    }

    // Twilio STT results (this is the KEY)
    if (data.event === "speech") {
      const text = data.speech.text;
      const final = data.speech.is_final;

      console.log("👤 Caller:", text);

      logCallEvent(callId, {
        type: "user_speech",
        text,
        ts: Date.now(),
      });

      if (final) {
        // memory update
        memory.push({ ts: Date.now(), text });
        saveMemory();

        // NLU routing example
        if (text.includes("appointment")) {
          session.input_text.send("The caller wants an appointment.");
        }

        if (text.includes("emergency")) {
          session.input_text.send("This is urgent. Respond seriously.");
        }

        // Forward to OpenAI to speak
        session.input_text.send(text);
      }
    }
  });
});
