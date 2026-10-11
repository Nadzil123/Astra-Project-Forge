# Astra Project Forge v2.6.2 — Coordination Efficiency

Tanggal: 7 Oktober 2026  
Status: desain disetujui; implementasi dan verifikasi dilaporkan terpisah dalam [COORDINATION-v2.6.2.md](COORDINATION-v2.6.2.md) dan [EVALUATION-v2.6.2.md](EVALUATION-v2.6.2.md). Evaluasi model belum dijalankan; desain ini bukan klaim hasil yang belum diukur.

## 1. Tujuan dan keputusan yang sudah disepakati

Mengurangi biaya koordinasi tanpa sengaja menurunkan kemampuan Forge. Pengguna sudah menyetujui arsitektur dan alur komponen: implicit coordination fusion, Decision Capsule, State Reference Protocol, deterministic offloading, result projection, serta adaptasi terhadap dukungan host. Bagian pelestarian kualitas dan pengujian dalam dokumen ini melengkapi rancangan tersebut untuk tinjauan tertulis.

Prinsip:

> Preserve capability. Compress coordination.
>
> Useful computation is not waste.

Operasi deterministik dipindahkan ke kode hanya jika kontrak hasilnya setara. Penilaian relevansi, kecukupan bukti, pemilihan strategi, dan interpretasi hasil tetap memerlukan judgment ketika tidak tersedia pemeriksaan objektif yang memadai.

Penghematan tidak boleh menghapus success criteria, mengurangi tuntutan bukti, membatasi eskalasi yang diperlukan, atau menjadikan soft budget sebagai alasan menyatakan pekerjaan selesai. Persentase penghematan baru tidak dijanjikan sebelum diukur.

## 2. Baseline yang benar-benar diperiksa

Sumber: `astra-project-forge-local-marketplace-2.6.1.zip`.

SHA-256 arsip:

`f84fc8a14e4ff75b9c632f4630982bc77a1a1c9b666f859badd96330def5fbcf`

Pemeriksaan source pada sesi ini menemukan:

- `package.json` berisi versi `2.6.1`, Node.js `>=20`, dan lisensi `AGPL-3.0-only`.
- `server/mcp-server.mjs` mendaftarkan sembilan tool `forge_*` dan sepuluh tool `adaptive_*`.
- README membedakan fixture v2.6.1 verified dari tambahan compact responses yang masih memakai nomor versi yang sama. Karena itu nomor versi saja tidak cukup untuk mengidentifikasi baseline.
- `server/control-results.mjs` memproyeksikan response ketika `resultLevel: "summary"`; default/full tetap lengkap.
- `ProjectStore.#write` memakai file sementara dan `rename`. Ini belum membuktikan transaksi read-modify-write aman terhadap penulis bersamaan.
- `addEvaluation` sudah mencatat evaluasi dan failed strategy tertentu dalam satu penyimpanan. Fusion harus memperluas bagian yang memang masih terpisah, tanpa menghitung pekerjaan yang sudah tergabung sebagai penghematan baru.
- `scripts/benchmark-v261.mjs` secara eksplisit menyebut workload deterministik Node/library, bukan eksekusi model. Model turns, model tokens, host cache hits, dan billing tidak tersedia. `contextBytes` sudah termasuk dalam response bytes.

Sesi desain ini membaca source; tidak menjalankan ulang suite tes atau benchmark. Angka hasil dari percakapan sebelumnya tidak diperlakukan sebagai hasil pengujian baru.

Pembanding utama v2.6.2 adalah isi ZIP ini dengan konfigurasi yang dinyatakan jelas, termasuk mode compact. Fixture v2.6.1 verified dan v2.6.0 menjadi pembanding tambahan. Source, konfigurasi, dan hash setiap pembanding dibekukan sebelum pengujian.

## 3. Batas arsitektur

Coordination Core bekerja di atas komponen yang sudah ada. Governor, goal graph, epistemic state, planner, evaluator, evidence cache, adaptasi, anti-thrashing, recovery, transfer state, dan pemeriksaan risiko tetap tersedia.

