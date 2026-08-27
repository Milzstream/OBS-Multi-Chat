import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import WebSocket from 'ws';
import { createServer } from 'node:http';
import { KickChat } from './kick-chat.js';
process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && warning.message.includes('Fetch API'))
        return;
    console.warn(warning.stack || warning.message);
});
const isPackaged = Boolean(process.pkg);
const runtimeDir = isPackaged ? path.dirname(process.execPath) : process.cwd();
const envPath = process.env.DOTENV_CONFIG_PATH || (fs.existsSync(path.join(runtimeDir, 'production.env')) ? path.join(runtimeDir, 'production.env') : path.join(runtimeDir, '.env'));
dotenv.config({ path: envPath });
const port = Number(process.env.PORT || 4173);
const app = express();
const httpServer = createServer(app);
const clients = new Set();
const dataDir = path.resolve(process.env.RELAY_DATA_DIR || './data');
const tokenFile = path.join(dataDir, 'tokens.json');
const redirectUri = process.env.OAUTH_REDIRECT_URI || `http://localhost:${port}/oauth/callback`;
const tokens = loadTokens();
const oauthStates = new Map();
const youtubeSeen = new Set();
const youtubeChatLabels = new Map();
const twitchBadgeUrls = new Map();
const twitchAvatars = new Map();
const twitchAvatarPending = new Set();
let twitchBadgesLoaded = false;
let twitchAvatarTimer;
const refreshLocks = new Map();
const kickChat = new KickChat();
const emptyHealth = () => ({ status: 'ok', message: '' });
const state = {
    accounts: ['Twitch', 'Kick', 'YouTube'].map((platform) => ({ platform, connected: Boolean(tokens[platform]), live: false, viewers: 0, handle: tokens[platform]?.user || '' })),
    streamInfo: { Twitch: { title: '', category: '' }, Kick: { title: '', category: '' } },
    messages: [],
    health: { Twitch: emptyHealth(), Kick: emptyHealth(), YouTube: emptyHealth() },
};
let twitchIrc;
let twitchIrcReady = false;
let twitchEventSub;
let twitchEventSubGeneration = 0;
let twitchEventSubReady = false;
let twitchEventSubUnsupported = false;
let twitchKeepaliveMs = 10_000;
let twitchLastEventSub = 0;
const recentOutgoing = [];
app.use(cors());
app.use(express.json());
app.get('/api/state', (_request, response) => response.json(state));
app.get('/events', (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    response.write(`data: ${JSON.stringify(state)}\n\n`);
    clients.add(response);
    request.on('close', () => clients.delete(response));
});
app.post('/api/messages', async (request, response) => {
    const { platforms, text } = request.body;
    if (!text?.trim() || !platforms?.length)
        return response.status(400).json({ error: 'platforms and text are required' });
    const trimmed = text.trim();
    const id = crypto.randomUUID();
    const user = tokens[platforms.find((platform) => tokens[platform]) || platforms[0]]?.user || 'You';
    rememberOutgoing({ id, text: trimmed, platforms, at: Date.now() });
    addMessage({ id, platform: platforms[0], platforms, user, text: trimmed, time: new Date().toISOString() });
    const results = await Promise.all(platforms.map((platform) => sendMessage(platform, trimmed)));
    const sentPlatforms = results.filter((result) => result.ok).map((result) => result.platform);
    const existing = state.messages.find((item) => item.id === id)
        || state.messages.find((item) => item.text === trimmed && ownHandles().has(item.user.toLowerCase()) && Math.abs(Date.parse(item.time) - Date.now()) < 20_000);
    if (existing) {
        if (!sentPlatforms.length)
            state.messages = state.messages.filter((item) => item.id !== existing.id);
        else {
            existing.platforms = sentPlatforms;
            existing.platform = sentPlatforms[0];
        }
        broadcast();
    }
    response.json({ results });
});
app.post('/api/moderate', async (request, response) => {
    const body = request.body;
    if (!body.action || !body.platform)
        return response.status(400).json({ error: 'action and platform are required' });
    try {
        const result = await moderate(body.platform, { action: body.action, messageId: body.messageId, userId: body.userId, sourceId: body.sourceId, duration: body.duration });
        if (result.ok && body.action === 'delete' && body.messageId) {
            state.messages = state.messages.map((item) => item.id === body.messageId ? { ...item, deleted: true } : item);
            broadcast();
        }
        response.json(result);
    }
    catch (error) {
        response.status(502).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
});
app.get('/api/categories/:platform', async (request, response) => {
    const platform = request.params.platform.toLowerCase() === 'twitch' ? 'Twitch' : request.params.platform.toLowerCase() === 'kick' ? 'Kick' : undefined;
    const query = String(request.query.query || '').trim();
    if (!platform || !query)
        return response.json([]);
    try {
        response.json(await searchCategories(platform, query));
    }
    catch (error) {
        console.error(`${platform} category search:`, error);
        response.status(502).json({ error: 'Category search failed' });
    }
});
app.post('/api/stream-info/:platform', async (request, response) => {
    const platform = request.params.platform.toLowerCase() === 'twitch' ? 'Twitch' : request.params.platform.toLowerCase() === 'kick' ? 'Kick' : undefined;
    if (!platform)
        return response.status(404).json({ error: 'Unknown stream platform' });
    const { title, category, categoryId } = request.body;
    const details = { title: String(title || '').trim(), category: String(category || '').trim(), ...(categoryId ? { categoryId: String(categoryId) } : {}) };
    const result = await updateStreamInfo(platform, details);
    if (result.ok)
        state.streamInfo[platform] = details;
    broadcast();
    response.json({ streamInfo: state.streamInfo, results: [result] });
});
app.post('/api/stream-info', async (request, response) => {
    const { title, Twitch, Kick } = request.body;
    const detailsByPlatform = { Twitch: { category: '', ...Twitch, title: String(title || '').trim() }, Kick: { category: '', ...Kick, title: String(title || '').trim() } };
    const results = await Promise.all(['Twitch', 'Kick'].map((platform) => updateStreamInfo(platform, detailsByPlatform[platform])));
    for (const result of results)
        if (result.ok)
            state.streamInfo[result.platform] = detailsByPlatform[result.platform];
    broadcast();
    response.json({ streamInfo: state.streamInfo, results });
});
app.post('/api/disconnect/:platform', (request, response) => {
    const platform = ['Twitch', 'Kick', 'YouTube'].find((item) => item.toLowerCase() === request.params.platform.toLowerCase());
    if (!platform)
        return response.status(404).json({ error: 'Unknown platform' });
    delete tokens[platform];
    saveTokens();
    const account = state.accounts.find((item) => item.platform === platform);
    if (account)
        Object.assign(account, { connected: false, live: false, viewers: 0, handle: '' });
    if (platform === 'Twitch')
        closeTwitchChat();
    if (platform === 'Kick')
        void kickChat.stop();
    broadcast();
    response.json({ ok: true });
});
app.get('/oauth/callback', async (request, response) => {
    const oauthState = oauthStates.get(String(request.query.state || ''));
    const platform = oauthState?.platform;
    const code = String(request.query.code || '');
    if (!code || !platform || Date.now() - oauthState.createdAt > 10 * 60 * 1000)
        return response.status(400).send('OAuth callback is missing a valid state or code.');
    oauthStates.delete(String(request.query.state));
    try {
        tokens[platform] = await exchangeCode(platform, code, oauthState.codeVerifier);
        saveTokens();
        const account = state.accounts.find((item) => item.platform === platform);
        if (account)
            Object.assign(account, { connected: true, handle: tokens[platform]?.user || platform });
        startAdapter(platform);
        broadcast();
        response.send('<script>window.close()</script>Connected. You can close this window.');
    }
    catch (error) {
        console.error(error);
        response.type('text').status(502).send(`OAuth exchange failed: ${error instanceof Error ? error.message : String(error)}`);
    }
});
app.get('/oauth/:platform', (request, response) => {
    const platform = ['Twitch', 'Kick', 'YouTube'].find((item) => item.toLowerCase() === request.params.platform.toLowerCase());
    if (!platform)
        return response.status(404).send('Unknown platform');
    const url = authorizationUrl(platform);
    if (!url)
        return response.status(500).send(`Missing ${platform} client ID. Configure the backend .env file.`);
    response.redirect(url);
});
const distPath = path.resolve(isPackaged ? path.join(path.dirname(process.execPath), 'dist') : './dist');
if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_request, response) => response.sendFile(path.join(distPath, 'index.html')));
}
httpServer.on('error', (error) => {
    if (error.code === 'EADDRINUSE')
        console.error(`Relay is already running on port ${port}. Close the existing relay-chat-dock.exe before starting another copy.`);
    else
        console.error('Relay backend failed to start:', error);
    process.exitCode = 1;
});
httpServer.listen(port, '0.0.0.0', () => console.log(`Relay backend listening on http://127.0.0.1:${port} (OBS dock URL)`));
for (const platform of ['Twitch', 'Kick', 'YouTube'])
    if (tokens[platform])
        startAdapter(platform);
