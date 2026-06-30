const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const archiver = require('archiver');
const unzipper = require('unzipper');
let cron = null;
try {
  cron = require('node-cron');
} catch (_) {
  console.warn('node-cron не установлен: автоматические бэкапы отключены');
}
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.set('view engine', 'ejs');

app.use(helmet({ contentSecurityPolicy: false }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Слишком много попыток входа. Попробуйте позже.',
});

const kitchenLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
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
const backupsDir = path.join(__dirname, 'backups');
const tempDir = path.join(__dirname, 'tmp');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

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
    if (!allowedExt.includes(ext)) return cb(new Error('Разрешены только JPG, PNG и WEBP'));
    if (!file.mimetype.startsWith('image/') || file.mimetype === 'image/svg+xml')
      return cb(new Error('Разрешены только безопасные изображения'));
    cb(null, true);
  },
});

const backupStorage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, tempDir),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `uploaded-backup-${Date.now()}${ext}`);
  },
});

const backupUpload = multer({
  storage: backupStorage,
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext !== '.zip') return cb(new Error('Можно загрузить только ZIP-архив резервной копии'));
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

function requireKitchen(req, res, next) {
  if (!req.session.kitchenAuth) return res.redirect('/kitchen/login');
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

function safeBackupName(fileName) {
  const clean = path.basename(fileName || '');
  if (!clean.endsWith('.zip')) return null;
  return clean;
}

function listBackups() {
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
  return fs
    .readdirSync(backupsDir)
    .filter((name) => name.endsWith('.zip'))
    .map((name) => {
      const fullPath = path.join(backupsDir, name);
      const stat = fs.statSync(fullPath);
      return {
        name,
        size: stat.size,
        sizeMb: (stat.size / 1024 / 1024).toFixed(2),
        createdAt: stat.mtime,
        createdLabel: stat.mtime.toLocaleString('ru-RU'),
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

function pruneOldBackups(keep = 30) {
  const backups = listBackups();
  backups.slice(keep).forEach((backup) => {
    try {
      fs.unlinkSync(path.join(backupsDir, backup.name));
    } catch (err) {
      console.warn('Не удалось удалить старый backup:', backup.name, err.message);
    }
  });
}

function checkpointDatabase() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    console.warn('Не удалось выполнить WAL checkpoint:', err.message);
  }
}

function makeBackupFileName(prefix = 'backup') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${prefix}_${stamp}.zip`;
}

function createBackupArchive(fileName) {
  return new Promise((resolve, reject) => {
    checkpointDatabase();

    const cleanName = safeBackupName(fileName) || makeBackupFileName();
    const outputPath = path.join(backupsDir, cleanName);
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 9 },
    });

    output.on('close', () => resolve({ fileName: cleanName, outputPath }));
    archive.on('error', reject);

    archive.pipe(output);

    const dbPath = path.join(__dirname, 'menu.db');
    if (fs.existsSync(dbPath)) archive.file(dbPath, { name: 'menu.db' });
    if (fs.existsSync(uploadDir)) archive.directory(uploadDir, 'uploads');

    archive.append(
      JSON.stringify(
        {
          created_at: new Date().toISOString(),
          app: 'qrmenu',
          restaurant: settings().restaurant_name || '',
          contains: ['menu.db', 'uploads'],
        },
        null,
        2,
      ),
      { name: 'backup.json' },
    );

    archive.finalize();
  });
}

async function extractBackup(zipPath) {
  const extractDir = path.join(tempDir, `restore-${Date.now()}`);
  fs.mkdirSync(extractDir, { recursive: true });
  await fs
    .createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: extractDir }))
    .promise();
  return extractDir;
}

function restoreFromExtractedBackup(extractDir) {
  const extractedDb = path.join(extractDir, 'menu.db');
  const extractedUploads = path.join(extractDir, 'uploads');
  const activeDbPath = path.join(__dirname, 'menu.db');

  if (!fs.existsSync(extractedDb)) {
    throw new Error('В архиве не найден menu.db. Это не похоже на резервную копию сайта.');
  }

  checkpointDatabase();

  const beforeRestoreName = `before_restore_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`;
  if (fs.existsSync(activeDbPath)) {
    fs.copyFileSync(activeDbPath, path.join(backupsDir, beforeRestoreName));
  }

  db.close();

  fs.copyFileSync(extractedDb, activeDbPath);

  if (fs.existsSync(extractedUploads)) {
    fs.rmSync(uploadDir, { recursive: true, force: true });
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.cpSync(extractedUploads, uploadDir, { recursive: true });
  }
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
  const variants = db.prepare('SELECT * FROM item_variants ORDER BY item_id, position, id').all();

  const grouped = categories.map((c) => ({
    ...c,
    items: items
      .filter((i) => i.category_id === c.id)
      .map((i) => ({
        ...i,
        variants: variants.filter((v) => v.item_id === i.id),
      })),
  }));

  res.render('menu-classic', { settings: s, categories: grouped, subgroups });
});

/* =========================
   KITCHEN AUTH
========================= */

app.get('/kitchen/login', (req, res) => res.render('kitchen-login'));

app.post('/kitchen/login', kitchenLoginLimiter, (req, res) => {
  const { password } = req.body;
  const kitchenPassword = process.env.KITCHEN_PASSWORD || '';

  if (!kitchenPassword) {
    req.flash('error', 'KITCHEN_PASSWORD не настроен в .env');
    return res.redirect('/kitchen/login');
  }

  // Сравнение константного времени — защита от timing-атак
  const crypto = require('crypto');
  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(String(kitchenPassword));
  const isValid = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!isValid) {
    req.flash('error', 'Неверный пароль');
    return res.redirect('/kitchen/login');
  }

  // Пересоздаём сессию при логине — защита от session fixation
  req.session.regenerate((err) => {
    if (err) {
      req.flash('error', 'Ошибка входа, попробуйте ещё раз');
      return res.redirect('/kitchen/login');
    }
    req.session.kitchenAuth = true;
    res.redirect('/kitchen');
  });
});

app.post('/kitchen/logout', (req, res) => {
  req.session.kitchenAuth = false;
  res.redirect('/kitchen/login');
});

/* =========================
   KITCHEN / COOKS PAGE
========================= */

app.get('/kitchen', requireKitchen, (req, res) => {
  const s = settings();
  const categories = db
    .prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY position, id')
    .all();
  const items = db.prepare('SELECT * FROM items WHERE is_active = 1 ORDER BY position, id').all();
  const subgroups = db.prepare('SELECT * FROM subgroups ORDER BY category_id, position, id').all();
  const variants = db.prepare('SELECT * FROM item_variants ORDER BY item_id, position, id').all();

  const grouped = categories.map((c) => ({
    ...c,
    items: items
      .filter((i) => i.category_id === c.id)
      .map((i) => ({
        ...i,
        variants: variants.filter((v) => v.item_id === i.id),
      })),
  }));

  res.render('kitchen', { settings: s, categories: grouped, subgroups });
});

/* =========================
   AUTH (ADMIN)
========================= */

app.get('/admin/login', (req, res) => res.render('login'));

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
  let editVariants = [];

  if (tab === 'edit-item' && req.query.id) {
    editItem = db.prepare('SELECT * FROM items WHERE id = ?').get(req.query.id);
    editVariants = db
      .prepare('SELECT * FROM item_variants WHERE item_id = ? ORDER BY position, id')
      .all(req.query.id);
  }

  const backups = tab === 'backups' ? listBackups() : [];

  res.render('admin', {
    settings: s,
    categories,
    subgroups,
    items,
    backups,
    currentTab: tab,
    editItem,
    editVariants,
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
  const stmt = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  allowed.forEach((k) => stmt.run(k, req.body[k] || ''));
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
    'INSERT INTO categories (title, description, position, is_active) VALUES (?, ?, ?, ?)',
  ).run(title, description || '', Number(position || 0), is_active ? 1 : 0);
  req.flash('success', 'Раздел добавлен');
  res.redirect('/admin?tab=categories');
});

app.post('/admin/categories/:id', (req, res) => {
  const { title, description, position, is_active } = req.body;
  db.prepare(
    'UPDATE categories SET title = ?, description = ?, position = ?, is_active = ? WHERE id = ?',
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
  db.prepare('INSERT INTO subgroups (category_id, title, position) VALUES (?, ?, ?)').run(
    Number(category_id),
    title,
    Number(position || 0),
  );
  req.flash('success', 'Подраздел добавлен');
  res.redirect('/admin?tab=subgroups');
});

app.post('/admin/subgroups/:id', (req, res) => {
  const { category_id, title, position } = req.body;
  db.prepare('UPDATE subgroups SET category_id = ?, title = ?, position = ? WHERE id = ?').run(
    Number(category_id),
    title,
    Number(position || 0),
    req.params.id,
  );
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

function saveVariants(itemId, body) {
  db.prepare('DELETE FROM item_variants WHERE item_id = ?').run(itemId);

  const labels = [].concat(body.variant_label || []);
  const prices = [].concat(body.variant_price || []);
  const positions = [].concat(body.variant_position || []);

  const insert = db.prepare(
    'INSERT INTO item_variants (item_id, label, price, position) VALUES (?, ?, ?, ?)',
  );

  const tx = db.transaction(() => {
    labels.forEach((label, i) => {
      const lbl = (label || '').trim();
      const price = parseFloat(prices[i] || 0);
      const pos = Number(positions[i] || i);
      if (lbl && !isNaN(price)) insert.run(itemId, lbl, price, pos);
    });
  });
  tx();
}

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
    tech_card,
  } = req.body;

  const result = db
    .prepare(
      `
    INSERT INTO items
      (category_id, title, description, price, old_price, weight, image,
       badges, allergens, promo_label, promo_text, promo_type, tech_card,
       is_popular, is_new, is_active, position, subgroup_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
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
      tech_card || '',
      is_popular ? 1 : 0,
      is_new ? 1 : 0,
      is_active ? 1 : 0,
      Number(position || 0),
      subgroup_id ? Number(subgroup_id) : null,
    );

  saveVariants(result.lastInsertRowid, req.body);

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
    tech_card,
  } = req.body;

  db.prepare(
    `
    UPDATE items SET
      category_id = ?, title = ?, description = ?, price = ?,
      old_price = ?, weight = ?, image = ?, badges = ?, allergens = ?,
      promo_label = ?, promo_text = ?, promo_type = ?, tech_card = ?,
      is_popular = ?, is_new = ?, is_active = ?, position = ?, subgroup_id = ?
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
    tech_card || '',
    is_popular ? 1 : 0,
    is_new ? 1 : 0,
    is_active ? 1 : 0,
    Number(position || 0),
    subgroup_id ? Number(subgroup_id) : null,
    req.params.id,
  );

  saveVariants(req.params.id, req.body);

  req.flash('success', 'Позиция обновлена');
  res.redirect('/admin?tab=items');
});

app.post('/admin/items/:id/delete', (req, res) => {
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  req.flash('success', 'Позиция удалена');
  res.redirect('/admin?tab=items');
});

/* =========================
   BACKUPS
========================= */

app.post('/admin/backups/create', async (req, res, next) => {
  try {
    const backup = await createBackupArchive(makeBackupFileName('backup'));
    req.flash('success', `Резервная копия создана: ${backup.fileName}`);
    res.redirect('/admin?tab=backups');
  } catch (err) {
    next(err);
  }
});

app.get('/admin/backups/:file/download', (req, res, next) => {
  try {
    const fileName = safeBackupName(req.params.file);
    if (!fileName) throw new Error('Некорректное имя файла');
    const filePath = path.join(backupsDir, fileName);
    if (!fs.existsSync(filePath)) throw new Error('Резервная копия не найдена');
    res.download(filePath, fileName);
  } catch (err) {
    next(err);
  }
});

app.post('/admin/backups/:file/delete', (req, res, next) => {
  try {
    const fileName = safeBackupName(req.params.file);
    if (!fileName) throw new Error('Некорректное имя файла');
    const filePath = path.join(backupsDir, fileName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    req.flash('success', 'Резервная копия удалена');
    res.redirect('/admin?tab=backups');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/backups/upload', backupUpload.single('backup_zip'), async (req, res, next) => {
  try {
    if (!req.file) throw new Error('Файл не загружен');

    const originalBase = path.basename(req.file.originalname || 'uploaded.zip', '.zip');
    const safeBase =
      originalBase.replace(/[^a-zA-Z0-9а-яА-ЯёЁ._-]/g, '_').slice(0, 80) || 'uploaded_backup';
    const fileName = `${safeBase}_${Date.now()}.zip`;
    const finalPath = path.join(backupsDir, fileName);
    fs.copyFileSync(req.file.path, finalPath);
    fs.unlinkSync(req.file.path);

    if (req.body.action === 'restore') {
      const extractDir = await extractBackup(finalPath);
      restoreFromExtractedBackup(extractDir);
      res.send(`
        <meta charset="utf-8">
        <style>body{font-family:Arial,sans-serif;padding:30px;line-height:1.5}</style>
        <h2>Резервная копия загружена и восстановлена</h2>
        <p>Сервер сейчас будет остановлен для перезапуска с новой базой.</p>
        <p>Если у тебя PM2 — он поднимет сайт сам. Локально запусти <code>node server.js</code> заново.</p>
      `);
      return setTimeout(() => process.exit(0), 800);
    }

    req.flash('success', `Резервная копия загружена: ${fileName}`);
    res.redirect('/admin?tab=backups');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/backups/:file/restore', async (req, res, next) => {
  try {
    const fileName = safeBackupName(req.params.file);
    if (!fileName) throw new Error('Некорректное имя файла');
    const filePath = path.join(backupsDir, fileName);
    if (!fs.existsSync(filePath)) throw new Error('Резервная копия не найдена');

    const extractDir = await extractBackup(filePath);
    restoreFromExtractedBackup(extractDir);

    res.send(`
      <meta charset="utf-8">
      <style>body{font-family:Arial,sans-serif;padding:30px;line-height:1.5}</style>
      <h2>Резервная копия восстановлена</h2>
      <p>Активная база <code>menu.db</code> и папка <code>public/uploads</code> заменены.</p>
      <p>Сервер сейчас будет остановлен для перезапуска с новой базой.</p>
      <p>Если у тебя PM2 — он поднимет сайт сам. Локально запусти <code>node server.js</code> заново.</p>
    `);

    setTimeout(() => process.exit(0), 800);
  } catch (err) {
    next(err);
  }
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
   AUTO BACKUPS
========================= */

if (cron) {
  const autoBackupCron = process.env.BACKUP_CRON || '0 3 * * *';
  const autoBackupKeep = Number(process.env.BACKUP_KEEP || 30);

  cron.schedule(
    autoBackupCron,
    async () => {
      try {
        const backup = await createBackupArchive(makeBackupFileName('auto_backup'));
        pruneOldBackups(autoBackupKeep);
        console.log(`Auto backup created: ${backup.fileName}`);
      } catch (err) {
        console.error('Auto backup failed:', err);
      }
    },
    { timezone: process.env.BACKUP_TIMEZONE || 'Europe/Kyiv' },
  );
}

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(`Menu site running: http://localhost:${PORT}`);
});
