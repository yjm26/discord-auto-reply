// index.js

require('dotenv').config(); // Load environment variables from .env
const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');

// === Configuration and Constants ===
const CONFIG = {
    READ_DELAY: 15,
    MAX_REPLY_DELAY: 1, // Ganti kembali ke 2
    HUMAN_DELAY: { MIN: 1000, MAX: 5000 },
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY, // Ambil dari .env
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,   // Ambil dari .env
    TARGET_CHANNEL_ID: process.env.TARGET_CHANNEL_ID, // Ambil dari .env
    LOG_FILE_PATH: path.join(__dirname, 'bot_activity.log') // Path untuk file log
};

const DISCORD_API_BASE = 'https://discord.com/api/v9';

// Headers untuk permintaan Discord API
const DISCORD_HEADERS = {
    getStandardHeaders: () => ({
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }),
    getGetHeaders: (token) => ({
        ...DISCORD_HEADERS.getStandardHeaders(),
        'Authorization': token
    }),
    getPostHeaders: (token) => ({
        ...DISCORD_HEADERS.getStandardHeaders(),
        'Authorization': token,
        'Content-Type': 'application/json'
    })
};

// Add your own banned words here to filter messages
const bannedWords = []; // Example: ["spam", "unwanted", "filter"]


// === Globals and State ===
let requestQueue = [];
let isProcessingQueue = false;
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1000;

let botUserId = null;
let lastMessageId = null;
const repliedMessages = new Set();
let isRunning = false;

// Memory system per-channel (simplified for Node.js)
const channelMemory = new Map(); // channelId -> { history: [{u, r, t}] }

