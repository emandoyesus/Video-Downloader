import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';
import PQueue from 'p-queue';
import { spawn } from 'child_process';
import { downloaderService } from './services/downloader.js';
import { isValidHttpUrl, extractFirstUrl } from './utils/url.js';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('Error: BOT_TOKEN is not set in environment variables');
  process.exit(1);
}

// Startup dependency checks
async function checkDependencies() {
  const checks = [
    { cmd: 'yt-dlp', args: ['--version'] },
    { cmd: 'ffmpeg', args: ['-version'] },
  ];
  for (const check of checks) {
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(check.cmd, check.args, { stdio: 'ignore' });
        const timeout = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch (e) {}
          reject(new Error('timeout'));
        }, 5000);
        proc.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        proc.on('close', (code) => {
          clearTimeout(timeout);
          if (code === 0) resolve();
          else reject(new Error(`exit ${code}`));
        });
      });
      console.log(`✓ ${check.cmd} found`);
    } catch (err) {
      console.error(`✗ ${check.cmd} not found or not working: ${err.message}`);
      console.error(`Please install ${check.cmd} and ensure it's in PATH`);
      process.exit(1);
    }
  }
}

await checkDependencies();

const bot = new Telegraf(BOT_TOKEN);

// Set handler timeout to at least 5 minutes
bot.telegram.options = bot.telegram.options || {};
bot.telegram.options.timeout = 300000; // 5 minutes

// Queue with limited concurrency
const queue = new PQueue({ concurrency: Number(process.env.CONCURRENCY) || 4 });

// Track active downloads per user
const userActiveDownloads = new Map();
const userStatusMessages = new Map(); // userId -> { chatId, messageId }
// Store URL mappings for buttons (to avoid long callback data)
const urlStore = new Map(); // key -> url
let urlCounter = 0;

bot.start((ctx) => {
  const message = `Video Downloader

Send me a direct link to a video or audio page. I'll fetch it for you.

Options:
- Video — download in the best available quality
- Audio (MP3) — extract audio only

Limits:
- Max file size: 50 MB
- One active download per user
- Up to ${queue.concurrency} downloads at once

Use /help for details.`;
  ctx.reply(message).catch((err) => {
    console.error('Error sending start message:', err.message);
  });
});

bot.help((ctx) => {
  const message = `Usage

1. Send a link (http/https)
2. Select Video or Audio (MP3)
3. Wait for processing and upload

Commands
/start — Show welcome
/help — Show this message
/cancel — Cancel your active download

Notes
- Files over 50 MB cannot be sent by the Telegram Bot API
- One download per user; queued globally
- Some sites may restrict downloads
- Cancellation may take a moment to take effect`;
  ctx.reply(message).catch((err) => {
    console.error('Error sending help message:', err.message);
  });
});

bot.command('cancel', async (ctx) => {
  const userId = ctx.from.id;
  if (!userActiveDownloads.get(userId)) {
    await ctx.reply('No active download to cancel.').catch(() => {});
    return;
  }
  try {
    downloaderService.killUserDownload(userId);
    userActiveDownloads.delete(userId);
    const status = userStatusMessages.get(userId);
    if (status) {
      try {
        await ctx.telegram.editMessageText(status.chatId, status.messageId, undefined, 'Download cancelled.');
      } catch (e) {}
      userStatusMessages.delete(userId);
    }
    await ctx.reply('Download cancelled.').catch(() => {});
  } catch (err) {
    await ctx.reply('Failed to cancel download.').catch(() => {});
  }
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;
  
  if (text.startsWith('/')) {
    return;
  }
  
  if (userActiveDownloads.get(userId)) {
    const position = queue.size + queue.pending;
    await ctx.reply(`You already have an active download. Queued: ${position}`).catch((err) => {
      console.error('Error:', err.message);
    });
    return;
  }

  const url = extractFirstUrl(text);
  
  if (!url) {
    await ctx.reply('Send a valid http/https link.').catch((err) => {
      console.error('Error:', err.message);
    });
    return;
  }

  if (!isValidHttpUrl(url)) {
    await ctx.reply('Send a valid http/https link.').catch((err) => {
      console.error('Error:', err.message);
    });
    return;
  }

  urlCounter++;
  const key = String(urlCounter);
  urlStore.set(key, url);
  setTimeout(() => urlStore.delete(key), 10 * 60 * 1000);
  
  await ctx.reply(
    'Download as:',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('Video', `v${key}`),
        Markup.button.callback('Audio (MP3)', `a${key}`),
      ],
      [
        Markup.button.callback('Cancel', `c${key}`),
      ],
    ])
  ).catch((err) => {
    console.error('Error sending buttons:', err.message);
  });
});

bot.action(/^v(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const key = ctx.match[1];
  const url = urlStore.get(key);
  
  if (!url) {
    await ctx.answerCbQuery('Link expired').catch(() => {});
    return;
  }
  
  if (userActiveDownloads.get(userId)) {
    await ctx.answerCbQuery('Download already in progress').catch(() => {});
    return;
  }

  await ctx.answerCbQuery().catch(() => {});
  
  try {
    await ctx.deleteMessage();
  } catch (err) {}

  await processDownload(ctx, url, userId, false);
});

bot.action(/^a(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const key = ctx.match[1];
  const url = urlStore.get(key);
  
  if (!url) {
    await ctx.answerCbQuery('Link expired').catch(() => {});
    return;
  }
  
  if (userActiveDownloads.get(userId)) {
    await ctx.answerCbQuery('Download already in progress').catch(() => {});
    return;
  }

  await ctx.answerCbQuery().catch(() => {});
  
  try {
    await ctx.deleteMessage();
  } catch (err) {}

  await processDownload(ctx, url, userId, true);
});

