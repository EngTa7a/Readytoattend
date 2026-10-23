require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { pool } = require('./db');
const { signToken, requireAuth, allowRoles } = require('./security');
const { distanceMeters } = require('./geo');

const app = express();
const port = Number(process.env.PORT || 8080);
const jwtSecret = process.env.JWT_SECRET || '';
if (jwtSecret.length < 32) {
  console.error('JWT_SECRET must be set and at least 32 characters long.');
  process.exit(1);
}
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());
const origins = (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin(origin, cb) {
  if (!origin || origins.includes(origin)) return cb(null, true);
  return cb(new Error('Origin not allowed by CORS'));
} }));
app.use(express.json({ limit: '256kb' }));
app.use('/api/v1/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }));
app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok', database: 'ok', service: 'jahez-api' }); }
  catch { res.status(503).json({ status: 'degraded', database: 'unavailable' }); }
});

const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200)
});
app.post('/api/v1/auth/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'INVALID_INPUT', message: 'بيانات الدخول غير مكتملة' });
    const { username, password } = parsed.data;
    const result = await pool.query(
      `SELECT id, username, password_hash, full_name, role, employee_id, is_active
       FROM users WHERE username = $1`, [username]
    );
    const user = result.rows[0];
    if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'BAD_CREDENTIALS', message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
    await pool.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id)
      VALUES($1,'auth.login','user',$1::text)`, [user.id]);
    res.json({
      token: signToken(user),
      tokenType: 'Bearer',
      expiresIn: process.env.JWT_EXPIRES_IN || '8h',
      user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role, employeeId: user.employee_id }
    });
  } catch (e) { next(e); }
});

app.use('/api/v1', requireAuth);
app.get('/api/v1/me', async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT id, username, full_name, role, employee_id FROM users WHERE id=$1 AND is_active=true`,
      [req.auth.sub]
    );
    if (!r.rowCount) return res.status(401).json({ error: 'USER_INACTIVE' });
    const u = r.rows[0];
    res.json({ id: u.id, username: u.username, fullName: u.full_name, role: u.role, employeeId: u.employee_id });
  } catch (e) { next(e); }
});

app.get('/api/v1/sites', async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT id,code,name,latitude,longitude,radius_meters AS "radiusMeters"
       FROM sites WHERE is_active=true ORDER BY name`
    );
    res.json({ items: r.rows });
  } catch (e) { next(e); }
});

app.post('/api/v1/sites', allowRoles('admin','hr'), async (req, res, next) => {
  const schema = z.object({
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(160),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    radiusMeters: z.number().int().min(20).max(10000).default(150)
  });
  const p = schema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'INVALID_INPUT', details: p.error.flatten() });
  try {
    const { code, name, latitude, longitude, radiusMeters } = p.data;
    const r = await pool.query(
      `INSERT INTO sites(code,name,latitude,longitude,radius_meters)
       VALUES($1,$2,$3,$4,$5) RETURNING id,code,name,latitude,longitude,radius_meters AS "radiusMeters"`,
      [code,name,latitude,longitude,radiusMeters]
    );
    await pool.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,details)
      VALUES($1,'site.create','site',$2,$3)`, [req.auth.sub,r.rows[0].id,JSON.stringify({code,name})]);
    res.status(201).json(r.rows[0]);
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'DUPLICATE_SITE_CODE' }); next(e); }
});

app.get('/api/v1/employees', allowRoles('admin','hr','manager'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.id,e.employee_code AS "employeeCode",e.full_name AS "fullName",
              e.department,e.site_id AS "siteId",s.name AS "siteName",e.is_active AS "isActive"
       FROM employees e LEFT JOIN sites s ON s.id=e.site_id
       ORDER BY e.full_name LIMIT 2000`
    );
    res.json({ items: rows });
  } catch (e) { next(e); }
});

app.post('/api/v1/employees', allowRoles('admin','hr'), async (req, res, next) => {
  const schema = z.object({
    employeeCode: z.string().trim().min(1).max(60),
    fullName: z.string().trim().min(1).max(160),
    department: z.string().trim().max(120).optional().nullable(),
    siteId: z.string().uuid().optional().nullable()
  });
  const p = schema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'INVALID_INPUT', details: p.error.flatten() });
  try {
    const d = p.data;
    const r = await pool.query(
      `INSERT INTO employees(employee_code,full_name,department,site_id)
       VALUES($1,$2,$3,$4)
       RETURNING id,employee_code AS "employeeCode",full_name AS "fullName",department,site_id AS "siteId"`,
      [d.employeeCode,d.fullName,d.department || null,d.siteId || null]
    );
    await pool.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,details)
      VALUES($1,'employee.create','employee',$2,$3)`,
      [req.auth.sub,r.rows[0].id,JSON.stringify({employeeCode:d.employeeCode})]);
    res.status(201).json(r.rows[0]);
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'DUPLICATE_EMPLOYEE_CODE' }); next(e); }
});

const syncSchema = z.object({
  events: z.array(z.object({
    clientEventId: z.string().uuid(),
    employeeId: z.string().uuid(),
    siteId: z.string().uuid(),
    eventType: z.enum(['CHECK_IN','CHECK_OUT']),
    capturedAt: z.string().datetime({ offset: true }),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyMeters: z.number().min(0).max(10000),
    photoObjectKey: z.string().max(500).optional().nullable(),
    deviceId: z.string().max(120).optional().nullable()
  })).min(1).max(100)
});

