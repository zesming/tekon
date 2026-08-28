import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { StatusBadge } from '../../src/client/components/ui/StatusBadge.js';

function render(status: string): string {
  return renderToStaticMarkup(StatusBadge({ status, size: 'sm' }));
}

describe('StatusBadge', () => {
  it('renders active sessions as in progress rather than cancelled', () => {
    const html = render('active');
    expect(html).toContain('badge-running');
    expect(html).toContain('进行中');
    expect(html).not.toContain('badge-cancelled');
  });

  it('renders completed sessions as successful', () => {
    const html = render('done');
    expect(html).toContain('badge-passed');
    expect(html).toContain('已完成');
  });

  it('keeps unknown plugin statuses neutral instead of inventing cancellation', () => {
    const html = render('plugin/waiting');
    expect(html).toContain('badge-skipped');
    expect(html).toContain('plugin/waiting');
    expect(html).not.toContain('badge-cancelled');
  });
});
