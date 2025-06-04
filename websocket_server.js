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

wss.on('connection', (ws) => {
  console.log('🔗 WebSocket client connected');
  let audioChunks = [];

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
      return;
    }

    if (parsed.event === 'media') {
      // Twilio sends raw 16-bit PCM audio base64 encoded
      const audioData = Buffer.from(parsed.media.payload, 'base64');
      audioChunks.push(audioData);
      return;
    }

    if (parsed.event === 'stop') {
      // Convert raw PCM audio chunks to WAV buffer
      const rawBuffer = Buffer.concat(audioChunks);
      const filename = `./temp/${uuidv4()}.wav`;

      try {
        await saveWavFile(rawBuffer, filename);
        console.log(`🎧 Audio saved (WAV): ${filename}`);

        console.log('[STEP] Transcribing audio...');
        const transcript = await transcribeAudio(filename);
        console.log(`📝 Transcript: ${transcript || '❌ empty'}`);

        if (!transcript || transcript.trim().length === 0) throw new Error('Empty transcription');

        console.log('[STEP] Generating GPT response...');
        const gptResponse = await generateGPTResponse(transcript);
        console.log(`🤖 GPT: ${gptResponse || '❌ empty'}`);

        if (!gptResponse || gptResponse.trim().length === 0) throw new Error('Empty GPT response');

        console.log('[STEP] Synthesizing TTS...');
        const ttsAudio = await synthesizeSpeech(gptResponse);

        if (!ttsAudio || !Buffer.isBuffer(ttsAudio) || ttsAudio.length === 0) {
          throw new Error('Invalid TTS audio');
        }

        console.log(`🔊 Sending audio (${ttsAudio.length} bytes)...`);
        ws.send(JSON.stringify({
          event: 'media',
          media: {
            payload: ttsAudio.toString('base64')
          }
        }));

      } catch (err) {
        console.error('❌ Pipeline failed:', err.message);
        try {
          ws.send(JSON.stringify({
            event: 'media',
            media: {
              payload: Buffer.from('Sorry, something went wrong.').toString('base64')
            }
          }));
        } catch (fallbackErr) {
          console.error('❌ Could not send fallback:', fallbackErr);
        }
        ws.send(JSON.stringify({ event: 'stop', reason: 'internal_error' }));
      } finally {
        if (fs.existsSync(filename)) fs.unlinkSync(filename);
        audioChunks = [];
      }
    }
  });
});

// Convert raw PCM buffer to WAV file
async function saveWavFile(rawBuffer, outputPath) {
  // Twilio audio format: 16-bit signed PCM, 16 kHz, mono
  const sampleRate = 16000;

  // Convert Buffer of Int16 samples to Float32 array normalized [-1,1]
  const int16Array = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2);
  const float32Array = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 32768;
  }

  const audioData = {
    sampleRate,
    channelData: [float32Array]
  };

  const wavBuffer = await WavEncoder.encode(audioData);
  fs.writeFileSync(outputPath, Buffer.from(wavBuffer));
}

// Whisper transcription
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

// GPT-4 response
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

// ElevenLabs TTS
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

// Twilio XML endpoint
app.all('/twilio', (req, res) => {
  res.type('text/xml');
  res.sendFile(__dirname + '/call.xml');
});

// Health check
app.all('/', (req, res) => {
  res.send('✅ AI Voice Agent Server is running');
});

// Create temp dir
if (!fs.existsSync('./temp')) {
  fs.mkdirSync('./temp');
}

server.listen(3000, () => {
  console.log('🚀 WebSocket server running on port 3000');
});
