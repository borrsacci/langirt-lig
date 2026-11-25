# Langırt Ligi

Ofis langırt ligi: kura, canlı maç kaydı, istatistikler ve coin ile iddia. Android uygulaması (APK) olarak çalışır; tüm veriler ücretsiz bir Supabase sunucusunda tutulur ve herkesin telefonunda anlık görünür.

## Nasıl çalışır

- **Maç**: 4 oyuncu seçilir. Kura (veya elle dizme) ile Mavi ve Kırmızı takımlar, kaleci ve forvetler belirlenir. Kura, daha önce birlikte çok oynamış ikilileri daha az eşleştirir. Maç 3'er dakikalık iki yarıdır; süre bitince **son top** oynanır ve gelen gol yarıyı bitirir. Her takım maç başına bir kez mevki değiştirebilir.
- **Onay**: Biten maç, kaydeden kişi tarafından onaya gönderilir. Admin onaylamadan maç istatistiklere girmez, kuponlar sonuçlanmaz. Admin gerekirse golleri düzeltir, maçı reddeder (bahisler iade edilir) veya "onayla, bahisleri iade et" der.
- **Bahis**: Kadro kesinleşince ("Oranları çıkar, bahsi aç") oranlar sunucuda hesaplanır ve sabitlenir. "Maçı başlat" ile bahisler kapanır. Her yeni hesap admin onayıyla 1000 coin alır. En az bahis 2 coin. Maçta oynayanlar kendi maçlarına sadece kendi lehlerine bahis yapabilir.
- **Pazarlar**: Maç sonucu, çifte şans, ilk yarı sonucu, toplam gol alt/üst (3 çizgi), karşılıklı gol, oyuncu gol atar, oyuncu gol sayısı alt/üst, ilk golü atan.

### Oranlar nasıl hesaplanır

Futbol bahis modellerinin (Maher, Dixon-Coles) temeli olan Poisson süreci 2'ye 2 langırta uyarlandı:

- Her oyuncunun ayrı ayrı **forvet hücum, kaleci hücum, forvet savunma, kaleci savunma** gücü ve bir **genel** gücü vardır. Ayrıca her ikilinin bir **uyum** puanı vardır. Kimin hangi mevkide iyi olduğu ve hangi ikililerin iyi anlaştığı ayrı ayrı öğrenilir.
- Her golün kimin hangi mevkideyken, hangi kaleciye karşı ve kaçıncı saniyede atıldığı kaydedilir. Son top golleri ayrıca "kim önce atar" yarışı olarak modele girer.
- Eski maçların ağırlığı 120 günde yarıya iner; son form daha çok etkiler.
- Az veride model temkinlidir. Parametrelerin belirsizliği (Bayesçi Laplace yaklaşımı) hesaba katılır ve oranlar dengeye yakın kalır. Veri biriktikçe gerçek farklar ortaya çıkar.
- Skor dağılımı tam (kesin) olarak hesaplanır. Tüm pazarlar aynı dağılımdan okunduğu için birbiriyle tutarlıdır.
- Kasa payı %7'dir ve "güç yöntemi" ile dağıtılır: marj, gerçek bahis şirketlerindeki gibi sürprizlere daha çok yüklenir. Oranlar hep aşağı yuvarlanır. %95'ten olası sonuçlar bahse kapalıdır. Böylece hiçbir oran, modelin adil oranının üstüne çıkmaz.

Maç ekranındaki "Oranlar nasıl çıktı?" bağlantısı her maç için beklenen skoru, oyuncuların o mevkideki gücünü ve ikili uyumunu gösterir.

## Kurulum (bir kez, ~15 dakika)

### 1. Supabase projesi

