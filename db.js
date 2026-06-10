const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const db = new Database('menu.db');

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  position INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  old_price REAL,
  weight TEXT DEFAULT '',
  image TEXT DEFAULT '',
  badges TEXT DEFAULT '',
  allergens TEXT DEFAULT '',
  is_popular INTEGER DEFAULT 0,
  is_new INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  position INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE CASCADE
);
`);

function setDefault(key, value) {
  const exists = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!exists) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

setDefault('restaurant_name', process.env.RESTAURANT_NAME || 'My Restaurant');
setDefault('restaurant_subtitle', process.env.RESTAURANT_SUBTITLE || 'Modern Restaurant');
setDefault('currency', process.env.CURRENCY || '₴');
setDefault('theme_color', '#111111');
setDefault('accent_color', '#d7b56d');
setDefault('cover_image', '');

const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'change_me_123';
const admin = db.prepare('SELECT id FROM admins WHERE username = ?').get(adminUsername);
if (!admin) {
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
    .run(adminUsername, bcrypt.hashSync(adminPassword, 10));
}

const countCategories = db.prepare('SELECT COUNT(*) as count FROM categories').get().count;
if (countCategories === 0) {
  const cat = db.prepare('INSERT INTO categories (title, description, position) VALUES (?, ?, ?)');
  const item = db.prepare(`INSERT INTO items
    (category_id, title, description, price, weight, badges, is_popular, is_new, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const starters = cat.run('Закуски', 'Легкие блюда для начала', 1).lastInsertRowid;
  const mains = cat.run('Основные блюда', 'Фирменные позиции ресторана', 2).lastInsertRowid;
  const drinks = cat.run('Напитки', 'Кофе, чай, лимонады и коктейли', 3).lastInsertRowid;

  item.run(starters, 'Брускетта с томатами', 'Хрустящий хлеб, томаты, базилик, оливковое масло', 180, '180 г', 'vegan', 1, 0, 1);
  item.run(starters, 'Сырная тарелка', 'Ассорти сыров, мед, орехи, виноград', 390, '250 г', '', 0, 1, 2);
  item.run(mains, 'Стейк из говядины', 'Сочный стейк с соусом демиглас и овощами гриль', 690, '320 г', 'chef', 1, 0, 1);
  item.run(mains, 'Паста с морепродуктами', 'Паста, креветки, мидии, сливочный соус', 420, '300 г', '', 0, 0, 2);
  item.run(drinks, 'Домашний лимонад', 'Лимон, мята, содовая, лед', 120, '350 мл', 'fresh', 1, 0, 1);
}

module.exports = db;
