import type { DraftShape } from '@tekon/core';
import {
  generateClarifyingQuestions,
  updateDraftWithAnswers,
} from '@tekon/core';
import type { CliIO } from './index.js';

export interface InteractiveResult {
  draft: DraftShape;
  answersCount: number;
  questionsAsked: number;
  /** True if the user interrupted the session with Ctrl+C */
  interrupted: boolean;
}

export async function runInteractiveClarification(
  initialDraft: DraftShape,
  readLine: () => Promise<string>,
  stdout: CliIO['stdout'],
): Promise<InteractiveResult> {
  // Skip interactive mode when stdin is not a TTY (piped input, scripts, etc.)
  if (!process.stdin.isTTY) {
    return {
      draft: initialDraft,
      answersCount: 0,
      questionsAsked: 0,
      interrupted: false,
    };
  }

  let currentDraft = initialDraft;
  let interrupted = false;

  // Ctrl+C handler: mark interrupted, save partial state
  const sigintHandler = () => {
    interrupted = true;
    // Close stdin to unblock readStdinLine
    if (!process.stdin.destroyed) {
      process.stdin.destroy();
    }
  };
  process.once('SIGINT', sigintHandler);

  try {
    // Display initial summary
    const categoryMap: Record<string, string> = {
      feature: '功能',
      bugfix: '缺陷修复',
      test: '测试',
      docs: '文档',
      refactor: '重构',
      other: '其他',
    };
    const riskMap: Record<string, string> = {
      low: '低',
      medium: '中',
      high: '高',
    };

    stdout.write('\n──────── 初始草案概要 ────────\n');
    stdout.write(`  标题:    ${currentDraft.title}\n`);
    stdout.write(
      `  类别:    ${categoryMap[currentDraft.category] ?? currentDraft.category}\n`,
    );
    stdout.write(
      `  风险:    ${riskMap[currentDraft.risk.level] ?? currentDraft.risk.level}`,
    );
    if (currentDraft.risk.tags.length > 0) {
      stdout.write(` (${currentDraft.risk.tags.join(', ')})`);
    }
    stdout.write('\n');
    stdout.write(`  模板:    ${currentDraft.recommendedTemplate}\n`);
    stdout.write(
      `  就绪:    ${currentDraft.readyForRun ? '可运行' : '待完善'}\n`,
    );
    if (currentDraft.openQuestions.length > 0) {
      stdout.write('  待解决:\n');
      for (const q of currentDraft.openQuestions.slice(0, 3)) {
        stdout.write(`    - ${q}\n`);
      }
      if (currentDraft.openQuestions.length > 3) {
        stdout.write(
          `    ... 共 ${currentDraft.openQuestions.length} 个问题\n`,
        );
      }
    }
    stdout.write('──────────────────────────────\n');

    // Generate clarifying questions
    const questions = generateClarifyingQuestions(currentDraft);

    if (questions.length === 0) {
      stdout.write('\n未发现需要澄清的问题，跳过交互模式。\n\n');
      return {
        draft: currentDraft,
        answersCount: 0,
        questionsAsked: 0,
        interrupted: false,
      };
    }

    stdout.write(
      `\n需要澄清 ${questions.length} 个问题（按 Enter 跳过，Ctrl+C 退出并保留已填内容）:\n`,
    );

    const answers = [];
    let answeredCount = 0;

    for (let i = 0; i < questions.length; i++) {
      if (interrupted) break;

      const question = questions[i];
      const progressLabel = `[${i + 1}/${questions.length}]`;

      if (i > 0) {
        stdout.write('\n');
      }
      stdout.write(`\n${progressLabel} ${question}\n> `);

      const answer = await readLine();

      // Check again after await (Ctrl+C may have arrived during read)
      if (interrupted) break;

      if (!answer) {
        stdout.write('  (已跳过)');
        continue;
      }

      answeredCount++;
      answers.push({ question, answer });
    }

    // Update draft with answers
    if (answeredCount > 0) {
      stdout.write('\n\n正在更新草案');
      currentDraft = updateDraftWithAnswers(currentDraft, answers);
      stdout.write(' 完成\n');

      // Show updated summary
      stdout.write('\n──────── 最终草案概要 ────────\n');
      stdout.write(`  标题:    ${currentDraft.title}\n`);
      stdout.write(
        `  类别:    ${categoryMap[currentDraft.category] ?? currentDraft.category}\n`,
      );
      stdout.write(
        `  风险:    ${riskMap[currentDraft.risk.level] ?? currentDraft.risk.level}`,
      );
      if (currentDraft.risk.tags.length > 0) {
        stdout.write(` (${currentDraft.risk.tags.join(', ')})`);
      }
      stdout.write('\n');
      stdout.write(
        `  就绪:    ${currentDraft.readyForRun ? '可运行' : '待完善'}\n`,
      );
      if (currentDraft.openQuestions.length > 0) {
        stdout.write('  待解决:\n');
        for (const q of currentDraft.openQuestions.slice(0, 3)) {
          stdout.write(`    - ${q}\n`);
        }
        if (currentDraft.openQuestions.length > 3) {
          stdout.write(
            `    ... 共 ${currentDraft.openQuestions.length} 个问题\n`,
          );
        }
      } else {
        stdout.write('  待解决: 无\n');
      }
      stdout.write('──────────────────────────────\n');
    } else if (interrupted) {
      stdout.write('\n\n交互已中断。\n');
    } else {
      stdout.write('\n');
    }

    return {
      draft: currentDraft,
      answersCount: answeredCount,
      questionsAsked: questions.length,
      interrupted,
    };
  } finally {
    process.removeListener('SIGINT', sigintHandler);
  }
}
