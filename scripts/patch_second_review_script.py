from pathlib import Path

path = Path(__file__).with_name('apply_second_review_fixes.py')
text = path.read_text(encoding='utf-8')
start_marker = '''insert_before_last(
    "packages/cli/__tests__/approval-terminal.test.ts",'''
next_operation = '''replace_once(
    "packages/cli/__tests__/e2e/cli-flow.test.ts",'''
start = text.index(start_marker)
end = text.index(next_operation, start)
replacement = """replace_once(
    \"packages/cli/__tests__/approval-terminal.test.ts\",
    \"});\\n\\nfunction createMemoryIo\",
    r'''  it('M5: tekon pause on a cancelled run exits 1 and cannot revive the terminal status', async () => {
    const { repoPath, runId } = await createCancelledRunWithPendingDecision();
    const io = createMemoryIo();

    await expect(
      runCli(['pause', '--run-id', runId, '--repo', repoPath], io),
    ).resolves.toBe(1);
    expect(io.takeStderr()).toContain('终态');

    const db = openTekonDatabase({
      filename: join(repoPath, '.tekon', 'tekon.sqlite'),
    });
    expect(await createRepositories(db).getWorkflowInstance(runId)).toMatchObject({
      status: 'cancelled',
    });
    db.close();
  });
});

function createMemoryIo''',
)

"""
text = text[:start] + replacement + text[end:]
old = """      if (['passed', 'failed', 'cancelled'].includes(status)) {\\n        throw new WorkflowTerminalError(runId, status);\\n      }"""
new = """      if (\\n        status === 'passed' ||\\n        status === 'failed' ||\\n        status === 'cancelled'\\n      ) {\\n        throw new WorkflowTerminalError(runId, status);\\n      }"""
if text.count(old) != 1:
    raise RuntimeError(f'expected one terminal-status expression, found {text.count(old)}')
text = text.replace(old, new, 1)
path.write_text(text, encoding='utf-8')
print('Repaired staged review script and explicit terminal status narrowing.')