setInterval(pollLiveState, 15_000);
setInterval(watchTwitchEventSub, 2_000);
setInterval(refreshChatHealth, 5_000);
function authorizationUrl(platform) {
    const clientId = process.env[`${platform.toUpperCase()}_CLIENT_ID`];
    if (!clientId)
        return null;
    const stateValue = crypto.randomBytes(24).toString('hex');
    const codeVerifier = platform === 'Kick' ? crypto.randomBytes(32).toString('base64url') : undefined;
    oauthStates.set(stateValue, { platform, createdAt: Date.now(), codeVerifier });
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', state: stateValue });
    if (platform === 'Twitch') {
        params.set('scope', 'user:read:email chat:read chat:edit user:read:chat user:write:chat channel:manage:broadcast moderator:manage:banned_users moderator:manage:chat_messages');
        params.set('force_verify', 'true');
    }
    if (platform === 'Kick') {
        params.set('scope', 'user:read channel:read channel:write chat:write events:subscribe moderation:ban moderation:chat_message:manage');
        params.set('code_challenge', crypto.createHash('sha256').update(codeVerifier).digest('base64url'));
        params.set('code_challenge_method', 'S256');
    }
    if (platform === 'YouTube') {
        params.set('access_type', 'offline');
        params.set('prompt', 'consent');
        params.set('scope', 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl');
    }
    return platform === 'Twitch' ? `https://id.twitch.tv/oauth2/authorize?${params}` : platform === 'Kick' ? `https://id.kick.com/oauth/authorize?${params}` : `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}
async function exchangeCode(platform, code, codeVerifier) {
    const json = await requestToken(platform, {
        client_id: process.env[`${platform.toUpperCase()}_CLIENT_ID`] || '',
        client_secret: process.env[`${platform.toUpperCase()}_CLIENT_SECRET`] || '',
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        ...(platform === 'Kick' ? { code_verifier: codeVerifier || '' } : {}),
    });
    const token = { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined };
    if (platform === 'Twitch') {
        const user = await twitchApi('/helix/users', token);
        token.user = user.data?.[0]?.login || 'Twitch';
        token.userId = user.data?.[0]?.id;
    }
    else if (platform === 'YouTube') {
        try {
            await hydrateYouTubeToken(token);
        }
        catch {
            token.user = token.user || 'YouTube';
        }
    }
    else
        await hydrateKickToken(token);
    return token;
}
async function hydrateYouTubeToken(token) {
    const channels = await youtubeApi('/channels?part=snippet&mine=true', token);
    const channel = channels.items?.[0]?.snippet;
    const handle = String(channel?.customUrl || '').replace(/^@/, '');
    token.user = channel?.title || handle || token.user || 'YouTube';
}
async function hydrateKickToken(token) {
    const [userResponse, channelResponse] = await Promise.all([kickApi('/users', token), kickApi('/channels', token)]);
    const userPayload = userResponse.ok ? await userResponse.json() : undefined;
    const channelPayload = channelResponse.ok ? await channelResponse.json() : undefined;
    const user = userPayload?.data?.[0];
    const channel = channelPayload?.data?.[0];
    token.user = channel?.slug || user?.name || token.user || 'Kick';
    token.userId = channel?.broadcaster_user_id ? String(channel.broadcaster_user_id) : user?.user_id ? String(user.user_id) : token.userId;
}
async function requestToken(platform, body) {
    const endpoint = platform === 'Twitch' ? 'https://id.twitch.tv/oauth2/token' : platform === 'Kick' ? 'https://id.kick.com/oauth/token' : 'https://oauth2.googleapis.com/token';
    const result = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    if (!result.ok)
        throw new Error(`${platform} token request: ${result.status} ${await result.text()}`);
    return result.json();
}
async function ensureToken(platform) {
    const token = tokens[platform];
    if (!token)
        return;
    if (!token.expiresAt || token.expiresAt - 120_000 > Date.now())
        return token;
    if (!token.refreshToken)
        return token;
    if (!refreshLocks.has(platform)) {
        refreshLocks.set(platform, refreshAccessToken(platform).finally(() => refreshLocks.delete(platform)));
    }
    return refreshLocks.get(platform);
}
async function refreshAccessToken(platform) {
    const token = tokens[platform];
    if (!token?.refreshToken)
        return token;
    try {
        const json = await requestToken(platform, {
            client_id: process.env[`${platform.toUpperCase()}_CLIENT_ID`] || '',
            client_secret: process.env[`${platform.toUpperCase()}_CLIENT_SECRET`] || '',
            grant_type: 'refresh_token',
            refresh_token: token.refreshToken,
        });
        tokens[platform] = {
            ...token,
            accessToken: json.access_token,
            refreshToken: json.refresh_token || token.refreshToken,
            expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : token.expiresAt,
        };
        saveTokens();
        console.log(`${platform} access token refreshed`);
        return tokens[platform];
    }
    catch (error) {
        console.error(`${platform} token refresh:`, error instanceof Error ? error.message : error);
        return tokens[platform];
    }
}
async function fetchTimed(url, options = {}, ms = 8_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    }
    catch (error) {
        if (error instanceof Error && error.name === 'AbortError')
            throw new Error(`Request timed out after ${ms}ms`);
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}
function summarizeApiError(status, text) {
    if (/504|Gateway Timeout/i.test(text) || status === 504)
        return 'Gateway Timeout (Twitch CDN busy)';
    if (/502|Bad Gateway/i.test(text) || status === 502)
        return 'Bad Gateway';
    if (/503|Service Unavailable/i.test(text) || status === 503)
        return 'Service Unavailable';
    try {
        const json = JSON.parse(text);
        return json.message || json.error || `HTTP ${status}`;
    }
    catch {
        const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return plain.slice(0, 160) || `HTTP ${status}`;
    }
}
async function twitchApi(endpoint, token, options = {}, retried = false) {
    let response;
    try {
        response = await fetchTimed(`https://api.twitch.tv${endpoint}`, {
            ...options,
            headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID || '', Authorization: `Bearer ${token.accessToken}`, ...options.headers },
        });
    }
    catch (error) {
        if (!retried)
            return twitchApi(endpoint, token, options, true);
        throw error;
    }
    if (response.status === 401 && !retried) {
        const refreshed = await refreshAccessToken('Twitch');
        if (refreshed)
            return twitchApi(endpoint, refreshed, options, true);
    }
    if ((response.status === 502 || response.status === 503 || response.status === 504) && !retried) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return twitchApi(endpoint, token, options, true);
    }
    const text = await response.text();
    if (!response.ok)
        throw new Error(`Twitch API ${response.status}: ${summarizeApiError(response.status, text)}`);
    return text ? JSON.parse(text) : {};
}
async function youtubeApi(endpoint, token, retried = false) {
    const localized = /[?&]hl=/.test(endpoint) ? endpoint : `${endpoint}${endpoint.includes('?') ? '&' : '?'}hl=en`;
    const response = await fetchTimed(`https://www.googleapis.com/youtube/v3${localized}`, { headers: { Authorization: `Bearer ${token.accessToken}` } }, 12_000);
    if (response.status === 401 && !retried) {
        const refreshed = await refreshAccessToken('YouTube');
        if (refreshed)
            return youtubeApi(endpoint, refreshed, true);
    }
    if (!response.ok)
        throw new Error(`YouTube API ${response.status}: ${await response.text()}`);
    return response.json();
}
function startAdapter(platform) {
    if (platform === 'Twitch') {
        twitchEventSubUnsupported = false;
        twitchBadgesLoaded = false;
        void ensureTwitchBadges();
        connectTwitchEventSub();
        setTimeout(() => { if (!twitchEventSubReady)
            connectTwitchIrc(); }, 4_000);
    }
    if (platform === 'Kick')
        void pollKick().catch((error) => console.error('Kick poll:', error instanceof Error ? error.message : error));
    if (platform === 'YouTube')
        void pollYouTube().catch((error) => console.error('YouTube poll:', error instanceof Error ? error.message : error));
}
function looksLikePlaceholder(handle) {
    return !handle || handle === 'Kick account' || handle.includes(' ');
}
function startKickChat(slug) {
    void kickChat.start(slug, (message) => addMessage({
        id: message.id || crypto.randomUUID(),
        platform: 'Kick',
        user: message.user,
        userId: message.userId,
        color: message.color,
        avatar: normalizeAvatar(message.avatar),
        badges: kickBadges(message.badges),
        text: message.text,
        time: new Date().toISOString(),
        parts: parseKickParts(message.text, message.emotes),
    }), tokens.Kick?.channelId ? Number(tokens.Kick.channelId) : undefined).then(() => {
        if (kickChat.currentChatroomId && tokens.Kick && tokens.Kick.channelId !== String(kickChat.currentChatroomId)) {
            tokens.Kick.channelId = String(kickChat.currentChatroomId);
            saveTokens();
        }
    }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Kick chat:', message);
        setHealth('Kick', 'down', 'Kick chat failed to connect — messages may be missing');
    });
}
function closeTwitchChat() {
    twitchEventSubGeneration += 1;
    twitchEventSubReady = false;
    twitchEventSubUnsupported = false;
    twitchIrcReady = false;
    twitchEventSub?.close();
    twitchIrc?.close();
    twitchEventSub = undefined;
    twitchIrc = undefined;
}
function connectTwitchEventSub(url = 'wss://eventsub.wss.twitch.tv/ws') {
    if (!tokens.Twitch?.userId || twitchEventSubUnsupported)
        return;
    const generation = ++twitchEventSubGeneration;
    const isResume = url !== 'wss://eventsub.wss.twitch.tv/ws';
    const socket = new WebSocket(url);
    twitchEventSub = socket;
    twitchEventSubReady = false;
    socket.on('message', (data) => {
        if (generation !== twitchEventSubGeneration)
            return;
        twitchLastEventSub = Date.now();
        let payload;
        try {
            payload = JSON.parse(String(data));
        }
        catch {
            return;
        }
        const type = payload?.metadata?.message_type;
        if (type === 'session_welcome') {
            twitchKeepaliveMs = Number(payload.payload?.session?.keepalive_timeout_seconds || 10) * 1000;
            if (isResume) {
                twitchEventSubReady = true;
                console.log('Twitch EventSub resumed');
            }
            else
                void subscribeTwitchChat(payload.payload.session.id);
        }
        else if (type === 'notification' && payload.metadata?.subscription_type === 'channel.chat.message') {
            const event = payload.payload?.event;
            addMessage({
                id: event?.message_id || crypto.randomUUID(),
                platform: 'Twitch',
                user: event?.chatter_user_name || event?.chatter_user_login || 'Twitch user',
                userId: event?.chatter_user_id ? String(event.chatter_user_id) : undefined,
                color: event?.color || undefined,
                badges: twitchBadgesFromList(event?.badges),
                avatar: normalizeAvatar(twitchAvatars.get(String(event?.chatter_user_id || ''))),
                text: event?.message?.text || '',
                time: new Date().toISOString(),
                parts: partsFromTwitchFragments(event?.message?.fragments, event?.message?.text || ''),
                emotes: (event?.message?.fragments || []).filter((item) => item.type === 'emote').map((item) => item.emote?.id).filter(Boolean),
            });
            setHealth('Twitch', 'ok');
        }
        else if (type === 'session_reconnect' && payload.payload?.session?.reconnect_url) {
            connectTwitchEventSub(payload.payload.session.reconnect_url);
        }
        else if (type === 'revocation') {
            console.error('Twitch EventSub revoked:', payload.payload?.subscription?.status);
            twitchEventSubReady = false;
            connectTwitchIrc();
        }
    });
    socket.on('close', () => {
        if (generation !== twitchEventSubGeneration)
            return;
        twitchEventSub = undefined;
        twitchEventSubReady = false;
        if (tokens.Twitch && !twitchEventSubUnsupported)
            setTimeout(() => connectTwitchEventSub(), 3_000);
    });
    socket.on('error', (error) => { console.error('Twitch EventSub:', error.message); socket.close(); });
}
async function subscribeTwitchChat(sessionId) {
    const token = await ensureToken('Twitch');
    if (!token?.userId)
        return;
    try {
        await twitchApi('/helix/eventsub/subscriptions', token, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'channel.chat.message',
                version: '1',
                condition: { broadcaster_user_id: token.userId, user_id: token.userId },
                transport: { method: 'websocket', session_id: sessionId },
            }),
        });
        twitchEventSubReady = true;
        twitchIrc?.close();
        setHealth('Twitch', 'ok');
        console.log(`Twitch EventSub subscribed for ${token.user}`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Twitch EventSub subscribe:', message);
        if (message.includes('403') || message.includes('401') || message.includes('scope')) {
            twitchEventSubUnsupported = true;
            console.log('Twitch chat falling back to IRC. Reconnect Twitch in settings to grant user:read:chat if you want EventSub.');
        }
        connectTwitchIrc();
    }
}
function watchTwitchEventSub() {
    if (!twitchEventSub || !twitchLastEventSub)
        return;
    if (Date.now() - twitchLastEventSub > twitchKeepaliveMs + 2_000)
        twitchEventSub.close();
}
function setHealth(platform, status, message = '') {
    const current = state.health[platform];
    if (current.status === status && current.message === message)
        return;
    state.health[platform] = { status, message };
    broadcast();
}
function ensureTwitchChat() {
    if (!tokens.Twitch)
        return;
    if (twitchEventSubReady)
        return;
    if (twitchIrc && twitchIrc.readyState === WebSocket.OPEN)
        return;
    if (twitchIrc) {
        try {
            twitchIrc.close();
        }
        catch {
            twitchIrc = undefined;
            twitchIrcReady = false;
            connectTwitchIrc();
            return;
        }
    }
    connectTwitchIrc();
}
function refreshChatHealth() {
    if (tokens.Twitch) {
        if (twitchEventSubReady || twitchIrcReady) {
            if (state.health.Twitch.status === 'down')
                setHealth('Twitch', 'ok');
        }
        else
            setHealth('Twitch', 'down', 'Twitch chat disconnected — messages may be missing');
        if (!twitchEventSubReady)
            ensureTwitchChat();
    }
    if (tokens.Kick) {
        if (kickChat.connected) {
            if (state.health.Kick.status === 'down')
                setHealth('Kick', 'ok');
        }
        else
            setHealth('Kick', 'down', 'Kick chat disconnected — messages may be missing');
    }
    if (tokens.YouTube) {
        const account = state.accounts.find((item) => item.platform === 'YouTube');
        if (account?.live && !tokens.YouTube.liveChatIds?.length && !tokens.YouTube.liveChatId)
            setHealth('YouTube', 'warn', 'YouTube is live but chat is unavailable');
    }
}
function connectTwitchIrc() {
    if (!tokens.Twitch?.user || twitchIrc || twitchEventSubReady)
        return;
    void ensureToken('Twitch').then(() => {
        if (!tokens.Twitch?.user || twitchIrc || twitchEventSubReady)
            return;
        openTwitchIrc();
    });
}
function openTwitchIrc() {
    if (!tokens.Twitch?.user || twitchIrc || twitchEventSubReady)
        return;
    const nick = tokens.Twitch.user.toLowerCase();
    twitchIrcReady = false;
    twitchIrc = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    twitchIrc.on('open', () => {
        const token = tokens.Twitch;
        if (!token || !twitchIrc)
            return;
        twitchIrc.send('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership\r\n');
        twitchIrc.send(`PASS oauth:${token.accessToken}\r\n`);
        twitchIrc.send(`NICK ${nick}\r\n`);
    });
    twitchIrc.on('message', (data) => {
        const raw = String(data);
        if (raw.includes('NOTICE * :Login authentication failed') || raw.includes('NOTICE * :Improperly formatted auth')) {
            console.error('Twitch IRC authentication failed; reconnect Twitch to refresh its token and chat scopes.');
            setHealth('Twitch', 'down', 'Twitch chat login failed — reconnect Twitch in settings');
            void refreshAccessToken('Twitch').then(() => twitchIrc?.close());
            return;
        }
        if (raw.includes(' 001 ')) {
            twitchIrc?.send(`JOIN #${nick}\r\n`);
            console.log(`Twitch IRC connected as ${nick}`);
        }
        if (raw.includes(' 366 ')) {
            twitchIrcReady = true;
            setHealth('Twitch', 'ok');
            console.log(`Twitch IRC joined #${nick}`);
        }
        parseTwitchLines(raw).forEach(addMessage);
    });
    twitchIrc.on('close', () => {
        twitchIrc = undefined;
        twitchIrcReady = false;
        if (tokens.Twitch && !twitchEventSubReady)
            setTimeout(connectTwitchIrc, 5_000);
    });
    twitchIrc.on('error', (error) => { console.error('Twitch IRC:', error.message); twitchIrc?.close(); });
}
function parseTwitchLines(raw) {
    return raw.split(/\r?\n/).flatMap((line) => {
        if (line.startsWith('PING')) {
            twitchIrc?.send('PONG :tmi.twitch.tv\r\n');
            return [];
        }
        const match = line.match(/^(?:@([^ ]+) )?:([^!]+)!.* PRIVMSG #[^ ]+ :(.*)$/);
        if (!match)
            return [];
        const tags = parseIrcTags(match[1] || '');
        const userId = tags['user-id'] || undefined;
        return [{ id: tags.id || crypto.randomUUID(), platform: 'Twitch', user: tags['display-name'] || match[2], userId, color: tags.color || undefined, badges: twitchBadgesFromTag(tags.badges), avatar: userId ? twitchAvatars.get(userId) : undefined, text: match[3], time: new Date().toISOString(), parts: parseTwitchEmoteParts(match[3], tags.emotes), emotes: tags.emotes ? tags.emotes.split('/').map((item) => item.split(':')[0]) : [] }];
    });
}
function parseIrcTags(raw) {
    return Object.fromEntries((raw || '').split(';').filter(Boolean).map((item) => {
        const index = item.indexOf('=');
        return index === -1 ? [item, ''] : [item.slice(0, index), item.slice(index + 1)];
    }));
}
function twitchBadgeLabel(set) {
    const name = set.toLowerCase();
    if (name === 'broadcaster')
        return 'HOST';
    if (name === 'moderator')
        return 'MOD';
    if (name === 'subscriber' || name === 'founder')
        return 'SUB';
    if (name === 'vip')
        return 'VIP';
    if (name === 'premium' || name === 'turbo')
        return 'PRIME';
    if (name === 'staff' || name === 'admin')
        return 'STAFF';
    if (name === 'partner' || name === 'verified')
        return '✓';
    if (name.includes('bit'))
        return 'BITS';
    if (name.includes('gift'))
        return 'GIFT';
    return '';
}
function twitchBadge(set, version) {
    return { title: set, url: twitchBadgeUrls.get(`${set}/${version || '1'}`), label: twitchBadgeLabel(set) };
}
function twitchBadgesFromTag(tag) {
    return (tag || '').split(',').filter(Boolean).map((item) => {
        const [set, version] = item.split('/');
        return twitchBadge(set, version || '1');
    }).filter((badge) => badge.url || badge.label).slice(0, 5);
}
function twitchBadgesFromList(badges) {
    return (badges || []).map((badge) => twitchBadge(String(badge.set_id || ''), String(badge.id || '1'))).filter((badge) => badge.url || badge.label).slice(0, 5);
}
async function ensureTwitchBadges() {
    const token = await ensureToken('Twitch');
    if (!token?.userId || twitchBadgesLoaded)
        return;
    try {
        const [globalBadges, channelBadges] = await Promise.all([
            twitchApi('/helix/chat/badges/global', token),
            twitchApi(`/helix/chat/badges?broadcaster_id=${token.userId}`, token),
        ]);
        twitchBadgeUrls.clear();
        for (const set of [...(globalBadges.data || []), ...(channelBadges.data || [])]) {
            for (const version of set.versions || []) {
                twitchBadgeUrls.set(`${set.set_id}/${version.id}`, version.image_url_2x || version.image_url_1x);
            }
        }
        twitchBadgesLoaded = true;
    }
    catch (error) {
        console.error('Twitch badges:', error instanceof Error ? error.message : error);
    }
}
function queueTwitchAvatar(userId) {
    if (!userId || twitchAvatars.has(userId) || twitchAvatarPending.has(userId))
        return;
    twitchAvatarPending.add(userId);
    if (twitchAvatarTimer)
        clearTimeout(twitchAvatarTimer);
    twitchAvatarTimer = setTimeout(() => { void flushTwitchAvatars(); }, 400);
}
async function flushTwitchAvatars() {
    const token = await ensureToken('Twitch');
    if (!token)
        return;
    const ids = [...twitchAvatarPending].slice(0, 80);
    ids.forEach((id) => twitchAvatarPending.delete(id));
    if (!ids.length)
        return;
    try {
        const result = await twitchApi(`/helix/users?${ids.map((id) => `id=${encodeURIComponent(id)}`).join('&')}`, token);
        for (const user of result.data || []) {
            const avatar = normalizeAvatar(user.profile_image_url);
            if (user.id && avatar)
                twitchAvatars.set(String(user.id), avatar);
        }
        let changed = false;
        state.messages = state.messages.map((item) => {
            if (item.platform !== 'Twitch' || !item.userId)
                return item;
            const avatar = twitchAvatars.get(item.userId);
            if (!avatar || item.avatar === avatar)
                return item;
            changed = true;
            return { ...item, avatar };
        });
        if (changed)
            broadcast();
    }
    catch (error) {
        console.error('Twitch avatars:', error instanceof Error ? error.message : error);
    }
    if (twitchAvatarPending.size)
        queueTwitchAvatar([...twitchAvatarPending][0]);
}
function kickBadges(badges) {
    return (badges || []).map((badge) => {
        const type = String(badge.type || '').toLowerCase();
        let label = '';
        if (type.includes('broadcaster') || type === 'og')
            label = 'HOST';
        else if (type.includes('mod'))
            label = 'MOD';
        else if (type.includes('sub'))
            label = 'SUB';
        else if (type.includes('vip'))
            label = 'VIP';
        else if (type.includes('verified'))
            label = '✓';
        else if (type.includes('staff'))
            label = 'STAFF';
        else if (type.includes('founder'))
            label = 'OG';
        return { title: badge.text || badge.type || label, label };
    }).filter((badge) => badge.label).slice(0, 4);
}
function normalizeAvatar(url) {
    if (!url)
        return;
    let next = String(url).trim();
    if (!next)
        return;
    if (next.startsWith('//'))
        next = `https:${next}`;
    else if (next.startsWith('http://'))
        next = `https://${next.slice(7)}`;
    if (/default-user|\/photo\.jpg(\?|$)/i.test(next))
        return;
    return next.replace(/=s\d+/i, '=s88');
}
function youtubeBadges(author) {
    const badges = [];
    if (author?.isChatOwner)
        badges.push({ title: 'Owner', label: 'HOST' });
    if (author?.isChatModerator)
        badges.push({ title: 'Moderator', label: 'MOD' });
    if (author?.isChatSponsor)
        badges.push({ title: 'Member', label: 'MEM' });
    if (author?.isVerified)
        badges.push({ title: 'Verified', label: '✓' });
    return badges;
}
function twitchEmoteUrl(id) {
    return `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/2.0`;
}
function kickEmoteUrl(id) {
    return `https://files.kick.com/emotes/${encodeURIComponent(id)}/fullsize`;
}
function parseTwitchEmoteParts(text, emotesTag) {
    if (!emotesTag)
        return [{ type: 'text', text }];
    const ranges = [];
    for (const emote of emotesTag.split('/').filter(Boolean)) {
        const [id, positions] = [emote.slice(0, emote.indexOf(':')), emote.slice(emote.indexOf(':') + 1)];
        if (!id || !positions)
            continue;
        for (const position of positions.split(',').filter(Boolean)) {
            const [start, end] = position.split('-').map(Number);
            if (Number.isFinite(start) && Number.isFinite(end) && end >= start)
                ranges.push({ start, end, id });
        }
    }
    if (!ranges.length)
        return [{ type: 'text', text }];
    ranges.sort((left, right) => left.start - right.start);
    const parts = [];
    let cursor = 0;
    for (const range of ranges) {
        if (range.start < cursor)
            continue;
        if (range.start > cursor)
            parts.push({ type: 'text', text: text.slice(cursor, range.start) });
        parts.push({ type: 'emote', name: text.slice(range.start, range.end + 1), url: twitchEmoteUrl(range.id) });
        cursor = range.end + 1;
    }
    if (cursor < text.length)
        parts.push({ type: 'text', text: text.slice(cursor) });
    return parts.length ? parts : [{ type: 'text', text }];
}
function partsFromTwitchFragments(fragments, fallback) {
    if (!fragments?.length)
        return fallback ? [{ type: 'text', text: fallback }] : [];
    const parts = [];
    for (const fragment of fragments) {
        if (fragment?.type === 'emote' && fragment.emote?.id)
            parts.push({ type: 'emote', name: String(fragment.text || ''), url: twitchEmoteUrl(String(fragment.emote.id)) });
        else if (fragment?.text)
            parts.push({ type: 'text', text: String(fragment.text) });
    }
    return parts.length ? parts : [{ type: 'text', text: fallback }];
}
function parseKickParts(text, emotes) {
    const token = /\[emote:(\d+):([^\]]+)\]/g;
    const parts = [];
    let cursor = 0;
    let matched = false;
    for (const match of text.matchAll(token)) {
        matched = true;
        const index = match.index || 0;
        if (index > cursor)
            parts.push({ type: 'text', text: text.slice(cursor, index) });
        parts.push({ type: 'emote', name: match[2], url: kickEmoteUrl(match[1]) });
        cursor = index + match[0].length;
    }
    if (matched) {
        if (cursor < text.length)
            parts.push({ type: 'text', text: text.slice(cursor) });
        return parts.length ? parts : [{ type: 'text', text }];
    }
    if (emotes?.length) {
        const ranges = emotes.flatMap((emote) => {
            const id = String(emote.emote_id || emote.id || '');
            const name = String(emote.name || '');
            return (emote.positions || []).map((position) => ({ start: Number(position.s ?? position.start), end: Number(position.e ?? position.end), id, name }));
        }).filter((range) => range.id && Number.isFinite(range.start) && Number.isFinite(range.end)).sort((left, right) => left.start - right.start);
        if (ranges.length) {
            let offset = 0;
            for (const range of ranges) {
                if (range.start < offset)
                    continue;
                if (range.start > offset)
                    parts.push({ type: 'text', text: text.slice(offset, range.start) });
                parts.push({ type: 'emote', name: range.name || text.slice(range.start, range.end + 1), url: kickEmoteUrl(range.id) });
                offset = range.end + 1;
            }
            if (offset < text.length)
                parts.push({ type: 'text', text: text.slice(offset) });
            return parts.length ? parts : [{ type: 'text', text }];
        }
    }
    return [{ type: 'text', text }];
}
function rememberOutgoing(entry) {
    const cutoff = Date.now() - 20_000;
    for (let index = recentOutgoing.length - 1; index >= 0; index--)
        if (recentOutgoing[index].at < cutoff)
            recentOutgoing.splice(index, 1);
    recentOutgoing.push(entry);
}
function ownHandles() {
    const names = new Set(['you']);
    for (const platform of ['Twitch', 'Kick', 'YouTube']) {
        const user = tokens[platform]?.user;
        if (user)
            names.add(user.toLowerCase());
    }
    for (const account of state.accounts)
        if (account.handle)
            names.add(account.handle.toLowerCase());
    return names;
}
const translationCache = new Map();
const translateQueue = [];
let translating = false;
const NON_ENGLISH = /[\u0400-\u052F\u0600-\u06FF\u0750-\u077F\u1100-\u11FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\u0590-\u05FF]/;
function needsTranslation(text) {
    return NON_ENGLISH.test(text);
}
async function translateToEnglish(text) {
    const key = text.trim();
    if (!key || !needsTranslation(key))
        return;
    const cached = translationCache.get(key);
    if (cached)
        return cached;
    const response = await fetchTimed(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(key.slice(0, 500))}`, { headers: { Accept: 'application/json' } }, 6_000);
    if (!response.ok)
        return;
    const data = await response.json();
    const translated = Array.isArray(data?.[0]) ? data[0].map((row) => String(row?.[0] || '')).join('').trim() : '';
    if (!translated || translated === key)
        return;
    translationCache.set(key, translated);
    if (translationCache.size > 2_000) {
        const oldest = translationCache.keys().next().value;
        if (oldest)
            translationCache.delete(oldest);
    }
    return translated;
}
async function applyTranslation(message) {
    const parts = message.parts?.length ? message.parts : (message.text ? [{ type: 'text', text: message.text }] : []);
    let changed = false;
    const next = [];
    for (const part of parts) {
        if (part.type !== 'text' || !needsTranslation(part.text)) {
            next.push(part);
            continue;
        }
        try {
            const translated = await translateToEnglish(part.text);
            if (translated) {
                next.push({ type: 'text', text: translated });
                changed = true;
            }
            else
                next.push(part);
        }
        catch {
            next.push(part);
        }
    }
    if (!changed)
        return;
    const index = state.messages.findIndex((item) => item.id === message.id);
    if (index < 0)
        return;
    const current = state.messages[index];
    const text = next.filter((part) => part.type === 'text').map((part) => part.text).join('') || current.text;
    state.messages = state.messages.map((item, itemIndex) => itemIndex === index ? { ...item, text, parts: next, originalText: current.originalText || current.text } : item);
    broadcast();
}
function queueTranslation(message) {
    const source = message.parts?.some((part) => part.type === 'text' && needsTranslation(part.text)) || needsTranslation(message.text);
    if (!source)
        return;
    translateQueue.push(message);
    void drainTranslations();
}
async function drainTranslations() {
    if (translating)
        return;
    translating = true;
    while (translateQueue.length) {
        const batch = translateQueue.splice(0, 3);
        await Promise.all(batch.map((item) => applyTranslation(item)));
    }
    translating = false;
}
function addMessage(message) {
    if (!message.text && !message.parts?.length)
        return;
    if (state.messages.some((item) => item.id === message.id))
        return;
    const incomingTime = Date.parse(message.time) || Date.now();
    const incomingPlatforms = message.platforms?.length ? message.platforms : [message.platform];
    const incomingIsOwn = ownHandles().has(message.user.toLowerCase());
    const tracked = recentOutgoing.find((item) => item.text === message.text && Math.abs(incomingTime - item.at) < 20_000);
    const mergeAt = tracked ? state.messages.findIndex((item) => item.id === tracked.id || (item.text === message.text && Math.abs(Date.parse(item.time) - incomingTime) < 20_000 && (incomingIsOwn || item.id === tracked.id))) : -1;
    if (mergeAt >= 0) {
        const current = state.messages[mergeAt];
        const preferred = tracked?.platforms || [];
        const platforms = [...new Set([...preferred, ...(current.platforms || [current.platform]), ...incomingPlatforms])];
        const already = current.platforms || [current.platform];
        const parts = current.parts?.some((part) => part.type === 'emote') ? current.parts : message.parts?.length ? message.parts : current.parts;
        const platformsUnchanged = platforms.length === already.length && platforms.every((platform) => already.includes(platform));
        if (platformsUnchanged && parts === current.parts)
            return;
        state.messages = state.messages.map((item, index) => index === mergeAt ? { ...item, platform: platforms[0], platforms, ...(parts ? { parts } : {}) } : item);
        broadcast();
        return;
    }
    const stored = { ...message, platforms: incomingPlatforms };
    state.messages = [...state.messages.slice(-199), stored];
    broadcast();
    queueTranslation(stored);
    if (stored.platform === 'Twitch')
        queueTwitchAvatar(stored.userId);
}
async function pollLiveState() {
    if (tokens.Twitch)
        try {
            await pollTwitch();
            if (state.health.Twitch.status === 'warn')
                setHealth('Twitch', twitchEventSubReady || twitchIrcReady ? 'ok' : 'down', twitchEventSubReady || twitchIrcReady ? '' : 'Twitch chat disconnected — messages may be missing');
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('Twitch poll:', message);
            if (state.health.Twitch.status !== 'down')
                setHealth('Twitch', twitchEventSubReady || twitchIrcReady ? 'warn' : 'down', twitchEventSubReady || twitchIrcReady ? 'Twitch status poll failed' : `Twitch poll failed — messages may be missing`);
            ensureTwitchChat();
        }
    if (tokens.YouTube)
        try {
            await pollYouTube();
            if (state.health.YouTube.status === 'warn')
                setHealth('YouTube', 'ok');
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('YouTube poll:', message);
            setHealth('YouTube', 'warn', 'YouTube poll failed — chat or counts may be stale');
        }
    if (tokens.Kick)
        try {
            await pollKick();
            if (kickChat.connected)
                setHealth('Kick', 'ok');
            else if (tokens.Kick)
                setHealth('Kick', 'down', 'Kick chat disconnected — messages may be missing');
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('Kick poll:', message);
            if (!kickChat.connected)
                setHealth('Kick', 'down', 'Kick poll failed — messages may be missing');
            else
                setHealth('Kick', 'warn', 'Kick status poll failed');
        }
    refreshChatHealth();
    broadcast();
}
async function pollTwitch() {
    const token = await ensureToken('Twitch');
    if (!token)
        return;
    const streams = await twitchApi(`/helix/streams?user_id=${token.userId}`, token);
    const account = state.accounts.find((item) => item.platform === 'Twitch');
    const stream = streams.data?.[0];
    Object.assign(account, { live: Boolean(stream), viewers: stream?.viewer_count || 0, handle: token.user || account.handle });
    if (stream) {
        state.streamInfo.Twitch = { title: stream.title || '', category: stream.game_name || '', categoryId: stream.game_id || undefined };
    }
    else {
        const channel = await twitchApi(`/helix/channels?broadcaster_id=${token.userId}`, token);
        const info = channel.data?.[0];
        if (info)
            state.streamInfo.Twitch = { title: info.title || '', category: info.game_name || '', categoryId: info.game_id || undefined };
    }
    void ensureTwitchBadges();
    ensureTwitchChat();
}
async function pollYouTube() {
    const token = await ensureToken('YouTube');
    if (!token)
        return;
    const account = state.accounts.find((item) => item.platform === 'YouTube');
    let broadcasts;
    try {
        broadcasts = await youtubeApi('/liveBroadcasts?part=snippet,contentDetails,status&broadcastStatus=active&broadcastType=all&maxResults=10', token);
    }
    catch {
        broadcasts = await youtubeApi('/liveBroadcasts?part=snippet,contentDetails,status&mine=true&maxResults=10', token);
    }
    const liveItems = (broadcasts.items || []).filter((item) => item.status?.lifeCycleStatus === 'live');
    const videoIds = liveItems.map((item) => item.id).filter(Boolean);
    let videos = [];
    let viewers = 0;
    if (videoIds.length) {
        try {
            const result = await youtubeApi(`/videos?part=snippet,liveStreamingDetails&id=${videoIds.map((id) => encodeURIComponent(id)).join(',')}`, token);
            videos = result.items || [];
            viewers = videos.reduce((total, item) => total + Number(item.liveStreamingDetails?.concurrentViewers || 0), 0);
        }
        catch { /* liveStreamingDetails is optional */ }
    }
    if (looksLikePlaceholder(token.user || '') || token.user === 'YouTube') {
        try {
            await hydrateYouTubeToken(token);
            saveTokens();
        }
        catch (error) {
            console.error('YouTube profile:', error instanceof Error ? error.message : error);
        }
    }
    labelYouTubeChats(liveItems, videos);
    const chatIds = [...new Set(liveItems.map((item) => item.snippet?.liveChatId || item.contentDetails?.activeLiveChatId).filter(Boolean))];
    token.liveChatIds = chatIds;
    token.liveChatId = chatIds[0];
    Object.assign(account, { live: liveItems.length > 0, viewers, handle: token.user && !looksLikePlaceholder(token.user) ? token.user : account.handle });
    if (liveItems.length)
        console.log(`YouTube lives: ${liveItems.length} chat(s), ${viewers} viewers`);
    for (const chatId of chatIds) {
        try {
            const messages = await youtubeApi(`/liveChat/messages?liveChatId=${encodeURIComponent(chatId)}&part=snippet,authorDetails`, token);
            for (const item of messages.items || [])
                if (!youtubeSeen.has(item.id)) {
                    youtubeSeen.add(item.id);
                    addMessage({
                        id: item.id,
                        platform: 'YouTube',
                        user: String(item.authorDetails?.displayName || 'YouTube user').replace(/^@+/, ''),
                        userId: item.authorDetails?.channelId,
                        avatar: normalizeAvatar(item.authorDetails?.profileImageUrl),
                        badges: youtubeBadges(item.authorDetails),
                        sourceId: chatId,
                        sourceLabel: chatIds.length > 1 ? youtubeChatLabels.get(chatId) : undefined,
                        text: item.snippet?.textMessageDetails?.messageText || item.snippet?.displayMessage || '',
                        time: item.snippet?.publishedAt || new Date().toISOString(),
                    });
                }
        }
        catch (error) {
            console.error('YouTube chat poll:', error instanceof Error ? error.message : error);
        }
    }
}
function labelYouTubeChats(liveItems, videos) {
    youtubeChatLabels.clear();
    const rows = liveItems.map((item) => {
        const chatId = item.snippet?.liveChatId || item.contentDetails?.activeLiveChatId;
        const video = videos.find((entry) => entry.id === item.id);
        const title = String(item.snippet?.title || video?.snippet?.title || '');
        const viewers = Number(video?.liveStreamingDetails?.concurrentViewers || 0);
        return { chatId, title, viewers };
    }).filter((row) => row.chatId);
    const topViewers = Math.max(0, ...rows.map((row) => row.viewers));
    for (const row of rows) {
        const shorts = /short/i.test(row.title) || (rows.length > 1 && row.viewers < topViewers);
        youtubeChatLabels.set(row.chatId, shorts ? 'Shorts' : 'Live');
    }
    if (rows.length > 1 && [...youtubeChatLabels.values()].every((label) => label === 'Live')) {
        const secondary = rows.slice().sort((left, right) => right.viewers - left.viewers)[1];
        if (secondary?.chatId)
            youtubeChatLabels.set(secondary.chatId, 'Shorts');
    }
}
async function pollKick() {
    const token = await ensureToken('Kick');
    if (!token)
        return;
    const response = await kickApi('/channels', token);
    if (!response.ok) {
        if (response.status === 401)
            await refreshAccessToken('Kick');
        return;
    }
    const payload = await response.json();
    const channel = payload.data?.[0];
    const account = state.accounts.find((item) => item.platform === 'Kick');
    const slug = channel?.slug || (!looksLikePlaceholder(token.user || '') ? token.user : '');
    if (slug && token.user !== slug) {
        token.user = slug;
        saveTokens();
    }
    if (channel?.broadcaster_user_id && token.userId !== String(channel.broadcaster_user_id)) {
        token.userId = String(channel.broadcaster_user_id);
        saveTokens();
    }
    Object.assign(account, { live: Boolean(channel?.stream?.is_live), viewers: Number(channel?.stream?.viewer_count || 0), handle: slug || account.handle });
    if (channel) {
        state.streamInfo.Kick = {
            title: channel.stream_title || state.streamInfo.Kick.title,
            category: channel.category?.name || state.streamInfo.Kick.category,
            ...(channel.category?.id ? { categoryId: String(channel.category.id) } : {}),
        };
    }
    if (slug)
        startKickChat(slug);
    else
        await kickChat.stop();
}
async function sendMessage(platform, text) {
    if (!tokens[platform])
        return { platform, ok: false, error: 'Not connected' };
    try {
        if (platform === 'Twitch')
            return { platform, ...(await sendTwitchMessage(text)) };
        if (platform === 'Kick')
            return { platform, ...(await sendKickMessage(text)) };
        if (platform === 'YouTube')
            return { platform, ...(await sendYouTubeMessage(text)) };
    }
    catch (error) {
        return { platform, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return { platform, ok: false, error: `${platform} chat is not live or its API adapter is unavailable` };
}
async function sendTwitchMessage(text) {
    const nick = tokens.Twitch?.user?.toLowerCase();
    if (twitchIrc?.readyState === WebSocket.OPEN && twitchIrcReady && nick) {
        twitchIrc.send(`PRIVMSG #${nick} :${text}\r\n`);
        return { ok: true };
    }
    const helix = await sendTwitchHelix(text);
    if (helix.ok)
        return helix;
    await waitForTwitchIrc();
    if (twitchIrc?.readyState === WebSocket.OPEN && twitchIrcReady && nick) {
        twitchIrc.send(`PRIVMSG #${nick} :${text}\r\n`);
        return { ok: true };
    }
    return { ok: false, error: helix.error || 'Twitch chat is not ready; reconnect Twitch and try again' };
}
async function sendTwitchHelix(text) {
    const token = await ensureToken('Twitch');
    if (!token?.userId)
        return { ok: false, error: 'Twitch user id missing' };
    try {
        const result = await twitchApi('/helix/chat/messages', token, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ broadcaster_id: token.userId, sender_id: token.userId, message: text }),
        });
        if (result.data?.[0]?.is_sent === false)
            return { ok: false, error: result.data[0].drop_reason?.message || 'Twitch dropped the message' };
        return { ok: true, id: result.data?.[0]?.message_id };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
