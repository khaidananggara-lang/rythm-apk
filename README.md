# RYTHM

Pemutar musik sederhana di atas InnerTube (API YouTube Music). Web + API jalan dari satu Cloudflare Worker.

## 1. Hosting (gratis)
1. `npm install`
2. `npx wrangler login`
3. `npm run deploy` → dapat alamat `https://rythm.NAMAKAMU.workers.dev`

Buka di HP → menu browser → "Tambahkan ke layar utama" (PWA).

## 2. Jadi APK (Capacitor)
1. Di `public/config.js` isi: `window.RYTHM_API = "https://rythm.NAMAKAMU.workers.dev";`
2. `npx cap add android` → `npm run apk` → Build > Build APK di Android Studio.

Alternatif tanpa Android Studio: masukkan alamat Worker ke https://pwabuilder.com lalu unduh paket Android.

## API
| Endpoint | Fungsi |
|---|---|
| `/api/ping` | cek server |
| `/api/home` | rak beranda |
| `/api/search?q=&type=song\|video\|album\|artist` | pencarian dengan filter |
| `/api/suggest?q=` | saran pencarian |
| `/api/browse?id=` | isi album / playlist / halaman artis |
| `/api/next?id=` | lagu berikutnya (antrean otomatis) |
| `/api/lyrics?id=` | lirik, kalau tersedia |
| `/api/stream?id=` | audio lagu, diteruskan worker (mendukung seek) |
| `/api/player?id=` | diagnosis: klien mana yang berhasil dan format audionya |

## Catatan
- Audio diambil lewat endpoint `player` InnerTube (klien VISIONOS, cadangan ANDROID_VR) dan diputar dengan `<audio>`. URL googlevideo terikat ke IP peminta, jadi Worker yang mengambil dan meneruskannya.
- Kalau lagu tidak mau diputar, buka `https://rythm.NAMAKAMU.workers.dev/api/player?id=ID_LAGU`. Pesan errornya menunjukkan klien mana yang ditolak. Daftar klien ada di bagian atas `worker.js` (`PLAYER_CLIENTS`) dan perlu disesuaikan kalau YouTube mengubah aturannya.
- Pustaka (lagu tersimpan) disimpan di perangkat lewat localStorage.
- Worker ini ditulis sendiri dengan endpoint InnerTube yang sama dengan klien YouTube Music. Tidak ada kode dari InnerTune (GPL-3.0) yang disalin.
