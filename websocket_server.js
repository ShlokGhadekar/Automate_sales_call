// websocket_server.js (real-time interaction enabled)

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VOICE_ID = process.env.VOICE_ID;

const TEMP_DIR = './temp';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

wss.on('connection', (ws) => {
  console.log('🔗 WebSocket client connected');

  let buffer = [];
  let lastChunkTime = Date.now();

  const INTERVAL = 3000; // every 3 seconds
  const MIN_AUDIO_LENGTH = 8000; // bytes (around 1 second)

  const processBuffer = async () => {
    if (buffer.length === 0) return;
    const chunk = Buffer.concat(buffer);
    buffer = [];

    if (chunk.length < MIN_AUDIO_LENGTH) return;

    const filename = `${TEMP_DIR}/${uuidv4()}.wav`;
    fs.writeFileSync(filename, chunk);
    console.log(`🎧 Processing chunk: ${filename}`);

    try {
      const transcript = await transcribeAudio(filename);
      console.log(`📝 Transcript: ${transcript}`);

      if (!transcript.trim()) return;

      const gptReply = await generateGPTResponse(transcript);
      console.log(`🤖 GPT: ${gptReply}`);

      const ttsAudio = await synthesizeSpeech(gptReply);
      console.log(`🔊 Sending audio (${ttsAudio.length} bytes)`);

      ws.send(JSON.stringify({
        event: 'media',
        media: {
          payload: ttsAudio.toString('base64')
        }
      }));
    } catch (err) {
      console.error('❌ Real-time pipeline error:', err.message);
    } finally {
      fs.unlinkSync(filename);
    }
  };

  const interval = setInterval(() => {
    if (Date.now() - lastChunkTime > INTERVAL) return;
    processBuffer();
  }, INTERVAL);

  ws.on('message', async (msg) => {
    let parsed;
    try {
      parsed = JSON.parse(msg);
    } catch (err) {
      console.error('❌ Bad JSON:', err);
      return;
    }

    if (parsed.event === 'start') {
      console.log('🚀 Stream started from Twilio');
    }

    if (parsed.event === 'media') {
      const chunk = Buffer.from(parsed.media.payload, 'base64');
      buffer.push(chunk);
      lastChunkTime = Date.now();
    }

    if (parsed.event === 'stop') {
      console.log('🛑 Stream ended by Twilio');
      clearInterval(interval);
      processBuffer();
    }
  });

  ws.on('close', () => {
    console.log('❌ WebSocket closed');
    clearInterval(interval);
  });
});

// Whisper transcription
async function transcribeAudio(filePath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('model', 'whisper-1');

  const res = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  });

  return res.data.text;
}

// GPT-4 chat
async function generateGPTResponse(text) {
  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are a helpful AI sales assistant.' },
      { role: 'user', content: text }
    ]
  }, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    }
  });

  return res.data.choices[0].message.content;
}

// ElevenLabs TTS
async function synthesizeSpeech(text) {
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      text,
      model_id: 'eleven_monolingual_v1',
      voice_settings: { stability: 0.5, similarity_boost: 0.7 }
    },
    {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer'
    }
  );

  return Buffer.from(res.data);
}

// Twilio webhook
app.all('/twilio', (req, res) => {
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you to our AI agent now.</Say>
  <Connect>
    <Stream url="wss://${req.headers.host}/ws" />
  </Connect>
</Response>`);
});

app.get('/', (_, res) => res.send('✅ AI Voice Agent Live'));

server.listen(3000, () => console.log('🚀 WebSocket server running on port 3000'));