app.post('/api/v1/attendance/sync', async (req, res, next) => {
  const p = syncSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'INVALID_INPUT', details: p.error.flatten() });
  const results = [];
  const maxAccuracy = Number(process.env.MAX_GPS_ACCURACY_METERS || 100);
  const maxAgeHours = Number(process.env.MAX_OFFLINE_AGE_HOURS || 168);
  const requirePhoto = process.env.REQUIRE_PHOTO_EVIDENCE === 'true';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const ev of p.data.events) {
      const existing = await client.query('SELECT id FROM attendance_events WHERE client_event_id=$1', [ev.clientEventId]);
      if (existing.rowCount) {
        results.push({ clientEventId: ev.clientEventId, status: 'duplicate', serverEventId: existing.rows[0].id });
        continue;
      }
      if (req.auth.role === 'employee' && req.auth.employeeId !== ev.employeeId) {
        results.push({ clientEventId: ev.clientEventId, status: 'rejected', code: 'EMPLOYEE_SCOPE' });
        continue;
      }
      const captured = new Date(ev.capturedAt);
      const ageHours = (Date.now() - captured.getTime()) / 3600000;
      if (!Number.isFinite(ageHours) || ageHours < -0.05 || ageHours > maxAgeHours) {
        results.push({ clientEventId: ev.clientEventId, status: 'rejected', code: 'CAPTURE_TIME_OUT_OF_RANGE' });
        continue;
      }
      if (ev.accuracyMeters > maxAccuracy) {
        results.push({ clientEventId: ev.clientEventId, status: 'rejected', code: 'GPS_ACCURACY_TOO_LOW' });
        continue;
      }
      if (requirePhoto && !ev.photoObjectKey) {
        results.push({ clientEventId: ev.clientEventId, status: 'rejected', code: 'PHOTO_REQUIRED' });
        continue;
      }
      const emp = await client.query('SELECT id,is_active FROM employees WHERE id=$1', [ev.employeeId]);
      const site = await client.query('SELECT id,latitude,longitude,radius_meters,is_active FROM sites WHERE id=$1', [ev.siteId]);
      if (!emp.rowCount || !emp.rows[0].is_active) {
        results.push({ clientEventId: ev.clientEventId, status: 'rejected', code: 'EMPLOYEE_NOT_ACTIVE' }); continue;
      }
      if (!site.rowCount || !site.rows[0].is_active) {
        results.push({ clientEventId: ev.clientEventId, status: 'rejected', code: 'SITE_NOT_ACTIVE' }); continue;
      }
      const s = site.rows[0];
      const distance = distanceMeters(ev.latitude,ev.longitude,Number(s.latitude),Number(s.longitude));
      if (distance > Number(s.radius_meters)) {
        results.push({ clientEventId: ev.clientEventId, status: 'rejected', code: 'OUTSIDE_GEOFENCE', distanceMeters: Math.round(distance) }); continue;
      }
      const inserted = await client.query(
        `INSERT INTO attendance_events
         (client_event_id,employee_id,site_id,event_type,captured_at,latitude,longitude,accuracy_meters,distance_meters,photo_object_key,device_id,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT(client_event_id) DO NOTHING
         RETURNING id,received_at`,
        [ev.clientEventId,ev.employeeId,ev.siteId,ev.eventType,captured,ev.latitude,ev.longitude,ev.accuracyMeters,distance,ev.photoObjectKey || null,ev.deviceId || null,req.auth.sub]
      );
      if (!inserted.rowCount) {
        const duplicate = await client.query('SELECT id FROM attendance_events WHERE client_event_id=$1',[ev.clientEventId]);
        results.push({ clientEventId: ev.clientEventId, status: 'duplicate', serverEventId: duplicate.rows[0]?.id });
      } else {
        results.push({ clientEventId: ev.clientEventId, status: 'accepted', serverEventId: inserted.rows[0].id, receivedAt: inserted.rows[0].received_at });
      }
    }
    await client.query('COMMIT');
    res.json({ results });
  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally { client.release(); }
});

app.get('/api/v1/attendance', allowRoles('admin','hr','manager'), async (req, res, next) => {
  const schema = z.object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    siteId: z.string().uuid().optional(),
    employeeId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200)
  });
  const p = schema.safeParse(req.query);
  if (!p.success) return res.status(400).json({ error: 'INVALID_QUERY' });
  try {
    const q = p.data;
    const where = [];
    const args = [];
    const add = (clause, value) => { args.push(value); where.push(clause.replace('?', `$${args.length}`)); };
    if (q.from) add('a.captured_at >= ?', q.from);
    if (q.to) add('a.captured_at < ?', q.to);
    if (q.siteId) add('a.site_id = ?', q.siteId);
    if (q.employeeId) add('a.employee_id = ?', q.employeeId);
    args.push(q.limit);
    const sql = `SELECT a.id,a.client_event_id AS "clientEventId",a.event_type AS "eventType",
      a.captured_at AS "capturedAt",a.received_at AS "receivedAt",a.latitude,a.longitude,
      a.accuracy_meters AS "accuracyMeters",a.distance_meters AS "distanceMeters",
      a.photo_object_key AS "photoObjectKey",e.employee_code AS "employeeCode",
      e.full_name AS "employeeName",s.name AS "siteName"
      FROM attendance_events a JOIN employees e ON e.id=a.employee_id JOIN sites s ON s.id=a.site_id
      ${where.length ? 'WHERE '+where.join(' AND ') : ''}
      ORDER BY a.captured_at DESC LIMIT $${args.length}`;
    const r = await pool.query(sql,args);
    res.json({ items:r.rows });
  } catch (e) { next(e); }
});

app.use((err, _req, res, _next) => {
  console.error(err.stack || err.message || err);
  if (err.message === 'Origin not allowed by CORS') return res.status(403).json({ error: 'CORS_ORIGIN_DENIED' });
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'حدث خطأ داخلي. راجع سجل الخادم.' });
});

const server = app.listen(port, () => console.log(`Jahez API listening on ${port}`));
async function shutdown() {
  server.close(async () => { await pool.end(); process.exit(0); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
