import 'dotenv/config';
import './logBuffer.js';
import { Client, Events, GatewayIntentBits, MessageFlags, REST, Routes } from 'discord.js';
import * as clearCommand from './commands/clear.js';
import * as logCommand from './commands/log.js';
import { togglePauseMessage } from './commands/pause.js';
import * as pauseCommand from './commands/pause.js';
import * as playCommand from './commands/play.js';
import * as queueCommand from './commands/queue.js';
import * as removeLastCommand from './commands/removelast.js';
import { skipMessage } from './commands/skip.js';
import * as skipCommand from './commands/skip.js';
import * as stopCommand from './commands/stop.js';
import type { Command } from './commands/types.js';
import { PAUSE_BUTTON_ID, SessionManager, SKIP_BUTTON_ID } from './player/SessionManager.js';

const rawToken = process.env.DISCORD_TOKEN;
const rawClientId = process.env.DISCORD_CLIENT_ID;
// 可選：設定後指令只註冊在這個 guild，變更會立即生效，適合開發階段使用。
const devGuildId = process.env.DISCORD_GUILD_ID;

if (!rawToken || !rawClientId) {
  throw new Error('缺少環境變數 DISCORD_TOKEN 或 DISCORD_CLIENT_ID');
}
const token: string = rawToken;
const clientId: string = rawClientId;

const commands = new Map<string, Command>(
  [
    playCommand,
    skipCommand,
    pauseCommand,
    queueCommand,
    stopCommand,
    logCommand,
    clearCommand,
    removeLastCommand,
  ].map((command) => [
    command.data.name,
    command,
  ]),
);

async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  const body = [...commands.values()].map((command) => command.data.toJSON());
  const route = devGuildId
    ? Routes.applicationGuildCommands(clientId, devGuildId)
    : Routes.applicationCommands(clientId);
  await rest.put(route, { body });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const sessions = new SessionManager(client);

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const command = commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction, sessions);
    } catch (err) {
      console.error(`指令 /${interaction.commandName} 執行失敗`, err);
      const message = '執行指令時發生錯誤';
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message).catch(() => {});
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton() && (interaction.customId === PAUSE_BUTTON_ID || interaction.customId === SKIP_BUTTON_ID)) {
    try {
      if (!interaction.inCachedGuild()) {
        await interaction.reply({ content: '這個功能只能在伺服器頻道中使用', flags: MessageFlags.Ephemeral });
        return;
      }

      const message =
        interaction.customId === PAUSE_BUTTON_ID
          ? togglePauseMessage(sessions, interaction.guildId)
          : skipMessage(sessions, interaction.guildId);
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error(`按鈕 ${interaction.customId} 執行失敗`, err);
      await interaction.reply({ content: '執行時發生錯誤', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// discord.js 的 'error' 事件沒有 listener 時會直接 throw，讓整個 process 掛掉。
client.on(Events.Error, (err) => {
  console.error('[client error]', err);
});

// 兜底：漏接的 promise rejection 只記錄，不讓它把 bot 弄掛（Node 預設行為是直接結束 process）。
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// k8s 停 pod 時送 SIGTERM。node 當 PID 1 時沒有預設的訊號處理，不接的話會被晾到
// grace period 結束才 SIGKILL，bot 也不會離開語音頻道。
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，離開語音頻道並關閉連線`);
  try {
    sessions.leaveAll();
  } catch (err) {
    console.error('關閉時離開語音頻道失敗', err);
  }
  void client
    .destroy()
    .catch((err: unknown) => console.error('關閉 Discord 連線失敗', err))
    .finally(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// 頻道人數變動時重新評估閒置倒數（頻道無人 5 分鐘後離開）。
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  sessions.reconcileIdle(newState.guild.id ?? oldState.guild.id);
});

async function main(): Promise<void> {
  await registerCommands();
  await client.login(token);
}

main().catch((err: unknown) => {
  console.error('啟動失敗', err);
  process.exit(1);
});
