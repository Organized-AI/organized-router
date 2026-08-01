/**
 * Circuit breaker for the Tier 2 healer.
 * 3 consecutive transport failures opens a 30 second cooldown. One success clears the streak.
 */
export class HealerBreaker {
  private failures = 0;
  private openUntil = 0;
  constructor(private state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/success") { this.failures = 0; this.openUntil = 0; return new Response("ok"); }
    if (path === "/failure") {
      this.failures += 1;
      if (this.failures >= 3) this.openUntil = Date.now() + 30_000;
      return new Response("ok");
    }
    return Response.json({ open: Date.now() < this.openUntil, failures: this.failures });
  }
}
