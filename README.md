# JohorStudio Redirect

Link shortener subdomain untuk `johorstudio.com`. Setiap pautan menggunakan satu
subdomain, contohnya:

```
https://telegram.johorstudio.com  →  https://t.me/johrostudio
```

Admin page berada di **https://re.johorstudio.com** dan dilindungi Cloudflare
Access. Hanya `rafierosliputra@gmail.com` dibenarkan masuk.

## Apa yang ada

- CRUD pautan: cipta, edit, jeda/aktifkan semula, padam.
- Redirect `302` tanpa cache, jadi destinasi boleh ditukar bila-bila masa.
- Statistik klik keseluruhan, 7 hari terakhir dan aktiviti terkini.
- Cloudflare Access JWT disahkan di server (RS256, issuer + audience + email).
  App tidak percaya buta pada header `Cf-Access-Authenticated-User-Email`.
- UI responsif mengikut tema johorstudio.com: Archivo, warna paper/teal/graphite,
  logo rasmi.
- SQLite pada TrueNAS. Tiada dependency npm dan tiada panggilan ke DB luar.
- Fail statik disajikan oleh Node; tiada build step.

## Susunan fail di TrueNAS

```
/mnt/ssd/redirect/
├── .env                 # config app (600)
├── tunnel.env           # token Cloudflare Tunnel (600)
├── app/                 # kod dan aset (read-only dalam container)
├── data/redirect.db     # SQLite + WAL
└── deploy/truenas-app.yaml
```

Semua fail aplikasi berada di bawah direktori ini. Container hanya menggunakan
image rasmi `node:24-alpine` dan `cloudflare/cloudflared:latest`.

## Deploy di TrueNAS

App didaftarkan sebagai **Custom App** melalui TrueNAS Apps (nama app: `redirect`)
supaya ia muncul dalam senarai Apps dan boleh di-start/stop dari UI.

1. Salin fail ke `/mnt/ssd/redirect`.
2. Isi `.env` (team domain + AUD daripada Cloudflare Access).
3. Isi `tunnel.env` dengan `TUNNEL_TOKEN=...`.
4. Cipta Custom App menggunakan `deploy/truenas-app.yaml`, atau melalui API
   TrueNAS dengan `app.create`.
5. Buka `http://192.168.0.100:18123/healthz`; patut pulangkan `{"ok":true}`.

Selepas app berjalan, Cloudflare Tunnel akan menghubungkan:

```
*.johorstudio.com  →  http://redirect:8080  (dalam network Docker app)
re.johorstudio.com →  Access (email policy) → app
```

## Cloudflare

- DNS wildcard `*` proxied ke tunnel (perlu untuk subdomain dinamik).
- Universal SSL meliputi first-level wildcard `*.johorstudio.com`.
- Tunnel ingress mesti mempunyai catch-all ke `http://redirect:8080`; ini
  membolehkan hostname baharu berfungsi tanpa deploy semula.
- Cloudflare Access application: `re.johorstudio.com`, policy Allow untuk
  `rafierosliputra@gmail.com` sahaja.
- `CF_ACCESS_AUD` mestilah AUD application tersebut.
- Reserved slugs mesti diselaraskan dengan DNS sedia ada (`shop`, `tele`, dll)
  supaya pautan pendek tidak bertembung dengan servis lain.

## Update kod

Kod dibaca terus dari `/mnt/ssd/redirect/app` (read-only bind mount). Selepas
tukar fail, restart app `redirect` dari TrueNAS Apps. Tiada image rebuild.

Data dan backup:

```bash
# backup selamat semasa app berjalan
sqlite3 /mnt/ssd/redirect/data/redirect.db ".backup '/mnt/ssd/redirect/data/redirect-backup.db'"
```


## Deployment semasa

- Admin: `https://re.johorstudio.com` (Cloudflare Access, OTP ke `rafierosliputra@gmail.com`)
- Contoh: `https://telegram.johorstudio.com` → `https://t.me/johrostudio`
- TrueNAS Apps: **redirect** (Custom App, state RUNNING)
- Tunnel: **johorstudio-redirect** (Cloudflare, remotely managed)
- Kod/data: `/mnt/ssd/redirect/app` dan `/mnt/ssd/redirect/data`
- Container app berjalan sebagai UID/GID `950:950` (`truenas_admin`) kerana data
  folder dimiliki UID itu. Jika UID pemilik data berubah, kemas kini `user:` dalam
  compose dan `chown` folder data.

Setiap subdomain baharu tidak perlu tambah DNS record: rekod proxied
`*.johorstudio.com` sudah menghala ke tunnel ini. Nama yang sudah ada dalam DNS
(shop, tele, mail, dan lain-lain) kekal didahulukan.

## Keselamatan

- Admin memerlukan JWT Access yang sah; app gagal tertutup (fail closed) jika
  `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` kosong.
- Email dalam JWT mesti sepadan dengan `ALLOWED_EMAILS`.
- Hanya token tunnel disimpan pada TrueNAS. Cloudflare API token digunakan
  sekali sahaja semasa setup dan tidak disimpan dalam app.
- Port `18123` di LAN hanya untuk health check; HTML/API admin tetap memerlukan
  JWT Access walaupun diakses terus.
- Klik disimpan 90 hari. Tiada IP pelawat disimpan.

## API ringkas

Semua endpoint admin memerlukan JWT Access.

```
GET    /api/me
GET    /api/links?q=&status=all|active|paused
POST   /api/links              { slug, targetUrl, title }
PATCH  /api/links/:id          { slug?, targetUrl?, title?, active? }
DELETE /api/links/:id
```

Public hostname mengambil `slug` daripada Host header, cari pautan aktif, rekod
klik, dan pulangkan `302 Location`.
