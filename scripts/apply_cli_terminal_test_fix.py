from pathlib import Path

path = Path('packages/cli/__tests__/run-cli.test.ts')
text = path.read_text(encoding='utf-8')
old = '''    await expect(
      runCli(['pause', '--run-id', gatedRunId!, '--repo', repoPath], io),
    ).resolves.toBe(0);
    expect(io.takeStdout()).toContain('status=paused');

    await expect(
      runCli(['cancel', '--run-id', gatedRunId!, '--repo', repoPath], io),
    ).resolves.toBe(0);
    expect(io.takeStdout()).toContain('status=cancelled');
'''
new = '''    // The human-approved run is already passed. Terminal status is monotonic:
    // pause must fail instead of reviving it as paused.
    await expect(
      runCli(['pause', '--run-id', gatedRunId!, '--repo', repoPath], io),
    ).resolves.toBe(1);
    expect(io.takeStderr()).toContain('终态');

    // Cancel is idempotent against a different terminal outcome and reports
    // the authoritative status without mutating the passed workflow.
    await expect(
      runCli(['cancel', '--run-id', gatedRunId!, '--repo', repoPath], io),
    ).resolves.toBe(0);
    expect(io.takeStdout()).toContain('status=passed');
'''
if text.count(old) != 1:
    raise RuntimeError(f'expected one stale pause/cancel assertion block, found {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
print('Updated full CLI surface test for monotonic terminal states.')
