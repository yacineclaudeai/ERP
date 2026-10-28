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
4. **الإرسال الأوتوماتيكي**: كي تتأكد الطلبية، المخزون ينقص وتتبعث لشركة التوصيل. الاختيار بهاد الترتيب: استثناء الولاية في البوتيك ← حساب التوصيل تاع البوتيك (صفحة "البوتيكات") ← الشركة المربوطة بالولاية (صفحة "التوصيل") ← الشركة الافتراضية. إذا فشل الإرسال تبقى مؤكدة مع الخطأ وتقدر تعاود.
5. **التتبع**: كل 30 دقيقة (ولا بالزر) يجيب الحالات من Ecotrack: مستلمة / روتور (الروتور يرجع المخزون).
6. **الإحصائيات**: نسبة التأكيد، نسبة التوصيل، المبيعات، سعر الشراء، الإشهار، الفايدة الصافية والتكلفة لكل طلبية، حسب المنتج وحسب الولاية.
7. **المستخدمين**: مدير، ومؤكدة (تأكيد الطلبيات برك).

## شركات التوصيل

| النوع | الاستعمال |
|---|---|
| `ecotrack` | أي شركة تخدم على منصة Ecotrack (HHD، Packers، DHD...): الرابط (`https://xxxx.ecotrack.dz` ولا `.../api/v1`) + API token (يتبعث `?api_token=`) |
| `manual` | شركة بلا API: الطلبية تتربط بالشركة والتراكينغ يتكتب يدوياً |
| `sandbox` | للتجربة: يعطي تراكينغ وهمي |

باش تزيد شركة بـ API آخر (Yalidine، ZR Express، Maystro...)، زيد ملف في `src/delivery/` فيه `createShipment` و `getStatus` وسجلو في `src/delivery/index.js`.

## التشغيل على Netlify (production)

الموقع: https://erp-yacine.netlify.app (كل تبديل في `main` يطلع وحدو).

الـ ERP يخدم على Netlify: الواجهة ملفات static (`public/`)، الـ API في Netlify Function (`netlify/functions/api.mjs`)، والتتبع يتحدث كل 30 دقيقة (`netlify/functions/sync-tracking.mjs`). قاعدة البيانات هي Netlify Database (Postgres): Netlify يخلقها ويطبق الـ migrations اللي في `netlify/database/migrations/` وحدو مع كل deploy.

1. اربط الريبو بـ Netlify (Add new project ← Import from GitHub). الإعدادات تتقرا من `netlify.toml`.
2. في Environment variables زيد:
   - `SESSION_SECRET`: نص طويل عشوائي (ضروري)
   - `ADMIN_USERNAME` و `ADMIN_PASSWORD`: حساب المدير الأول
   - `AUTOMATION_TOKEN`: للروتين تاع إطلاق الحملات (اختياري)
3. Deploy. أول دخول بحساب المدير، وبدل كلمة السر.

## التشغيل في الكمبيوتر

يلزم Node.js 20.12 ولا أحدث. محلياً قاعدة البيانات Postgres مدمجة (PGlite) في `data/pg`، ولا Postgres حقيقي بـ `DATABASE_URL`.

```bash
npm install
cp .env.example .env     # بدل SESSION_SECRET و ADMIN_PASSWORD
npm start                # http://localhost:3000
npm run seed             # (اختياري) بيانات تجريبية
npm test
```

## البنية

```
src/app.js               API HTTP (Hono), partagée par Netlify et le serveur local
src/server.js            serveur local
src/db.js                accès Postgres (pg) ; src/db-local.js : PGlite pour local et tests
netlify/database/migrations/  schéma de la base
netlify/functions/       api (toutes les routes /api/*) et sync-tracking (toutes les 30 min)
src/services/orders.js   cycle de vie des commandes, stock, dispatch auto
src/services/stats.js    statistiques et profit par produit
src/delivery/            adaptateurs des sociétés de livraison
src/routes/api.js        API admin (authentifiée)
src/routes/public.js     API publique pour les landing pages (CORS ouvert)
public/                  interface admin (arabe, RTL) + embed.js
```
