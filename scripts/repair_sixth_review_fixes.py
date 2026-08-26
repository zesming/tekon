from pathlib import Path

root = Path(__file__).resolve().parents[1]
patch_path = Path(__file__).with_name('apply_sixth_review_fixes.py')
text = patch_path.read_text(encoding='utf-8')

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
patch_path.write_text(text, encoding='utf-8')

routing_path = root / 'packages/web/__tests__/e2e/session-routing.test.ts'
routing = routing_path.read_text(encoding='utf-8')
old_heading = "page.getByRole('heading', { name: '会话 Sessions' })"
new_heading = "page.getByRole('heading', { name: '受控交付' })"
if routing.count(old_heading) != 1:
    raise RuntimeError(
        f'expected one stale routing heading assertion, found {routing.count(old_heading)}',
    )
routing_path.write_text(routing.replace(old_heading, new_heading, 1), encoding='utf-8')

print('Scoped canonical run Sessions and updated the routing UX assertion.')
