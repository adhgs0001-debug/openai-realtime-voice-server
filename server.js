import express from "express";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";
import OpenAI from "openai";

dotenv.config();

// -------------------------
// EXPRESS APP
// -------------------------

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Twilio webhook → return TwiML that opens websocket stream
app.post("/incoming", (req, res) => {
  console.log("📞 Incoming call from:", req.body.From);

  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${process.env.RENDER_EXTERNAL_HOSTNAME}/stream" />
      </Start>
      <Say>Hi, I'm Jessica. How can I help you today?</Say>
    </Response>
  `;

  res.type("text/xml");
  res.send(twiml);
});

// -------------------------
// SERVER + WEBSOCKET
// -------------------------

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () =>
  console.log("🚀 Server running on port", PORT)
);

const wss = new WebSocketServer({ server, path: "/stream" });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------------------------
// AUDIO BUFFER (1.5-second safe batching)
// -------------------------
let audioBuffer = [];
let lastProcessTime = Date.now();
const BATCH_TIME = 1500; // ms

// -------------------------
// SAFE FALLBACK RESPONSE
// -------------------------
async function fallbackAudio() {
  const resp = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: "Sorry, I didn't catch that. Could you repeat it?"
  });

  return Buffer.from(await resp.arrayBuffer()).toString("base64");
}

// -------------------------
// TRANSCRIBE CHUNK (safe try/catch)
// -------------------------
async function transcribeChunk(base64wav) {
  try {
    const resp = await openai.audio.transcriptions.create({
      file: Buffer.from(base64wav, "base64"),
      model: "whisper-1"
    });
    return resp.text || "";
  } catch (err) {
    console.error("⚠️ Whisper transcription failed:", err);
    return null; // return null so fallback is used
  }
}

// -------------------------
// SEND TEXT → SPEECH
// -------------------------
async function ttsResponse(text) {
  const resp = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: text
  });
  return Buffer.from(await resp.arrayBuffer()).toString("base64");
}

// -------------------------
// GENERATE AI RESPONSE
// -------------------------
async function aiResponse(userText) {
  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: `You are Jessica, a friendly phone assistant. User said: ${userText}`
  });

  return resp.output_text;
}

// -------------------------
// WEBSOCKET CONNECTION
// -------------------------
wss.on("connection", (ws) => {
  console.log("🔌 Twilio WebSocket connected");

  ws.on("message", async (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.event === "start") {
      console.log("▶️ Stream started");
      return;
    }

    if (data.event === "stop") {
      console.log("⏹ Stream stopped");
      return;
    }

    if (data.event === "media") {
      audioBuffer.push(data.media.payload);

      // Process every BATCH_TIME ms
      if (Date.now() - lastProcessTime < BATCH_TIME) return;
      lastProcessTime = Date.now();

      const chunk = audioBuffer.join("");
      audioBuffer = []; // reset buffer

      console.log("🎤 Processing batch of audio...");

      // -------------------------
      // TRANSCRIBE
      // -------------------------
      const text = await transcribeChunk(chunk);

      if (!text || text.trim() === "") {
        console.log("⚠️ Empty/failed transcription → sending fallback");
        const fb = await fallbackAudio();
        ws.send(JSON.stringify({ event: "media", media: { payload: fb } }));
        return;
      }

      console.log("🗣 User said:", text);

      // -------------------------
      // AI RESPONSE
      // -------------------------
      const reply = await aiResponse(text);
      console.log("🤖 AI:", reply);

      // -------------------------
      // SYNTHESIZE AUDIO
      // -------------------------
      const audio = await ttsResponse(reply);

      // -------------------------
      // SEND AUDIO BACK TO TWILIO
      // -------------------------
      ws.send(
        JSON.stringify({
          event: "media",
          media: { payload: audio }
        })
      );
    }
  });
});