| Komponen | Tanggung jawab | Batas |
|---|---|---|
| Decision Capsule | Menyajikan state yang relevan dengan keputusan berikutnya | Tidak boleh menyembunyikan kendala penting hanya karena tidak berubah |
| State Reference Protocol | Menghindari pengiriman objek yang sama dan menyediakan ekspansi | Referensi hanya berlaku pada proyek, generasi state, dan revisi yang benar |
| Atomic Coordination Commit | Menyatukan pembaruan administratif setelah judgment eksplisit | Tidak menebak bahwa bukti memenuhi suatu kriteria |
| Deterministic Work Engine | Validasi, hash, delta, counter, deduplikasi eksak, resolusi referensi | Tidak mengganti judgment semantik dengan heuristik yang diklaim setara |
| Capability Relevance / Host Adapter | Menyarankan tool relevan dan menggunakan dukungan host yang tersedia | Tidak menghilangkan kemampuan atau melewati izin host |
| Result Projection | Mengembalikan perubahan, status penting, dan referensi detail | Error, uncertainty, missing criteria, dan jalur pemulihan tetap terlihat |

Alur: route dan context → judgment → tindakan → interpretasi hasil → pembaruan lokal gabungan → proyeksi hasil → keputusan berikutnya atau status akhir yang tepat.

Penggabungan berhenti di batas ketika hasil antara membutuhkan judgment, izin, atau tindakan eksternal baru. Tidak ada tool besar `forge_cycle` pada scope ini.

## 4. Kontrak kompatibilitas

Semua tool berikut tetap terdaftar dan dapat ditemukan melalui `tools/list`:

| Forge | Adaptive legacy |
|---|---|
| `forge_route` | `adaptive_route_task` |
| `forge_goal` | `adaptive_get_context` |
| `forge_context` | `adaptive_initialize_project` |
| `forge_observe` | `adaptive_get_state` |
| `forge_plan` | `adaptive_list_projects` |
| `forge_evaluate` | `adaptive_record_observation` |
| `forge_adapt` | `adaptive_record_hypothesis` |
| `forge_checkpoint` | `adaptive_record_experiment` |
| `forge_consolidate` | `adaptive_checkpoint` |
| — | `adaptive_consolidate` |

Nama, parameter wajib lama, makna operasi, response default, dan error contract lama tetap kompatibel. Tambahan input harus opsional. Perilaku baru yang mengubah side effect atau format respons harus dipilih secara eksplisit; tidak boleh diam-diam menjadikan panggilan evaluasi lama sebagai pembaruan goal/claim.

Capsule menjadi opsi proyeksi baru yang eksplisit. `summary`, `relevant`, `full`, `recovery`, dan perilaku tanpa opsi baru tetap tersedia sesuai tool yang sudah mendukungnya. Ekspansi dilakukan melalui `forge_context`, sehingga tidak perlu menambah tool publik.

State lama harus dapat dibaca tanpa migrasi destruktif. Metadata tambahan tidak boleh menghapus bukti, riwayat, status, atau kriteria lama. Menonaktifkan optimisasi harus tetap memungkinkan pembacaan lengkap dengan engine v2.6.2; ini bukan janji bahwa executable lama otomatis dapat membaca setiap format baru. Perubahan format harus memiliki backup dan pengujian migrasi.

Lisensi, LICENSE, NOTICE, dan ATTRIBUTION dipertahankan. Push, merge, publikasi, dan perubahan main berada di luar pekerjaan desain ini.

## 5. Quality Preservation: aturan wajib

### 5.1 Ketersediaan data dan kualitas keputusan diuji terpisah

Data tersimpan tidak otomatis berarti model mengetahui bahwa ia perlu membacanya. Karena itu ada dua kewajiban:

1. **Integritas data:** detail lengkap, status pengetahuan, provenance, dan bukti terkait tetap dapat diambil.
2. **Kecukupan untuk keputusan:** capsule membantu menemukan informasi penting sebelum model mengambil keputusan.

Tes deterministik dapat memeriksa kewajiban pertama dan aturan pemilihan yang eksplisit. Pengujian perilaku model diperlukan untuk menilai kewajiban kedua. Tidak ada klaim bahwa pemilihan relevansi heuristik bebas kehilangan makna untuk seluruh tugas yang mungkin muncul.

