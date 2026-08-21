import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SttOptions {
  python?: string;
  script?: string;
}

export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function transcribe(pcm: Buffer, sampleRate: number, opts: SttOptions = {}): Promise<string> {
  const python = opts.python || process.env.AGENTBRIDGE_PYTHON || 'python';
  const script = opts.script || process.env.AGENTBRIDGE_STT_SCRIPT || join(process.cwd(), 'stt', 'transcribe.py');
  const dir = mkdtempSync(join(tmpdir(), 'agentbridge-stt-'));
  const wavPath = join(dir, 'utterance.wav');
  try {
    writeFileSync(wavPath, pcmToWav(pcm, sampleRate));
    return await runPython(python, script, wavPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runPython(python: string, script: string, wavPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, wavPath]);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(`STT failed (${code}): ${stderr || stdout}`));
    });
  });
}
