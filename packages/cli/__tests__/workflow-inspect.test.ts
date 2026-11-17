import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliIO } from '../src/index.js';

// PD-07 / CD-20：workflow list 标记无效模板、show 节点化、validate 子命令、
// create --minimal 最小脚手架。
describe('workflow template inspection commands (PD-07/CD-20)', () => {
  const tempDirs: string[] = [];
  const anchorCwd = process.cwd();

  afterEach(() => {
    try {
      process.chdir(anchorCwd);
    } catch {
      /* keep cwd valid */
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function memoryIo(): CliIO & {
    takeStdout(): string;
    takeStderr(): string;
  } {
    const chunks: { stdout: string[]; stderr: string[] } = {
      stdout: [],
      stderr: [],
    };
    return {
      stdout: {
        write: (text: string) => {
          chunks.stdout.push(text);
          return true;
        },
      },
      stderr: {
        write: (text: string) => {
          chunks.stderr.push(text);
          return true;
        },
      },
      takeStdout: () => chunks.stdout.splice(0).join(''),
      takeStderr: () => chunks.stderr.splice(0).join(''),
    };
  }

  function repo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-wf-inspect-'));
    tempDirs.push(repoPath);
    execFileSync('git', ['init', '-b', 'main'], {
      cwd: repoPath,
      stdio: 'pipe',
    });
    execFileSync('git', ['config', 'user.email', 't@tekon.local'], {
      cwd: repoPath,
      stdio: 'pipe',
    });
    execFileSync('git', ['config', 'user.name', 'Tekon'], {
      cwd: repoPath,
      stdio: 'pipe',
    });
    return repoPath;
  }

  function writeTemplate(repoPath: string, name: string, content: string) {
    const dir = join(repoPath, '.tekon', 'workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.yaml`), content, 'utf8');
  }

  const minimalValid = `
id: tiny
name: Tiny
version: 1
phases:
  - id: dev
    name: Dev
    dependsOn: []
    nodes:
      - id: impl
        role: rd
        inputs: []
        outputs:
          - id: code
            type: code-changes
        gates:
          - type: human
        dependsOn: []
`;

  it('list marks a malformed project template as invalid without dropping valid ones', async () => {
    const repoPath = repo();
    writeTemplate(repoPath, 'good-tpl', minimalValid);
    writeTemplate(repoPath, 'bad-tpl', 'id: bad-tpl\nphases: nope\n');
    const io = memoryIo();
    const code = await runCli(['workflow', 'list', '--repo', repoPath], io);
    expect(code).toBe(0);
    const out = io.takeStdout();
    expect(out).toContain('good-tpl');
    expect(out).toContain('bad-tpl');
    // 有效项保持纯 ID（向后兼容），无效项带可读标记。
    expect(out).toMatch(/bad-tpl.*invalid/);
    expect(out).not.toMatch(/good-tpl.*invalid/);
  });

  it('show prints nodes with role, gates and outputs (not just id/name/phase count)', async () => {
    const repoPath = repo();
    writeTemplate(repoPath, 'shown-tpl', minimalValid);
    const io = memoryIo();
    const code = await runCli(
      ['workflow', 'show', 'shown-tpl', '--repo', repoPath],
      io,
    );
    expect(code).toBe(0);
    const out = io.takeStdout();
    expect(out).toContain('impl');
    expect(out).toContain('rd');
    expect(out).toContain('human');
    expect(out).toContain('code-changes');
  });

  it('validate exits 0 for a valid template and gives a next step for an invalid one', async () => {
    const repoPath = repo();
    writeTemplate(repoPath, 'ok-tpl', minimalValid);
    writeTemplate(repoPath, 'broken-tpl', 'id: broken-tpl\nphases: nope\n');

    const okIo = memoryIo();
    await expect(
      runCli(['workflow', 'validate', 'ok-tpl', '--repo', repoPath], okIo),
    ).resolves.toBe(0);
    expect(okIo.takeStdout()).toContain('ok-tpl');

    const badIo = memoryIo();
    const badCode = await runCli(
      ['workflow', 'validate', 'broken-tpl', '--repo', repoPath],
      badIo,
    );
    expect(badCode).toBe(1);
    // CD-20：错误要指路，而不是裸 zod JSON。
    const message = badIo.takeStderr() + badIo.takeStdout();
    expect(message).toContain('broken-tpl');
    expect(message).toContain('phases');
    expect(message).not.toContain('ZodError');
    expect(message).not.toContain('"code"');
  });

  it('parses flags placed before the positional name without mistaking the flag for a template name', async () => {
    const repoPath = repo();
    writeTemplate(repoPath, 'shown-tpl', minimalValid);

    // 标志位在位置参数之前：早期解构会把 '--repo' 当成模板名。
    const showIo = memoryIo();
    const showCode = await runCli(
      ['workflow', 'show', '--repo', repoPath, 'shown-tpl'],
      showIo,
    );
    expect(showCode).toBe(0);
    const showOut = showIo.takeStdout();
    // 文件名是 shown-tpl，模板内部 id 为 fixture 自带的 tiny。
    expect(showOut).toContain('id=tiny');
    expect(showOut).toContain('node impl role=rd');
    expect(showOut).not.toContain('--repo.yaml');

    const validateIo = memoryIo();
    await expect(
      runCli(
        ['workflow', 'validate', '--repo', repoPath, 'shown-tpl'],
        validateIo,
      ),
    ).resolves.toBe(0);

    // 无位置参数时 preflight 回落 standard-delivery，而不是把标志位当名称。
    const preflightIo = memoryIo();
    const preflightCode = await runCli(
      ['workflow', 'preflight', '--repo', repoPath],
      preflightIo,
    );
    expect(preflightCode).toBe(0);
    const preflightOut = preflightIo.takeStdout();
    expect(preflightOut).toContain('gate=');
    expect(preflightOut).not.toContain('--repo.yaml');
  });

  it('create --minimal scaffolds a small valid template that validate accepts', async () => {
    const repoPath = repo();
    // create 要求已初始化的 Tekon 仓库。
    const initIo = memoryIo();
    await runCli(['init', '--repo', repoPath], initIo);
    const io = memoryIo();
    const code = await runCli(
      ['workflow', 'create', 'lite-tpl', '--minimal', '--repo', repoPath],
      io,
    );
    expect(code).toBe(0);
    const createdPath = io.takeStdout().trim();
    expect(createdPath).toContain('lite-tpl.yaml');

    const check = memoryIo();
    await expect(
      runCli(['workflow', 'validate', 'lite-tpl', '--repo', repoPath], check),
    ).resolves.toBe(0);
    // 最小脚手架明显轻于 standard-delivery：单阶段、单节点。
    const scaffolded = readFileSync(createdPath, 'utf8');
    expect(scaffolded).toContain('id: lite-tpl');
    const nodeCount = (scaffolded.match(/^      - id: /gm) ?? []).length;
    expect(nodeCount).toBe(1);
    expect(existsSync(createdPath)).toBe(true);
  });

  it('CD-20: show and preflight report a broken template in readable Chinese instead of raw validator JSON', async () => {
    const repoPath = repo();
    writeTemplate(repoPath, 'broken-tpl', 'id: broken-tpl\nphases: nope\n');

    for (const subcommand of ['show', 'preflight'] as const) {
      const io = memoryIo();
      const code = await runCli(
        ['workflow', subcommand, 'broken-tpl', '--repo', repoPath],
        io,
      );
      expect(code).toBe(1);
      const message = io.takeStderr() + io.takeStdout();
      expect(message).toContain('broken-tpl');
      expect(message).toMatch(/类型错误|phases/u);
      expect(message).not.toContain('ZodError');
      expect(message).not.toContain('"code"');
      expect(message).not.toContain('"expected"');
    }
  });

  it('keeps the one-template-per-line contract even when YAML syntax errors contain newlines', async () => {
    const repoPath = repo();
    writeTemplate(
      repoPath,
      'yamlsyntax',
      'id: yamlsyntax\nphases:\n  - id: dev\n   nodes: []\n',
    );
    const io = memoryIo();
    const code = await runCli(['workflow', 'list', '--repo', repoPath], io);
    expect(code).toBe(0);
    const lines = io.takeStdout().trim().split('\n');
    // 每个模板严格占一行：错误里的换行与代码片段必须被折叠。
    for (const line of lines) {
      expect(line).toMatch(/^\S+ \[[^\n]+\]$/u);
    }
    const broken = lines.find((line) => line.startsWith('yamlsyntax'));
    expect(broken).toContain('invalid');
  });

  it('points to workflow list when validating an unknown template name without leaking install paths', async () => {
    const repoPath = repo();
    const io = memoryIo();
    const code = await runCli(
      ['workflow', 'validate', 'ghost-tpl', '--repo', repoPath],
      io,
    );
    expect(code).toBe(1);
    const message = io.takeStderr() + io.takeStdout();
    expect(message).toContain('ghost-tpl');
    expect(message).toMatch(/不存在/u);
    expect(message).toContain('workflow list');
    expect(message).not.toContain('ENOENT');
    expect(message).not.toContain(repoPath);
  });

  it('refuses to overwrite an existing template on create instead of silently replacing it', async () => {
    const repoPath = repo();
    const initIo = memoryIo();
    await runCli(['init', '--repo', repoPath], initIo);
    const first = memoryIo();
    await runCli(
      ['workflow', 'create', 'dup-tpl', '--minimal', '--repo', repoPath],
      first,
    );
    const second = memoryIo();
    const code = await runCli(
      ['workflow', 'create', 'dup-tpl', '--minimal', '--repo', repoPath],
      second,
    );
    expect(code).toBe(1);
    const message = second.takeStderr() + second.takeStdout();
    expect(message).toMatch(/已存在/u);
  });

  it('renders an inline node prompt in show output', async () => {
    const repoPath = repo();
    const withPrompt = minimalValid.replace(
      '        role: rd\n',
      '        role: rd\n        prompt: 先读 README 再动手\n',
    );
    writeTemplate(repoPath, 'prompt-tpl', withPrompt);
    const io = memoryIo();
    const code = await runCli(
      ['workflow', 'show', 'prompt-tpl', '--repo', repoPath],
      io,
    );
    expect(code).toBe(0);
    expect(io.takeStdout()).toContain('prompt=先读 README 再动手');
  });

  it('warns on stderr when --minimal and --from are combined because --from is ignored', async () => {
    const repoPath = repo();
    const initIo = memoryIo();
    await runCli(['init', '--repo', repoPath], initIo);
    const io = memoryIo();
    const code = await runCli(
      [
        'workflow',
        'create',
        'warn-tpl',
        '--minimal',
        '--from',
        'bugfix',
        '--repo',
        repoPath,
      ],
      io,
    );
    expect(code).toBe(0);
    expect(io.takeStderr()).toMatch(/--from/u);
  });

  it('reports a missing --from source in readable Chinese without ENOENT or install paths', async () => {
    const repoPath = repo();
    const initIo = memoryIo();
    await runCli(['init', '--repo', repoPath], initIo);
    const io = memoryIo();
    const code = await runCli(
      [
        'workflow',
        'create',
        'copied-tpl',
        '--from',
        'nope-tpl',
        '--repo',
        repoPath,
      ],
      io,
    );
    expect(code).toBe(1);
    const message = io.takeStderr() + io.takeStdout();
    expect(message).toContain('nope-tpl');
    expect(message).toMatch(/不存在/u);
    expect(message).toContain('workflow list');
    expect(message).not.toContain('ENOENT');
    // 失败不得留下目标文件或空目录副作用。
    expect(
      existsSync(join(repoPath, '.tekon', 'workflows', 'copied-tpl.yaml')),
    ).toBe(false);
  });

  it('rejects escaping symlinks on explicit validate and show without leaking outside contents', async () => {
    const repoPath = repo();
    const workflowsDir = join(repoPath, '.tekon', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    const outside = join(repoPath, 'secret.ini');
    writeFileSync(outside, 'SECRET_TOKEN: [unclosed\npw: hunter2\n');
    symlinkSync(outside, join(workflowsDir, 'escape.yaml'));

    for (const subcommand of ['validate', 'show'] as const) {
      const io = memoryIo();
      const code = await runCli(
        ['workflow', subcommand, 'escape', '--repo', repoPath],
        io,
      );
      expect(code).toBe(1);
      const message = io.takeStderr() + io.takeStdout();
      expect(message).toMatch(/超出模板目录|符号链接/u);
      // 统一 containment：显式命令也不得回显外部文件内容。
      expect(message).not.toContain('SECRET_TOKEN');
      expect(message).not.toContain('hunter2');
    }
  });

  it('reports a broken symlink on validate with precise link wording rather than generic not-found', async () => {
    const repoPath = repo();
    const workflowsDir = join(repoPath, '.tekon', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    symlinkSync(
      join(workflowsDir, 'gone.yaml'),
      join(workflowsDir, 'broken-link.yaml'),
    );

    const io = memoryIo();
    const code = await runCli(
      ['workflow', 'validate', 'broken-link', '--repo', repoPath],
      io,
    );
    expect(code).toBe(1);
    const message = io.takeStderr() + io.takeStdout();
    // 与 list 的断链诊断对齐，而不是笼统的「模板不存在」。
    expect(message).toMatch(/符号链接已断开/u);
    expect(message).not.toMatch(/模板 broken-link 不存在/u);
  });
});