Capsule selalu menyertakan tujuan aktif, kendala yang mengikat tindakan berikutnya, kriteria yang belum terpenuhi, kontradiksi, blocker, ketidakpastian penting, risiko, dan kegagalan strategi yang relevan. Informasi tersebut dapat tetap wajib tampil walaupun tidak berubah sejak revisi sebelumnya. Delta perubahan dan state penting yang tetap berlaku adalah dua hal berbeda.

Capsule mempertahankan perbedaan `known`, `inferred`, `unknown`, dan `contradicted`, beserta referensi bukti pendukung/penyangkal. Nilai hilang tidak berarti aman, tidak relevan, atau telah terpenuhi. Jika batas output tercapai, capsule harus menandai ketidaklengkapan dan menyediakan kelanjutan/ekspansi; pemotongan tidak boleh diam-diam.

### 5.2 Jalur ekspansi tidak terhalang efisiensi

Urutan normal: capsule → detail relevan → context lengkap. Model atau pemanggil boleh langsung meminta context lengkap ketika diperlukan. Soft budget, filter relevansi, atau keadaan host tidak boleh menutup jalur ini.

Referensi rusak, cursor tidak cocok, konteks berubah, atau ketidakcukupan informasi memicu resinkronisasi/ekspansi, bukan tebakan isi. Banyak ekspansi berulang pada kelas tugas yang sama menjadi bukti bahwa capsule terlalu sempit; optimisasi tersebut dinonaktifkan untuk kelas itu sampai diperbaiki.

### 5.3 Completion tidak sama dengan tidak adanya perubahan

`No meaningful change` dapat berarti macet. Kondisi tersebut tidak cukup untuk menyatakan sukses atau menghentikan pekerjaan yang masih bisa dilakukan.

Rekomendasi selesai mensyaratkan semua kriteria yang berlaku telah dievaluasi terpenuhi, bukti yang diwajibkan tersedia dan sesuai state saat ini, serta tidak ada kontradiksi material, blocker, atau risiko penting yang belum diselesaikan. Nilai yang tidak diketahui tidak boleh dianggap lulus.

Jika bukti kurang, hasil tetap `partially_verified` atau `inconclusive`; jika ada hambatan nyata, `blocked`. Model masih boleh mencari strategi atau bukti baru. Penghentian karena pembatalan, tidak ada izin, atau hambatan dilaporkan sebagai kondisi itu, bukan verified success.

Server memeriksa struktur, hubungan bukti-kriteria, freshness, dan hasil verifier yang tersedia. Server tidak menganggap string `outcome: "verified"` sebagai bukti independen atas kebenaran isi. Penilaian semantik dari model dicatat sebagai penilaian yang dilaporkan, dengan sumbernya.

### 5.4 Fusion hanya menggabungkan konsekuensi yang dinyatakan

Panggilan evaluasi dengan opsi coordination dapat membawa evidence baru, pemetaan kriteria, claim updates, dan hasil strategi. Jika opsinya tidak diberikan, semantik lama dipertahankan.

Kode memvalidasi seluruh usulan sebelum menyimpan. Klaim tidak otomatis menjadi `known` hanya karena evaluasi bernilai `verified`; hanya klaim yang secara eksplisit dipetakan dan didukung bukti boleh diperbarui. Kriteria lain tidak ikut terpenuhi. Invalidation dependency tetap dilakukan ketika ada perubahan yang relevan.

Bookkeeping, counter, dan referensi yang dapat diturunkan secara eksak diperbarui tanpa judgment model tambahan. Angka penghematan tidak boleh berasal dari counter yang ditebak.

## 6. Atomicity, retry, dan konkurensi

Satu coordination commit merupakan satu transaksi lokal terhadap state proyek. Seluruh pembaruan valid tersimpan bersama atau state sebelumnya tetap utuh. File `rename` saja tidak cukup untuk melindungi keseluruhan read-modify-write.

Kontrak transaksi baru:

