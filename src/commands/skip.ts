import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SessionManager } from '../player/SessionManager.js';

export const data = new SlashCommandBuilder().setName('skip').setDescription('跳過目前播放的歌曲');

/** 斜線指令跟 skip 按鈕共用同一套文字，避免兩邊訊息對不上。 */
export function skipMessage(sessions: SessionManager, guildId: string): string {
  const skipped = sessions.skip(guildId);
  return skipped ? '⏭️ 已跳過' : '目前沒有正在播放的歌曲';
}

export async function execute(interaction: ChatInputCommandInteraction, sessions: SessionManager): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: '這個指令只能在伺服器頻道中使用', ephemeral: true });
    return;
  }

  await interaction.reply(skipMessage(sessions, interaction.guildId));
}
