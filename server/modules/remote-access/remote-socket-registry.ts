/** WebSocket close code sent when the remote browser session behind a socket is no longer valid. */
export const REMOTE_SESSION_ENDED_CLOSE_CODE = 4401;

type TrackedSocket = {
  close(code?: number, reason?: string): void;
  once(event: 'close', listener: () => void): unknown;
};

/**
 * Open sockets per remote browser session. Revoking a session closes its
 * sockets at once; a bounded periodic re-check also closes sockets whose
 * session expired while they stayed open. The timer only exists while at
 * least one remote socket is open and never keeps the process alive.
 */
export function createRemoteSocketRegistry(options: {
  isSessionActive(sessionId: string): boolean;
  revalidateIntervalMs?: number;
}) {
  const socketsBySession = new Map<string, Set<TrackedSocket>>();
  const intervalMs = options.revalidateIntervalMs ?? 60_000;
  let timer: NodeJS.Timeout | null = null;

  const closeSession = (sessionId: string) => {
    const sockets = socketsBySession.get(sessionId);
    socketsBySession.delete(sessionId);
    for (const socket of sockets ?? []) {
      socket.close(REMOTE_SESSION_ENDED_CLOSE_CODE, 'remote session ended');
    }
  };

  const stopTimerIfIdle = () => {
    if (socketsBySession.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const ensureTimer = () => {
    if (timer) {
      return;
    }
    timer = setInterval(() => {
      for (const sessionId of [...socketsBySession.keys()]) {
        if (!options.isSessionActive(sessionId)) {
          closeSession(sessionId);
        }
      }
      stopTimerIfIdle();
    }, intervalMs);
    timer.unref?.();
  };

  return {
    track(sessionId: string, socket: TrackedSocket): void {
      const sockets = socketsBySession.get(sessionId) ?? new Set<TrackedSocket>();
      sockets.add(socket);
      socketsBySession.set(sessionId, sockets);
      socket.once('close', () => {
        const current = socketsBySession.get(sessionId);
        current?.delete(socket);
        if (current && current.size === 0) {
          socketsBySession.delete(sessionId);
        }
        stopTimerIfIdle();
      });
      ensureTimer();
    },

    closeSessions(sessionIds: string[]): void {
      for (const sessionId of sessionIds) {
        closeSession(sessionId);
      }
      stopTimerIfIdle();
    },

    countOpenSockets(): number {
      let count = 0;
      for (const sockets of socketsBySession.values()) {
        count += sockets.size;
      }
      return count;
    },
  };
}