- Pemanggil memberikan operation ID, expected project revision, dan identitas generasi state.
- Pemeriksaan revision serta penulisan berada dalam critical section yang mencakup seluruh penulis ke proyek yang sama. Mutex satu instance tidak mencukupi bila beberapa proses dapat membuka direktori state yang sama.
- Konflik revisi mengembalikan konflik dan referensi state saat ini; tidak ada overwrite atau penggabungan keputusan semantik secara diam-diam.
- Operation ID dan digest payload disimpan bersama hasil commit. Retry ID yang sama dengan payload sama mengembalikan hasil commit terdahulu tanpa mencatat ledger, evidence, atau evaluasi dua kali.
- ID yang sama dengan payload berbeda ditolak. Sesudah restart, catatan idempotency tetap berlaku. Scope v2.6.2 tidak melakukan pruning otomatis atas catatan ini; biaya penyimpanannya diukur.
- Retry sesudah commit tetapi sebelum respons diterima harus tetap dikenali sebagai replay yang sudah berhasil, walaupun expected revision awal kini lebih lama.
- Durabilitas dan pemulihan harus diuji dengan interupsi proses; klaim jaminan mengikuti mekanisme flush/journal yang benar-benar dipakai.

Atomicity ini berlaku pada state lokal Forge. Tool eksternal, command shell, layanan jaringan, dan efek samping dunia luar tidak dapat dibatalkan hanya karena commit lokal gagal. Tindakan tersebut tetap memiliki status eksekusi sendiri dan tidak otomatis diulang akibat timeout koordinasi.

Batas implementasi persistensi: koordinasi penulis berlaku untuk proses kooperatif
pada satu host dengan filesystem lokal. Recovery yang tidak dapat membuktikan
kepemilikan lock, termasuk recovery guard yang mati/tidak dapat dibuktikan,
berhenti secara konservatif dan memerlukan penanganan manual. Tidak ada jaminan
universal terhadap power loss, filesystem jaringan, atau penulis nonkooperatif.

## 7. State Reference Protocol

Identitas referensi mencakup proyek, generasi state, ID record, dan revisi record. Revision proyek mengurutkan commit; revision record berubah ketika record berubah. Keduanya tidak boleh dipertukarkan sehingga semua referensi dianggap berubah pada setiap commit.

Referensi hanyalah pointer, bukan sertifikat kebenaran atau freshness. Dependensi source, konfigurasi, environment, atau data eksternal yang berubah tetap dapat membuat bukti tidak berlaku. Input dinamis yang tidak mempunyai identitas freshness memadai tidak boleh direuse sebagai bukti current.

Respons `changed: false` hanya diberikan relatif terhadap cursor/referensi eksplisit pemanggil pada scope yang cocok. Server tidak menganggap semua client sudah melihat state yang sama. Compaction atau sesi baru tidak otomatis mewarisi cursor yang masih cukup untuk keputusan berikutnya.

Resolusi versi yang sudah tidak tersedia mengembalikan status stale/not-found beserta jalur mendapatkan versi current. Sistem tidak mengembalikan objek terbaru seolah-olah objek itu merupakan revisi lama. Protokol ini tidak menjanjikan penyimpanan seluruh snapshot historis.

Reset proyek mengganti identitas generasi agar cursor lama tidak cocok secara kebetulan. Penghapusan atau invalidation harus tercermin dalam delta; delta tidak boleh hanya berisi penambahan. Referensi lintas proyek tetap mengikuti mekanisme transfer yang membutuhkan validasi pada proyek tujuan.

## 8. Adaptasi host dan fallback

Server selalu mempertahankan katalog 19 tool. Pemilihan relevansi merupakan rekomendasi; bukan mekanisme izin baru dan bukan alasan menghapus tool dari `tools/list`.

| Dukungan yang dikonfirmasi | Perilaku |
|---|---|
| Deferred discovery tersedia dan konfigurasi host dapat dikendalikan | Adapter boleh memakai fasilitas host; discovery/ekspansi tetap dapat dijangkau |
| Host mendukung pembatasan subset dan perluasan kembali | Adapter boleh menyarankan subset sementara; kemampuan yang diizinkan tetap dapat dipulihkan |
| Dukungan tidak ada, tidak diketahui, atau discovery gagal | Katalog stabil dan perilaku kompatibel baseline |

Plugin lokal tidak boleh mengklaim dapat mengaktifkan `tool_search`, `allowed_tools`, atau mengatur prompt-cache host hanya dari server MCP. Itu memerlukan integrasi dan dukungan host yang nyata. Izin pengguna/host tetap mengikat pada seluruh mode.

