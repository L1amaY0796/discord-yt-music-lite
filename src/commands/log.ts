import { PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { getRecentLines } from '../logBuffer.js';
import type { SessionManager } from '../player/SessionManager.js';

const DEFAULT_LINES = 20;
const MAX_LINES = 50;
const DISCORD_MESSAGE_LIMIT = 2000;
const TRUNCATION_NOTICE = '…（過長已截斷）';

export const data = new SlashCommandBuilder()
  .setName('log')
  .setDescription('查看機器人最近的 log（僅限管理員）')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addIntegerOption((option) =>
    option
      .setName('lines')
      .setDescription(`要顯示的行數（1-${MAX_LINES}，預設 ${DEFAULT_LINES}）`)
      .setMinValue(1)
      .setMaxValue(MAX_LINES),
  );

export async function execute(interaction: ChatInputCommandInteraction, _sessions: SessionManager): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: '這個指令只能在伺服器頻道中使用', ephemeral: true });
    return;
  }

  // setDefaultMemberPermissions 只是註冊時的預設值，伺服器管理員可能透過 Discord 的
  // Integrations 設定重新開放給其他身分組，這裡再檢查一次避免真的洩漏 log 給非管理員。
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: '這個指令僅限伺服器管理員使用', ephemeral: true });
    return;
  }

  const lineCount = interaction.options.getInteger('lines') ?? DEFAULT_LINES;
  const recent = getRecentLines(lineCount);

  if (recent.length === 0) {
    await interaction.reply({ content: '目前沒有任何 log 記錄', ephemeral: true });
    return;
  }

  await interaction.reply({ content: buildLogMessage(recent), ephemeral: true });
}

function codeBlock(body: string): string {
  return '```\n' + body + '\n```';
}

/** 從最舊的行開始丟棄，直到（含截斷提示）整包內容塞得下 Discord 的 2000 字元上限。 */
function buildLogMessage(lines: string[]): string {
  const full = codeBlock(lines.join('\n'));
  if (full.length <= DISCORD_MESSAGE_LIMIT) {
    return full;
  }

  const remaining = [...lines];
  while (remaining.length > 0) {
    remaining.shift();
    const truncated = codeBlock([TRUNCATION_NOTICE, ...remaining].join('\n'));
    if (truncated.length <= DISCORD_MESSAGE_LIMIT) {
      return truncated;
    }
  }
  return codeBlock(TRUNCATION_NOTICE);
}
