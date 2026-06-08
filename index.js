const { Telegraf } = require('telegraf');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

// Импортируем константы и товары из отдельного файла
const {
    products,
    ADMIN_IDS,
    getMenuKeyboard,
    getWeightKeyboard,
    getCartKeyboard,
    getAddToCartKeyboard,
    getCommentKeyboard
} = require('./consts.js');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ==================== БАЗА ДАННЫХ SQLITE ====================
const db = new sqlite3.Database(path.join(__dirname, 'referrals.db'));

// Создаём таблицы
db.run(`
    CREATE TABLE IF NOT EXISTS referrals (
        user_id INTEGER PRIMARY KEY,
        invited_by INTEGER,
        created_at INTEGER,
        order_made INTEGER DEFAULT 0,
        bonus_given INTEGER DEFAULT 0
    )
`);

db.run(`
    CREATE TABLE IF NOT EXISTS referral_counts (
        user_id INTEGER PRIMARY KEY,
        invite_count INTEGER DEFAULT 0,
        reward_count INTEGER DEFAULT 0
    )
`);

// Функции для работы с БД
function saveReferral(userId, invitedBy) {
    db.run(
        `INSERT OR IGNORE INTO referrals (user_id, invited_by, created_at) VALUES (?, ?, ?)`,
        [userId, invitedBy, Date.now()]
    );
    db.run(
        `INSERT OR IGNORE INTO referral_counts (user_id, invite_count) VALUES (?, 0)`,
        [invitedBy]
    );
    db.run(
        `UPDATE referral_counts SET invite_count = invite_count + 1 WHERE user_id = ?`,
        [invitedBy]
    );
}

function getReferralInfo(userId, callback) {
    db.get(`SELECT * FROM referrals WHERE user_id = ?`, [userId], (err, row) => {
        callback(row || null);
    });
}

function getInviteCount(userId, callback) {
    db.get(`SELECT invite_count, reward_count FROM referral_counts WHERE user_id = ?`, [userId], (err, row) => {
        callback(row || { invite_count: 0, reward_count: 0 });
    });
}

function markOrderMade(userId) {
    db.run(`UPDATE referrals SET order_made = 1 WHERE user_id = ?`, [userId]);
}

function markBonusGiven(referredUserId, referrerId) {
    db.run(`UPDATE referrals SET bonus_given = 1 WHERE user_id = ?`, [referredUserId]);
    db.run(`UPDATE referral_counts SET reward_count = reward_count + 1 WHERE user_id = ?`, [referrerId]);
}

function getReferralsStats(callback) {
    db.all(`
        SELECT rc.user_id, rc.invite_count, rc.reward_count 
        FROM referral_counts rc 
        ORDER BY rc.invite_count DESC 
        LIMIT 10
    `, (err, rows) => {
        callback(rows || []);
    });
}

// ==================== ХРАНИЛИЩА ====================
const carts = new Map();
const waitingForWeight = new Map();
const waitingForComment = new Map();

// ==================== КОМАНДЫ БОТА ====================

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const startPayload = ctx.startPayload;

    if (startPayload && startPayload.startsWith('ref_')) {
        const referrerId = parseInt(startPayload.replace('ref_', ''));

        if (referrerId !== userId) {
            getReferralInfo(userId, (info) => {
                if (!info) {
                    saveReferral(userId, referrerId);

                    try {
                        bot.telegram.sendMessage(referrerId,
                            `🎉 По вашей ссылке зарегистрировался новый пользователь ${ctx.from.first_name}!\n\n` +
                            `Когда он сделает первый заказ, вы получите подарок!`
                        );
                    } catch (e) { }

                    ctx.reply(
                        `🎁 Вы пришли по ссылке от друга!\n\n` +
                        `🍖 Добро пожаловать в Molotov BBQ!\n\n` +
                        `📋 Команды:\n` +
                        `/menu — посмотреть меню\n` +
                        `/cart — моя корзина\n` +
                        `/order — оформить заказ\n` +
                        `/clear — очистить корзину\n` +
                        `/invite — получить ссылку для друга`
                    );
                    return;
                }
            });
            return;
        }
    }

    ctx.reply(
        '🍖 Добро пожаловать в Molotov BBQ!\n\n' +
        '📋 Команды:\n' +
        '/menu — посмотреть меню\n' +
        '/cart — моя корзина\n' +
        '/order — оформить заказ\n' +
        '/clear — очистить корзину\n\n' +
        '👥 Есть друг? /invite — получи ссылку и получай подарки за каждого друга!'
    );
});

bot.command('invite', async (ctx) => {
    const userId = ctx.from.id;
    const botUsername = ctx.botInfo.username;
    const inviteLink = `https://t.me/${botUsername}?start=ref_${userId}`;

    getInviteCount(userId, (data) => {
        let bonusText = '';
        if (data.reward_count >= 3) {
            bonusText = `\n\n🏆 СУПЕР! Вы получили ${data.reward_count} подарков! Закажите брискет со скидкой 15% — просто напишите нам!`;
        } else if (data.reward_count >= 1) {
            bonusText = `\n\n✅ Вы уже получили ${data.reward_count} ${data.reward_count === 1 ? 'подарок' : 'подарка'}!`;
        } else {
            bonusText = `\n\n🎁 За каждого друга, который сделает заказ, вы получите 200 г свинины в подарок!`;
        }

        ctx.reply(
            `👥 ВАША РЕФЕРАЛЬНАЯ ССЫЛКА\n\n` +
            `🔗 ${inviteLink}\n\n` +
            `📊 Приглашено друзей: ${data.invite_count}\n` +
            `🎁 Получено подарков: ${data.reward_count}${bonusText}\n\n` +
            `💡 Просто отправьте ссылку другу. Когда он перейдёт и сделает заказ — вы получите подарок!`
        );
    });
});

