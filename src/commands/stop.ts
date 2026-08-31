import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SessionManager } from '../player/SessionManager.js';

export const data = new SlashCommandBuilder().setName('stop').setDescription('停止播放、清空佇列並離開語音頻道');

export async function execute(interaction: ChatInputCommandInteraction, sessions: SessionManager): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: '這個指令只能在伺服器頻道中使用', ephemeral: true });
    return;
  }

  if (!sessions.hasSession(interaction.guildId)) {
    await interaction.reply('目前沒有在任何語音頻道中');
    return;
  }

  sessions.leave(interaction.guildId);
  await interaction.reply('🛑 已停止播放並離開語音頻道');
}
