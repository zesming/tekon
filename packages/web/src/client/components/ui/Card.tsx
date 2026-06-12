import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Card — surface container with optional header and right-side action
// ---------------------------------------------------------------------------

interface CardProps {
  title?: string;
  headerRight?: ReactNode;
  children: ReactNode;
  compact?: boolean;
  full?: boolean;
  className?: string;
}

export function Card({
  title,
  headerRight,
  children,
  compact = false,
  full = false,
  className = '',
}: CardProps) {
  return (
    <div className={`card${full ? ' full' : ''}${className ? ` ${className}` : ''}`}>
      {title !== undefined || headerRight !== undefined ? (
        <div className="card-header">
          {title !== undefined ? (
            <span className="card-title">{title}</span>
          ) : null}
          {headerRight}
        </div>
      ) : null}
      <div className={compact ? 'card-body compact' : 'card-body'}>
        {children}
      </div>
    </div>
  );
}
