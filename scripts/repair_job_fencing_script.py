from pathlib import Path

path = Path(__file__).with_name('apply_job_fencing_fix.py')
text = path.read_text(encoding='utf-8')
old = '''text = read("packages/core/src/workflow/node-executor.ts")
remaining = text.count("if (deps.signal?.aborted) {")
if remaining != 2:
    raise RuntimeError(
        f"node-executor: expected two remaining abort branches, found {remaining}",
    )
write(
    "packages/core/src/workflow/node-executor.ts",
    text.replace(
        "if (deps.signal?.aborted) {",
        "if (isJobCancellationAbort(deps.signal)) {",
    ),
)
'''
new = '''text = read("packages/core/src/workflow/node-executor.ts")
needle = "if (deps.signal?.aborted) {"
parts = text.split(needle)
if len(parts) != 4:
    raise RuntimeError(
        f"node-executor: expected three abort branches after pre-start rewrite, found {len(parts) - 1}",
    )
# The first branch must react to both cancellation and ownership-loss aborts;
# only the finally/catch branches decide whether the workflow becomes cancelled.
text = (
    parts[0]
    + needle
    + parts[1]
    + "if (isJobCancellationAbort(deps.signal)) {"
    + parts[2]
    + "if (isJobCancellationAbort(deps.signal)) {"
    + parts[3]
)
write("packages/core/src/workflow/node-executor.ts", text)
'''
if text.count(old) != 1:
    raise RuntimeError(f'expected one node-executor replacement block, found {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
print('Repaired node-executor abort branch selection in staged fencing patch.')
