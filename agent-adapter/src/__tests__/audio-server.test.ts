import test from 'node:test';
import assert from 'node:assert/strict';
import { VadSegmenter, rms16 } from '../audio-server.js';

function sine(sampleRate: number, seconds: number, amplitude: number): Buffer {
  const samples = Math.floor(sampleRate * seconds);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
    buf.writeInt16LE(value, i * 2);
  }
  return buf;
}

test('rms16 measures amplitude of a sine wave', () => {
  const loud = sine(16000, 0.5, 1000);
  const quiet = Buffer.alloc(loud.length);
  assert.ok(rms16(loud) > 500);
  assert.equal(rms16(quiet), 0);
});

test('VadSegmenter emits an utterance after speech followed by silence', () => {
  const vad = new VadSegmenter({ sampleRate: 16000, speechThreshold: 100, silenceMs: 500, preRollMs: 200 });
  const speech = sine(16000, 0.5, 1000);
  const silence = Buffer.alloc(16000 * 2);

  assert.equal(vad.push(speech), null);
  const utterance = vad.push(silence);
  assert.ok(utterance);
  assert.ok(utterance.length >= speech.length);
});

test('VadSegmenter ignores pre-speech silence shorter than preRollMs', () => {
  const vad = new VadSegmenter({ sampleRate: 16000, speechThreshold: 100, silenceMs: 500, preRollMs: 100 });
  const shortSilence = Buffer.alloc(1600 * 2);
  assert.equal(vad.push(shortSilence), null);
});
