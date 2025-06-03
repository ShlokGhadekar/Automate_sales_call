const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Environment variables or config
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

wss.on('connection', (ws) => {
  console.log('Client connected');
  let audioChunks = [];

  ws.on('message', async (message) => {
    const parsed = JSON.parse(message);

    // Handle audio stream
    if (parsed.event === 'media') {
      const audioData = Buffer.from(parsed.media.payload, 'base64');
      audioChunks.push(audioData);
    }

    // On stream end
    if (parsed.event === 'stop') {
      const filename = `./temp/${uuidv4()}.wav`;
      fs.writeFileSync(filename, Buffer.concat(audioChunks));
      console.log(`Saved audio to ${filename}`);

      // Step 1: Transcribe with Whisper
      const transcript = await transcribeAudio(filename);

      // Step 2: Get GPT response
      const gptResponse = await generateGPTResponse(transcript);

      // Step 3: Convert to speech with ElevenLabs
      const ttsAudio = await synthesizeSpeech(gptResponse);

      // Step 4: Send audio back to Twilio (Base64 encoded audio)
      ws.send(JSON.stringify({ event: 'media', media: { payload: ttsAudio.toString('base64') } }));

      // Cleanup
      fs.unlinkSync(filename);
      audioChunks = [];
    }
  });
});

async function transcribeAudio(filePath) {
  const response = await axios.post('https://api.openai.com/v1/audio/transcriptions',
    fs.createReadStream(filePath),
    {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'multipart/form-data'
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
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` }
  });
  return res.data.choices[0].message.content;
}

async function synthesizeSpeech(text) {
  const res = await axios({
    method: 'post',
    url: 'https://api.elevenlabs.io/v1/text-to-speech/YOUR_VOICE_ID',
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
app.get('/twilio', (req, res) => {
  res.set('Content-Type', 'text/xml');
  res.sendFile(__dirname + '/call.xml');
});
server.listen(3000, () => console.log('WebSocket server running on port 3000'));
