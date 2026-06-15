import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import type { CliIO } from '../lib/context.js';
import { ensureInitialized } from '../lib/context.js';
import { resolveProjectRepoPath } from '../lib/path-utils.js';
import { resolveTekonRoot, silentExec } from '../lib/utils.js';

export async function commandUi(
  argv: string[],
  io: CliIO,
) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      port: { type: 'string' },
    },
    allowPositionals: true,
  });
  const port = args.values.port ?? '3000';
  if (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(
      `无效的端口号: ${port}。必须是 1 到 65535 之间的数字。`,
    );
  }

  const repoPath = resolveProjectRepoPath(args.values.repo);
  await ensureInitialized(repoPath, io);

  const tokenPath = join(repoPath, '.tekon', 'web-session.json');
  if (!existsSync(tokenPath)) {
    throw new Error(
      '未找到 web-session.json 文件，请先运行 "tekon init" 初始化项目',
    );
  }
  const { token } = JSON.parse(readFileSync(tokenPath, 'utf8')) as {
    token: string;
  };
  if (!token || typeof token !== 'string') {
    throw new Error(
      `${tokenPath} 中的 web-session.json 格式无效，请重新运行 "tekon init"`,
    );
  }

  const tekonRoot = resolveTekonRoot();
  const webDir = join(tekonRoot, 'packages', 'web');
  if (!existsSync(webDir)) {
    throw new Error(
      `未找到 web 包目录: ${webDir}。请确认 Tekon 安装是否完整。`,
    );
  }

  const tsxBin = join(webDir, 'node_modules', '.bin', 'tsx');
  if (!existsSync(tsxBin)) {
    io.stdout.write('Installing dependencies...\n');
    execFileSync(
      'npm',
      ['exec', '--yes', '--', 'pnpm@10.12.1', 'install', '--frozen-lockfile'],
      { cwd: tekonRoot, stdio: 'inherit' },
    );
    if (!existsSync(tsxBin)) {
      throw new Error(
        `安装后仍未找到 tsx: ${tsxBin}。请检查上方 pnpm install 的输出信息。`,
      );
    }
  }

  io.stdout.write(`repo=${repoPath}\n`);
  io.stdout.write(`url=http://localhost:${port}\n`);
  io.stdout.write(
    'Starting Tekon Web... Press Ctrl+C to stop\n',
  );

  const child = spawn(tsxBin, ['src/server/index.ts'], {
    cwd: webDir,
    env: {
      ...process.env,
      TEKON_PROJECT_ROOT: repoPath,
      PORT: port,
    },
    stdio: 'inherit',
    shell: false,
  });

  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(
          new Error(`Web 服务器异常退出，退出码: ${code}`),
        );
      }
    });
  });
}

export async function commandUpdate(
  _argv: string[],
  io: CliIO,
) {
  const tekonRoot = resolveTekonRoot();
  if (!existsSync(tekonRoot)) {
    throw new Error(
      'Tekon 未安装。请先运行安装脚本: curl -fsSL https://raw.githubusercontent.com/zesming/tekon/main/scripts/install.sh | bash',
    );
  }

  const currentPkg = JSON.parse(
    readFileSync(join(tekonRoot, 'package.json'), 'utf8'),
  ) as { version: string };
  const oldVersion = currentPkg.version;

  execFileSync('git', ['fetch', 'origin', 'main'], {
    cwd: tekonRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const remotePkgJson = execFileSync(
    'git',
    ['show', 'FETCH_HEAD:package.json'],
    { cwd: tekonRoot, encoding: 'utf8' },
  );
  const targetVersion = (
    JSON.parse(remotePkgJson) as { version: string }
  ).version;

  if (oldVersion === targetVersion) {
    io.stdout.write(`已是最新版本 (v${oldVersion})\n`);
    return;
  }

  io.stdout.write(
    `正在更新 v${oldVersion} → v${targetVersion}...\n`,
  );

  silentExec('git', ['checkout', 'main'], { cwd: tekonRoot });
  silentExec('git', ['pull', 'origin', 'main'], {
    cwd: tekonRoot,
  });
  silentExec(
    'npm',
    [
      'exec',
      '--yes',
      '--',
      'pnpm@10.12.1',
      'install',
      '--frozen-lockfile',
    ],
    { cwd: tekonRoot },
  );
  silentExec(
    'npm',
    ['exec', '--yes', '--', 'pnpm@10.12.1', 'build'],
    { cwd: tekonRoot },
  );

  const cliPath = join(
    tekonRoot,
    'packages',
    'cli',
    'dist',
    'index.js',
  );
  if (!existsSync(cliPath)) {
    throw new Error(
      `构建失败: 未找到 ${cliPath}。请检查构建输出。`,
    );
  }

  io.stdout.write(`已更新到 v${targetVersion}\n`);
}
