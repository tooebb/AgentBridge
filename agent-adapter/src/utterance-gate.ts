export class UtteranceGate {
  private generation = 0;

  markNewRecording(): void {
    this.generation++;
  }

  snapshot(): number {
    return this.generation;
  }

  isCurrent(snapshot: number): boolean {
    return snapshot === this.generation;
  }
}
