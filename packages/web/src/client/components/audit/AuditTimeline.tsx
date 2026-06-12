import type { ApiAuditEvent } from '../../../shared/api-types.js';

// ---------------------------------------------------------------------------
// AuditTimeline — vertical timeline with chain dots and connecting lines
// ---------------------------------------------------------------------------

interface AuditTimelineProps {
  events: ApiAuditEvent[];
}

/** Format an ISO timestamp to a short time string like "14:32:18". */
function formatTime(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Format the payload into a compact string for display. */
function formatPayload(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}

export function AuditTimeline({ events }: AuditTimelineProps) {
  return (
    <div className="audit-list">
      {events.map((event) => (
        <div key={event.id} className="audit-item">
          <div className="audit-chain" />
          <div className="audit-type">{event.type}</div>
          <div className="audit-payload">{formatPayload(event.payload)}</div>
          <div className="audit-time">{formatTime(event.createdAt)}</div>
        </div>
      ))}
    </div>
  );
}
