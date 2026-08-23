import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { SttClient, pcmToWav } from '../stt.js';

test('pcmToWav writes a valid 44-byte WAV header around the PCM payload', () => {
  const pcm = Buffer.alloc(32000);
  const wav = pcmToWav(pcm, 16000);

  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.length, 44 + pcm.length);
});

test('SttClient.transcribe POSTs wav and returns text', async () => {
  const { port, server } = await fakeSttServer('你好');
  const client = new SttClient();
  client.port = port;
  client.ready = true;

  try {
    const text = await client.transcribe(Buffer.alloc(3200), 16000);
    assert.equal(text, '你好');
  } finally {
    await closeServer(server);
  }
});

function fakeSttServer(text: string): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/transcribe') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const wav = Buffer.concat(chunks);
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve({ port: address.port, server });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}