bot.action(/^c(\d+)$/, async (ctx) => {
  const key = ctx.match[1];
  urlStore.delete(key);
  try {
    await ctx.answerCbQuery('Cancelled');
  } catch (err) {}
  try {
    await ctx.deleteMessage();
  } catch (err) {}
});

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function sanitizeTitle(title) {
  if (!title) return '';
  return title.replace(/[\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 100);
}

async function processDownload(ctx, url, userId, audioOnly) {
  userActiveDownloads.set(userId, true);
  
  const queuePos = queue.size + queue.pending;
  let statusMessage;
  try {
    if (queuePos > 0) {
      statusMessage = await ctx.reply(
        audioOnly ? `Queued (#${queuePos + 1}) — preparing audio...` : `Queued (#${queuePos + 1}) — preparing download...`
      );
    } else {
      statusMessage = await ctx.reply(audioOnly ? 'Preparing audio...' : 'Preparing download...');
    }
    userStatusMessages.set(userId, { chatId: ctx.chat.id, messageId: statusMessage.message_id });
  } catch (err) {
    console.error('Error sending status message:', err.message);
    userActiveDownloads.delete(userId);
    return;
  }

  let lastProgress = -1;
  const updateProgress = async (info) => {
    if (!info || typeof info.percent !== 'number') return;
    const p = Math.floor(info.percent);
    if (p === lastProgress && !info.speed && !info.eta) return;
    if (p % 2 === 0 || p >= 95 || info.speed) {
      lastProgress = p;
      let text = audioOnly ? `Extracting audio — ${p}%` : `Downloading — ${p}%`;
      if (info.speed) text += ` • ${info.speed}`;
      if (info.eta) text += ` • ETA ${info.eta}`;
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          undefined,
          text
        );
      } catch (e) {}
    }
  };

  const task = async () => {
    let result;
    try {
      if (audioOnly) {
        result = await downloaderService.downloadAudio(url, userId, { onProgress: updateProgress });
      } else {
        result = await downloaderService.downloadVideo(url, userId, { onProgress: updateProgress });
      }

      try {
        const sizeStr = result.fileSize ? formatBytes(result.fileSize) : '';
        const title = sanitizeTitle(result.title);
        let text = 'Uploading';
        if (title) text += ` — ${title}`;
        if (sizeStr) text += ` (${sizeStr})`;
        text += '...';
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          undefined,
          text
        );
      } catch (e) {}

      try {
        const sizeStr = result.fileSize ? formatBytes(result.fileSize) : '';
        const title = sanitizeTitle(result.title);
        if (audioOnly) {
          const caption = title ? (sizeStr ? `${title} • ${sizeStr}` : title) : (sizeStr ? `Downloaded • ${sizeStr}` : 'Downloaded');
          await ctx.replyWithAudio(
            { source: result.filePath },
            { caption }
          );
        } else {
          const caption = title ? (sizeStr ? `${title} • ${sizeStr}` : title) : (sizeStr ? `Downloaded • ${sizeStr}` : 'Downloaded');
          await ctx.replyWithVideo(
            { source: result.filePath },
            { 
              caption,
              supports_streaming: true 
            }
          );
        }
      } catch (sendErr) {
        const msg = sendErr.message || '';
        if (msg.includes('FILE_TOO_LARGE') || msg.includes('413')) {
          try {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMessage.message_id,
              undefined,
              'File too large for Telegram (50 MB limit).'
            );
          } catch (e) {}
        } else if (msg.includes('bot was blocked') || msg.includes('Forbidden')) {
        } else {
          try {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMessage.message_id,
              undefined,
              'Failed to send file.'
            );
          } catch (e) {}
        }
        throw sendErr;
      }

      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id);
      } catch (err) {}
    } catch (err) {
      const errorMsg = err.message || 'Unknown error';
      const sanitizedError = errorMsg
        .replace(/\/[^\s]+/g, '[path]')
        .replace(/password|token|key/gi, '[redacted]')
        .replace(/\s+/g, ' ')
        .substring(0, 160);
      
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          undefined,
          `Error: ${sanitizedError}`
        );
      } catch (e) {
        try {
          await ctx.reply(`Error: ${sanitizedError}`);
        } catch (e2) {}
      }
      throw err;
    } finally {
      if (result && result.tempDir) {
        try {
          await downloaderService.removeTempDir(result.tempDir);
        } catch (e) {}
      }
      userActiveDownloads.delete(userId);
      userStatusMessages.delete(userId);
      try {
        downloaderService.killUserDownload(userId);
      } catch (e) {}
    }
  };

  queue.add(task).catch((err) => {
    console.error('Queue task error:', err.message);
  });
}

// Graceful shutdown
const shutdown = (signal) => {
  console.log(`Received ${signal}, shutting down gracefully...`);
  try {
    // Kill all active downloads
    for (const [userId] of userActiveDownloads) {
      try {
        downloaderService.killUserDownload(userId);
      } catch (e) {}
    }
    userActiveDownloads.clear();
    userStatusMessages.clear();
  } catch (e) {}
  try {
    bot.stop(signal);
  } catch (e) {}
  process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
});

bot.launch().then(() => {
  console.log('Bot is running...');
}).catch((err) => {
  console.error('Failed to start bot:', err);
  process.exit(1);
});
