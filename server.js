import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// TWILIO INCOMING CALL → RETURN TWIML THAT STARTS <Stream>
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

// WebSocket server
const wss = new WebSocketServer({ server, path: "/stream" });

// OpenAI
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Handle WebSocket connections
wss.on("connection", (ws) => {
  console.log("🔌 Twilio WebSocket connected");

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "start") {
        console.log("Twilio stream started");
      }

      if (data.event === "media") {
        const audioData = data.media.payload;

        const response = await client.audio.speech.create({
          model: "gpt-4o-realtime-preview",
          voice: "alloy",
          input: "Hi, how can I help you?",
          audio: {
            format: "wav"
          }
        });

        ws.send(
          JSON.stringify({
            event: "media",
            media: { payload: response.audio }
          })
        );
      }

      if (data.event === "stop") {
        console.log("Twilio stream stopped");
      }

    } catch (err) {
      console.error("WS message error:", err);
    }
  });
});
