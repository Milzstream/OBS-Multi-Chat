import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
function browserPath() {
    const candidates = [
        process.env.KICK_BROWSER_PATH,
        process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}
export class KickScraper {
    browser;
    page;
    timer;
    refreshTimer;
    seen = new Set();
    lastCount = 0;
    async start(channelSlug, onMessage) {
        if (this.page)
            return;
        const executablePath = browserPath();
        if (!executablePath)
            throw new Error('No Microsoft Edge or Google Chrome installation was found for headless Kick chat.');
        this.browser = await chromium.launch({ headless: true, executablePath });
        this.page = await this.browser.newPage({ viewport: { width: 1280, height: 900 } });
        await this.page.goto(`https://kick.com/${encodeURIComponent(channelSlug)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        this.timer = setInterval(() => { void this.collect(onMessage); }, 1_000);
        this.refreshTimer = setInterval(() => { if (this.page)
            void this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined); }, 5 * 60_000);
    }
    async stop() {
        if (this.timer)
            clearInterval(this.timer);
        if (this.refreshTimer)
            clearInterval(this.refreshTimer);
        this.timer = undefined;
        this.refreshTimer = undefined;
        await this.browser?.close();
        this.browser = undefined;
        this.page = undefined;
        this.seen.clear();
    }
    async collect(onMessage) {
        if (!this.page)
            return;
        try {
            const messages = await this.page.evaluate(`() => {
        const selectors = '[data-testid="chat-message"], [data-testid*="chat-message"], [class*="chat-entry"], [class*="chat-message"], [class*="chat-line"]'
        return [...document.querySelectorAll(selectors)].map((element) => {
          const user = element.querySelector('[class*="username"], [class*="user-name"], [data-testid*="username"]')?.textContent?.trim() || 'Kick user'
          const text = element.querySelector('[class*="message"], [class*="content"], [data-testid*="message"]')?.textContent?.trim() || element.textContent?.trim() || ''
          return { user, text }
        }).filter((message) => message.text.length > 0)
      }`);
            if (messages.length !== this.lastCount) {
                console.log(`Kick chat scraper found ${messages.length} rendered messages`);
                this.lastCount = messages.length;
            }
            for (const message of messages) {
                const key = `${message.user}:${message.text}`;
                if (this.seen.has(key))
                    continue;
                this.seen.add(key);
                onMessage(message);
            }
            if (this.seen.size > 2_000)
                this.seen.clear();
        }
        catch (error) {
            console.error('Kick chat scraper:', error instanceof Error ? error.message : error);
        }
    }
}
