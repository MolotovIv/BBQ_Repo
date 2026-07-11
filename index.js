const { Telegraf } = require('telegraf');
const express = require('express');
require('dotenv').config();
const fs = require('fs');
const logStream = fs.createWriteStream('chat.log', { flags: 'a' });

const bot = new Telegraf(process.env.BOT_TOKEN);

// ==================== ХРАНИЛИЩА ====================
const carts = new Map();              // Корзины пользователей
const waitingForWeight = new Map();   // Ожидание выбора веса
const waitingForComment = new Map();  // Ожидание ввода комментария

// Для двустороннего чата
const orderNotifications = new Map(); // message_id уведомления админа → clientId
const activeChats = new Map();        // clientId → Set(adminId)
const lastClient = new Map();         // adminId → clientId (для быстрых ответов)

// Счётчик заказов (при перезапуске сбрасывается — для продакшена нужна БД)
let orderCounter = 1;

// ==================== ТОВАРЫ ====================
const products = {
    ribs: { name: '🍖 Ребра свиные', price: 2000, unit: 'кг', maxWeight: 3 },
    brisket: { name: '🥩 Брискет', price: 4500, unit: 'кг', maxWeight: 3 },
    pork: { name: '🐖 Свинина', price: 2200, unit: 'кг', maxWeight: 5 },
    turkey: { name: '🦃 Индейка', price: 2000, unit: 'кг', maxWeight: 3 }
};

// ID администраторов
const ADMIN_IDS = [1323252853, 1069660149];

// ==================== ФУНКЦИИ КЛАВИАТУР ====================


