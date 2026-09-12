import type { SessionLineage } from '../types/types';

type SessionLineageLinkProps = {
  lineage: SessionLineage | null;
  onNavigateToSession: (sessionId: string) => void;
  className?: string;
};

/**
 * Compact provenance for the chat header subtitle: "↪ <source>" on a handoff
 * target, "→ <latest target>" on a session that was continued elsewhere. Text
 * and arrow carry the meaning; the full sentence is in `title`/`aria-label`.
 */
export default function SessionLineageLink({ lineage, onNavigateToSession, className }: SessionLineageLinkProps) {
  const incoming = lineage?.incoming ?? null;
  const latestOutgoing = lineage?.outgoing.length ? lineage.outgoing[lineage.outgoing.length - 1] : null;

  if (incoming) {
    const sourceTitle = incoming.sourceTitle || 'previous run';
    const description = `Continued from “${sourceTitle}”`;
    if (!incoming.sourceExists) {
      return <span className={className} title={`${description} (deleted)`}>↪ {sourceTitle}</span>;
    }
    return (
      <button
        type="button"
        className={className}
        title={description}
        aria-label={description}
        onClick={() => onNavigateToSession(incoming.sourceSessionId)}
      >
        ↪ {sourceTitle}
      </button>
    );
  }

  if (latestOutgoing && lineage) {
    const targetTitle = latestOutgoing.targetTitle || 'new run';
    const extraCount = lineage.outgoing.length - 1;
    const description = `Continued in “${targetTitle}”${extraCount > 0 ? ` and ${extraCount} other run${extraCount > 1 ? 's' : ''}` : ''}`;
    return (
      <button
        type="button"
        className={className}
        title={description}
        aria-label={description}
        onClick={() => onNavigateToSession(latestOutgoing.targetSessionId)}
      >
        → {targetTitle}{extraCount > 0 ? ` +${extraCount}` : ''}
      </button>
    );
  }

  return null;
}
