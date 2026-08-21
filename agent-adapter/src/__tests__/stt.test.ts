import test from 'node:test';
import assert from 'node:assert/strict';
import { pcmToWav } from '../stt.js';

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
