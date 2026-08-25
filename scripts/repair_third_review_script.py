from pathlib import Path

path = Path(__file__).with_name('apply_third_review_fixes.py')
text = path.read_text(encoding='utf-8')

helper_anchor = '''def regex_replace_once(path: str, pattern: str, replacement: str) -> None:\n'''
helper = '''def replace_first(path: str, old: str, new: str) -> None:\n    text = read(path)\n    if old not in text:\n        raise RuntimeError(f"{path}: expected at least one exact match")\n    write(path, text.replace(old, new, 1))\n\n\n'''
if helper not in text:
    if helper_anchor not in text:
        raise RuntimeError('helper insertion anchor not found')
    text = text.replace(helper_anchor, helper + helper_anchor, 1)

call_marker = '''replace_once(\n    "packages/core/src/workflow/rework.ts",\n    """    } catch (error) {\\n      await repositories.transitionNode(reworkNodeId, 'interrupted');\\n      await audit.append({\\n""",\n'''
replacement = call_marker.replace('replace_once(', 'replace_first(', 1)
if text.count(call_marker) != 1:
    raise RuntimeError(
        f'expected one ambiguous rework-agent catch patch call, found {text.count(call_marker)}',
    )
text = text.replace(call_marker, replacement, 1)

# The staged patch intentionally replaces direct ownership checks with a local
# helper, but a blind textual replacement would also rewrite the helper body
# itself into infinite recursion. Restore the generated helper immediately
# before gate-runner.ts is written.
write_marker = '''text = text.replace(\n    "isJobOwnershipLostAbort(deps.getSignal?.())",\n    "ownershipLost()",\n)\nwrite("packages/core/src/workflow/gate-runner.ts", text)\n'''
write_replacement = '''text = text.replace(\n    "isJobOwnershipLostAbort(deps.getSignal?.())",\n    "ownershipLost()",\n)\ntext = text.replace(\n    "const ownershipLost = (): boolean =>\\n    ownershipLost();",\n    "const ownershipLost = (): boolean =>\\n    isJobOwnershipLostAbort(deps.getSignal?.());",\n    1,\n)\nwrite("packages/core/src/workflow/gate-runner.ts", text)\n'''
if text.count(write_marker) != 1:
    raise RuntimeError(
        f'expected one gate-runner write marker, found {text.count(write_marker)}',
    )
text = text.replace(write_marker, write_replacement, 1)

path.write_text(text, encoding='utf-8')
print('Repaired staged patch selection and generated ownership helper.')
