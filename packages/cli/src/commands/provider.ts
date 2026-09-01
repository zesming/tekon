import { parseArgs } from 'node:util';

import {
  DSH_NODE_REQUIREMENT,
  dshInstallHint,
  DshCapabilityError,
  DshHostNodeError,
  DshVersionGateError,
  isHostNodeVersionCompatible,
  runDshPreflight as runCoreDshPreflight,
  TESTED_DSH_VERSION,
  type DshPreflightResult as CoreDshPreflightResult,
} from '@tekon/core';

import type { CliIO } from '../lib/context.js';

export type DshPreflightResult = Omit<CoreDshPreflightResult, 'actualVersion'> & {
  actualVersion: string | null;
  compatible: boolean;
  error?: string;
  failureKind?: 'host-node' | 'version' | 'contract' | 'not-installed';
};

export async function runDshPreflight(options?: {
  command?: string;
  allowVersion?: string;
  probeVersion?: (command: string) => Promise<string>;
  probeHelp?: (command: string) => Promise<string>;
  probeConfig?: (command: string) => Promise<string>;
  hostNodeVersion?: string;
  onWarn?: (message: string) => void;
}): Promise<DshPreflightResult> {
  const allowVersion =
    options?.allowVersion ?? process.env.TEKON_DSH_ALLOW_VERSION;

  try {
    const result = await runCoreDshPreflight(options?.command ?? 'dsh', {
      allowVersion,
      probeVersion: options?.probeVersion,
      probeHelp: options?.probeHelp,
      probeConfig: options?.probeConfig,
      hostNodeVersion: options?.hostNodeVersion,
      onWarn: options?.onWarn,
    });
    return {
      ...result,
      compatible: true,
    };
  } catch (error) {
    let failureKind: 'host-node' | 'version' | 'contract' | 'not-installed';
    let actualVersion: string | null = null;
    let hostNodeVersion = options?.hostNodeVersion ?? process.versions.node;

    if (error instanceof DshHostNodeError) {
      failureKind = 'host-node';
      hostNodeVersion = error.hostNodeVersion;
      actualVersion = null;
    } else if (error instanceof DshVersionGateError) {
      failureKind = 'version';
      actualVersion = error.actualVersion;
    } else if (error instanceof DshCapabilityError) {
      failureKind = 'contract';
      actualVersion = error.actualVersion ?? null;
    } else {
      failureKind = 'not-installed';
      actualVersion =
        error && typeof error === 'object' && 'actualVersion' in error
          ? ((error as { actualVersion: unknown }).actualVersion == null
              ? null
              : String((error as { actualVersion: unknown }).actualVersion))
          : null;
    }

    const isCompatible = isHostNodeVersionCompatible(hostNodeVersion);
    const allowHostNode = process.env.TEKON_DSH_ALLOW_HOST_NODE;
    const hostNodeBypassed =
      !isCompatible && allowHostNode === hostNodeVersion;
    const hostNodeCompatible =
      error instanceof DshHostNodeError
        ? false
        : isCompatible || hostNodeBypassed;

    return {
      testedVersion: TESTED_DSH_VERSION,
      actualVersion,
      nodeRequirement: DSH_NODE_REQUIREMENT,
      helpContractOk: false,
      configContractOk: false,
      installHint: dshInstallHint(),
      hostNodeVersion,
      hostNodeCompatible,
      hostNodeBypassed: error instanceof DshHostNodeError ? false : hostNodeBypassed,
      compatible: false,
      failureKind,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
        'host-node-version': { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });

    const hostNodeVersion = args.values['host-node-version'];
    if (hostNodeVersion && hostNodeVersion !== process.versions.node) {
      io.stderr.write(
        `[dsh bridge] 警告: 检测到 --host-node-version='${hostNodeVersion}' 诊断注入 (真实宿主 Node: ${process.versions.node})，该选项仅供测试与诊断使用，生产环境请升级 Node.js。\n`,
      );
    }

    const result = await runDshPreflight({
      command: args.values.command,
      allowVersion: args.values['allow-version'],
      hostNodeVersion,
      onWarn: (msg) => {
        io.stderr.write(`${msg}\n`);
      },
    });

    if (args.values.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.compatible ? 0 : 1;
    }

    const actualVersionDisplay =
      result.actualVersion ??
      (result.failureKind === 'host-node'
        ? '宿主 Node 不兼容'
        : '未安装或不可执行');

    const lines: string[] = [
      '🔍 DSH Headless Provider 预检',
      `  测试基准版本: ${result.testedVersion}`,
      `  当前检测版本: ${actualVersionDisplay}`,
      `  宿主 Node: ${result.hostNodeVersion} (${result.hostNodeCompatible ? (result.hostNodeBypassed ? '已旁路' : '兼容') : '不兼容'})`,
      `  DSH Node 要求: ${result.nodeRequirement}`,
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