function logMessage(sender, text, type = 'INFO') {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${type}] ${sender}: ${text}\n`;
    logStream.write(logEntry);
    console.log(logEntry.trim());
}

function getWeightKeyboard(productId) {
    const weightOptions = {
        ribs: ['0.45', '0.9', '1.35', '1.8'],
        brisket: ['0.2', '0.4', '0.6', '0.8', '1'],
        pork: ['0.2', '0.4', '0.6', '0.8', '1'],
        turkey: ['0.2', '0.4', '0.6', '0.8', '1']
    };
    const options = weightOptions[productId] || weightOptions.pork;
    const buttons = [[]];
    options.forEach(weight => {
        const weightNum = parseFloat(weight);
        const text = weightNum >= 1 ? `${weightNum} кг` : `${weightNum * 1000} г`;
        buttons[0].push({ text: `🔹 ${text}`, callback_data: `weight_${weight}` });
    });
    buttons.push([{ text: '❌ Отмена', callback_data: 'weight_cancel' }]);
    return { inline_keyboard: buttons };
}

function getAfterAddKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '🛒 Перейти в корзину', callback_data: 'view_cart' }],
            [{ text: '📦 Оформить заказ', callback_data: 'checkout' }]
        ]
    };
}

function getCartKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '📦 Оформить заказ', callback_data: 'checkout' }],
            [{ text: '🗑 Очистить корзину', callback_data: 'clear_cart' }]
        ]
    };
}

function getCommentKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '📝 Пропустить (без комментария)', callback_data: 'skip_comment' }],
            [{ text: '❌ Отмена заказа', callback_data: 'cancel_order' }]
        ]
    };
}

// ==================== КОМАНДЫ БОТА ====================

bot.start(async (ctx) => {
    const msg = await ctx.reply('🔄 Загружаем меню... 🔥');
    await new Promise(resolve => setTimeout(resolve, 500));
    await ctx.telegram.editMessageText(
        ctx.chat.id,
        msg.message_id,
        null,
        '🍖 Добро пожаловать в Molotov BBQ!\n\n' +
        '📋 Команды:\n' +
        '/menu — посмотреть меню\n' +
        '/cart — моя корзина\n' +
        '/order — оформить заказ\n' +
        '/clear — очистить корзину'
    );
});

bot.command('menu', (ctx) => {
    ctx.reply('🔥 Наше меню. Нажимай — выбирай вес и добавляй в корзину:', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🍖 Ребра свиные — 2000₽/кг', callback_data: 'select_ribs' }],
                [{ text: '🥩 Брискет — 4500₽/кг', callback_data: 'select_brisket' }],
                [{ text: '🐖 Свинина — 2200₽/кг', callback_data: 'select_pork' }],
                [{ text: '🦃 Индейка — 2000₽/кг', callback_data: 'select_turkey' }],
                [{ text: '🛒 Перейти в корзину', callback_data: 'view_cart' }]
            ]
        }
    });
});

bot.command('cart', (ctx) => showCart(ctx));
bot.command('order', (ctx) => checkout(ctx));
bot.command('clear', (ctx) => {
    carts.delete(ctx.from.id);
    waitingForWeight.delete(ctx.from.id);
    waitingForComment.delete(ctx.from.id);
    ctx.reply('🗑 Корзина очищена!');
});

// ==================== ВЫБОР ТОВАРА И ВЕСА ====================

bot.action('select_ribs', (ctx) => askForWeight(ctx, 'ribs'));
bot.action('select_brisket', (ctx) => askForWeight(ctx, 'brisket'));
bot.action('select_pork', (ctx) => askForWeight(ctx, 'pork'));
bot.action('select_turkey', (ctx) => askForWeight(ctx, 'turkey'));

async function askForWeight(ctx, productId) {
    const product = products[productId];
    waitingForWeight.set(ctx.from.id, productId);
    await ctx.reply(
        `${product.name}\n💰 Цена: ${product.price}₽/кг\n\n⚖️ Выберите вес:`,
        { reply_markup: getWeightKeyboard(productId) }
    );
}

bot.action(/weight_(\d+\.?\d*)/, async (ctx) => {
    const weight = parseFloat(ctx.match[1]);
    await addToCartWithWeight(ctx, weight);
});

bot.action('weight_cancel', async (ctx) => {
    waitingForWeight.delete(ctx.from.id);
    await ctx.reply('❌ Добавление товара отменено');
    await ctx.answerCbQuery();
});

// ==================== ДОБАВЛЕНИЕ В КОРЗИНУ ====================

async function addToCartWithWeight(ctx, weight, productId = null) {
    let userId = ctx.from.id;
    let actualProductId = productId;
    if (!actualProductId && waitingForWeight.has(userId)) {
        actualProductId = waitingForWeight.get(userId);
        waitingForWeight.delete(userId);
    }
    if (!actualProductId) {
        return ctx.reply('❌ Ошибка. Попробуйте добавить товар заново через /menu');
    }
    const product = products[actualProductId];
    const sum = product.price * weight;
    if (!carts.has(userId)) carts.set(userId, []);
    const cart = carts.get(userId);
    const existing = cart.find(item => item.id === actualProductId);
    if (existing) {
        existing.weight += weight;
        existing.totalPrice = existing.price * existing.weight;
    } else {
        cart.push({
            id: actualProductId,
            name: product.name,
            price: product.price,
            weight: weight,
            totalPrice: sum
        });
    }
    carts.set(userId, cart);
    const weightText = weight >= 1 ? `${weight} кг` : `${weight * 1000} г`;
    const items = cart.filter(item => item.id && item.name);
    const totalItems = items.length;
    const totalSum = items.reduce((acc, item) => acc + (item.totalPrice || 0), 0);
    await ctx.reply(
        `✅ ${product.name}\n⚖️ Вес: ${weightText}\n💰 Сумма: ${sum}₽\n\n` +
        `🛒 В корзине: ${totalItems} товаров на ${totalSum}₽\n\n` +
        `Товар добавлен в корзину!`,
        { reply_markup: getAfterAddKeyboard() }
    );
    await ctx.answerCbQuery();
}

// ==================== КОРЗИНА ====================

async function showCart(ctx) {
    const userId = ctx.from.id;
    const cart = carts.get(userId) || [];
    const items = cart.filter(item => item.id && item.name);
    if (items.length === 0) {
        return ctx.reply('🛒 Корзина пуста. Добавьте что-нибудь через /menu');
    }
    let total = 0;
    let text = '🛒 ВАША КОРЗИНА:\n\n';
    items.forEach((item, index) => {
        const weightText = item.weight >= 1 ? `${item.weight} кг` : `${item.weight * 1000} г`;
        total += item.totalPrice;
        text += `${item.name}\n`;
        text += `   ⚖️ Вес: ${weightText}\n`;
        text += `   💰 ${item.price}₽/кг = ${item.totalPrice}₽\n`;
        text += `   🗑️ /del_${index}\n\n`;
    });
    text += `\n💰 ИТОГО: ${total} ₽`;
    if (cart.userComment) {
        text += `\n📝 Комментарий: ${cart.userComment.substring(0, 50)}`;
        if (cart.userComment.length > 50) text += '...';
    }
    await ctx.reply(text, { reply_markup: getCartKeyboard() });
}

bot.action('view_cart', (ctx) => showCart(ctx));

bot.command(/del_(\d+)/, (ctx) => {
    const userId = ctx.from.id;
    const index = parseInt(ctx.match[1]);
    const cart = carts.get(userId);
    if (cart && cart[index]) {
        cart.splice(index, 1);
        carts.set(userId, cart);
        ctx.reply('❌ Товар удалён');
        showCart(ctx);
    } else {
        ctx.reply('❌ Товар не найден');
    }
});

bot.action('clear_cart', (ctx) => {
    carts.delete(ctx.from.id);
    waitingForWeight.delete(ctx.from.id);
    waitingForComment.delete(ctx.from.id);
    ctx.answerCbQuery('Корзина очищена');
    ctx.reply('🗑 Корзина очищена!');
});

// ==================== КОММЕНТАРИЙ К ЗАКАЗУ ====================

async function askForComment(ctx) {
    const userId = ctx.from.id;
    waitingForComment.set(userId, true);
    await ctx.reply(
        '📝 Оставьте комментарий к заказу (необязательно)\n\n' +
        'Например: время доставки, особые пожелания, адрес самовывоза и т.д.\n\n' +
        '💡 Просто напишите текст или нажмите "Пропустить"',
        { reply_markup: getCommentKeyboard() }
    );
}

bot.action('skip_comment', async (ctx) => {
    const userId = ctx.from.id;
    waitingForComment.delete(userId);
    if (!carts.has(userId)) carts.set(userId, []);
    const cart = carts.get(userId);
    cart.userComment = '';
    carts.set(userId, cart);
    await ctx.answerCbQuery();
    await ctx.reply('⏩ Комментарий пропущен');
    await finalizeOrder(ctx);
});

bot.action('cancel_order', async (ctx) => {
    const userId = ctx.from.id;
    waitingForComment.delete(userId);
    await ctx.answerCbQuery('Заказ отменён');
    await ctx.reply('❌ Оформление заказа отменено');
    await showCart(ctx);
});

// ==================== ОФОРМЛЕНИЕ ЗАКАЗА (С ДВУСТОРОННИМ ЧАТОМ) ====================

async function finalizeOrder(ctx) {
    const userId = ctx.from.id;
    const cart = carts.get(userId);
    if (!cart) return ctx.reply('🛒 Корзина пуста');
    const items = cart.filter(item => item.id && item.name);
    if (items.length === 0) return ctx.reply('🛒 Корзина пуста');

    // Номер заказа
    const orderNumber = orderCounter++;
    let total = 0;
    let orderText = `📦 ЗАКАЗ #${orderNumber}\n\n`;
    items.forEach(item => {
        const weightText = item.weight >= 1 ? `${item.weight} кг` : `${item.weight * 1000} г`;
        total += item.totalPrice;
        orderText += `${item.name}\n`;
        orderText += `   ⚖️ Вес: ${weightText}\n`;
        orderText += `   💰 ${item.price}₽/кг = ${item.totalPrice}₽\n\n`;
    });
    orderText += `💰 Итого: ${total} ₽\n`;
    orderText += `👤 Клиент: ${ctx.from.first_name}\n`;
    orderText += `🆔 ID: ${userId}\n`;
    orderText += `📛 Username: @${ctx.from.username || 'нет username'}`;
    if (cart.userComment && cart.userComment.trim()) {
        orderText += `\n\n📝 Комментарий:\n${cart.userComment}`;
    } else {
        orderText += `\n\n📝 Комментарий: не указан`;
    }

    // Сохраняем клиента в активные чаты
    const adminSet = new Set(ADMIN_IDS);
    activeChats.set(userId, adminSet);

    // Отправляем уведомления админам и сохраняем связь
    for (const adminId of ADMIN_IDS) {
        try {
            const sentMsg = await bot.telegram.sendMessage(adminId, orderText);
            orderNotifications.set(sentMsg.message_id, userId);
            lastClient.set(adminId, userId); // для быстрых ответов
        } catch (error) {
            console.error(`Ошибка отправки админу ${adminId}:`, error);
        }
    }

    carts.delete(userId);
    waitingForComment.delete(userId);

    await ctx.reply(
        `✅ ЗАКАЗ #${orderNumber} ОТПРАВЛЕН!\n\n` +
        'Мы свяжемся с вами для подтверждения.\n\n' +
        'Спасибо, что выбрали Molotov BBQ! 🔥'
    );
}

