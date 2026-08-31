import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SessionManager } from '../player/SessionManager.js';

export const data = new SlashCommandBuilder().setName('pause').setDescription('暫停或繼續播放');

/** 斜線指令跟 pause 按鈕共用同一套文字，避免兩邊訊息對不上。 */
export function togglePauseMessage(sessions: SessionManager, guildId: string): string {
  const result = sessions.togglePause(guildId);
  return result === 'paused' ? '⏸️ 已暫停播放' : result === 'resumed' ? '▶️ 已繼續播放' : '目前沒有正在播放的歌曲';
}

export async function execute(interaction: ChatInputCommandInteraction, sessions: SessionManager): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: '這個指令只能在伺服器頻道中使用', ephemeral: true });
    return;
  }

  await interaction.reply(togglePauseMessage(sessions, interaction.guildId));
}
