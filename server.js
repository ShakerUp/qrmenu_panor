const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.set('view engine', 'ejs');

app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Слишком много попыток входа. Попробуйте позже.',
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const allowedExt = ['.jpg', '.jpeg', '.png', '.webp'];

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();

    if (!allowedExt.includes(ext)) {
      return cb(new Error('Разрешены только JPG, PNG и WEBP'));
    }

    if (!file.mimetype.startsWith('image/') || file.mimetype === 'image/svg+xml') {
      return cb(new Error('Разрешены только безопасные изображения'));
    }

    cb(null, true);
  },
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  '/public',
  express.static(path.join(__dirname, 'public'), {
    maxAge: '30d',
    immutable: false,
  }),
);

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'CHANGE_THIS_SECRET_IN_ENV_FILE_32_CHARS_MINIMUM',
    resave: false,
    saveUninitialized: false,
    name: 'menu.sid',
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 14,
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
    },
  }),
);

app.use(flash());

function settings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function requireAdmin(req, res, next) {
  if (!req.session.adminId) return res.redirect('/admin/login');
  next();
}

app.use((req, res, next) => {
  res.locals.flash = req.flash();
  res.locals.currentPath = req.path;
  next();
});

async function optimizeImage(file) {
  if (!file) return '';

  const inputPath = file.path;
  const outputName = `${path.parse(file.filename).name}.webp`;
  const outputPath = path.join(uploadDir, outputName);

  await sharp(inputPath)
    .rotate()
    .resize({ width: 900, withoutEnlargement: true })
    .webp({ quality: 75 })
    .toFile(outputPath);

  fs.unlinkSync(inputPath);

  return `/public/uploads/${outputName}`;
}

/* =========================
   PUBLIC MENU
========================= */

app.get('/', (req, res) => {
  const s = settings();

  const categories = db
    .prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY position, id')
    .all();

  const items = db.prepare('SELECT * FROM items WHERE is_active = 1 ORDER BY position, id').all();

  const subgroups = db.prepare('SELECT * FROM subgroups ORDER BY category_id, position, id').all();

  const grouped = categories.map((c) => ({
    ...c,
    items: items.filter((i) => i.category_id === c.id),
  }));

  res.render('menu-classic', {
    settings: s,
    categories: grouped,
    subgroups,
  });
});

/* =========================
   AUTH
========================= */

app.get('/admin/login', (req, res) => {
  res.render('login');
});

app.post('/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);

  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    req.flash('error', 'Неверный логин или пароль');
    return res.redirect('/admin/login');
  }

  req.session.adminId = admin.id;
  res.redirect('/admin');
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

/* =========================
   ADMIN MIDDLEWARE
========================= */

app.use('/admin', requireAdmin, adminLimiter);

/* =========================
   ADMIN PAGE
========================= */

app.get('/admin', (req, res) => {
  const s = settings();
  const tab = req.query.tab || 'dashboard';

  const categories = db.prepare('SELECT * FROM categories ORDER BY position, id').all();

  const subgroups = db.prepare('SELECT * FROM subgroups ORDER BY category_id, position, id').all();

  const items = db
    .prepare(
      `
      SELECT items.*, categories.title AS category_title
      FROM items
      LEFT JOIN categories ON categories.id = items.category_id
      ORDER BY categories.position, items.position, items.id
      `,
    )
    .all();

  let editItem = null;

  if (tab === 'edit-item' && req.query.id) {
    editItem = db.prepare('SELECT * FROM items WHERE id = ?').get(req.query.id);
  }

  res.render('admin', {
    settings: s,
    categories,
    subgroups,
    items,
    currentTab: tab,
    editItem,
  });
});

/* =========================
   SETTINGS
========================= */

app.post('/admin/settings', upload.single('cover_image'), async (req, res) => {
  const allowed = [
    'restaurant_name',
    'restaurant_subtitle',
    'currency',
    'theme_color',
    'accent_color',
  ];

  const stmt = db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  allowed.forEach((k) => {
    stmt.run(k, req.body[k] || '');
  });

  if (req.file) {
    const coverImage = await optimizeImage(req.file);
    stmt.run('cover_image', coverImage);
  }

  req.flash('success', 'Настройки сохранены');
  res.redirect('/admin?tab=settings');
});

/* =========================
   CATEGORIES
========================= */

app.post('/admin/categories', (req, res) => {
  const { title, description, position, is_active } = req.body;

  db.prepare(
    `
    INSERT INTO categories (title, description, position, is_active)
    VALUES (?, ?, ?, ?)
    `,
  ).run(title, description || '', Number(position || 0), is_active ? 1 : 0);

  req.flash('success', 'Раздел добавлен');
  res.redirect('/admin?tab=categories');
});

app.post('/admin/categories/:id', (req, res) => {
  const { title, description, position, is_active } = req.body;

  db.prepare(
    `
    UPDATE categories
    SET title = ?, description = ?, position = ?, is_active = ?
    WHERE id = ?
    `,
  ).run(title, description || '', Number(position || 0), is_active ? 1 : 0, req.params.id);

  req.flash('success', 'Раздел обновлен');
  res.redirect('/admin?tab=categories');
});

