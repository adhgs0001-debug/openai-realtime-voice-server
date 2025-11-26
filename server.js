import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ======== TWILIO INCOMING CALL ========
app.post("/incoming", (req, res) => {
  console.log("📞 Incoming call from:", req.body.From);

  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${process.env.RENDER_EXTERNAL_HOSTNAME}/stream" />
      </Start>
      <Say>Hello! Connecting you now.</Say>
    </Response>
  `;
  res.type("text/xml");
  res.send(twiml);
});

// ======== SERVER + WEBSOCKET ========
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});

const wss = new WebSocketServer({ server, path: "/stream" });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Conversation memory per call
const calls = {};

function getCallMemory(callId) {
  if (!calls[callId]) calls[callId] = [];
  return calls[callId];
}

function addMemory(callId, role, text) {
  calls[callId].push({ role, content: text });
}

// WHISPER CONVERSION OF TWILIO AUDIO
async function transcribeBase64Audio(b64) {
  const buffer = Buffer.from(b64, "base64");

  const result = await client.audio.transcriptions.create({
    file: buffer,
    model: "whisper-1",
    response_format: "text"
  });

  return result;
}

// ======== WEBSOCKET STREAM HANDLER ========
wss.on("connection", (ws) => {
  console.log("🔌 Twilio WebSocket connected");

  const callId = uuidv4();

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "media") {
        // Twilio sends audio blobs in base64
        const b64audio = data.media.payload;

        // → Convert audio → text using Whisper
        const text = await transcribeBase64Audio(b64audio);
        console.log("👂 Caller said:", text);

        addMemory(callId, "user", text);

        // → Send text to GPT-4o Realtime
        const resp = await client.responses.create({
          model: "gpt-4o-realtime-preview-2024-12-17",
          modalities: ["text", "audio"],
          audio: { voice: "alloy", format: "wav" },
          input: [
            { role: "system", content: "You are Jessica, a warm human receptionist." },
            ...getCallMemory(callId),
            { role: "user", content: text }
          ],
        });

        // Extract audio
        const audioChunk = resp.output.find(o => o.type === "audio");

        if (audioChunk) {
          ws.send(
            JSON.stringify({
              event: "media",
              media: { payload: audioChunk.audio }
            })
          );
        }

        // Save assistant memory
        const assistantText = resp.output
          .filter(o => o.type === "output_text")
          .map(o => o.content)
          .join(" ");

        addMemory(callId, "assistant", assistantText);
      }

      if (data.event === "start") {
        console.log("▶️ Stream started");
      }

      if (data.event === "stop") {
        console.log("⏹ Stream stopped");
      }

    } catch (err) {
      console.error("WS error:", err);
    }
  });
});
