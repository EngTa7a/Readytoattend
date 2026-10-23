# جاهز — خادم الحضور المركزي (Starter Kit)

هذه الحزمة تنقل المشروع من نموذج HTML محلي إلى **بداية خادم مركزي** يستخدم Node.js وExpress وPostgreSQL. وهي ليست بعدُ خدمة إنتاج منشورة ولا تطبيق أندرويد/iOS جاهزاً للنشر.

## ما الموجود؟
- REST API بإصدار `/api/v1`.
- PostgreSQL مع ترحيل أولي للمخطط.
- تسجيل دخول بكلمات مرور مجزأة بـ bcrypt ورموز JWT.
- أدوار `admin`, `hr`, `manager`, `employee`.
- إدارة أساسية للفروع والموظفين.
- مزامنة دفعات سجلات الحضور حتى 100 حدث، مع `clientEventId` فريد لمنع إدخال السجل نفسه مرتين.
- التحقق على الخادم من حدود الفرع، ودقة GPS، وعمر الحدث غير المتصل.
- سجل تدقيق أولي، وفحص صحة الخدمة.
- Docker Compose للتشغيل التجريبي.

## تشغيل محلي للتطوير
1. ثبّت Docker وDocker Compose وNode.js 20+.
2. انسخ `.env.example` إلى `.env`.
3. أنشئ `JWT_SECRET` عشوائياً بطول 32 حرفاً أو أكثر، وغير كلمات المرور الافتراضية.
4. شغّل قاعدة البيانات والخادم:
   ```bash
   docker compose up -d db
   npm install
   npm run migrate
   npm run create-admin
   npm start
   ```
   بدلاً من تشغيل API عبر Node محلياً، يمكن تشغيل الحزمة كاملة بـ `docker compose up --build -d` بعد تجهيز `.env`. راجع `DATABASE_URL` لأن ملف Compose يمرر كلمة مرور قاعدة البيانات من `POSTGRES_PASSWORD`.
5. اختبر `http://localhost:8080/health`.

> لا ترفع ملف `.env` إلى Git ولا تستخدم كلمات مرور المثال في الاستضافة.

## واجهات API الأساسية

### تسجيل الدخول
`POST /api/v1/auth/login`
```json
{"username":"admin","password":"YOUR_PASSWORD"}
```

### إضافة فرع (admin/hr)
`POST /api/v1/sites` مع `Authorization: Bearer TOKEN`
```json
{"code":"BAG-01","name":"فرع بغداد","latitude":33.3152,"longitude":44.3661,"radiusMeters":150}
```

### إضافة موظف (admin/hr)
`POST /api/v1/employees`
```json
{"employeeCode":"E-1001","fullName":"موظف تجريبي","department":"الدعم الفني","siteId":null}
```

### مزامنة سجلات مؤجلة
`POST /api/v1/attendance/sync`
```json
{
  "events": [{
    "clientEventId":"7caec6f6-48b5-4f0b-a3bb-b2a30b2e13c9",
    "employeeId":"UUID-FROM-EMPLOYEES",
    "siteId":"UUID-FROM-SITES",
    "eventType":"CHECK_IN",
    "capturedAt":"2026-10-23T08:15:00+03:00",
    "latitude":33.3152,
    "longitude":44.3661,
    "accuracyMeters":12,
    "photoObjectKey":null,
    "deviceId":"android-kiosk-01"
  }]
}
```
استبدل القيم الوهمية بمعرّفات UUID الفعلية. يعيد الخادم لكل حدث `accepted` أو `duplicate` أو `rejected` مع رمز سبب الرفض. يجب أن يحتفظ العميل بالسجلات المرفوضة ليتمكن المسؤول من مراجعتها، وألا يحذف من طابور المزامنة إلا `accepted` و`duplicate`.

### التقارير
`GET /api/v1/attendance?from=2026-10-01T00:00:00%2B03:00&to=2026-11-01T00:00:00%2B03:00&limit=500`

## المزامنة دون إنترنت: تصميم العميل
راجع `docs/OFFLINE_SYNC_AR.md` لتصميم الطابور المحلي وسياسة إعادة المحاولة. يجب توليد `clientEventId` مرة واحدة عند إنشاء الحركة، والاحتفاظ به في كل محاولة لاحقة. لا تستخدم وقت الخادم بديلاً عن وقت الالتقاط: يحتفظ النظام بـ `capturedAt` و`receivedAt` منفصلين.

## نشر سحابي — قبل الإنتاج
1. أنشئ PostgreSQL مُداراً لدى مزود سحابي، مع نسخ احتياطية آلية واستعادة مجرّبة.
2. انشر API كخدمة Node.js/Container، مع HTTPS فقط.
3. اضبط `DATABASE_URL` و`PGSSL=true` عند اشتراط TLS من مزود قاعدة البيانات، و`JWT_SECRET`، و`CORS_ORIGINS` على النطاقات الفعلية.
4. ضع الأسرار في مدير أسرار المزود، لا في المستودع.
5. فعّل مراقبة الأخطاء، حدود المعدل، التنبيهات، سياسة الاحتفاظ، وخطة الاستعادة.
6. أضف مخزن صور خاصاً متوافقاً مع S3 أو خدمة مشابهة، وروابط رفع موقعة قصيرة العمر، والتحقق من نوع/حجم الصورة، قبل تفعيل `REQUIRE_PHOTO_EVIDENCE=true`.
7. اختبر الصلاحيات، واختبار ضغط لـ 500+ موظف، ونسخاً احتياطياً واستعادةً قبل الاستخدام الحقيقي.

## قيود أمنية مهمة
- إحداثيات GPS من الهاتف قابلة للتزوير؛ GPS وحده لا يثبت الوجود الفعلي. يمكن إضافة فحوصات سلامة الجهاز أو مراجعة إدارية حسب الحاجة.
- `photoObjectKey` هنا مجرد مرجع نصي، وليس رفعاً أو تحققاً من صورة. لا تفعّل اشتراط الصورة قبل دمج التخزين الخاص والتحقق.
- إنشاء حسابات المستخدمين وربطها بالموظفين يحتاج شاشة/واجهة إدارة آمنة؛ هذه الحزمة توفر إنشاء حساب المدير الأول فقط.
- يجب إضافة اختبارات آلية شاملة، وسياسات صلاحيات تفصيلية للمديرين حسب الفرع، وتصدير التقارير، وإدارة الجداول والورديات والعطل قبل الإنتاج.
- هذه الحزمة لا تزامن نموذج HTML السابق تلقائياً؛ يلزم ربط واجهة الويب/تطبيق الهاتف بواجهات API وتخزين طابور offline في IndexedDB على الويب وSQLite على الهاتف.

## هيكل المشروع
```text
src/server.js          API routes and validation
src/security.js        JWT authentication and role checks
src/geo.js             Haversine distance calculation
src/db.js              PostgreSQL pool
db/001_init.sql        Database schema
scripts/migrate.js     SQL migrations
scripts/create-admin.js Initial admin creation
docs/OFFLINE_SYNC_AR.md Offline queue design
```


## النشر على Render
راجع `docs/DEPLOY_RENDER_AR.md`. يوجد `render.yaml` لتجهيز API وPostgreSQL كـ Blueprint. راجع السعر النهائي في لوحة Render قبل التأكيد، واضبط `CORS_ORIGINS` على نطاق الواجهة الفعلي.
