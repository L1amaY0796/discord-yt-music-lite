import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SessionManager } from '../player/SessionManager.js';

export const data = new SlashCommandBuilder().setName('clear').setDescription('清空待播佇列（不含正在播放的歌曲）');

export async function execute(interaction: ChatInputCommandInteraction, sessions: SessionManager): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: '這個指令只能在伺服器頻道中使用', ephemeral: true });
    return;
  }

  const count = sessions.clearQueue(interaction.guildId);
  if (count === 0) {
    await interaction.reply('待播佇列本來就是空的');
    return;
  }

  await interaction.reply(`🧹 已清空待播佇列（共 ${count} 首）`);
}
