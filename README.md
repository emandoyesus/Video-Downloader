# Telegram Video Downloader Bot

A Telegram bot built with Node.js (ES modules) that downloads videos from links users send. Uses Telegraf, yt-dlp, and ffmpeg.

## Features

1. `/start` - Sends a short welcome message with usage instructions
2. URL validation - Validates http/https URLs before downloading
3. Watermark-free preference - Prefers watermark-free streams when platforms offer them (e.g., TikTok). Does not remove watermarks from the video itself
4. Send with streaming support - Results sent via `replyWithVideo` with `supports_streaming`
5. Status messages - Shows "Downloading..." status, deletes on success or edits with short error on failure
6. Audio-only mode - Inline buttons let users choose "Video" or "Audio (MP3)"

## Limits and Safety

- **50 MB limit** - Respects Bot API upload limit using `--max-filesize` and checks final file size
- **Per-user lock + global queue** - One active download per user, plus global queue (p-queue) with limited concurrency (2)
- **3-minute timeout** - 3-minute timeout per download, kills process if exceeded
- **Temp files** - Downloads to temp directory per request, always deleted in finally block
- **Handler timeout** - Telegraf handlerTimeout set to at least 5 minutes
- **Security** - Never passes user input to shell, sanitizes error messages before showing to users

## Prerequisites

- Node.js >= 20.0.0
- yt-dlp installed and in PATH
- ffmpeg installed and in PATH
- A Telegram Bot Token from [@BotFather](https://t.me/BotFather)

## Setup

### Local Development

1. Clone the repository:
```bash
git clone <your-repo-url>
cd "Telegram bot"
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file:
```bash
cp .env.example .env
```

4. Add your bot token to `.env`:
```env
BOT_TOKEN=your_telegram_bot_token_here
```

5. Install system dependencies (if not already installed):

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install ffmpeg python3 pip
pip install yt-dlp
```

**macOS (Homebrew):**
```bash
brew install ffmpeg yt-dlp
```

**Windows:** Download [ffmpeg](https://ffmpeg.org/download.html) and [yt-dlp](https://github.com/yt-dlp/yt-dlp) and add them to PATH

6. Run the bot:
```bash
npm start
```

For development with auto-restart:
```bash
npm run dev
```

## Deployment

### Railway

1. Create a new project on [Railway](https://railway.app/)
2. Connect your GitHub repository
3. Add environment variable `BOT_TOKEN` in Railway settings
4. Railway will automatically detect the Dockerfile and deploy
5. The bot will start automatically

### VPS (Ubuntu/Debian)

1. SSH into your VPS
2. Install Node.js 20, ffmpeg, python3, pip:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs ffmpeg python3 pip
pip install yt-dlp
```

3. Clone and setup the bot:
```bash
git clone <your-repo-url>
cd "Telegram bot"
npm install
```

4. Create `.env` with your BOT_TOKEN
5. Use a process manager like PM2:
```bash
sudo npm install -g pm2
pm2 start bot.js --name telegram-downloader-bot
pm2 save
pm2 startup
```

Or use systemd. See systemd example below.

### Docker

Build and run:
```bash
docker build -t telegram-video-bot .
docker run -d --env-file .env --name telegram-bot telegram-video-bot
```

## Important Notes

**⚠️ Copyright & Terms of Service:** Users are responsible for respecting copyright laws and platform terms of service. Only download content you have the right to download. This bot is for personal use only.

## Project Structure

```
.
├── bot.js                 # Main bot file
├── services/
│   └── downloader.js      # yt-dlp download logic
├── utils/
│   └── url.js            # URL validation utilities
├── package.json
├── Dockerfile
├── .env.example
└── README.md
```

## License

MIT
