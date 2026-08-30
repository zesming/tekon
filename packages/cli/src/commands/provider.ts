import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

import * as coreModule from '@tekon/core';
import {
  assertDshDefaultConfigContract,
  assertDshHeadlessHelpContract,
  assertDshVersionAllowed,
  parseDshVersion,
  TESTED_DSH_VERSION,
} from '@tekon/core';

import type { CliIO } from '../lib/context.js';

const execFileAsync = promisify(execFile);

export interface DshPreflightResult {
  testedVersion: string;
  actualVersion: string | null;
  helpContractOk: boolean;
  configContractOk: boolean;
  installHint: string;
  compatible: boolean;
  error?: string;
}

export async function runDshPreflight(options?: {
  command?: string;
  allowVersion?: string;
  probeVersion?: (command: string) => Promise<string>;
  probeHelp?: (command: string) => Promise<string>;
  probeConfig?: (command: string) => Promise<string>;
}): Promise<DshPreflightResult> {
  const corePreflight = (coreModule as Record<string, unknown>).runDshPreflight;
  if (typeof corePreflight === 'function' && !options?.probeVersion) {
    try {
      const res = (await corePreflight(options?.command)) as {
        testedVersion: string;
        actualVersion: string;
        helpContractOk: boolean;
        configContractOk: boolean;
        installHint?: string;
      };
      const testedVersion = res.testedVersion ?? TESTED_DSH_VERSION;
      const actualVersion = res.actualVersion ?? null;
      const helpContractOk = Boolean(res.helpContractOk);
      const configContractOk = Boolean(res.configContractOk);
      const installHint =
        res.installHint ?? `npm install -g @deepseek-ai/dsh@${testedVersion}`;
      const allowVersion =
        options?.allowVersion ?? process.env.TEKON_DSH_ALLOW_VERSION;
      const versionOk =
        actualVersion !== null &&
        (actualVersion === testedVersion || allowVersion === actualVersion);
      const compatible = versionOk && helpContractOk && configContractOk;
      return {
        testedVersion,
        actualVersion,
        helpContractOk,
        configContractOk,
        installHint,
        compatible,
      };
    } catch (err) {
      const testedVersion = TESTED_DSH_VERSION;
      const installHint = `npm install -g @deepseek-ai/dsh@${testedVersion}`;
      const actualVersion =
        err && typeof err === 'object' && 'actualVersion' in err
          ? String((err as { actualVersion: unknown }).actualVersion)
          : null;
      return {
        testedVersion,
        actualVersion,
        helpContractOk: false,
        configContractOk: false,
        installHint,
        compatible: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Fallback probe logic adhering to design §4-B contract
  const dshCommand = options?.command ?? 'dsh';
  const testedVersion = TESTED_DSH_VERSION;
  const installHint = `npm install -g @deepseek-ai/dsh@${testedVersion}`;
  const allowVersion =
    options?.allowVersion ?? process.env.TEKON_DSH_ALLOW_VERSION;

  let actualVersion: string | null = null;
  let helpContractOk = false;
  let configContractOk = false;
  let errorMsg: string | undefined;

  try {
    const rawVersion = options?.probeVersion
      ? await options.probeVersion(dshCommand)
      : (await execFileAsync(dshCommand, ['--version'], { timeout: 15_000 }))
          .stdout;
    actualVersion = parseDshVersion(rawVersion);
    assertDshVersionAllowed(actualVersion, { allowVersion });
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
    const parsedVersion =
      err && typeof err === 'object' && 'actualVersion' in err
        ? String((err as { actualVersion: unknown }).actualVersion)
        : actualVersion;
    return {
      testedVersion,
      actualVersion: parsedVersion,
      helpContractOk: false,
      configContractOk: false,
      installHint,
      compatible: false,
      error: errorMsg,
    };
  }

  try {
    const rawHelp = options?.probeHelp
      ? await options.probeHelp(dshCommand)
      : (
          await execFileAsync(
            dshCommand,
            ['--profile', 'headless', '--help'],
            { timeout: 15_000 },
          )
        ).stdout;
    assertDshHeadlessHelpContract(rawHelp);
    helpContractOk = true;
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  try {
    const rawConfig = options?.probeConfig
      ? await options.probeConfig(dshCommand)
      : (
          await execFileAsync(
            dshCommand,
            ['--profile', 'headless', '--dump-default-config'],
            { timeout: 15_000 },
          )
        ).stdout;
    assertDshDefaultConfigContract(rawConfig);
    configContractOk = true;
  } catch (err) {
    if (!errorMsg) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }
  }

  const compatible =
    actualVersion !== null &&
    (actualVersion === testedVersion || allowVersion === actualVersion) &&
    helpContractOk &&
    configContractOk;

  return {
    testedVersion,
    actualVersion,
    helpContractOk,
    configContractOk,
    installHint,
    compatible,
    ...(errorMsg ? { error: errorMsg } : {}),
  };
}

export async function commandProvider(
  argv: string[],
  io: CliIO,
): Promise<number> {
  const [subcommand, providerName, ...rest] = argv;

  if (!subcommand) {
    io.stderr.write('请指定子命令，例如：tekon provider preflight dsh-headless\n');
    io.stderr.write('使用 tekon help provider 查看用法。\n');
    return 1;
  }

  if (subcommand === 'preflight') {
    if (!providerName) {
      io.stderr.write('请指定 Provider 名称，例如：tekon provider preflight dsh-headless\n');
      return 1;
    }

    if (providerName !== 'dsh-headless') {
      io.stderr.write(
        `暂不支持对 Provider '${providerName}' 进行预检，当前仅支持 dsh-headless\n`,
      );
      return 1;
    }

    const args = parseArgs({
      args: rest,
      options: {
        command: { type: 'string' },
        'allow-version': { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });

    const result = await runDshPreflight({
      command: args.values.command,
      allowVersion: args.values['allow-version'],
    });

    if (args.values.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.compatible ? 0 : 1;
    }

    const lines: string[] = [
      '🔍 DSH Headless Provider 预检',
      `  测试基准版本: ${result.testedVersion}`,
      `  当前检测版本: ${result.actualVersion ?? '未安装或不可执行'}`,
      `  Help 合同检查: ${result.helpContractOk ? '通过' : '未通过'}`,
      `  Config 合同检查: ${result.configContractOk ? '通过' : '未通过'}`,
      `  安装指引: ${result.installHint}`,
      `  兼容性结论: ${result.compatible ? '兼容' : '不兼容'}`,
    ];

    if (!result.compatible && result.error) {
      lines.push(`  详情: ${result.error}`);
    }

    io.stdout.write(lines.join('\n') + '\n');
    return result.compatible ? 0 : 1;
  }

  io.stderr.write(`未知的 provider 子命令: ${subcommand}\n`);
  io.stderr.write('使用 tekon help provider 查看用法。\n');
  return 1;
}
