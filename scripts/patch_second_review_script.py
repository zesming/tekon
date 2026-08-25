from pathlib import Path

path = Path(__file__).with_name('apply_second_review_fixes.py')
text = path.read_text(encoding='utf-8')
start_marker = '''insert_before_last(
    "packages/cli/__tests__/approval-terminal.test.ts",'''
next_operation = '''
regex_replace_once(
    "packages/cli/src/commands/approval.ts",'''
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
path.write_text(text[:start] + replacement + text[end:], encoding='utf-8')
print('Repaired approval-terminal test insertion in the staged review script.')