app.post('/admin/categories/:id/delete', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);

  req.flash('success', 'Раздел удален');
  res.redirect('/admin?tab=categories');
});

/* =========================
   SUBGROUPS
========================= */

app.post('/admin/subgroups', (req, res) => {
  const { category_id, title, position } = req.body;

  db.prepare(
    `
    INSERT INTO subgroups (category_id, title, position)
    VALUES (?, ?, ?)
    `,
  ).run(Number(category_id), title, Number(position || 0));

  req.flash('success', 'Подраздел добавлен');
  res.redirect('/admin?tab=subgroups');
});

app.post('/admin/subgroups/:id', (req, res) => {
  const { category_id, title, position } = req.body;

  db.prepare(
    `
    UPDATE subgroups
    SET category_id = ?, title = ?, position = ?
    WHERE id = ?
    `,
  ).run(Number(category_id), title, Number(position || 0), req.params.id);

  req.flash('success', 'Подраздел обновлён');
  res.redirect('/admin?tab=subgroups');
});

app.post('/admin/subgroups/:id/delete', (req, res) => {
  db.prepare('DELETE FROM subgroups WHERE id = ?').run(req.params.id);

  req.flash('success', 'Подраздел удалён');
  res.redirect('/admin?tab=subgroups');
});

/* =========================
   ITEMS
========================= */

app.post('/admin/items', upload.single('image'), async (req, res) => {
  const image = req.file ? await optimizeImage(req.file) : '';

  const {
    category_id,
    title,
    description,
    price,
    old_price,
    weight,
    badges,
    allergens,
    is_popular,
    is_new,
    is_active,
    position,
    promo_label,
    promo_text,
    promo_type,
    subgroup_id,
  } = req.body;

  db.prepare(
    `
    INSERT INTO items
    (
      category_id,
      title,
      description,
      price,
      old_price,
      weight,
      image,
      badges,
      allergens,
      promo_label,
      promo_text,
      promo_type,
      is_popular,
      is_new,
      is_active,
      position,
      subgroup_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    Number(category_id),
    title,
    description || '',
    Number(price || 0),
    old_price ? Number(old_price) : null,
    weight || '',
    image,
    badges || '',
    allergens || '',
    promo_label || '',
    promo_text || '',
    promo_type || 'gift',
    is_popular ? 1 : 0,
    is_new ? 1 : 0,
    is_active ? 1 : 0,
    Number(position || 0),
    subgroup_id ? Number(subgroup_id) : null,
  );

  req.flash('success', 'Позиция добавлена');
  res.redirect('/admin?tab=items');
});

app.post('/admin/items/:id', upload.single('image'), async (req, res) => {
  const current = db.prepare('SELECT image FROM items WHERE id = ?').get(req.params.id);
  const image = req.file ? await optimizeImage(req.file) : current?.image || '';

  const {
    category_id,
    title,
    description,
    price,
    old_price,
    weight,
    badges,
    allergens,
    is_popular,
    is_new,
    is_active,
    position,
    promo_label,
    promo_text,
    promo_type,
    subgroup_id,
  } = req.body;

  db.prepare(
    `
    UPDATE items SET
      category_id = ?,
      title = ?,
      description = ?,
      price = ?,
      old_price = ?,
      weight = ?,
      image = ?,
      badges = ?,
      allergens = ?,
      promo_label = ?,
      promo_text = ?,
      promo_type = ?,
      is_popular = ?,
      is_new = ?,
      is_active = ?,
      position = ?,
      subgroup_id = ?
    WHERE id = ?
    `,
  ).run(
    Number(category_id),
    title,
    description || '',
    Number(price || 0),
    old_price ? Number(old_price) : null,
    weight || '',
    image,
    badges || '',
    allergens || '',
    promo_label || '',
    promo_text || '',
    promo_type || 'gift',
    is_popular ? 1 : 0,
    is_new ? 1 : 0,
    is_active ? 1 : 0,
    Number(position || 0),
    subgroup_id ? Number(subgroup_id) : null,
    req.params.id,
  );

  req.flash('success', 'Позиция обновлена');
  res.redirect('/admin?tab=items');
});

app.post('/admin/items/:id/delete', (req, res) => {
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);

  req.flash('success', 'Позиция удалена');
  res.redirect('/admin?tab=items');
});

/* =========================
   ERROR HANDLER
========================= */

app.use((err, req, res, next) => {
  console.error(err);

  if (err instanceof multer.MulterError) {
    req.flash('error', 'Ошибка загрузки файла: ' + err.message);
    return res.redirect('/admin');
  }

  if (err.message) {
    req.flash('error', err.message);
    return res.redirect(req.originalUrl.startsWith('/admin') ? '/admin' : '/');
  }

  res.status(500).send('Server error');
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(`Menu site running: http://localhost:${PORT}`);
});
