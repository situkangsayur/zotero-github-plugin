# Tutorial: mencadangkan pustaka Zotero ke GitHub

Panduan ini menjelaskan cara memasang Zotero GitHub Sync, menghubungkannya ke repositori
GitHub, dan menjalankan sinkronisasi pertama. Kira-kira sepuluh menit, ditambah waktu
unggah PDF Anda.

*English: [TUTORIAL.md](TUTORIAL.md)*

---

## 1. Buat repositori

Di GitHub, buat repositori baru untuk menyimpan pustaka, misalnya `zotero-library`. Jadikan
**private** kecuali Anda ingin pustaka Anda terbuka. Repositori boleh dibiarkan kosong sama
sekali; plugin membuat commit pertamanya sendiri.

(Langkah ini bisa dilewati dan repositori dibuat oleh plugin, tetapi token butuh izin
tambahan. Membuat sendiri lebih sederhana.)

## 2. Buat personal access token

Plugin berkomunikasi lewat API GitHub, jadi butuh token. Kunci SSH tidak bisa dipakai.

1. Buka <https://github.com/settings/personal-access-tokens/new>
   (**Settings → Developer settings → Personal access tokens → Fine-grained tokens →
   Generate new token**).
2. **Token name:** bebas, misalnya `zotero-github-sync`.
3. **Expiration:** sesuai keinginan. Setelah kedaluwarsa, sinkronisasi gagal dengan *401*
   dan Anda cukup membuat token baru.
4. **Repository access:** *Only select repositories* → pilih repositori dari langkah 1.
5. **Permissions → Repository permissions → Contents:** **Read and write**.
   *Metadata: Read-only* tercentang otomatis. Izin lain biarkan *No access* — Contents sudah
   mencakup Git LFS.
6. Klik **Generate token** dan salin tokennya (`github_pat_…`). GitHub hanya menampilkannya
   sekali.

Jangan tempel token di mana pun selain di Zotero.

## 3. Pasang plugin

