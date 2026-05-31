const { Telegraf } = require('telegraf');
const express = require('express');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

// ==================== ХРАНИЛИЩА ====================
const carts = new Map();              // Корзины пользователей
const waitingForWeight = new Map();   // Ожидание ввода веса
const waitingForComment = new Map();  // Ожидание ввода комментария

// ==================== ТОВАРЫ ====================
const products = {
    ribs: { name: '🍖 Ребра свиные', price: 2200, unit: 'кг' },
    brisket: { name: '🥩 Брискет', price: 4500, unit: 'кг' },
    pork: { name: '🐖 Свинина', price: 2500, unit: 'кг' },
    turkey: { name: '🦃 Индейка', price: 2000, unit: 'кг' }
};

// ID администраторов (замените на свои)
const ADMIN_IDS = [1323252853, 1069660149];

// ==================== КОМАНДЫ БОТА ====================
bot.start(async (ctx) => {
    // Показываем индикатор загрузки
    const msg = await ctx.reply('🔄 Загружаем меню... 🔥');

    // Искусственная задержка (опционально, можно убрать)
    await new Promise(resolve => setTimeout(resolve, 500));

    // Редактируем сообщение
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
                [{ text: '🍖 Ребра свиные — 2200₽/кг', callback_data: 'select_ribs' }],
                [{ text: '🥩 Брискет — 4500₽/кг', callback_data: 'select_brisket' }],
                [{ text: '🐖 Свинина — 2500₽/кг', callback_data: 'select_pork' }],
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

    const keyboard = {
        inline_keyboard: [
            [{ text: '🔹 300 г', callback_data: 'weight_0.3' }, { text: '🔹 500 г', callback_data: 'weight_0.5' }],
            [{ text: '🔹 700 г', callback_data: 'weight_0.7' }, { text: '🔹 1 кг', callback_data: 'weight_1.0' }],
            [{ text: '🔹 1.5 кг', callback_data: 'weight_1.5' }, { text: '🔹 2 кг', callback_data: 'weight_2.0' }],
            [{ text: '✏️ Свой вес (кратно 100 г)', callback_data: 'weight_custom' }],
            [{ text: '❌ Отмена', callback_data: 'weight_cancel' }]
        ]
    };

    await ctx.reply(
        `${product.name}\n💰 Цена: ${product.price}₽/кг\n\n⚖️ Выберите вес (от 300 г до 5 кг, кратно 100 г):`,
        { reply_markup: keyboard }
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

    // Подсчитываем актуальное состояние корзины
    const items = cart.filter(item => item.id && item.name);
    const totalItems = items.length;
    const totalSum = items.reduce((acc, item) => acc + (item.totalPrice || 0), 0);

    // Отправляем сообщение с подтверждением и кнопками
    await ctx.reply(
        `✅ ${product.name}\n⚖️ Вес: ${weightText}\n💰 Сумма: ${sum}₽\n\n` +
        `🛒 В корзине: ${totalItems} товаров на ${totalSum}₽\n\n` +
        `Товар добавлен в корзину!`,
        {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🛒 Перейти в корзину', callback_data: 'view_cart' }],
                    [{ text: '📦 Оформить заказ', callback_data: 'checkout' }]
                ]
            }
        }
    );

    // Всплывающее уведомление (короткое, для обратной связи)
    await ctx.answerCbQuery(`✅ +${weightText} ${product.name}`);
}

// ==================== КОРЗИНА ====================

async function showCart(ctx) {
    const userId = ctx.from.id;
    const cart = carts.get(userId) || [];

    // Фильтруем только товары
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

    // Показываем комментарий, если есть
    if (cart.userComment) {
        text += `\n📝 Комментарий: ${cart.userComment.substring(0, 50)}`;
        if (cart.userComment.length > 50) text += '...';
    }

    const keyboard = {
        inline_keyboard: [
            [{ text: '📦 Оформить заказ', callback_data: 'checkout' }],
            [{ text: '🗑 Очистить корзину', callback_data: 'clear_cart' }]
        ]
    };

    await ctx.reply(text, { reply_markup: keyboard });
}

bot.action('view_cart', (ctx) => showCart(ctx));

// Удаление товара
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

// Очистка корзины (кнопка)
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

    const keyboard = {
        inline_keyboard: [
            [{ text: '📝 Пропустить (без комментария)', callback_data: 'skip_comment' }],
            [{ text: '❌ Отмена заказа', callback_data: 'cancel_order' }]
        ]
    };

    await ctx.reply(
        '📝 Оставьте комментарий к заказу (необязательно)\n\n' +
        'Например: время доставки, особые пожелания, адрес самовывоза и т.д.\n\n' +
        'Рекомендем оставить номер для связи и указать примерное время доставки для вашего удобства' +
        '💡 Просто напишите текст или нажмите "Пропустить"',
        { reply_markup: keyboard }
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

    for (const adminId of ADMIN_IDS) {
        try {
            await bot.telegram.sendMessage(adminId, orderText);
        } catch (error) {
            console.error(`Ошибка отправки админу ${adminId}:`, error);
        }
    }

    carts.delete(userId);
    waitingForComment.delete(userId);

    await ctx.reply(
        '✅ ЗАКАЗ ОТПРАВЛЕН!\n\n' +
        'Мы свяжемся с вами для подтверждения.\n\n' +
        'Спасибо, что выбрали Molotov BBQ! 🔥'
    );
}

// ==================== ОФОРМЛЕНИЕ ЗАКАЗА ====================

async function checkout(ctx) {
    const userId = ctx.from.id;
    const cart = carts.get(userId);

    if (!cart || cart.filter(item => item.id && item.name).length === 0) {
        return ctx.reply('🛒 Корзина пуста. Добавьте товары через /menu');
    }

    await askForComment(ctx);
}

bot.action('checkout', (ctx) => checkout(ctx));

// ==================== ОБРАБОТЧИК ТЕКСТА (должен быть последним!) ====================

bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const messageText = ctx.message.text;

    // Пропускаем команды
    if (messageText.startsWith('/')) return;

    // Если пользователь ожидает ввод веса
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

    // Если пользователь ожидает ввод комментария
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

// Ручка для проверки, что бот жив
app.get('/', (req, res) => {
    res.send('🔥 Molotov BBQ Bot is running!');
});

app.get('/webhook', (req, res) => {
    res.send('Webhook endpoint is ready');
});

// Ручка для вебхуков Telegram
app.post('/webhook', async (req, res) => {
    try {
        await bot.handleUpdate(req.body);
        res.send('ok');
    } catch (error) {
        console.error('Ошибка обработки вебхука:', error);
        res.status(500).send('error');
    }
});

// Устанавливаем вебхук при запуске
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

// Запускаем сервер
const port = process.env.PORT || 3000;
app.listen(port, async () => {
    console.log(`🚀 Сервер запущен на порту ${port}`);
    await setWebhook();
});