// === Utility Functions ===

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
const sessionIds = {
    launch_id: generateUUID(),
    launch_signature: generateUUID(),
    heartbeat_session: generateUUID()
};
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function mulberry32(seed) { return function () { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function seeded(channelId) { let seed = 0; for (let i = 0; i < channelId.length; i++) seed = (seed * 31 + channelId.charCodeAt(i)) >>> 0; return mulberry32(seed); }
function rememberTurn(channelId, userMsg, reply) {
    const mem = channelMemory.get(channelId) || { history: [] };
    mem.history.push({ u: userMsg, r: reply, t: Date.now() });
    if (mem.history.length > 50) mem.history.shift();
    channelMemory.set(channelId, mem);
}


// === Logging ===

async function logToFile(logEntry) {
    try {
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] ${logEntry}\n`;
        await fs.appendFile(CONFIG.LOG_FILE_PATH, logLine, 'utf8');
    } catch (error) {
        console.error(`[FATAL LOG ERROR] Could not write to log file: ${error.message}`);
    }
}

function log(msg, isCritical = false) {
    const fullMsg = `[Discord Auto Reply] ${msg}`;
    console.log(fullMsg);
    // Log ke file jika bukan log startup/stop
    if (isRunning || isCritical) {
        logToFile(msg);
    }
}
log.critical = (msg) => log(msg, true);


// === Request queue with rate limiting (using Axios) ===

function addToQueue(requestFunc, priority = 0) {
    return new Promise((resolve, reject) => {
        requestQueue.push({ requestFunc, resolve, reject, priority });
        requestQueue.sort((a, b) => b.priority - a.priority);
        processQueue();
    });
}

async function processQueue() {
    if (isProcessingQueue || requestQueue.length === 0) return;
    isProcessingQueue = true;
    while (requestQueue.length > 0) {
        const { requestFunc, resolve, reject } = requestQueue.shift();
        const delta = Date.now() - lastRequestTime;
        if (delta < MIN_REQUEST_INTERVAL) await sleep(MIN_REQUEST_INTERVAL - delta);
        try {
            resolve(await requestFunc());
        } catch (error) {
            reject(error);
        }
        lastRequestTime = Date.now();
    }
    isProcessingQueue = false;
}

async function queuedAxiosWithRetry(url, options = {}, maxRetries = 5) {
    let attempt = 0;
    while (true) {
        try {
            const response = await axios({ url, ...options });
            return response;
        } catch (error) {
            attempt++;
            if (error.response && error.response.status === 429) {
                let retryAfter = parseFloat(error.response.headers['retry-after']);
                if (Number.isNaN(retryAfter)) retryAfter = Math.min(60, 2 ** attempt);
                log.critical(`Discord Rate Limit hit. Retrying after ${retryAfter}s...`);
                if (attempt > maxRetries) throw new Error('Exceeded max retries on 429');
                await sleep((retryAfter * 1000) + 250);
            } else if (attempt > maxRetries) {
                throw error;
            } else {
                log.critical(`Request failed, attempt ${attempt}. Retrying in ${500 * attempt}ms.`);
                await sleep(500 * attempt);
            }
        }
    }
}


// === Discord API functions (Adapted for Node.js) ===

async function getMessages(channelId, limit = 50) {
    if (!CONFIG.DISCORD_TOKEN) return [];
    return addToQueue(async () => {
        const headers = DISCORD_HEADERS.getGetHeaders(CONFIG.DISCORD_TOKEN);
        const url = `${DISCORD_API_BASE}/channels/${channelId}/messages?limit=${limit}`;
        try {
            const res = await queuedAxiosWithRetry(url, { method: 'GET', headers });
            return res.data;
        } catch (error) {
            log.critical(`Failed to get messages: ${error.message}`);
            return [];
        }
    });
}

async function getBotUserId() {
    if (!CONFIG.DISCORD_TOKEN) return null;
    return addToQueue(async () => {
        const headers = DISCORD_HEADERS.getGetHeaders(CONFIG.DISCORD_TOKEN);
        const url = `${DISCORD_API_BASE}/users/@me`;
        try {
            const res = await queuedAxiosWithRetry(url, { method: 'GET', headers });
            return res.data.id;
        } catch (error) {
            log.critical(`Failed to get user ID: ${error.message}`);
            return null;
        }
    });
}

async function simulateTyping(channelId) {
    if (!CONFIG.DISCORD_TOKEN) return;
    return addToQueue(async () => {
        const headers = DISCORD_HEADERS.getPostHeaders(CONFIG.DISCORD_TOKEN);
        delete headers['Content-Type']; // Typing endpoint doesn't need Content-Type
        const url = `${DISCORD_API_BASE}/channels/${channelId}/typing`;
        try {
            await queuedAxiosWithRetry(url, { method: 'POST', headers });
        } catch (error) {
            log.critical(`Failed to simulate typing: ${error.message}`);
        }
    }, 1);
}

async function sendReply(channelId, messageId, content) {
    if (!CONFIG.DISCORD_TOKEN) return false;
    return addToQueue(async () => {
        const headers = DISCORD_HEADERS.getPostHeaders(CONFIG.DISCORD_TOKEN);
        const url = `${DISCORD_API_BASE}/channels/${channelId}/messages`;
        const body = {
            content,
            message_reference: { message_id: messageId, channel_id: channelId },
            allowed_mentions: { replied_user: false }
        };
        try {
            const res = await queuedAxiosWithRetry(url, { method: 'POST', headers, data: body });
            return res.status === 200;
        } catch (error) {
            log.critical(`Failed to send reply: ${error.message}`);
            return false;
        }
    }, 2);
}


// === Text processing utilities (Keep as is) ===
function containsBannedWord(text) {
    const words = (text || '').toLowerCase().split(/\s+/);
    return words.some(w => bannedWords.includes(w));
}
function levenshteinDistance(a, b) {
    // ... (keep the function)
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) matrix[i][j] = matrix[i - 1][j - 1];
            else matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
        }
    }
    return matrix[b.length][a.length];
}
function calculateSimilarity(a, b) {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1.0;
    const editDistance = levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
}
function pickNovelCandidate(candidates, channelId) {
    const mem = channelMemory.get(channelId);
    const recent = mem?.history?.slice(-10).map(h => h.r) || [];
    let best = candidates[0], bestScore = Infinity;
    for (const c of candidates) {
        const score = recent.reduce((acc, prev) => acc + (1 - calculateSimilarity(c.toLowerCase(), (prev || '').toLowerCase())), 0);
        if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
}
async function variableTyping(channelId, text) {
    await simulateTyping(channelId);
    const cps = 7 + Math.random() * 8;
    const dur = Math.min(6000, Math.max(900, (text?.length || 20) / cps * 1000));
    await sleep(dur);
}
function sanitizeFinal(text) {
    let out = (text || '').trim();
    out = out.replace(/[–—]/g, ',');
    out = out.replace(/\s+/g, ' ');
    out = out.replace(/'/g, '');
    out = out.toLowerCase();
    out = out.replace(/[!.]+$/, '');
    return out.trim();
}
function humanize(text, rng) {
    let out = (text || '').trim();
    out = out.replace(/[–—]/g, ',');
    out = out.replace(/\s+/g, ' ').replace(/ +([,?])/g, '$1');
    if (rng() < 0.10 && out.length > 25) {
        const hedges = ['honestly,', 'tbh,', 'i think', 'fwiw,'];
        out = `${hedges[Math.floor(rng() * hedges.length)]} ${out.charAt(0).toLowerCase()}${out.slice(1)}`;
    }
    return out;
}
function enforceShortness(text) {
    let clean = text || '';
    clean = clean.replace(/[–—]/g, ',');
    const words = clean.trim().split(/\s+/);
    if (words.length > 12) clean = words.slice(0, 12).join(' ');
    clean = clean.replace(/[!.]+$/, '');
    return clean.trim();
}
function enforceCommunityPerspective(text) {
    let out = text || '';
    out = out.replace(/\bour team\b/gi, 'the team')
                 .replace(/\bwe are\b/gi, 'they are')
                 .replace(/\bwe were\b/gi, 'they were')
                 .replace(/\bwe will\b/gi, 'they will')
                 .replace(/\bwe do\b/gi, 'they do')
                 .replace(/\bwe\b/gi, 'they')
                 .replace(/\bours\b/gi, 'theirs')
                 .replace(/\bour\b/gi, 'their');
    out = out.replace(/\bi (know|confirm|guarantee)\b/gi, 'from what i know');
    return out;
}
function isLikelyInsiderQuestion(prompt) {
    const strictInsiderPatterns = [
        /\b(hire|hiring|recruit|application|apply for|job opening|position available)\b/i,
        /\b(roadmap|timeline|release date|launch date|when will.*release)\b/i,
        /\b(are you (staff|team|admin|mod)|team member|official response)\b/i,
        /\b(partnership with|funding round|investor|vc)\b/i,
        /\b(whitelist spot|airdrop allocation|insider.*info)\b/i
    ];
    const lower = (prompt || '').toLowerCase();
    return strictInsiderPatterns.some(pattern => pattern.test(lower));
}
function overrideIfInsider(prompt, reply) {
    if (isLikelyInsiderQuestion(prompt)) {
        if (/\b(dont know|no clue|not sure|cant say|no idea|wish i knew|haven.*heard)\b/i.test(reply)) {
            return reply;
        }
        const denyReplies = [
            'no clue tbh',
            'not sure honestly',
            'wish i knew',
            'havent heard anything',
            'no idea bout that'
        ];
        return denyReplies[Math.floor(Math.random() * denyReplies.length)];
    }
    return reply;
}


// === AI Reply Generation (Adapted for Axios) ===

async function generateReply(prompt, apiKey, channelId) {
    const rng = seeded(channelId || 'default');
    const userUsedEmoji = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}]/u.test(prompt || '');

    // CUSTOMIZE THIS: Your bot's personality and instructions
    const systemGuidance = `
you're a regular community member chatting naturally. respond like you would to a friend.

personality:
- genuine and laid back
- supportive when needed
- match the conversation energy
- be contextual and relevant

response style:
- keep it short and casual (5-15 words)
- all lowercase, no apostrophes, no ending punctuation
- vary your responses - dont repeat patterns
- use natural reactions that fit the context
- sometimes just be direct without extra words
- only reply in english
- do not reply to non-english chats

context-based responses:
- greetings: respond warmly
- good news: show excitement
- problems: show empathy
- questions: help if you can, admit if you dont know
- casual chat: engage naturally

avoid repetitive starts - mix between direct responses, questions, reactions, and casual phrases naturally.
    `.trim();

    // CUSTOMIZE THIS: Add your own example conversations
    const fewshot = [
        {u: "hello", a: "hey there!"},
        {u: "how are you?", a: "doing well, thanks for asking"},
        {u: "what's up", a: "not much, just chilling"},
        {u: "thanks", a: "no problem!"},
        {u: "good morning", a: "morning!"}
    ];

    const contents = [
        { role: "user", parts: [{ text:
`instruction:
${systemGuidance}

example conversations:
${fewshot.map(p=>`human: ${p.u}\nyou: ${p.a}`).join('\n')}

respond to this:
${prompt}` }]}
    ];

    function isWeakReply(t) {
        const s = (t || '').trim().toLowerCase();
        return !s || s === 'i dont know';
    }

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
    const headers = { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey };
    const data = {
        contents,
        generationConfig: {
            temperature: 0.9,
            topP: 0.85,
            maxOutputTokens: 35,
            candidateCount: 6
        }
    };

    try {
        const response = await axios.post(url, data, { headers });
        const resData = response.data;
        
        const cands = (resData.candidates || [])
            .map(c => c?.content?.parts?.[0]?.text?.trim())
            .filter(Boolean)
            .map(t => t.replace(/\n+/g, ' ').trim());

        let filtered = cands.map(t => userUsedEmoji ? t : t.replace(/[\p{Extended_Pictographic}]/gu, ''));

        const recentMemory = channelMemory.get(channelId);
        const recentReplies = recentMemory?.history?.slice(-5).map(h => (h.r || '').toLowerCase()) || [];
        const overusedStarters = ['ah', 'fr', 'tbh', 'ngl'];
        const starterCount = {};
        recentReplies.forEach(reply => {
            const firstWord = reply.split(' ')[0];
            if (overusedStarters.includes(firstWord)) {
                starterCount[firstWord] = (starterCount[firstWord] || 0) + 1;
            }
        });
        filtered = filtered.filter(cand => {
            const firstWord = cand.toLowerCase().split(' ')[0];
            return !(overusedStarters.includes(firstWord) && (starterCount[firstWord] || 0) >= 2);
        });

        if (!filtered.length) return null;

        const unique = [];
        filtered.forEach(t => {
            if (!unique.some(u => calculateSimilarity(u.toLowerCase(), t.toLowerCase()) > 0.75)) {
                unique.push(t);
            }
        });

        if (!unique.length) return null;

        let chosen = pickNovelCandidate(unique, channelId);
        chosen = enforceCommunityPerspective(chosen);
        chosen = overrideIfInsider(prompt, chosen);
        chosen = humanize(chosen, seeded(channelId || 'default'));
        chosen = enforceShortness(chosen);
        chosen = sanitizeFinal(chosen);

        if (isWeakReply(chosen)) return null;
        return chosen;
    } catch (error) {
        log.critical(`Gemini API call failed: ${error.message}`);
        return null;
    }
}


// === Main Bot Loop ===

async function autoReply(channelId, apiKey) {
    while (isRunning) {
        // Random delay between 60s and MAX_REPLY_DELAY*60s
        const maxDelayMs = CONFIG.MAX_REPLY_DELAY * 60 * 1000;
        const minDelayMs = 60 * 1000;
        const replyDelay = Math.random() * (maxDelayMs - minDelayMs) + minDelayMs;

        log(`Waiting for ${Math.round(replyDelay / 1000)} seconds before checking messages...`);
        await sleep(replyDelay);
        if (!isRunning) break;

        const messages = await getMessages(channelId);
        if (!messages || !messages.length) {
            log('No messages or failed to fetch messages.');
            continue;
        }

        let sentThisCycle = false;

        // Process messages from oldest to newest (Discord returns newest first, so iterate backward)
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            
            if (!isRunning) break;
            if (m.author.id === botUserId) continue; // Skip messages from self
            if (repliedMessages.has(m.id)) continue; // Skip messages already replied to
            // Skip older messages after the last one we processed
            if (lastMessageId && BigInt(m.id) <= BigInt(lastMessageId)) continue; 

            const userMessage = m.content || '';
            if (!userMessage) continue; // Skip messages with no text content
            if (containsBannedWord(userMessage)) {
                log(`Skipped message from ${m.author.username} (${m.author.id}) due to banned word: "${userMessage}"`);
                repliedMessages.add(m.id); // Mark as processed to avoid re-checking
                continue;
            }

            log(`Processing new message from ${m.author.username} (${m.author.id}): "${userMessage}"`);

            // Simulate reading time (CONFIG.READ_DELAY is in seconds)
            await sleep(CONFIG.READ_DELAY * 1000);
            if (!isRunning) break;

            // Generate reply - skip if no valid reply
            const reply = await generateReply(userMessage, CONFIG.GOOGLE_API_KEY, channelId);
            if (!reply) {
                log(`No valid reply generated for: "${userMessage}"`);
                repliedMessages.add(m.id); // Mark as processed
                continue;
            }

            // Type and send reply
            log(`- Reply generated: "${reply}"`);
            await variableTyping(channelId, reply);
            
            // Wait for human-like delay before sending
            const humanDelay = Math.floor(Math.random() * (CONFIG.HUMAN_DELAY.MAX - CONFIG.HUMAN_DELAY.MIN + 1)) + CONFIG.HUMAN_DELAY.MIN;
            await sleep(humanDelay);
            if (!isRunning) break;

            const ok = await sendReply(channelId, m.id, reply);
            if (ok) {
                repliedMessages.add(m.id);
                lastMessageId = m.id;
                rememberTurn(channelId, userMessage, reply);
                sentThisCycle = true;
                log(`==> Successfully replied to ${m.author.username}: "${reply}"`);
            } else {
                log.critical(`Failed to send reply for message ID ${m.id}`);
            }

            // Only reply to one message per cycle
            if (sentThisCycle) break; 
        }
    }
}


// === Control Functions ===

async function startBot() {
    if (isRunning) return log('Bot already running');

    if (!CONFIG.TARGET_CHANNEL_ID) return log.critical('Please set TARGET_CHANNEL_ID in your .env file.');
    if (!CONFIG.DISCORD_TOKEN) return log.critical('Please set DISCORD_TOKEN in your .env file.');
    if (!CONFIG.GOOGLE_API_KEY || CONFIG.GOOGLE_API_KEY === "AIzaSyDHogoSFYqlmzfpXm--xPbDWZNVd79xH7k") {
        return log.critical('Please set your GOOGLE_API_KEY in your .env file.');
    }

    // Get Bot/User ID
    botUserId = await getBotUserId();
    if (!botUserId) return log.critical('Cannot get user ID. Check your DISCORD_TOKEN in .env.');

    // Clear log file on startup
    try {
        await fs.writeFile(CONFIG.LOG_FILE_PATH, `--- Bot Startup Log: ${new Date().toISOString()} ---\n`, 'utf8');
    } catch (error) {
        log.critical(`Failed to clear/create log file: ${error.message}`);
    }

    isRunning = true;
    log(`Bot started on channel ${CONFIG.TARGET_CHANNEL_ID} as user ID ${botUserId}`);
    log(`Activity will be logged to ${CONFIG.LOG_FILE_PATH}`);
    
    // Start the main loop
    autoReply(CONFIG.TARGET_CHANNEL_ID, CONFIG.GOOGLE_API_KEY);
}

function stopBot() {
    if (!isRunning) return log('Bot already stopped');
    isRunning = false;
    log('Bot stopped');
    // Exit the process after the current loop finishes
    process.exit(0);
}

function getBotStatus() {
    log(`Status: ${isRunning ? 'RUNNING' : 'STOPPED'}`);
    if (isRunning && CONFIG.TARGET_CHANNEL_ID) {
        log(`Channel: ${CONFIG.TARGET_CHANNEL_ID}`);
        log(`User ID: ${botUserId}`);
        log(`Replied messages (current session): ${repliedMessages.size}`);
    }
}


// === Startup and Shutdown Hooks ===

// Start bot automatically
startBot();

// Handle graceful exit
process.on('SIGINT', () => {
    log('Caught interrupt signal (Ctrl+C). Stopping bot gracefully...');
    stopBot();
});