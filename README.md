# Jadwal Sholat

[![Deploy on Hostinger](https://assets.hostinger.com/vps/deploy.svg)](https://www.hostinger.com/docker-hosting?compose_url=https://raw.githubusercontent.com/USERNAME/jadwal-sholat/main/docker-compose.yml&REFERRALCODE=KODE_REFERRAL)

Aplikasi jadwal sholat untuk 500+ kabupaten/kota di Indonesia. Data dari **Bimas Islam Kementerian Agama RI** melalui API publik MyQuran (`api.myquran.com/v2`).

- Jadwal harian & bulanan, hitung mundur ke waktu sholat berikutnya
- Deteksi lokasi otomatis (kab/kota terdekat)
- Notifikasi waktu sholat, dapat dipasang sebagai aplikasi (PWA) & tetap tampil saat offline
- Ringan: vanilla JS + PHP, tanpa database, tanpa dependensi

## Deploy

### Sekali klik di Hostinger VPS
1. Klik tombol **Deploy on Hostinger** di atas, lalu pilih paket VPS.
2. Docker Manager terbuka dengan `docker-compose.yml` proyek ini. Isi variabel **`DOMAIN`** dengan domain Anda (mis. `sholat.contoh.id`) yang A record-nya sudah mengarah ke IP VPS. Sertifikat HTTPS dipasang otomatis.
3. Klik **Deploy**. Aplikasi tersedia di `https://DOMAIN` (atau `http://IP-VPS` bila `DOMAIN` dikosongkan).

> Deteksi lokasi & notifikasi browser hanya berfungsi lewat **HTTPS**, jadi sebaiknya isi `DOMAIN`.

### Docker di server sendiri
```bash
curl -O https://raw.githubusercontent.com/USERNAME/jadwal-sholat/main/docker-compose.yml
DOMAIN=sholat.contoh.id docker compose up -d
```

### Shared hosting (Apache/LiteSpeed) atau IIS
Unggah semua berkas ke folder web (PHP ≥ 8.1 dengan ekstensi cURL). `.htaccess` (Apache/LiteSpeed) atau `web.config` (IIS) sudah menyertakan header keamanan dan pemblokiran folder internal. Pastikan folder `storage/` dapat ditulis.

## Struktur

| Berkas | Fungsi |
|---|---|
| `index.html`, `assets/` | Antarmuka (vanilla JS, tanpa dependensi) |
| `api.php` | Proxy + cache ke data Kemenag (`cities`, `schedule`, `locate`) |
| `src/bootstrap.php` | HTTP client, cache berkas, rate limit (tidak bisa diakses dari web) |
| `storage/` | Cache & data rate limit (otomatis dibuat; tidak bisa diakses dari web) |
| `sw.js`, `manifest.webmanifest` | PWA: dapat dipasang & tetap tampil saat offline |
| `Dockerfile`, `docker-compose.yml` | Image PHP 8.3 + Apache, Caddy sebagai reverse proxy HTTPS |
| `.htaccess` / `web.config` | Header keamanan, cache statis, pemblokiran folder internal (Apache / IIS) |

## Kecepatan
- Server: cache jadwal 7 hari (bulan lalu 60 hari), daftar kota 30 hari; lock mencegah request ganda ke upstream; data lama dipakai bila Kemenag tidak dapat dihubungi.
- HTTP: ETag/304, `Cache-Control`, gzip; aset statis di-cache 30 hari (versi via `?v=`).
- Klien: snapshot di `localStorage` → tampilan instan lalu revalidasi; service worker untuk offline.

## Keamanan
- CSP ketat (`script-src 'self'`, tanpa inline script/style), `X-Frame-Options: DENY`, `nosniff`, `Permissions-Policy`.
- Validasi ketat semua parameter (ID kota harus ada di daftar resmi, tahun ±1, bulan 1–12) dan sanitasi data upstream.
- Rate limit per IP (120/menit API, 10/menit deteksi lokasi); IP disimpan sebagai hash.
- Upstream hanya HTTPS dengan verifikasi TLS, timeout, dan batas ukuran respons.
- Hanya metode GET/HEAD; `src/`, `storage/`, `.git` diblokir.
- Koordinat lokasi dibulatkan (~1 km) sebelum dikirim ke Nominatim (OpenStreetMap).

## Pengembangan
- Saat pindah versi aset, naikkan `?v=` di `index.html` dan `VERSION`/`ASSETS` di `sw.js`.
- Image Docker dibangun otomatis oleh GitHub Actions (`.github/workflows/docker.yml`) ke `ghcr.io/USERNAME/jadwal-sholat` setiap push ke `main`.

## Lisensi
[MIT](LICENSE). Data jadwal © Bimas Islam Kementerian Agama RI; data lokasi © kontributor OpenStreetMap.
