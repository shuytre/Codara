// 计数信号量：专家团并发限流（默认 2，可配）+ 全局排队
export class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get available(): number {
    return Math.max(0, this.limit - this.running);
  }

  get pending(): number {
    return this.queue.length;
  }

  async acquire(): Promise<() => void> {
    if (this.running < this.limit) {
      this.running++;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}
