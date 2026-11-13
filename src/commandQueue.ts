/**
 * Account-wide FIFO queue for MySubaru remote commands.
 *
 * Why: MySubaru handles one remote command at a time. When two arrive together
 * (e.g. a HomeKit automation that starts the engine and unlocks the doors),
 * the second gets `ServiceAlreadyStarted`, which subarulink answers by sleeping
 * 10 s and retrying, or it runs back to back with no breathing room. This queue
 * sends one command at a time, waits for it to fully finish (including
 * subarulink's completion polling), then waits `minGapMs` before the next.
 *
 * The queue never drops work: duplicate suppression lives in IntentRunner, one
 * level up. A failed task does not block the tasks behind it.
 */
export interface CommandQueueOptions {
  /** Minimum time between one command finishing and the next being sent. */
  minGapMs: number;
  /** Called when a command has to wait behind others. */
  onQueued?: (label: string, ahead: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class CommandQueue {
  private tail: Promise<void> = Promise.resolve();
  private outstanding = 0;
  private lastFinishedAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: CommandQueueOptions) {
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  /** True while any command is running, waiting out the gap, or queued. */
  public get busy(): boolean {
    return this.outstanding > 0;
  }

  /** Number of commands running or waiting. */
  public get size(): number {
    return this.outstanding;
  }

  public get minGapMs(): number {
    return this.options.minGapMs;
  }

  /**
   * Adds a command to the queue. The returned promise settles with the task's
   * own result once it has run.
   */
  public run<T>(label: string, task: () => Promise<T>): Promise<T> {
    const ahead = this.outstanding;
    this.outstanding++;
    if (ahead > 0) {
      this.options.onQueued?.(label, ahead);
    }

    const result = this.tail.then(async () => {
      const wait = this.lastFinishedAt + this.options.minGapMs - this.now();
      if (wait > 0) {
        await this.sleep(wait);
      }
      try {
        return await task();
      } finally {
        this.lastFinishedAt = this.now();
        this.outstanding--;
      }
    });

    // Keep the chain alive regardless of this task's outcome.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Resolves when everything queued so far has finished. */
  public whenIdle(): Promise<void> {
    return this.tail;
  }
}