Deferred loading tidak otomatis lebih efisien untuk 19 tool: pencarian juga membutuhkan pekerjaan dan dapat gagal menemukan tool relevan. Mode ini hanya diaktifkan berdasarkan hasil pengujian pada host yang mendukungnya. Biaya discovery dan fallback dihitung.

## 9. Rancangan pengujian

### A. Regresi kontrak dan state

Jalankan seluruh suite lama tanpa melemahkan assertion atau melewati tes. Tambahkan pengujian input/output lama, discovery 19 tool, context lengkap/recovery, pembacaan state lama, dan inisialisasi MCP dari working directory yang tidak terkait.

Bandingkan hasil semantik jalur gabungan dan jalur terpisah pada workload yang sama: bukti, kriteria, status goal/claim, invalidation, failed strategies, dan ledger. Normalisasi hanya field yang memang tak menentukan hasil seperti timestamp/ID yang baru dihasilkan; jangan menormalkan perbedaan status, bukti, atau urutan yang bermakna.

Baseline adalah pembanding, bukan sumber kebenaran tunggal. Jika muncul dugaan bug baseline, catat dan isolasi dengan expected behavior independen. Jangan mempertahankan bug atau mengubah fixture diam-diam demi kesetaraan.

### B. Kasus kegagalan terarah

| Kasus | Syarat lulus |
|---|---|
| Kendala penting lama tidak berubah | Tetap terlihat saat membatasi tindakan berikutnya |
| Bukti positif mempunyai counter-evidence | Kontradiksi terlihat; tidak auto-complete |
| Source/config/environment berubah | Bukti yang bergantung padanya tidak direuse sebagai current |
| Cursor hilang, tertinggal, atau dari proyek lain | Resinkronisasi aman; tidak memberi delta menyesatkan |
| Referensi dihapus/reset | Status eksplisit dan jalur pemulihan |
| Gagal sebelum commit | Tidak ada perubahan parsial pada state |
| Commit berhasil, respons hilang | Retry tidak menggandakan efek lokal |
| Dua writer memakai revision sama | Konflik terdeteksi; tidak ada lost update |
| Host gagal menemukan capability | Tool yang diizinkan tetap dapat dijangkau lewat fallback |
| Budget terlampaui tetapi verifikasi belum cukup | Jalur eskalasi tetap tersedia; tidak melaporkan sukses palsu |
| Tidak ada perubahan tetapi kriteria belum terpenuhi | Status belum selesai tetap terlihat |

### C. Kualitas keputusan model

Gunakan tugas representatif, kasus sulit, dan kasus yang sengaja menguji kekurangan capsule. Jalankan baseline dan kandidat dengan versi model, instruksi, alat, fixture, dan pengaturan yang sama. Ulangi tugas karena hasil model dapat bervariasi; tetapkan ukuran sampel dan rubrik sebelum hasil diperiksa.

Nilai keberhasilan terverifikasi, kepatuhan terhadap kendala, penggunaan bukti/counter-evidence, pemilihan tool, kemampuan pulih, dan premature completion. Perbandingan teks identik bukan syarat utama. Verifier objektif digunakan bila tersedia; keputusan semantik yang diperdebatkan membutuhkan penilaian yang terkalibrasi, bukan self-score kandidat semata.

Laporkan per kelas tugas, jumlah run, kegagalan, dan ketidakpastian statistik. Rata-rata baik tidak menghapus regresi pada kasus sulit. Interval yang tumpang tindih tidak membuktikan kualitas setara. Jangan mengubah margin penilaian sesudah melihat hasil agar kandidat lulus.

Jika akses eksekusi model/telemetri belum tersedia, bagian ini berstatus **belum diukur**. Tes Node saja tidak membenarkan klaim kualitas keputusan model terjaga. Mode proyeksi atau relevansi baru tidak dipromosikan menjadi default tanpa bukti perilaku yang memadai.

## 10. Benchmark efisiensi

Bandingkan v2.6.2 dengan baseline ZIP beku, termasuk compact yang sudah tersedia. Ukur varian tanpa optimisasi baru, fusion saja, projection saja, dan kombinasi. Pengujian host adapter dipisahkan menurut host; jangan mengatribusikan keuntungan host kepada engine lokal.

