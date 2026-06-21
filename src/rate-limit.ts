export class CooldownBucket {
  private readonly lastSeen = new Map<string, number>();

  constructor(private readonly cooldownMs: number) {}

  take(key: string, now = Date.now()): number {
    if (this.cooldownMs === 0) return 0;
    const last = this.lastSeen.get(key) ?? 0;
    const remaining = last + this.cooldownMs - now;
    if (remaining > 0) return remaining;
    this.lastSeen.set(key, now);
    this.cleanup(now);
    return 0;
  }

  private cleanup(now: number): void {
    if (this.lastSeen.size < 1000) return;
    for (const [key, value] of this.lastSeen) {
      if (now - value > this.cooldownMs * 4) this.lastSeen.delete(key);
    }
  }
}

export function formatRemaining(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${seconds}s`;
}