bot.command('stats', async (ctx) => {
    const userId = ctx.from.id;
    if (!ADMIN_IDS.includes(userId)) {
        return ctx.reply('❌ Только для администратора');
    }

    getReferralsStats((stats) => {
        if (stats.length === 0) {
            return ctx.reply('📊 Пока нет реферальных переходов');
        }

        let text = '📊 ТОП ПРИГЛАСИТЕЛЕЙ:\n\n';
        stats.forEach((stat, index) => {
            text += `${index + 1}. ID ${stat.user_id}: ${stat.invite_count} приглаш. (${stat.reward_count} подарков)\n`;
        });
        text += `\n📦 Всего в системе: ${stats.length} пользователей`;

        ctx.reply(text);
    });
});

bot.command('menu', (ctx) => {
    ctx.reply('🔥 Наше меню. Нажимай — выбирай вес и добавляй в корзину:', {
        reply_markup: getMenuKeyboard()
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
        `${product.name}\n💰 Цена: ${product.price}₽/кг\n\n⚖️ Выберите вес (от 300 г до 5 кг, кратно 100 г):`,
        { reply_markup: getWeightKeyboard() }
    );
}

bot.action(/weight_(\d+\.?\d*)/, async (ctx) => {
    const weight = parseFloat(ctx.match[1]);
    await addToCartWithWeight(ctx, weight);
});

bot.action('weight_custom', async (ctx) => {
    await ctx.reply(
        '📝 Введите вес в килограммах.\n\n' +
        'Примеры:\n• 0.3 = 300 г\n• 0.7 = 700 г\n• 1.2 = 1 кг 200 г\n\n' +
        'Вес должен быть от 0.3 до 5 и кратен 100 г (0.1 кг)'
    );
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
        {
            reply_markup: getAddToCartKeyboard()
        }
    );

    await ctx.answerCbQuery(`✅ +${weightText} ${product.name}`);
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

// ==================== ФИНАЛЬНОЕ ОФОРМЛЕНИЕ ЗАКАЗА ====================

async function finalizeOrder(ctx) {
    const userId = ctx.from.id;
    const cart = carts.get(userId);

    if (!cart) return ctx.reply('🛒 Корзина пуста');

    const items = cart.filter(item => item.id && item.name);
    if (items.length === 0) return ctx.reply('🛒 Корзина пуста');

    let total = 0;
    let orderText = '📦 НОВЫЙ ЗАКАЗ\n\n';

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

    getReferralInfo(userId, (referralInfo) => {
        if (referralInfo && referralInfo.invited_by && !referralInfo.bonus_given) {
            const referrerId = referralInfo.invited_by;

            markBonusGiven(userId, referrerId);

            orderText += `\n\n🎁 РЕФЕРАЛ: пришёл по ссылке от ${referrerId}`;

            try {
                bot.telegram.sendMessage(referrerId,
                    `🎁 ПОЗДРАВЛЯЕМ!\n\n` +
                    `Ваш друг ${ctx.from.first_name} сделал первый заказ!\n\n` +
                    `Вы получаете 200 г свинины в подарок к следующему заказу!\n` +
                    `Просто напишите нам "БОНУС" при оформлении.`
                );
            } catch (e) { }
        }
        markOrderMade(userId);

        for (const adminId of ADMIN_IDS) {
            try {
                bot.telegram.sendMessage(adminId, orderText);
            } catch (error) {
                console.error(`Ошибка отправки админу ${adminId}:`, error);
            }
        }
    });

    carts.delete(userId);
    waitingForComment.delete(userId);

    await ctx.reply(
        '✅ ЗАКАЗ ОТПРАВЛЕН!\n\n' +
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

// ==================== ОБРАБОТЧИК ТЕКСТА ====================

bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const messageText = ctx.message.text;

    if (messageText.startsWith('/')) return;

    if (waitingForWeight.has(userId)) {
        const productId = waitingForWeight.get(userId);
        let weight = parseFloat(messageText.replace(',', '.'));

        if (isNaN(weight)) return ctx.reply('❌ Введите число, например: 0.7');
        if (weight < 0.3) return ctx.reply('❌ Минимум 300 г (0.3 кг)');
        if (weight > 5) return ctx.reply('❌ Максимум 5 кг');

        const remainder = weight % 0.1;
        if (Math.abs(remainder) > 0.001) {
            return ctx.reply('❌ Вес должен быть кратен 100 г.\nПримеры: 0.3, 0.7, 1.2');
        }

        weight = Math.round(weight * 10) / 10;
        waitingForWeight.delete(userId);
        await addToCartWithWeight(ctx, weight, productId);
        return;
    }

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