1. Unduh `zotero-github-sync-<versi>.xpi` terbaru dari
   [halaman Releases](https://github.com/situkangsayur/zotero-github-plugin/releases/latest).
   Di Firefox, klik kanan tautannya lalu pilih *Save Link As…*, supaya Firefox tidak mencoba
   memasangnya sebagai ekstensi browser.
2. Di Zotero: **Tools → Plugins**, klik ikon roda gigi, pilih **Install Plugin From File…**,
   lalu pilih berkas `.xpi`.
3. Plugin muncul di daftar dalam keadaan aktif:

![Plugin di pengelola plugin Zotero](images/plugins-manager.png)

Tombol GitHub muncul di pojok kanan atas jendela utama, di sebelah tombol sinkronisasi
Zotero:

![Jendela utama Zotero dengan tombol GitHub Sync ditandai](images/main-window.png)

## 4. Hubungkan ke GitHub

Buka **Edit → Settings → GitHub Sync** (di macOS: **Zotero → Settings**).

### GitHub account

![Kolom token dan uji koneksi](images/settings-account.png)

1. Tempel token lalu klik **Save token**. Token disimpan di password manager Zotero, bukan di
   berkas preferensi biasa.
2. Isi bagian repositori (di bawah) sebelum menguji koneksi.

### Repository

![Pengaturan owner, repositori, branch dan folder](images/settings-repository.png)

| Kolom | Isi |
| --- | --- |
| Owner | Username GitHub Anda (atau nama organisasi) |
| Repository | Nama repositori dari langkah 1 |
| Branch | `main` |
| Folder inside the repository | **Kosongkan** untuk memakai seluruh repositori, atau misalnya `zotero` agar semua berada di satu folder |

Klik **Test connection**. Hasil yang benar: *"Write access to owner/repository (private)"*.
Kalau muncul *not visible to this token*, edit token di GitHub dan pastikan repositorinya
dipilih serta Contents diatur *Read and write*.

### What gets synced

![Apa saja yang disinkronkan](images/settings-what-syncs.png)

Semuanya menyala secara bawaan: metadata item, catatan Markdown, catatan anak, pustaka grup,
berkas lampiran (PDF, buku, snapshot, gambar di catatan) dan linked file. Berkas di atas
50 MB dikirim lewat **Git LFS**, karena GitHub menolak berkas di atas 100 MB di Git biasa.

Perlu diingat:

- Git LFS di GitHub Free mendapat 10 GiB penyimpanan dan 10 GiB bandwidth per bulan. Hanya
  berkas di atas ambang yang memakainya.
- GitHub menyarankan ukuran repositori di bawah 10 GB.
- Git menyimpan setiap versi berkas, jadi mengganti PDF menambah ukuran repositori.

### When to sync

![Pilihan jadwal dan status](images/settings-when-status.png)

| Pilihan | Kapan sinkron |
| --- | --- |
| *Sync every … minutes* | Berkala |
| *Sync after the library changes* | Beberapa menit setelah Anda berhenti mengedit |
| *Sync shortly after Zotero starts* | Satu menit setelah Zotero dibuka |
| *Sync to GitHub after Zotero's own sync finishes* | Setiap kali tombol sync Zotero ditekan (atau Zotero sinkron otomatis) |

Sinkronisasi yang tidak menemukan perubahan tidak membuat commit, jadi sinkron sering tidak
mengotori riwayat.

## 5. Jalankan sinkronisasi pertama

Klik **tombol GitHub** di toolbar, atau **Sync now** di pengaturan.

Selama berjalan, ikon berputar dan menampilkan persentase:

![Tombol toolbar saat sinkron](images/toolbar-syncing.png)

Arahkan kursor ke tombol untuk rinciannya, atau klik untuk membuka jendela progres:

![Jendela progres](images/progress-window.png)

Yang terjadi pada sinkronisasi pertama:

1. **Memeriksa berkas lampiran.** Setiap berkas di-hash sekali; sinkron berikutnya memakai
   hasil itu, jadi PDF yang tidak berubah tidak pernah dibaca ulang.
2. **Berkas besar ke Git LFS.**
3. **Metadata dan catatan.** Semua JSON item dan Markdown dikirim dalam beberapa request dan
   langsung di-commit — tampil di GitHub dalam satu-dua menit.
4. **Berkas lampiran**, di-commit bertahap setiap 100 MB atau 150 berkas. Kalau sinkron
   dibatalkan, gagal, atau Zotero ditutup, semua yang sudah di-commit tetap ada, dan
   sinkron berikutnya melanjutkan dari situ.
5. **Commit terakhir** berisi daftar berkas yang dikelola plugin.

GitHub membatasi kecepatan pembuatan konten per akun (sekitar 80 request per menit). Kalau
batas itu tercapai, plugin menunggu lalu melanjutkan, dan tooltip menunjukkan sampai jam
berapa. Untuk menghentikan sinkron: klik kanan tombol → **Cancel GitHub Sync**, atau
**Cancel sync** di pengaturan.

Setelah selesai, repositori berisi pustaka Anda:

![Pustaka yang tersinkron di GitHub, dengan PDF terbuka](images/github-repository.png)

- `my-library/items/` — satu berkas JSON per item, lengkap dengan catatan, lampiran dan
  anotasinya
- `my-library/notes/` — halaman Markdown per item (bisa dibuka di Obsidian)
- `my-library/attachments/` dan `attachments-lfs/` — berkas-berkasnya
- `my-library/index.md` — daftar isi per koleksi

## 6. Kalau ada masalah

Tombol berubah merah dengan titik:

![Tombol toolbar setelah sinkron gagal](images/toolbar-error.png)

Arahkan kursor untuk membaca pesan error, atau lihat **Status** di pengaturan. Penyebab umum:

| Pesan | Solusi |
| --- | --- |
| *GitHub rejected the token (401)* | Token kedaluwarsa atau salah ketik. Buat token baru lalu simpan lagi |
| *This token cannot see owner/repo* | Token belum diberi akses ke repositori itu. Edit token di GitHub |
| *GitHub denied the request (403)* | Token tidak punya izin *Contents: Read and write* |
| *Git LFS storage quota exceeded (507)* | Penyimpanan LFS akun penuh. Tambah budget LFS di billing GitHub, naikkan ambang LFS, atau matikan LFS |
| *Skipped or not restored* di pengaturan | Setiap baris menjelaskan kenapa berkas dilewati |

Untuk rincian lebih lanjut, nyalakan **Help → Debug Output Logging** sebelum sinkron; baris
dari plugin diawali `[GitHub Sync]`.

## 7. Memulihkan di komputer lain

1. Pasang Zotero dan plugin, lalu isi token, owner dan repositori yang sama.
2. **Tools → GitHub Sync → Import from GitHub…**

Import menambahkan item yang belum ada (dengan key yang sama, sehingga anotasi kembali ke PDF
yang benar), memperbarui item yang versi repositorinya lebih baru, membuat ulang koleksi,
saved search dan warna tag, serta mengunduh berkas lampiran yang belum ada ke folder storage
Zotero. Import tidak pernah menghapus apa pun dari pustaka Anda.

Untuk mengambil berkas dengan Git biasa, kloning repositori dengan
[git-lfs](https://git-lfs.com) terpasang; tanpa git-lfs, berkas besar hanya berupa berkas
pointer kecil.

## Perlu diketahui

- **Zotero tetap sumber kebenaran.** Perubahan yang dibuat langsung di GitHub akan ditimpa
  oleh sinkronisasi berikutnya.
- **Sinkronkan dari satu komputer.** Dua komputer dengan isi pustaka berbeda bisa saling
  membatalkan perubahan di repositori (riwayat Git tetap menyimpan semuanya).
- **Kalau GitHub menjadi tempat penyimpanan berkas Anda**, file sync bawaan Zotero bisa
  dimatikan (**Settings → Sync → File Syncing**) agar pesan kuota "Zotero File Storage"
  tidak muncul lagi. Komputer lain lalu mendapat berkas lewat *Import from GitHub*, bukan
  dari zotero.org.
