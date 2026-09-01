import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SessionManager } from '../player/SessionManager.js';

export const data = new SlashCommandBuilder().setName('removelast').setDescription('移除最後加入待播佇列的歌曲');

export async function execute(interaction: ChatInputCommandInteraction, sessions: SessionManager): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: '這個指令只能在伺服器頻道中使用', ephemeral: true });
    return;
  }

  const removed = sessions.removeLast(interaction.guildId);
  if (!removed) {
    await interaction.reply('待播佇列是空的，沒有可以移除的歌曲');
    return;
  }

  await interaction.reply(`↩️ 已移除：**${removed.title ?? removed.query}**`);
}
