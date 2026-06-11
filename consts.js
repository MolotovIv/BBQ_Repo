// consts.js - файл с константами и товарами

// ==================== ТОВАРЫ ====================
const products = {
    ribs: { name: '🍖 Ребра свиные', price: 3000, unit: 'кг' },
    brisket: { name: '🥩 Брискет', price: 4500, unit: 'кг' },
    pork: { name: '🐖 Свинина', price: 2500, unit: 'кг' },
    turkey: { name: '🦃 Индейка', price: 3000, unit: 'кг' }
};

// ==================== ID АДМИНИСТРАТОРОВ ====================
const ADMIN_IDS = [1323252853, 1069660149]; // Замените на свои

// ==================== КНОПКИ МЕНЮ ====================
const getMenuKeyboard = () => {
    return {
        inline_keyboard: [
            [{ text: '🍖 Ребра свиные — 3000₽/кг', callback_data: 'select_ribs' }],
            [{ text: '🥩 Брискет — 4500₽/кг', callback_data: 'select_brisket' }],
            [{ text: '🐖 Свинина — 2500₽/кг', callback_data: 'select_pork' }],
            [{ text: '🦃 Индейка — 3000₽/кг', callback_data: 'select_turkey' }],
            [{ text: '🛒 Перейти в корзину', callback_data: 'view_cart' }]
        ]
    };
};

// ==================== КНОПКИ ВЫБОРА ВЕСА ====================
const getWeightKeyboard = () => {
    return {
        inline_keyboard: [
            [{ text: '🔹 300 г', callback_data: 'weight_0.3' }, { text: '🔹 500 г', callback_data: 'weight_0.5' }],
            [{ text: '🔹 700 г', callback_data: 'weight_0.7' }, { text: '🔹 1 кг', callback_data: 'weight_1.0' }],
            [{ text: '🔹 1.5 кг', callback_data: 'weight_1.5' }, { text: '🔹 2 кг', callback_data: 'weight_2.0' }],
            [{ text: '✏️ Свой вес (кратно 100 г)', callback_data: 'weight_custom' }],
            [{ text: '❌ Отмена', callback_data: 'weight_cancel' }]
        ]
    };
};

// ==================== КНОПКИ КОРЗИНЫ ====================
const getCartKeyboard = () => {
    return {
        inline_keyboard: [
            [{ text: '📦 Оформить заказ', callback_data: 'checkout' }],
            [{ text: '🗑 Очистить корзину', callback_data: 'clear_cart' }]
        ]
    };
};

// ==================== КНОПКИ ДОБАВЛЕНИЯ В КОРЗИНУ ====================
const getAddToCartKeyboard = () => {
    return {
        inline_keyboard: [
            [{ text: '🛒 Перейти в корзину', callback_data: 'view_cart' }],
            [{ text: '📦 Оформить заказ', callback_data: 'checkout' }]
        ]
    };
};

// ==================== КНОПКИ КОММЕНТАРИЯ ====================
const getCommentKeyboard = () => {
    return {
        inline_keyboard: [
            [{ text: '📝 Пропустить (без комментария)', callback_data: 'skip_comment' }],
            [{ text: '❌ Отмена заказа', callback_data: 'cancel_order' }]
        ]
    };
};

// Экспортируем всё
module.exports = {
    products,
    ADMIN_IDS,
    getMenuKeyboard,
    getWeightKeyboard,
    getCartKeyboard,
    getAddToCartKeyboard,
    getCommentKeyboard
};