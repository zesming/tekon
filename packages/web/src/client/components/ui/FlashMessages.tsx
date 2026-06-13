import { useFlash } from '../../context/flash-context.js';

export function FlashMessages() {
  const { messages, removeFlash } = useFlash();

  if (messages.length === 0) {
    return null;
  }

  return (
    <div className="flash-container">
      {messages.map((flash) => (
        <div key={flash.id} className={`flash-item ${flash.variant}`}>
          <span>{flash.message}</span>
          <button
            type="button"
            className="flash-dismiss"
            onClick={() => removeFlash(flash.id)}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