1. [supabase.com](https://supabase.com) adresinde ücretsiz hesap açın ve **New project** oluşturun. Bölge olarak **Frankfurt (eu-central-1)** seçin.
2. Projeyi oluştururken belirlediğiniz **Database Password**'ü bir yere not edin.
3. **Authentication → Sign In / Providers → Email** bölümünde **Confirm email** seçeneğini **kapatın** ve kaydedin. Giriş kullanıcı adıyla yapıldığı için e-posta doğrulaması kullanılmaz.
4. Proje adresinizdeki kimliği not edin: `https://BURASI.supabase.co`. Bu değer **Project Settings → General → Project ID** altında da görünür.
5. Sağ üstteki profil menüsünden **Account → Access Tokens → Generate new token** ile bir erişim anahtarı oluşturun.

### 2. GitHub ayarları

Repo sayfasında **Settings → Secrets and variables → Actions → New repository secret** ile şu üç değeri ekleyin:

| Ad | Değer |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | 1.5'teki erişim anahtarı |
| `SUPABASE_PROJECT_REF` | 1.4'teki proje kimliği |
| `SUPABASE_DB_PASSWORD` | 1.2'deki veritabanı şifresi |

Sonra **Actions → Yayınla → Run workflow** ile çalıştırın; sonraki her `main` gönderiminde de kendiliğinden çalışır. Sırasıyla şunlar yapılır:

1. Tüm testler çalışır.
2. Veritabanı ve sunucu fonksiyonları Supabase'e yüklenir.
3. APK derlenir ve sabit bir linke yüklenir:

```
https://PROJE_KIMLIGI.supabase.co/storage/v1/object/public/app/langirt-ligi.apk
```

Link, Actions çalışmasının özet sayfasında da yazar. Bu linki ofis grubuna atmanız yeterli. Sonraki sürümlerde uygulama "Yeni sürüm hazır" diye kendisi haber verir.

### 3. İlk açılış

1. **Önce siz** uygulamayı kurup **Hesap aç** ile kayıt olun. İlk açılan hesap otomatik olarak **admin** olur ve 1000 coin alır.
2. Diğerleri kayıt olur. **Profil → Admin paneli → Kullanıcılar** bölümünden onaylarsınız; onaylanan hesaba 1000 coin yüklenir.
3. Uygulaması olmayan oyuncuları **Admin paneli → Oyuncular** bölümünden ekleyebilirsiniz. Bu kişiler sonradan hesap açarsa, onaylarken mevcut oyuncu profiline bağlarsınız ve istatistikleri korunur.

## Bilinmesi gerekenler

- **Ücretsiz plan**: Supabase ücretsiz projesi 7 gün hiç kullanılmazsa uykuya geçer. Uyanması için Supabase panelinden **Restore** demek yeterlidir; veriler kaybolmaz.
- **Şifremi unuttum**: Admin, **Kullanıcılar** bölümünden kişiye yeni şifre verebilir.
- **Coin düzeltmesi**: Admin herhangi bir hesaba coin ekleyip düşebilir. Her hareket hesabın "Hesap hareketleri" listesinde görünür.
- **APK imzası**: Güncellemelerin eski sürümün üstüne kurulabilmesi için tüm derlemeler `android/app/langirt.keystore` ile imzalanır. Bu dosya Play Store için değildir; sadece ofis içi dağıtım içindir.
- **Admin**: Sadece ilk kayıt olan hesaptır. Admin yetkisini başka hesaba taşımak için Supabase SQL Editor'de şunu çalıştırın:
  `update profiles set is_admin = false; update profiles set is_admin = true where username = 'yeni_admin';`

## Geliştirme

```bash
npm install
cp .env.example .env.local   # Supabase URL ve anon key
npm run dev                  # tarayıcıda http://localhost:3000
npm test                     # oran motoru testleri
PGTEST_HOST=/tmp PGTEST_PORT=5432 npm test   # + veritabanı testleri (yerel Postgres gerekir)
```

Klasör yapısı:

- `supabase/functions/_shared`: Oyun mantığı, model, oranlar ve bahis kuralları. Hem uygulama hem sunucu aynı kodu kullanır.
- `supabase/migrations`: Veritabanı, güvenlik kuralları ve tüm para işlemleri (SQL).
- `supabase/functions/create-match`: Oranları hesaplayıp maçı açan sunucu fonksiyonu.
- `src`: Mobil arayüz (React).
- `tests`: Model simülasyon testleri, veritabanı kural testleri ve uçtan uca arayüz testleri (`tests/e2e`).
