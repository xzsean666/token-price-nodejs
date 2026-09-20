export interface TaskQueueOptions {
  /**
   * Maximum number of concurrent async tasks.
   * Default: 3
   */
  readonly concurrency?: number | undefined;
}

interface QueuedItem {
  readonly execute: () => void;
  readonly reject: (err: any) => void;
}

/**
 * Global concurrency-limiting task queue with in-flight singleflight deduplication.
 * Prevents redundant archive downloads and REST API floods.
 */
export class TaskQueue {
  private readonly concurrency: number;
  private running = 0;
  private readonly queue: QueuedItem[] = [];
  private readonly inFlight = new Map<string, Promise<any>>();

  constructor(options: TaskQueueOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 3);
  }

  get activeCount(): number {
    return this.running;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get inFlightKeys(): readonly string[] {
    return [...this.inFlight.keys()];
  }

  /**
   * Enqueues an async task with concurrency control.
   * If a non-empty `key` is provided and an identical task is already running or queued,
   * reuses the existing in-flight Promise (singleflight coalescing).
   */
  async enqueue<T>(key: string | null | undefined, task: () => Promise<T>): Promise<T> {
    if (key) {
      const existing = this.inFlight.get(key);
      if (existing) {
        return existing as Promise<T>;
      }
    }

    const promise = this.schedule(task);

    if (key) {
      this.inFlight.set(key, promise);
      promise
        .finally(() => {
          if (this.inFlight.get(key) === promise) {
            this.inFlight.delete(key);
          }
        })
        .catch(() => {});
    }

    return promise;
  }

  private schedule<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const execute = async () => {
        this.running++;
        try {
          const result = await task();
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          this.running--;
          this.dequeue();
        }
      };

      if (this.running < this.concurrency) {
        execute();
      } else {
        this.queue.push({ execute, reject });
      }
    });
  }

  private dequeue(): void {
    if (this.running < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        next.execute();
      }
    }
  }

  /**
   * Clears pending queued tasks and rejects their pending promises (does not cancel active running tasks).
   */
  clear(reason?: any): void {
    const err = reason ?? new Error("TaskQueue cleared: pending task was aborted.");
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) {
        try {
          item.reject(err);
        } catch {}
      }
    }
    this.inFlight.clear();
  }
}

/**
 * Global singleton task queue shared across client operations.
 */
export const globalTaskQueue = new TaskQueue({ concurrency: 3 });
