/**
 * Pure state machine behind the composer's "Steer Now" button (FT-M06).
 *
 * Steer interrupts real in-flight work, so it needs a confirmation — but a
 * modal would be too heavy for an action meant to feel immediate. Instead,
 * the first tap arms the button (distinct label/icon, no network call yet);
 * a second tap while armed is the confirmation and actually sends. A tap
 * while `sending` is ignored, which doubles as the double-tap guard the
 * button itself needs.
 */
export type SteerConfirmationState = 'idle' | 'armed' | 'sending' | 'error';

export type SteerConfirmationAction =
  | { type: 'tap' }
  | { type: 'armTimeout' }
  | { type: 'sendSettled'; ok: boolean }
  | { type: 'reset' };

export function reduceSteerConfirmation(
  state: SteerConfirmationState,
  action: SteerConfirmationAction,
): SteerConfirmationState {
  switch (action.type) {
    case 'tap':
      if (state === 'idle' || state === 'error') {
        return 'armed';
      }
      if (state === 'armed') {
        // The confirming tap — this is what actually triggers the send.
        return 'sending';
      }
      // Already sending: ignored, not queued or retried.
      return state;

    case 'armTimeout':
      // A timeout that fires after the user already confirmed (or after a
      // stale timer from a previous arm) must not interrupt a real send.
      return state === 'armed' ? 'idle' : state;

    case 'sendSettled':
      return action.ok ? 'idle' : 'error';

    case 'reset':
      return 'idle';

    default:
      return state;
  }
}

/** Whether this tap is the confirming one that should actually dispatch Steer. */
export function isConfirmingSteerTap(state: SteerConfirmationState): boolean {
  return state === 'armed';
}
