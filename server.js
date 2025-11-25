import express from "express";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Realtime AI Voice Server is Running");
});

const server = app.listen(process.env.PORT || 3000, () => {
  console.log("Server live on port", process.env.PORT || 3000);
});

// --- REALTIME WEBSOCKET SETUP ---
const wss = new WebSocketServer({ server });

// OpenAI client
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Handle connections from Twilio/clients
wss.on("connection", (ws) => {
  console.log("☎️ Twilio connected.");

  ws.on("message", async (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.event === "user_speech") {
      console.log("Caller said:", data.text);

      const reply = await client.responses.create({
        model: "gpt-4o-realtime-preview",
        modalities: ["audio"],
        audio: {
          voice: "alloy",      // REAL HUMAN VOICE
          format: "wav"
        },
        input: `Act like a real human receptionist named Jessica. ${data.text}`
      });

      ws.send(JSON.stringify({
        event: "assistant_audio",
        audio: reply.output[0].audio
      }));
    }
  });
});
