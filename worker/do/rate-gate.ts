import { DurableObject } from "cloudflare:workers";

export class RateGateDO extends DurableObject {
  async allow(limit: number, windowSeconds: number): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const state = (await this.ctx.storage.get<{ count: number; windowStart: number }>("bucket"))
      ?? { count: 0, windowStart: now };

    if (now - state.windowStart >= windowSeconds) {
      await this.ctx.storage.put("bucket", { count: 1, windowStart: now });
      return true;
    }
    if (state.count >= limit) return false;

    await this.ctx.storage.put("bucket", { count: state.count + 1, windowStart: state.windowStart });
    return true;
  }
}