async function sendKickMessage(text) {
    const token = await ensureToken('Kick');
    if (!token)
        return { ok: false, error: 'Not connected' };
    const response = await kickApi('/chat', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, type: 'user', ...(token.userId ? { broadcaster_user_id: Number(token.userId) } : {}) }),
    });
    if (response.ok)
        return { ok: true };
    return { ok: false, error: await response.text() };
}
async function sendYouTubeMessage(text) {
    const token = await ensureToken('YouTube');
    if (!token)
        return { ok: false, error: 'Not connected' };
    const chatIds = token.liveChatIds?.length ? token.liveChatIds : token.liveChatId ? [token.liveChatId] : [];
    if (!chatIds.length)
        return { ok: false, error: 'YouTube chat is not live' };
    const results = await Promise.all(chatIds.map((liveChatId) => fetch('https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ snippet: { liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: text } } }),
    })));
    const failed = await Promise.all(results.filter((result) => !result.ok).map((result) => result.text()));
    return { ok: results.some((result) => result.ok), error: failed.length ? failed.join(' | ') : undefined };
}
async function moderate(platform, body) {
    if (!tokens[platform])
        return { ok: false, error: 'Not connected' };
    if (platform === 'Twitch')
        return moderateTwitch(body);
    if (platform === 'Kick')
        return moderateKick(body);
    if (platform === 'YouTube')
        return moderateYouTube(body);
    return { ok: false, error: `${platform} moderation is not available` };
}
async function moderateTwitch(body) {
    const token = await ensureToken('Twitch');
    if (!token?.userId)
        return { ok: false, error: 'Twitch is not connected' };
    const id = token.userId;
    if (body.action === 'delete') {
        if (!body.messageId)
            return { ok: false, error: 'Message id is required' };
        await twitchApi(`/helix/moderation/chat?broadcaster_id=${id}&moderator_id=${id}&message_id=${encodeURIComponent(body.messageId)}`, token, { method: 'DELETE' });
        return { ok: true };
    }
    if (!body.userId)
        return { ok: false, error: 'User id is required' };
    const data = { user_id: body.userId, reason: 'Relayed from OBS dock' };
    if (body.action === 'timeout')
        data.duration = Math.max(1, Number(body.duration || 60));
    await twitchApi(`/helix/moderation/bans?broadcaster_id=${id}&moderator_id=${id}`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
    });
    return { ok: true };
}
async function moderateKick(body) {
    const token = await ensureToken('Kick');
    if (!token?.userId)
        return { ok: false, error: 'Kick is not connected' };
    if (body.action === 'delete') {
        if (!body.messageId)
            return { ok: false, error: 'Message id is required' };
        const response = await kickApi(`/chat/${encodeURIComponent(body.messageId)}`, token, { method: 'DELETE' });
        if (!response.ok)
            return { ok: false, error: await response.text() };
        return { ok: true };
    }
    if (!body.userId)
        return { ok: false, error: 'User id is required' };
    const payload = {
        broadcaster_user_id: Number(token.userId),
        user_id: Number(body.userId),
        reason: 'Relayed from OBS dock',
    };
    if (body.action === 'timeout')
        payload.duration = Math.max(1, Math.round(Number(body.duration || 60) / 60) || 1);
    const response = await kickApi('/moderation/bans', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok)
        return { ok: false, error: await response.text() };
    return { ok: true };
}
async function moderateYouTube(body) {
    const token = await ensureToken('YouTube');
    if (!token)
        return { ok: false, error: 'YouTube is not connected' };
    if (body.action === 'delete') {
        if (!body.messageId)
            return { ok: false, error: 'Message id is required' };
        const result = await fetch(`https://www.googleapis.com/youtube/v3/liveChat/messages?id=${encodeURIComponent(body.messageId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token.accessToken}` } });
        if (!result.ok)
            return { ok: false, error: await result.text() };
        return { ok: true };
    }
    const chatIds = [...new Set([body.sourceId, ...(token.liveChatIds || []), token.liveChatId].filter(Boolean))];
    if (!body.userId || !chatIds.length)
        return { ok: false, error: 'YouTube user or live chat is missing' };
    const results = await Promise.all(chatIds.map((liveChatId) => fetch('https://www.googleapis.com/youtube/v3/liveChat/bans?part=snippet', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            snippet: {
                liveChatId,
                type: body.action === 'timeout' ? 'temporary' : 'permanent',
                ...(body.action === 'timeout' ? { banDurationSeconds: Math.max(1, Number(body.duration || 60)) } : {}),
                bannedUserDetails: { channelId: body.userId },
            },
        }),
    })));
    const failed = await Promise.all(results.filter((result) => !result.ok).map((result) => result.text()));
    return { ok: results.some((result) => result.ok), error: failed.length ? failed.join(' | ') : undefined };
}
async function waitForTwitchIrc() {
    if (!twitchIrc && !twitchEventSubReady)
        connectTwitchIrc();
    for (let attempt = 0; attempt < 40 && (!twitchIrc || twitchIrc.readyState !== WebSocket.OPEN || !twitchIrcReady); attempt++) {
        if (twitchEventSubReady)
            return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}
async function kickApi(endpoint, token = tokens.Kick, options = {}, retried = false) {
    const current = token || await ensureToken('Kick');
    if (!current)
        throw new Error('Kick is not connected');
    const base = process.env.KICK_API_BASE || 'https://api.kick.com/public/v1';
    const response = await fetchTimed(`${base}${endpoint}`, {
        ...options,
        headers: { Authorization: `Bearer ${current.accessToken}`, Accept: 'application/json', ...options.headers },
    });
    if (response.status === 401 && !retried) {
        const refreshed = await refreshAccessToken('Kick');
        if (refreshed)
            return kickApi(endpoint, refreshed, options, true);
    }
    return response;
}
async function searchCategories(platform, query) {
    if (platform === 'Twitch') {
        const token = await ensureToken('Twitch');
        const result = await twitchApi(`/helix/search/categories?query=${encodeURIComponent(query)}`, token);
        return (result.data || []).map((item) => ({ id: String(item.id), name: item.name }));
    }
    const response = await kickApi(`/categories?q=${encodeURIComponent(query)}&page=1`);
    if (!response.ok)
        throw new Error(`Kick categories ${response.status}: ${await response.text()}`);
    const result = await response.json();
    return (result.data || []).map((item) => ({ id: String(item.id), name: item.name }));
}
async function updateStreamInfo(platform, info) {
    if (!tokens[platform])
        return { platform, ok: false, error: 'Not connected' };
    if (platform === 'Twitch') {
        const token = await ensureToken('Twitch');
        if (!token)
            return { platform, ok: false, error: 'Not connected' };
        const games = info.categoryId ? { data: [{ id: info.categoryId }] } : await twitchApi(`/helix/games?name=${encodeURIComponent(info.category)}`, token);
        const body = { title: info.title, ...(games.data?.[0]?.id ? { game_id: games.data[0].id } : {}) };
        try {
            await twitchApi(`/helix/channels?broadcaster_id=${token.userId}`, token, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            return { platform, ok: true };
        }
        catch (error) {
            return { platform, ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    if (platform === 'Kick') {
        const response = await kickApi('/channels', undefined, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stream_title: info.title, ...(info.categoryId ? { category_id: Number(info.categoryId) } : {}) }) });
        return { platform, ok: response.ok, error: response.ok ? undefined : await response.text() };
    }
    return { platform, ok: false, error: 'Unsupported stream platform' };
}
function broadcast() { const payload = `data: ${JSON.stringify(state)}\n\n`; for (const client of clients)
    client.write(payload); }
function loadTokens() { try {
    return JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
}
catch {
    return {};
} }
function saveTokens() { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 }); }
