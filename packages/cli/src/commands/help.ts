import type { CliIO } from '../lib/context.js';
import { getVersion } from '../lib/utils.js';

interface CommandMeta {
  name: string;
  aliases?: string[];
  description: string;
  group: string;
  subcommands?: Array<{ name: string; description: string }>;
  usage?: string;
}

export async function commandHelp(
  argv: string[],
  io: CliIO,
  commands: CommandMeta[],
): Promise<number> {
  const [subcommand] = argv;

  if (subcommand === '--help') {
    io.stdout.write(
      'tekon help — 显示所有可用命令及其简要说明\n\n',
    );
    io.stdout.write('用法: tekon help [command]\n\n');
    io.stdout.write('不指定命令时，显示所有一级命令及分组。\n');
    io.stdout.write(
      '指定命令时，显示该命令的子命令和用法。\n',
    );
    return 0;
  }

  if (subcommand) {
    return writeCommandHelp(subcommand, io, commands);
  }

  writeGeneralHelp(io, commands);
  return 0;
}

function writeGeneralHelp(
  io: CliIO,
  commands: CommandMeta[],
): void {
  const version = getVersion();
  const lines: string[] = [];

  lines.push(
    `Tekon CLI v${version} — AI 驱动的软件交付自动化工具`,
  );
  lines.push('');
  lines.push('用法: tekon <command> [options]');
  lines.push('');

  const groups = new Map<string, typeof commands>();
  for (const cmd of commands) {
    const list = groups.get(cmd.group) ?? [];
    list.push(cmd);
    groups.set(cmd.group, list);
  }

  for (const [group, cmds] of groups) {
    lines.push(`  ${group}`);
    for (const cmd of cmds) {
      const label = cmd.aliases?.length
        ? `${cmd.name}（别名: ${cmd.aliases.join(', ')}）`
        : cmd.name;
      lines.push(`    ${label.padEnd(22)}${cmd.description}`);
    }
    lines.push('');
  }

  lines.push(
    '使用 tekon help <command> 查看特定命令的详细帮助。',
  );

  io.stdout.write(lines.join('\n') + '\n');
}

function writeCommandHelp(
  commandName: string,
  io: CliIO,
  commands: CommandMeta[],
): number {
  const cmd = commands.find(
    (c) =>
      c.name === commandName ||
      (c.aliases?.includes(commandName) ?? false),
  );

  if (!cmd) {
    io.stderr.write(`未知命令: ${commandName}\n`);
    io.stderr.write('使用 tekon help 查看可用命令。\n');
    return 1;
  }

  const lines: string[] = [];
  const aliasSuffix = cmd.aliases?.length
    ? `（别名: ${cmd.aliases.join(', ')}）`
    : '';
  lines.push(
    `tekon ${cmd.name} — ${cmd.description}${aliasSuffix}`,
  );
  lines.push('');

  if (cmd.usage) {
    lines.push(`用法: ${cmd.usage}`);
    lines.push('');
  }

  if (cmd.subcommands?.length) {
    lines.push('子命令:');
    for (const sub of cmd.subcommands) {
      lines.push(
        `  ${sub.name.padEnd(16)}${sub.description}`,
      );
    }
    lines.push('');
  }

  io.stdout.write(lines.join('\n') + '\n');
  return 0;
}
