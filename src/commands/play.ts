import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { fetchYoutubeTitle } from '../player/oembed.js';
import type { SessionManager } from '../player/SessionManager.js';

const URL_PATTERN = /^https?:\/\//i;

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('播放或加入佇列一首歌')
  .addStringOption((option) =>
    option.setName('query').setDescription('YouTube 網址').setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction, sessions: SessionManager): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: '這個指令只能在伺服器頻道中使用', ephemeral: true });
    return;
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: '請先加入一個語音頻道', ephemeral: true });
    return;
  }

  const channel = interaction.channel;
  if (!channel) {
    await interaction.reply({ content: '無法在此頻道使用', ephemeral: true });
    return;
  }

  const query = interaction.options.getString('query', true);
  if (!URL_PATTERN.test(query)) {
    await interaction.reply({ content: '請提供有效的 YouTube 網址', ephemeral: true });
    return;
  }

  await interaction.deferReply();

  // 跟 join() 併行取標題（僅供 /queue 顯示用），不要讓它拖慢加入語音頻道的速度。
  const titlePromise = fetchYoutubeTitle(query);

  try {
    await sessions.join(interaction.guildId, voiceChannel, channel);
  } catch {
    await interaction.editReply('無法加入語音頻道，請稍後再試');
    return;
  }

  const wasIdle = !sessions.getNowPlaying(interaction.guildId);
  const title = (await titlePromise) ?? undefined;
  const result = sessions.enqueue(interaction.guildId, { query, requestedBy: interaction.user.id, title });

  if (!result.queued) {
    await interaction.editReply('播放佇列已滿（上限 50 首），請稍後再試');
    return;
  }

  await interaction.editReply(
    wasIdle ? '🔎 解析中，即將開始播放...' : `已加入佇列，目前排在第 ${result.position} 位`,
  );
}
