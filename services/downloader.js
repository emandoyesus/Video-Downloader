import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const MAX_FILESIZE_BYTES = 50 * 1024 * 1024; // 50 MB (Bot API limit)
const MAX_FILESIZE_ARG = '50M'; // yt-dlp format like

export class DownloaderService {
  constructor() {
    this.activeDownloads = new Map(); // userId -> process
  }

  createTempDir() {
    const tempDir = path.join(os.tmpdir(), `tgdl-${randomUUID()}`);
    return tempDir;
  }

  async ensureTempDir(dir) {
    await fs.mkdir(dir, { recursive: true });
  }

  async getFileSize(filePath) {
    try {
      const stats = await fs.stat(filePath);
      return stats.size;
    } catch (err) {
      return 0;
    }
  }

  async removeTempDir(dir) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  }

  killUserDownload(userId) {
    const proc = this.activeDownloads.get(userId);
    if (proc) {
      try {
        proc.kill('SIGKILL');
      } catch (err) {
        // ignore
      }
      this.activeDownloads.delete(userId);
    }
  }

  downloadVideo(url, userId, options = {}) {
    return this.download(url, userId, { ...options, audioOnly: false });
  }

  downloadAudio(url, userId, options = {}) {
    return this.download(url, userId, { ...options, audioOnly: true });
  }

  download(url, userId, options = {}) {
    const { audioOnly = false, onProgress = null } = options;
    return new Promise(async (resolve, reject) => {
      const tempDir = this.createTempDir();
      try {
        await this.ensureTempDir(tempDir);
      } catch (e) {
        reject(new Error('Failed to create temp directory'));
        return;
      }

      let outputTemplate = path.join(tempDir, '%(title)s.%(ext)s');
      let args = [];

      // Common args
      args.push('--no-playlist');
      args.push('--max-filesize', MAX_FILESIZE_ARG);
      args.push('--restrict-filenames');
      args.push('--no-check-certificates');
      args.push('--geo-bypass');
      args.push('--no-warnings');
      args.push('--ignore-errors');
      args.push('--extractor-args', 'youtube:player_client=android,web,mweb');
      args.push('--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

      if (audioOnly) {
        args.push('-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best');
        args.push('-x');
        args.push('--audio-format', 'mp3');
        args.push('--audio-quality', '192K');
        args.push('--postprocessor-args', 'ffmpeg:-ar 44100');
        outputTemplate = path.join(tempDir, '%(title)s.mp3');
      } else {
        args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio/best[height<=1080][ext=mp4]/best[ext=mp4]/best');
      }

      args.push('-o', outputTemplate);
      args.push('--print', 'before_dl:%(title)s');
      args.push('--');
      args.push(url);

      let proc;
      let timeoutId;
      let killed = false;

      const cleanup = async () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (proc) {
          this.activeDownloads.delete(userId);
        }
      };

      try {
        const ytDlpCmd = process.env.YTDLP_PATH || 'yt-dlp';
        proc = spawn(ytDlpCmd, args, {
          cwd: tempDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/usr/bin:/bin:/home/container/.local/bin' },
        });
        this.activeDownloads.set(userId, proc);

        timeoutId = setTimeout(() => {
          killed = true;
          try {
            proc.kill('SIGKILL');
          } catch (e) {
            // ignore
          }
          cleanup();
          reject(new Error('Download timed out (exceeded 3 minutes)'));
        }, DOWNLOAD_TIMEOUT_MS);

        let stderr = '';
        let videoTitle = '';
        proc.stdout?.on('data', (data) => {
          const text = data.toString();
          if (text.startsWith('before_dl:')) {
            videoTitle = text.replace('before_dl:', '').trim();
          }
        });
        proc.stderr.on('data', (data) => {
          const text = data.toString();
          stderr += text;
          if (onProgress && typeof onProgress === 'function') {
            try {
              const percentMatch = text.match(/\[download\]\s+([0-9]+(?:\.[0-9]+)?)%/);
              const speedMatch = text.match(/at\s+([0-9]+(?:\.[0-9]+)?\S+\/s)/i);
              const etaMatch = text.match(/ETA\s+([0-9]+:[0-9]+(?:\:[0-9]+)?)/i);
              if (percentMatch) {
                const info = { percent: parseFloat(percentMatch[1]) };
                if (speedMatch) info.speed = speedMatch[1];
                if (etaMatch) info.eta = etaMatch[1];
                onProgress(info);
              }
            } catch (e) {}
          }
        });

        proc.on('error', async (err) => {
          await cleanup();
          await this.removeTempDir(tempDir);
          reject(new Error(`Failed to start yt-dlp: ${err.message}`));
        });

        proc.on('close', async (code) => {
          await cleanup();
          if (killed) {
            await this.removeTempDir(tempDir);
            return; // already rejected
          }
          if (code !== 0) {
            await this.removeTempDir(tempDir);
        // Sanitize error message
        const cleaned = stderr
          .replace(/\r/g, ' ')
          .replace(/\n/g, ' ')
          .replace(/\[.*?\]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        let msg = cleaned || `yt-dlp exited with code ${code}`;
        if (msg.length > 200) msg = msg.substring(0, 200) + '...';
        reject(new Error(msg));
            return;
          }

          try {
            // Find the downloaded file
            const files = await fs.readdir(tempDir);
            if (files.length === 0) {
              await this.removeTempDir(tempDir);
              reject(new Error('No file downloaded'));
              return;
            }
            // Get the largest file
            let targetFile = files[0];
            let maxSize = 0;
            for (const f of files) {
              const fullPath = path.join(tempDir, f);
              try {
                const size = await this.getFileSize(fullPath);
                if (size > maxSize) {
                  maxSize = size;
                  targetFile = f;
                }
              } catch (e) {}
            }
            const filePath = path.join(tempDir, targetFile);
            const fileSize = await this.getFileSize(filePath);

            if (fileSize > MAX_FILESIZE_BYTES) {
              await this.removeTempDir(tempDir);
              reject(new Error('File exceeds 50 MB limit'));
              return;
            }
            if (fileSize === 0) {
              await this.removeTempDir(tempDir);
              reject(new Error('Downloaded file is empty'));
              return;
            }

            resolve({
              filePath,
              tempDir,
              fileName: targetFile,
              fileSize,
              audioOnly,
              title: videoTitle || targetFile.replace(/\.[^/.]+$/, ''),
            });
          } catch (err) {
            await this.removeTempDir(tempDir);
            reject(err);
          }
        });
      } catch (err) {
        await cleanup();
        await this.removeTempDir(tempDir);
        reject(err);
      }
    });
  }
}

export const downloaderService = new DownloaderService();
