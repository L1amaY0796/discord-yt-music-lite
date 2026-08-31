import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SessionManager } from '../player/SessionManager.js';

export const data = new SlashCommandBuilder().setName('queue').setDescription('顯示目前佇列（前 10 筆）');

export async function execute(interaction: ChatInputCommandInteraction, sessions: SessionManager): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: '這個指令只能在伺服器頻道中使用', ephemeral: true });
    return;
  }

  const nowPlaying = sessions.getNowPlaying(interaction.guildId);
  const upcoming = sessions.peekQueue(interaction.guildId, 10);
  const total = sessions.queueSize(interaction.guildId);

  if (!nowPlaying && upcoming.length === 0) {
    await interaction.reply('目前沒有播放中的歌曲，佇列也是空的');
    return;
  }

  const lines: string[] = [nowPlaying ? `▶️ 正在播放：**${nowPlaying.title}**` : '▶️ 目前沒有播放中的歌曲'];

  if (upcoming.length > 0) {
    lines.push('', `待播清單（共 ${total} 首，顯示前 ${upcoming.length} 首）：`);
    upcoming.forEach((track, i) => {
      // <...> 包住網址可以抑制 Discord 的嵌入縮圖預覽。
      const entry = track.title ? `${track.title}\n<${track.query}>` : `<${track.query}>`;
      lines.push(`${i + 1}. ${entry}`);
    });
  }

  await interaction.reply(lines.join('\n'));
}
