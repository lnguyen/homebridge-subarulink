/**
 * Runs remote vehicle commands in the background ("fire and forget") so HomeKit
 * write handlers can return immediately.
 *
 * Why: MySubaru commands take 5-30 s. When a HAP `onSet` handler awaits that
 * long, Homebridge logs "slow to respond" and the Home app queues repeat writes;
 * each repeat used to become another real command (e.g. three back-to-back
 * ALL_DOORS unlocks from one tap).
 *
 * Rules:
 * - Only one command runs at a time per runner.
 * - A request equal to the running command is a duplicate and is dropped.
 * - A different request while busy is queued; only the latest queued request
 *   is kept. A duplicate of the running command also drops anything queued,
 *   because it is the user's latest intent.
 * - `onSuccess` / `onFailure` run after the runner's state has advanced, so
 *   `busy` and `latest` already reflect what happens next.
 */
export type IntentOutcome = 'started' | 'queued' | 'duplicate';

export interface IntentRunnerOptions<T> {
  /** Performs the command. Must reject/throw when the command did not succeed. */
  execute: (intent: T) => Promise<void>;
  onSuccess: (intent: T) => void;
  onFailure: (intent: T, err: unknown) => void;
  /** Equality used for duplicate detection. Defaults to `===`. */
  isSame?: (a: T, b: T) => boolean;
  /** Called if an onSuccess/onFailure callback itself throws. */
  onCallbackError?: (err: unknown) => void;
}

export class IntentRunner<T> {
  private running = false;
  private inFlight: T | undefined;
  private hasPending = false;
  private pending: T | undefined;
  private idle: Promise<void> = Promise.resolve();
  private readonly isSame: (a: T, b: T) => boolean;

  constructor(private readonly options: IntentRunnerOptions<T>) {
    this.isSame = options.isSame ?? ((a, b) => a === b);
  }

  /** True while a command is running (or about to run from the queue). */
  public get busy(): boolean {
    return this.running;
  }

  /** The most recent intent that is running or queued; undefined when idle. */
  public get latest(): T | undefined {
    if (this.hasPending) {
      return this.pending;
    }
    return this.running ? this.inFlight : undefined;
  }

  /** Resolves once the runner has finished all running and queued work. */
  public whenIdle(): Promise<void> {
    return this.idle;
  }

  public request(intent: T): IntentOutcome {
    if (!this.running) {
      this.running = true;
      this.inFlight = intent;
      this.idle = this.drain();
      return 'started';
    }
    if (this.isSame(intent, this.inFlight as T)) {
      this.hasPending = false;
      this.pending = undefined;
      return 'duplicate';
    }
    if (this.hasPending && this.isSame(intent, this.pending as T)) {
      return 'duplicate';
    }
    this.hasPending = true;
    this.pending = intent;
    return 'queued';
  }

  private async drain(): Promise<void> {
    for (;;) {
      const current = this.inFlight as T;
      let error: unknown;
      let ok = true;
      try {
        await this.options.execute(current);
      } catch (err) {
        ok = false;
        error = err;
      }

      // Advance state before notifying, so callbacks see what comes next.
      if (this.hasPending) {
        this.inFlight = this.pending;
        this.hasPending = false;
        this.pending = undefined;
      } else {
        this.running = false;
        this.inFlight = undefined;
      }

      try {
        if (ok) {
          this.options.onSuccess(current);
        } else {
          this.options.onFailure(current, error);
        }
      } catch (cbErr) {
        this.options.onCallbackError?.(cbErr);
      }

      if (!this.running) {
        return;
      }
    }
  }
}