| Metrik | Aturan pelaporan |
|---|---|
| Verified success dan kegagalan per tugas | Pemeriksaan kualitas utama sebelum menilai penghematan |
| Coordination request + response bytes | Ukur seluruh payload, termasuk envelope, error, ekspansi, dan retry |
| Work calls dan coordination calls | Dilaporkan terpisah; jumlah call MCP bukan jumlah model turns |
| Context bytes | Subset response bytes; tidak ditambahkan lagi ke total |
| Ledger, reference resolution, locking, serialization, I/O | Overhead koordinasi ikut dihitung |
| Latency | Beberapa pengulangan pada kondisi sama; median dan tail, bukan satu sampel sebagai janji kecepatan |
| Model tokens/turns, cache hits, biaya | Hanya dari telemetri nyata dengan sumber; `null` bila tidak tersedia |
| Expansion/fallback/conflict/replay | Biayanya masuk total, tidak disembunyikan agar hasil tampak hemat |

Benchmark deterministik harus memakai fixture dan pemeriksaan artefak yang sama untuk setiap versi. Semua output mentah, identitas source, konfigurasi, dan definisi metrik disimpan saat implementasi diuji. Tidak ada konversi bytes menjadi token aktual tanpa pengukuran yang sesuai.

## 11. Gerbang penerimaan dan fallback

Optimisasi ditolak atau dinonaktifkan bila menyebabkan kehilangan data, menutup akses capability yang diperlukan, menghasilkan sukses palsu, mengurangi tuntutan verifikasi, atau menimbulkan regresi perilaku yang terkonfirmasi. Perbaikan pada banyak tugas tidak menebus kegagalan baru pada tugas kritis.

Penerimaan menuntut suite regresi dan pengujian kegagalan lulus, hasil semantik benar, serta pengurangan overhead pada workload yang dituju. Dimensi yang memburuk tetap dilaporkan. Jika manfaat hanya berlaku untuk kelas tugas tertentu, aktifkan secara terbatas pada kelas yang tervalidasi; jangan mengklaim peningkatan universal.

Fallback tidak menjalankan model kedua atau semua jalur sekaligus pada setiap tugas. Differential/shadow runs ditempatkan pada pengujian atau debugging yang disengaja. Runtime memakai pemeriksaan deterministik lokal serta ekspansi saat diperlukan agar mekanisme penjagaan kualitas tidak menjadi overhead berulang yang tak berguna.

Klaim hasil yang diperbolehkan: “tidak ditemukan regresi pada suite dan workload yang dilaporkan.” Tidak diperbolehkan mengubahnya menjadi jaminan matematis bahwa model tidak akan pernah lebih buruk pada semua tugas.

## 12. Scope yang dibekukan setelah persetujuan

Termasuk: fusion administratif, capsule/references, proyeksi opt-in, adapter host dengan fallback, integritas transaksi terkait fusion, serta benchmark dan pengujian kualitas yang diperlukan.

Tidak termasuk: model baru, retraining, tool publik tambahan, framework orchestration baru, database terdistribusi, historical object store tanpa batas, atau fitur efisiensi tambahan tanpa bukti kebutuhan.

Implementation plan memetakan desain yang disetujui ke perubahan dan pengujian source. Hasil benchmark deterministik, batas persistensi, dan status evaluasi model disimpan dalam dokumen verifikasi terpisah yang ditautkan di atas; dokumen desain ini tidak menjanjikan penghematan atau kualitas model yang belum diukur.

## 13. Referensi resmi yang diperiksa

Dokumentasi digunakan untuk konteks dukungan host dan evaluasi. Aturan arsitektur Forge di atas adalah keputusan desain proyek, bukan klaim bahwa dokumentasi OpenAI menjamin implementasinya.

- OpenAI, [Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search), diakses 7 Oktober 2026. Mendokumentasikan konfigurasi deferred loading pada API/host dan trade-off discovery.
- OpenAI, [Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices), diakses 7 Oktober 2026. Mendukung penggunaan evaluasi khusus tugas, kasus tepi, evaluasi berkelanjutan, dan pemeriksaan tool selection.
