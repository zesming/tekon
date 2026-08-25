from pathlib import Path
import re

path = Path(__file__).with_name('apply_second_review_fixes.py')
text = path.read_text(encoding='utf-8')
pattern = re.compile(
    r'''insert_before_last\(\n    "packages/cli/__tests__/approval-terminal\.test\.ts",\n    "\}\);",\n    r'''\n  it\('M5: tekon pause on a cancelled run exits 1 and cannot revive the terminal status'.*?\n''',\n\)''',
    re.S,
)
match = pattern.search(text)
if not match:
    raise RuntimeError('approval-terminal insertion block not found')
block = match.group(0)
body_start = block.index("r'''\n") + len("r'''\n")
body_end = block.rindex("\n''',")
test_body = block[body_start:body_end]
replacement = '''replace_once(\n    "packages/cli/__tests__/approval-terminal.test.ts",\n    """});\\n\\nfunction createMemoryIo""",\n    r\'\'\'''' + test_body + '''});\n\nfunction createMemoryIo\n\'\'\',\n)'''
updated = text[:match.start()] + replacement + text[match.end():]
path.write_text(updated, encoding='utf-8')
print('Repaired approval-terminal test insertion in the staged review script.')
