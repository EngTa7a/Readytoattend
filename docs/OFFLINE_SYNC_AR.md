# تصميم المزامنة دون إنترنت — جاهز

## القاعدة الأساسية
يُسجل الحدث أولاً في قاعدة محلية دائمة، ثم يحاول العميل إرساله للخادم. عدم وجود اتصال لا يمنع التسجيل المحلي، لكنه يعني أن الحدث لم يصبح بعد سجلاً مركزياً مؤكداً.

## حقول الحدث المحلي
- `clientEventId`: UUID ثابت وفريد يُنشأ مرة واحدة.
- `employeeId`, `siteId`, `eventType`.
- `capturedAt`: وقت الالتقاط مع المنطقة الزمنية.
- `latitude`, `longitude`, `accuracyMeters`.
- `photoLocalUri` أو مسار ملف الصورة المحلي، ويظل خاصاً بالجهاز.
- `syncState`: `pending`, `syncing`, `accepted`, `rejected`.
- `attemptCount`, `lastAttemptAt`, `lastError`.

لا ترسل مسار ملف الصورة المحلي إلى الخادم. ارفع الصورة إلى مخزن خاص أولاً عند عودة الاتصال، ثم أرسل `photoObjectKey` بعد نجاح الرفع.

## دورة المزامنة
1. احفظ الحدث محلياً قبل عرض رسالة نجاح للمستخدم.
2. عندما يتوفر اتصال، خذ دفعة من 1 إلى 100 حدث بحالة `pending`.
3. أرسلها إلى `POST /api/v1/attendance/sync`.
4. `accepted` و`duplicate`: علّم الحدث محلياً بأنه متزامن، ثم احتفظ به محلياً حسب سياسة الاحتفاظ.
5. `rejected`: لا تحذفه؛ اعرض سبب الرفض للمشرف، واسمح بإعادة المحاولة بعد التصحيح إن كان ذلك ممكناً.
6. أخطاء الشبكة و5xx: أعد الحالة إلى `pending` وزد مدة الانتظار تدريجياً (مثلاً 2، 5، 15، 30، 60 ثانية، مع عشوائية بسيطة).
7. لا تنشئ `clientEventId` جديداً عند إعادة المحاولة؛ ذلك هو مفتاح منع التكرار.
8. عند إعادة تشغيل التطبيق، استأنف السجلات المعلقة من قاعدة البيانات المحلية.

## نموذج JavaScript توضيحي للويب
هذا مثال توضيحي لطبقة المزامنة، وليس ربطاً جاهزاً بواجهة الإصدار الثالث. في التنفيذ الفعلي استبدل `localQueue` بطبقة IndexedDB، ولا تحفظ الرموز الحساسة في localStorage إن أمكن استخدام تخزين آمن مناسب للمنصة.

```js
async function syncBatch({ apiBase, token, localQueue }) {
  const pending = await localQueue.getPending(100);
  if (!pending.length) return { sent: 0 };

  const response = await fetch(`${apiBase}/api/v1/attendance/sync`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      events: pending.map(({ photoLocalUri, syncState, ...event }) => event)
    })
  });

  if (!response.ok) throw new Error(`Sync failed: ${response.status}`);
  const { results } = await response.json();

  for (const result of results) {
    if (result.status === 'accepted' || result.status === 'duplicate') {
      await localQueue.markSynced(result.clientEventId, result);
    } else if (result.status === 'rejected') {
      await localQueue.markRejected(result.clientEventId, result.code);
    }
  }
  return { sent: pending.length, results };
}
```

## نقاط يجب حسمها قبل الإنتاج
- هل يسمح بتسجيل حضور موظف على هاتف مشترك دون حساب شخصي؟ إن كان نعم، يلزم PIN/QR أو وسيلة تحقق مستقلة وسجل يبين مشغل الجهاز.
- سياسة السماح بالأحداث المتأخرة: الإعداد الحالي 168 ساعة (7 أيام)، ويجب ضبطه حسب سياسة المؤسسة.
- معالجة اختلاف ساعة الهاتف: يحتفظ الخادم بوقت الاستلام، ويجب إظهار تحذير عند الانحراف الزمني غير المعتاد.
- الصور: يجب تشفير النقل والتخزين، وتحديد مدة احتفاظ، وصلاحيات الوصول، وموافقة وسياسة خصوصية واضحة.
- تضارب الحركات: إضافة قواعد عمل لمنع حضورين متتاليين أو انصراف بلا حضور، مع مسار استثناء إداري.
