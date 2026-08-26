from pathlib import Path

path = Path(__file__).with_name('apply_sixth_review_fixes.py')
text = path.read_text(encoding='utf-8')

old_where = "                 where run_id = ?\\n                 order by created_at asc, rowid asc\\n"
new_where = "                 where run_id = ? and workspace_id = ?\\n                 order by created_at asc, rowid asc\\n"
if text.count(old_where) != 1:
    raise RuntimeError(f'expected one staged Session lookup, found {text.count(old_where)}')
text = text.replace(old_where, new_where, 1)

old_get = ".get(input.runId) as SessionRow | undefined;"
new_get = ".get(input.runId, input.workspaceId) as SessionRow | undefined;"
if text.count(old_get) != 1:
    raise RuntimeError(f'expected one staged Session get, found {text.count(old_get)}')
text = text.replace(old_get, new_get, 1)

path.write_text(text, encoding='utf-8')
print('Scoped canonical run Sessions to their Workspace.')
