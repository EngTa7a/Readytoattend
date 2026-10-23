const jwt = require('jsonwebtoken');

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, employeeId: user.employee_id || null, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h', issuer: 'jahez-api', audience: 'jahez-client' }
  );
}
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'AUTH_REQUIRED', message: 'يرجى تسجيل الدخول' });
  try {
    req.auth = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'jahez-api', audience: 'jahez-client' });
    next();
  } catch {
    return res.status(401).json({ error: 'INVALID_TOKEN', message: 'انتهت الجلسة أو رمز الدخول غير صالح' });
  }
}
function allowRoles(...roles) {
  return (req, res, next) => roles.includes(req.auth.role)
    ? next()
    : res.status(403).json({ error: 'FORBIDDEN', message: 'ليست لديك الصلاحية المطلوبة' });
}
module.exports = { signToken, requireAuth, allowRoles };
