import { spawn, type ChildProcess } from 'node:child_process';
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
  if (opts.python || opts.script) {
    return runPythonFallback(pcm, sampleRate, opts);
  }
  if (!sttClient) {
    sttClient = new SttClient();
    await sttClient.start();
  }
  return sttClient.transcribe(pcm, sampleRate);
}

export function closeStt(): void {
  sttClient?.close();
  sttClient = null;
}

export class SttClient {
  port = Number(process.env.AGENTBRIDGE_STT_PORT || 8790);
  ready = false;
  private child: ChildProcess | null = null;
  private fallback = false;

  async start(): Promise<void> {
    const python = process.env.AGENTBRIDGE_PYTHON || 'python';
    const script = process.env.AGENTBRIDGE_STT_SERVER || join(process.cwd(), 'stt', 'transcribe_server.py');
    try {
      this.child = spawn(python, [script], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', AGENTBRIDGE_STT_PORT: String(this.port) },
      });
      await this.waitReady();
      this.ready = true;
    } catch (err) {
      console.warn('[stt] persistent server failed, falling back to one-shot:', err instanceof Error ? err.message : err);
      this.close();
      this.fallback = true;
    }
  }

  private async waitReady(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`);
        if (res.ok) return;
      } catch {
        // Server is still loading the model.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`STT server not ready within ${timeoutMs}ms`);
  }

  async transcribe(pcm: Buffer, sampleRate: number): Promise<string> {
    if (this.fallback) return runPythonFallback(pcm, sampleRate);
    const wav = pcmToWav(pcm, sampleRate);
    const res = await fetch(`http://127.0.0.1:${this.port}/transcribe`, {
      method: 'POST',
      body: new Uint8Array(wav),
    });
    if (!res.ok) throw new Error(`STT server error ${res.status}: ${await res.text()}`);
    return (await res.text()).trim();
  }

  close(): void {
    this.child?.kill();
    this.child = null;
    this.ready = false;
  }
}

let sttClient: SttClient | null = null;

async function runPythonFallback(pcm: Buffer, sampleRate: number, opts: SttOptions = {}): Promise<string> {
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
    const child = spawn(python, [script, wavPath], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
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
