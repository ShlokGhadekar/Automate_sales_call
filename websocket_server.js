const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const { v4: uuidv4 } = require('uuid');
const WavEncoder = require('wav-encoder');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VOICE_ID = process.env.VOICE_ID;

const CHUNK_DURATION_MS = 3000; // 3 seconds
const SAMPLE_RATE = 16000; // 16 kHz
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // 16-bit mono = 2 bytes per sample
const CHUNK_SIZE = (BYTES_PER_SECOND * CHUNK_DURATION_MS) / 1000;

wss.on('connection', (ws) => {
  console.log('🔗 WebSocket client connected');
  let buffer = Buffer.alloc(0);
  let interval = null;

  const processChunk = async () => {
    if (buffer.length < CHUNK_SIZE) return;

    const chunk = buffer.slice(0, CHUNK_SIZE);
    buffer = buffer.slice(CHUNK_SIZE);

    const filename = `./temp/${uuidv4()}.wav`;

    try {
      await saveWavFile(chunk, filename);
      console.log(`🎧 Processing chunk: ${filename}`);

      const transcript = await transcribeAudio(filename);
      console.log(`📝 Transcript: ${transcript || '❌ empty'}`);

      if (!transcript || transcript.trim().length === 0) return;

      const gptResponse = await generateGPTResponse(transcript);
      console.log(`🤖 GPT: ${gptResponse || '❌ empty'}`);

      if (!gptResponse || gptResponse.trim().length === 0) return;

      const ttsAudio = await synthesizeSpeech(gptResponse);
      console.log(`🔊 Sending audio (${ttsAudio.length} bytes)...`);

      ws.send(JSON.stringify({
        event: 'media',
        media: {
          payload: ttsAudio.toString('base64')
        }
      }));
    } catch (err) {
      console.error('❌ Real-time pipeline error:', err.message);
    } finally {
      if (fs.existsSync(filename)) fs.unlinkSync(filename);
    }
  };

  ws.on('message', async (message) => {
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch (e) {
      console.error('❌ Invalid JSON received:', message);
      return;
    }

    if (parsed.event === 'start') {
      console.log('🚀 Stream started from Twilio');
      interval = setInterval(processChunk, CHUNK_DURATION_MS);
      return;
    }

    if (parsed.event === 'media') {
      const audioData = Buffer.from(parsed.media.payload, 'base64');
      buffer = Buffer.concat([buffer, audioData]);
      return;
    }

    if (parsed.event === 'stop') {
      console.log('🛑 Stream ended by Twilio');
      clearInterval(interval);
      interval = null;
      return;
    }
  });
});

async function saveWavFile(rawBuffer, outputPath) {
  const int16Array = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2);
  const float32Array = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 32768;
  }

  const audioData = {
    sampleRate: SAMPLE_RATE,
    channelData: [float32Array]
  };

  const wavBuffer = await WavEncoder.encode(audioData);
  fs.writeFileSync(outputPath, Buffer.from(wavBuffer));
}

async function transcribeAudio(filePath) {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(filePath));
  formData.append('model', 'whisper-1');

  const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
    headers: {
      ...formData.getHeaders(),
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    }
  });

  return response.data.text;
}

async function generateGPTResponse(text) {
  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are a helpful AI sales assistant.' },
      { role: 'user', content: text }
    ]
  }, {
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    }
  });

  return res.data.choices[0].message.content;
}

async function synthesizeSpeech(text) {
  const res = await axios({
    method: 'post',
    url: `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json'
    },
    responseType: 'arraybuffer',
    data: {
      text,
      model_id: 'eleven_monolingual_v1',
      voice_settings: { stability: 0.5, similarity_boost: 0.7 }
    }
  });

  return Buffer.from(res.data);
}

app.all('/twilio', (req, res) => {
  res.type('text/xml');
  res.sendFile(__dirname + '/call.xml');
});

app.all('/', (req, res) => {
  res.send('✅ AI Voice Agent Server is running');
});

if (!fs.existsSync('./temp')) {
  fs.mkdirSync('./temp');
}

server.listen(3000, () => {
  console.log('🚀 WebSocket server running on port 3000');
});
