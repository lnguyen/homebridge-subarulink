/**
 * Account-wide priority queue for MySubaru remote commands.
 *
 * Why: MySubaru handles one remote command at a time. When two arrive together
 * (e.g. a HomeKit automation that starts the engine and unlocks the doors),
 * the second gets `ServiceAlreadyStarted`, which subarulink answers by sleeping
 * 10 s and retrying, or it runs back to back with no breathing room.
 *
 * How it works:
 * - One command at a time. Each is sent only after the previous one has fully
 *   finished (including subarulink's completion polling), plus `minGapMs`.
 * - When the queue is idle, the first command waits `batchWindowMs` before it is
 *   sent, so commands fired together by one automation are all queued and can
 *   be ordered (HomeKit delivers them milliseconds apart in no fixed order).
 * - The next command is the waiting one with the highest priority; ties go in
 *   arrival order. Remote start uses a higher priority than unlock because
 *   remote start locks the car: start-then-unlock leaves the doors unlocked.
 *
 * The queue never drops work: duplicate suppression lives in IntentRunner, one
 * level up. A failed task does not block the tasks behind it.
 */
export interface CommandQueueOptions {
  /** Minimum time between one command finishing and the next being sent. */
  minGapMs: number;
  /** How long an idle queue waits for more commands before sending the first. */
  batchWindowMs?: number;
  /** Called when a command has to wait behind others. */
  onQueued?: (label: string, ahead: number) => void;
  /** Called when a higher-priority command is sent ahead of earlier ones. */
  onPrioritized?: (label: string, overtaken: string[]) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunOptions {
  /** Higher runs first among waiting commands. Default 0. */
  priority?: number;
}

interface Entry {
  label: string;
  priority: number;
  seq: number;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

export class CommandQueue {
  private waiting: Entry[] = [];
  private draining = false;
  private executing = false;
  private seq = 0;
  private lastFinishedAt = Number.NEGATIVE_INFINITY;
  private idle: Promise<void> = Promise.resolve();
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

  /** True while any command is running, waiting, or the queue is pausing between them. */
  public get busy(): boolean {
    return this.draining;
  }

  /** Number of commands running or waiting. */
  public get size(): number {
    return this.waiting.length + (this.executing ? 1 : 0);
  }

  /**
   * Adds a command to the queue. The returned promise settles with the task's
   * own result once it has run.
   */
  public run<T>(label: string, task: () => Promise<T>, runOptions: RunOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const ahead = this.size;
      this.waiting.push({
        label,
        priority: runOptions.priority ?? 0,
        seq: this.seq++,
        task,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      if (ahead > 0) {
        this.options.onQueued?.(label, ahead);
      }
      if (!this.draining) {
        this.draining = true;
        this.idle = this.drain();
      }
    });
  }

  /** Resolves when everything queued so far has finished. */
  public whenIdle(): Promise<void> {
    return this.idle;
  }

  private async drain(): Promise<void> {
    const batchWindowMs = this.options.batchWindowMs ?? 0;
    if (batchWindowMs > 0) {
      await this.sleep(batchWindowMs);
    }
    while (this.waiting.length > 0) {
      const wait = this.lastFinishedAt + this.options.minGapMs - this.now();
      if (wait > 0) {
        await this.sleep(wait);
      }
      // Choose only after the pause, so commands that arrived meanwhile can be ordered too.
      const entry = this.takeNext();
      this.executing = true;
      try {
        entry.resolve(await entry.task());
      } catch (err) {
        entry.reject(err);
      } finally {
        this.executing = false;
        this.lastFinishedAt = this.now();
      }
    }
    this.draining = false;
  }

  private takeNext(): Entry {
    let best = 0;
    for (let i = 1; i < this.waiting.length; i++) {
      const candidate = this.waiting[i];
      const current = this.waiting[best];
      if (
        candidate.priority > current.priority ||
        (candidate.priority === current.priority && candidate.seq < current.seq)
      ) {
        best = i;
      }
    }
    const [entry] = this.waiting.splice(best, 1);
    const overtaken = this.waiting.filter((e) => e.seq < entry.seq).map((e) => e.label);
    if (overtaken.length > 0) {
      this.options.onPrioritized?.(entry.label, overtaken);
    }
    return entry;
  }
}
