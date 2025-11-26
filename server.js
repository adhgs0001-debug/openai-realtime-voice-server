import express from "express";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ====== TWILIO INCOMING CALL ======
app.post("/incoming", (req, res) => {
  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${process.env.RENDER_EXTERNAL_HOSTNAME}/stream" />
      </Start>
      <Say>Hi, I’m Jessica. How can I help?</Say>
    </Response>
  `;

  res.type("text/xml");
  res.send(twiml);
});

// ============ SERVER & WS ============
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});

const wss = new WebSocketServer({ server, path: "/stream" });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


// ========= PER-CALL STATE =========
const calls = {};

function initCall(callId) {
  calls[callId] = {
    audioBuffer: [],      // Collect incoming Twilio audio
    memory: [],           // Conversation context
    lastProcessTime: 0    // Rate limit Whisper requests
  };
}

function addMemory(callId, role, text) {
  calls[callId].memory.push({ role, content: text });
}

function getMemory(callId) {
  return calls[callId].memory;
}


// ========= TRANSCRIBE COLLECTED AUDIO ======
async function transcribeChunk(buffer) {
  const audio = Buffer.concat(buffer);

  const result = await client.audio.transcriptions.create({
    file: audio,
    model: "whisper-1",
    response_format: "text"
  });

  return result;
}


// ========= HANDLE TWILIO STREAM ==========
wss.on("connection", (ws) => {
  console.log("🔌 Twilio Stream Connected");

  const callId = uuidv4();
  initCall(callId);

  ws.on("message", async (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.event === "media") {
      const packet = Buffer.from(data.media.payload, "base64");
      calls[callId].audioBuffer.push(packet);

      const now = Date.now();

      // process every 1.2 seconds
      if (now - calls[callId].lastProcessTime > 1200) {
        calls[callId].lastProcessTime = now;

        const chunk = [...calls[callId].audioBuffer];
        calls[callId].audioBuffer = [];

        try {
          const text = await transcribeChunk(chunk);

          console.log("👂 Caller:", text);
          addMemory(callId, "user", text);

          const response = await client.responses.create({
            model: "gpt-4o-realtime-preview-2024-12-17",
            modalities: ["text", "audio"],
            audio: { voice: "alloy", format: "wav" },
            input: [
              { role: "system", content: "You are Jessica, a warm human receptionist." },
              ...getMemory(callId),
              { role: "user", content: text }
            ]
          });

          // Extract audio
          const audioChunk = response.output.find(o => o.type === "audio");

          if (audioChunk) {
            ws.send(JSON.stringify({
              event: "media",
              media: { payload: audioChunk.audio }
            }));
          }

          // Save assistant text memory
          const assistantText = response.output
            .filter(o => o.type === "output_text")
            .map(o => o.content)
            .join(" ");

          addMemory(callId, "assistant", assistantText);

        } catch (err) {
          console.error("❌ Processing error:", err.message);
        }
      }
    }

    if (data.event === "start") {
      console.log("▶️ Stream started");
    }

    if (data.event === "stop") {
      console.log("⏹ Stream stopped");
    }
  });
});
