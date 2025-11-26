import express from "express";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";

dotenv.config();

// ----- Express Setup -----
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});

// ----- WebSocket Server (Twilio will connect here) -----
const wss = new WebSocketServer({ server });

// ----- OpenAI client -----
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

console.log("Realtime server ready.");

// -------------------------------------------
//  Twilio Incoming Call -> Return TwiML
// -------------------------------------------
app.post("/incoming", (req, res) => {
  const twiml = `
    <Response>
      <Connect>
        <Stream url="wss://${process.env.RENDER_EXTERNAL_HOSTNAME}/stream" />
      </Connect>
    </Response>
  `;

  res.set("Content-Type", "text/xml");
  res.send(twiml);
});

// -------------------------------------------
//     WEBSOCKET STREAM: RAW AUDIO FROM TWILIO
// -------------------------------------------
wss.on("connection", async (ws, req) => {
  const callId = uuidv4();
  console.log(`☎️ Call connected: ${callId}`);

  // CREATE REALTIME SESSION
  const session = await client.realtime.sessions.create({
    model: "gpt-4o-realtime-preview",
    modalities: ["text", "audio"],
    audio: { voice: "verse", format: "wav" }
  });

  ws.on("message", async (msg) => {
    // Twilio sends JSON events AND raw audio frames
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      // Raw audio frame → forward to OpenAI
      session.inputAudio(msg);
      return;
    }

    if (data.event === "start") {
      console.log("Call start event received.");
    }

    if (data.event === "media") {
      // Base64 audio → convert → send to OpenAI
      const audioBuffer = Buffer.from(data.media.payload, "base64");
      session.inputAudio(audioBuffer);
    }

    if (data.event === "stop") {
      console.log("Call ended.");
      session.inputText("Call has ended.");
    }
  });

  // When OpenAI sends output (audio or text)
  session.on("response.audio.delta", (audio) => {
    ws.send(
      JSON.stringify({
        event: "assistant_audio",
        audio: audio
      })
    );
  });

  session.on("response.text.delta", (text) => {
    console.log("AI says:", text);
  });
});