async function checkout(ctx) {
    const userId = ctx.from.id;
    const cart = carts.get(userId);
    if (!cart || cart.filter(item => item.id && item.name).length === 0) {
        return ctx.reply('🛒 Корзина пуста. Добавьте товары через /menu');
    }
    await askForComment(ctx);
}

bot.action('checkout', (ctx) => checkout(ctx));

// ==================== ОБРАБОТЧИК ТЕКСТА (ДВУСТОРОННИЙ ЧАТ И КОМАНДЫ) ====================

bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const message = ctx.message;
    const userId = ctx.from.id;
    const messageText = ctx.message.text;

    const sender = ctx.from.first_name + (ctx.from.username ? ` (@${ctx.from.username})` : '') + ` (ID: ${userId})`;
    logMessage(sender, messageText, ADMIN_IDS.includes(chatId) ? 'ADMIN' : 'CLIENT');

    // === 1. АДМИНСКИЕ КОМАНДЫ ===

    // /send ID_или_@username Текст
    if (ADMIN_IDS.includes(chatId) && messageText.startsWith('/send ')) {
        const parts = messageText.split(' ');
        if (parts.length < 3) {
            return ctx.reply('❌ Формат: /send ID_или_@username Текст сообщения');
        }
        const target = parts[1];
        const replyText = parts.slice(2).join(' ');
        let clientId = null;
        if (/^\d+$/.test(target)) {
            clientId = parseInt(target);
        } else {
            const username = target.startsWith('@') ? target.slice(1) : target;
            try {
                const chat = await bot.telegram.getChat(`@${username}`);
                clientId = chat.id;
            } catch (e) {
                return ctx.reply('❌ Пользователь с таким username не найден или не начал диалог с ботом.');
            }
        }
        if (!clientId) {
            return ctx.reply('❌ Не удалось определить ID.');
        }
        try {
            await bot.telegram.sendMessage(clientId, replyText);
            await ctx.reply(`✅ Сообщение отправлено клиенту (${clientId})`);
        } catch (error) {
            await ctx.reply('❌ Ошибка отправки. Клиент, вероятно, не активировал бота.');
        }
        return;
    }

    // /clients — список активных клиентов
    if (ADMIN_IDS.includes(chatId) && messageText === '/clients') {
        if (activeChats.size === 0) {
            return ctx.reply('📭 Нет активных клиентов.');
        }
        let text = '👥 АКТИВНЫЕ КЛИЕНТЫ:\n\n';
        let index = 1;
        for (const [clientId] of activeChats) {
            text += `${index}. ID: ${clientId} — /send ${clientId} Текст...\n`;
            index++;
        }
        await ctx.reply(text);
        return;
    }

    // /confirm — отправить подтверждение последнему клиенту
    if (ADMIN_IDS.includes(chatId) && messageText === '/confirm') {
        const lastClientId = lastClient.get(chatId);
        if (lastClientId) {
            const replyText = '✅ Ваш заказ принят! Мы свяжемся с вами для подтверждения.';
            try {
                await bot.telegram.sendMessage(lastClientId, replyText);
                await ctx.reply(`✅ Подтверждение отправлено клиенту (${lastClientId})`);
            } catch (error) {
                await ctx.reply('❌ Ошибка отправки.');
            }
        } else {
            await ctx.reply('❌ Нет активного клиента для подтверждения.');
        }
        return;
    }

    // === 2. Если админ отвечает на уведомление (пересылаем клиенту) ===
    if (ADMIN_IDS.includes(chatId) && message.reply_to_message) {
        const repliedMsgId = message.reply_to_message.message_id;
        if (orderNotifications.has(repliedMsgId)) {
            const clientChatId = orderNotifications.get(repliedMsgId);
            try {
                await bot.telegram.sendMessage(clientChatId, messageText);
                orderNotifications.delete(repliedMsgId); // очищаем, чтобы не отправлять повторно
                await ctx.reply('✅ Ответ отправлен клиенту.');
            } catch (error) {
                console.error('Ошибка отправки ответа клиенту:', error);
                await ctx.reply('❌ Не удалось отправить ответ клиенту. Возможно, клиент не активировал бота.');
            }
            return;
        }
    }

    // === 3. Если клиент (не админ) пишет в бот — пересылаем всем админам ===
    if (!ADMIN_IDS.includes(chatId) && activeChats.has(userId)) {
        const admins = activeChats.get(userId);
        const userName = ctx.from.first_name || 'Клиент';
        const userLink = ctx.from.username ? `@${ctx.from.username}` : `ID: ${userId}`;
        const forwardedText = `💬 Сообщение от ${userName} (${userLink}):\n\n${messageText}`;
        for (const adminId of admins) {
            try {
                await bot.telegram.sendMessage(adminId, forwardedText);
            } catch (error) {
                console.error(`Ошибка пересылки сообщения админу ${adminId}:`, error);
            }
        }
        await ctx.reply('✅ Ваше сообщение отправлено менеджеру. Мы ответим в ближайшее время.');
        return;
    }

    // === 4. Обычная логика для клиентов (комментарии, команды) ===
    if (messageText.startsWith('/')) return;

    if (waitingForComment.has(userId)) {
        waitingForComment.delete(userId);
        if (!carts.has(userId)) carts.set(userId, []);
        const cart = carts.get(userId);
        cart.userComment = messageText;
        carts.set(userId, cart);
        await ctx.reply('✅ Комментарий сохранён!');
        await finalizeOrder(ctx);
        return;
    }
});

// ==================== ВЕБ-СЕРВЕР ДЛЯ RENDER ====================

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.send('🔥 Molotov BBQ Bot is running!');
});

app.get('/webhook', (req, res) => {
    res.send('Webhook endpoint is ready');
});

app.post('/webhook', async (req, res) => {
    console.log('📩 Получен вебхук');
    try {
        await bot.handleUpdate(req.body);
        res.send('ok');
    } catch (error) {
        console.error('Ошибка обработки вебхука:', error);
        res.status(500).send('error');
    }
});

const setWebhook = async () => {
    const url = process.env.RENDER_EXTERNAL_URL;
    if (!url) {
        console.error('RENDER_EXTERNAL_URL не задан');
        return;
    }
    try {
        await bot.telegram.setWebhook(`${url}/webhook`);
        console.log(`✅ Вебхук установлен: ${url}/webhook`);
    } catch (error) {
        console.error('Ошибка установки вебхука:', error);
    }
};

const port = process.env.PORT || 3000;
app.listen(port, async () => {
    console.log(`🚀 Сервер запущен на порту ${port}`);
    await setWebhook();
});