# ERP — e-commerce COD (Algérie)

نظام لتسيير التجارة الإلكترونية بالدفع عند الاستلام: المنتجات، الطلبيات من صفحات الهبوط، التأكيد، الإرسال الأوتوماتيكي لشركات التوصيل حسب الولاية، المخزون والإحصائيات.

## الخدمة باختصار

1. **المنتجات**: سعر البيع، سعر الشراء، المخزون، ورابط صفحة الهبوط. كل منتج عندو مفتاح (`public_key`).
2. **صفحة الهبوط**: من "المنتجات ← ربط صفحة الهبوط" تنسخ كود وتحطو في الصفحة:
   ```html
   <div id="erp-order-form"></div>
   <script src="https://ERP-DOMAIN/embed.js" data-key="PRODUCT_KEY"></script>
   ```
   ولا رابط مباشر: `https://ERP-DOMAIN/form.html?key=PRODUCT_KEY`. الطلبيات تدخل وحدها (مع utm_source / utm_campaign، وكشف الطلبيات المكررة بنفس الرقم في 3 أيام).
3. **التأكيد**: جديدة ← ما ردش (يحسب المحاولات) / مؤجلة ← مؤكدة / ملغاة.
4. **الإرسال الأوتوماتيكي**: كي تتأكد الطلبية، المخزون ينقص وتتبعث لشركة التوصيل المربوطة بالولاية تاعها (صفحة "التوصيل")، ولا للشركة الافتراضية. إذا فشل الإرسال تبقى مؤكدة مع الخطأ وتقدر تعاود.
5. **التتبع**: كل 30 دقيقة (ولا بالزر) يجيب الحالات من Ecotrack: مستلمة / روتور (الروتور يرجع المخزون).
6. **الإحصائيات**: نسبة التأكيد، نسبة التوصيل، المبيعات، سعر الشراء، الإشهار، الفايدة الصافية والتكلفة لكل طلبية، حسب المنتج وحسب الولاية.
7. **المستخدمين**: مدير، ومؤكدة (تأكيد الطلبيات برك).

## شركات التوصيل

| النوع | الاستعمال |
|---|---|
| `ecotrack` | أي شركة تخدم على منصة Ecotrack: الرابط (`https://xxxx.ecotrack.dz`) + API token |
| `manual` | شركة بلا API: الطلبية تتربط بالشركة والتراكينغ يتكتب يدوياً |
| `sandbox` | للتجربة: يعطي تراكينغ وهمي |

باش تزيد شركة بـ API آخر (Yalidine، ZR Express، Maystro...)، زيد ملف في `src/delivery/` فيه `createShipment` و `getStatus` وسجلو في `src/delivery/index.js`.

## التشغيل

يلزم Node.js 22.13 ولا أحدث (قاعدة البيانات SQLite مدمجة في Node، ما يلزم حتى برنامج آخر).

```bash
npm install
cp .env.example .env     # بدل SESSION_SECRET و ADMIN_PASSWORD
npm start                # http://localhost:3000
npm run seed             # (اختياري) بيانات تجريبية
npm test
```

أول مرة يتخلق حساب المدير من `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

## البنية

```
src/server.js            Express app
src/db.js                schéma SQLite
src/services/orders.js   cycle de vie des commandes, stock, dispatch auto
src/services/stats.js    statistiques et profit par produit
src/delivery/            adaptateurs des sociétés de livraison
src/routes/api.js        API admin (authentifiée)
src/routes/public.js     API publique pour les landing pages (CORS ouvert)
public/                  interface admin (arabe, RTL) + embed.js
```
