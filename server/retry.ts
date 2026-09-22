/**
 * A turn the API dropped, put back on by itself.
 *
 * An overloaded model is not a decision anyone made — it is weather. The
 * old behaviour was to end the turn, print the CLI's apology, and wait
 * for the user to come back and type "continue", which could be hours
 * after the outage cleared. So ruri types it: a short wait, a nudge down
 * the same session (which still holds the whole conversation), and the
 * work carries on from where it stopped.
 *
 * Three tries over about a minute and a half. That is the shape of a
 * blip; past it, the API is not having a moment, it is having an outage,
 * and a person should hear about that rather than a loop keep paying to
 * find out. Anything the user does — a prompt, a stop — cancels the wait,
 * because they are now driving.
 */
export const RETRY_WAITS_MS = [8_000, 25_000, 60_000];
export const RETRY_NUDGE =
  "[ruri] The API dropped the last turn — an overload or a network error on the way, nothing you did, and nothing the user asked to change. Pick up exactly where you left off and carry on. Don't restate the plan or apologise; just continue the work.";

export interface RetryState {
  attempt: number;
  /** Calls off the wait: its timer, or its watch on the connection. */
  cancel: () => void;
}

export class Retries {
  private readonly pending = new Map<string, RetryState>();

  has = (channelId: string): boolean => this.pending.has(channelId);

  get = (channelId: string): RetryState | undefined => this.pending.get(channelId);

  set = (channelId: string, state: RetryState): void => {
    this.pending.set(channelId, state);
  };

  /** The wait is over (it fired, or the send failed): nothing is pending. */
  delete = (channelId: string): void => {
    this.pending.delete(channelId);
  };

  /** The user took the wheel — whatever was going to be tried again isn't. */
  cancelRetry = (channelId: string): void => {
    const pending = this.pending.get(channelId);
    if (!pending) return;
    pending.cancel();
    this.pending.delete(channelId);
  };

  forgetChannel(channelId: string): void {
    this.cancelRetry(channelId);
  }
}
