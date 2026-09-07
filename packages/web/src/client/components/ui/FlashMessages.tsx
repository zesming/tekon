import { useFlash } from '../../context/flash-context.js';

export function FlashMessages() {
  const { messages, removeFlash } = useFlash();
  return (
    <div className="flash-container">
      {(['status', 'alert'] as const).map(role => (
        <div key={role} role={role} aria-relevant="additions" aria-atomic="false">
          {messages.filter(message => (message.variant === 'error') === (role === 'alert')).map(flash => (
            <div key={flash.id} className={`flash-item ${flash.variant}`}>
              <span>{flash.message}</span>
              <button type="button" className="flash-dismiss" onClick={() => removeFlash(flash.id)} aria-label="关闭通知">✕</button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
