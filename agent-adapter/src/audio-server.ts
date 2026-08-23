import { WebSocket, WebSocketServer } from 'ws';

export interface VadOptions {
  sampleRate: number;
  speechThreshold: number;
  silenceMs: number;
  preRollMs: number;
}

export function rms16(chunk: Buffer): number {
  const samples = Math.floor(chunk.length / 2);
  if (samples === 0) return 0;

  let sum = 0;
  for (let offset = 0; offset + 1 < chunk.length; offset += 2) {
    const sample = chunk.readInt16LE(offset);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

export class VadSegmenter {
  private readonly silenceSamples: number;
  private readonly preRollSamplesLimit: number;
  private chunks: Buffer[] = [];
  private preRoll: Buffer[] = [];
  private preRollSamples = 0;
  private silentSamples = 0;
  private inSpeech = false;

  constructor(private readonly opts: VadOptions) {
    this.silenceSamples = Math.floor((opts.sampleRate * opts.silenceMs) / 1000);
    this.preRollSamplesLimit = Math.floor((opts.sampleRate * opts.preRollMs) / 1000);
  }

  push(chunk: Buffer): Buffer | null {
    const samples = Math.floor(chunk.length / 2);
    const speech = rms16(chunk) >= this.opts.speechThreshold;

    if (speech) {
      this.inSpeech = true;
      this.silentSamples = 0;
      this.flushPreRoll();
      this.chunks.push(chunk);
      return null;
    }

    if (!this.inSpeech) {
      this.keepPreRoll(chunk, samples);
      return null;
    }

    this.chunks.push(chunk);
    this.silentSamples += samples;
    if (this.silentSamples >= this.silenceSamples) {
      return this.finalize();
    }
    return null;
  }

  private keepPreRoll(chunk: Buffer, samples: number): void {
    this.preRoll.push(chunk);
    this.preRollSamples += samples;
    while (this.preRollSamples > this.preRollSamplesLimit && this.preRoll.length > 0) {
      const dropped = this.preRoll.shift()!;
      this.preRollSamples -= Math.floor(dropped.length / 2);
    }
  }

  private flushPreRoll(): void {
    this.chunks.push(...this.preRoll);
    this.preRoll = [];
    this.preRollSamples = 0;
  }

  private finalize(): Buffer {
    const utterance = Buffer.concat(this.chunks);
    this.chunks = [];
    this.inSpeech = false;
    this.silentSamples = 0;
    return utterance;
  }
}

export interface AudioServerOptions {
  port: number;
  vad: VadOptions;
  onUtterance: (pcm: Buffer, sampleRate: number) => void | Promise<void>;
}

export class AudioServer {
  private wss: WebSocketServer | null = null;

  constructor(private readonly opts: AudioServerOptions) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: '0.0.0.0', port: this.opts.port });
      const onError = (err: Error) => {
        wss.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        wss.off('error', onError);
        resolve();
      };

      wss.once('error', onError);
      wss.once('listening', onListening);
      wss.on('connection', (ws) => this.handleConnection(ws));
      this.wss = wss;
    });
  }

  close(): void {
    this.wss?.close();
    this.wss = null;
  }

  private handleConnection(ws: WebSocket): void {
    console.log('[audio] device connected');
    const vad = new VadSegmenter(this.opts.vad);
    ws.on('message', (data) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const utterance = vad.push(chunk);
      if (!utterance) return;

      const durationMs = Math.round(utterance.length / 2 / (this.opts.vad.sampleRate / 1000));
      console.log(`[audio] utterance finalized: ${utterance.length} bytes (~${durationMs}ms)`);
      void Promise.resolve(this.opts.onUtterance(utterance, this.opts.vad.sampleRate)).catch((err) => {
        console.error('[audio] failed to handle utterance:', err instanceof Error ? err.message : err);
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stop' }));
      }
    });
    ws.on('close', () => console.log('[audio] device disconnected'));
  }
}
