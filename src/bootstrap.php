<?php
/**
 * Inti backend Jadwal Sholat: HTTP client, cache berkas, rate limit, utilitas.
 * Folder ini diblokir dari akses web (lihat web.config → hiddenSegments).
 */
declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(E_ALL);
header_remove('X-Powered-By');

/** Sumber data: Bimas Islam Kementerian Agama RI melalui API publik MyQuran. */
const UPSTREAM_BASE  = 'https://api.myquran.com/v2';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const USER_AGENT     = 'JadwalSholat/1.0 (self-hosted prayer times proxy)';
const HTTP_TIMEOUT   = 8;          // detik
const MAX_BODY       = 2_000_000;  // byte, batas aman ukuran respons upstream

final class ApiError extends RuntimeException
{
    public function __construct(string $message, public readonly int $status = 400)
    {
        parent::__construct($message);
    }
}

/** Direktori penyimpanan yang bisa ditulis (fallback ke temp sistem). */
function storage(string $sub): string
{
    static $base = null;
    if ($base === null) {
        foreach ([dirname(__DIR__) . '/storage', sys_get_temp_dir() . '/jadwal-sholat'] as $dir) {
            if ((is_dir($dir) || @mkdir($dir, 0775, true)) && is_writable($dir)) {
                $base = $dir;
                break;
            }
        }
        if ($base === null) {
            throw new RuntimeException('Storage tidak dapat ditulis');
        }
    }
    $path = $base . '/' . $sub;
    if (!is_dir($path)) {
        @mkdir($path, 0775, true);
    }
    return $path;
}

/** GET JSON lewat HTTPS dengan verifikasi TLS, timeout, dan batas ukuran. */
function http_get_json(string $url): array
{
    $body = '';
    $ch = curl_init($url);
    $opts = [
        CURLOPT_WRITEFUNCTION  => static function ($ch, string $chunk) use (&$body): int {
            if (strlen($body) + strlen($chunk) > MAX_BODY) {
                return 0; // batalkan transfer
            }
            $body .= $chunk;
            return strlen($chunk);
        },
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_TIMEOUT        => HTTP_TIMEOUT,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_USERAGENT      => USER_AGENT,
        CURLOPT_HTTPHEADER     => ['Accept: application/json'],
        CURLOPT_ENCODING       => '',
    ];
    if (defined('CURLOPT_PROTOCOLS_STR')) {
        $opts[CURLOPT_PROTOCOLS_STR] = 'https';
    }
    if (defined('CURLSSLOPT_NATIVE_CA') && !ini_get('curl.cainfo')) {
        $opts[CURLOPT_SSL_OPTIONS] = CURLSSLOPT_NATIVE_CA;
    }
    curl_setopt_array($ch, $opts);

    $ok     = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err    = curl_error($ch);
    unset($ch);

    if ($ok === false || $status !== 200) {
        throw new RuntimeException("Upstream gagal ($status): $err");
    }
    $data = json_decode($body, true, 32, JSON_THROW_ON_ERROR);
    if (!is_array($data)) {
        throw new RuntimeException('Format upstream tidak valid');
    }
    return $data;
}

function cache_file(string $key): string
{
    return storage('cache') . '/' . preg_replace('/[^a-z0-9_\-]/i', '_', $key) . '.json';
}

/**
 * Ambil dari cache bila masih segar; jika tidak, panggil $fetch.
 * Bila upstream gagal, data kedaluwarsa tetap dipakai (stale-if-error).
 * Lock berkas mencegah banyak request memanggil upstream bersamaan.
 */
function remember(string $key, int $ttl, callable $fetch): array
{
    $file = cache_file($key);
    $read = static function () use ($file): ?array {
        $raw = is_file($file) ? @file_get_contents($file) : false;
        $c = $raw ? json_decode($raw, true) : null;
        return (is_array($c) && isset($c['t'], $c['d']) && is_array($c['d'])) ? $c : null;
    };

    $cached = $read();
    if ($cached && time() - $cached['t'] < $ttl) {
        return $cached['d'];
    }

    $lock = fopen($file . '.lock', 'c');
    if ($lock) {
        flock($lock, LOCK_EX);
    }
    try {
        $cached = $read() ?? $cached;
        if ($cached && time() - $cached['t'] < $ttl) {
            return $cached['d'];
        }
        try {
            $data = $fetch();
        } catch (Throwable $e) {
            error_log('[jadwal-sholat] ' . $e->getMessage());
            if ($cached) {
                return $cached['d'];
            }
            throw new ApiError('Server Kemenag sedang tidak dapat dihubungi. Coba lagi nanti.', 502);
        }
        $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
        if (@file_put_contents($tmp, json_encode(['t' => time(), 'd' => $data], JSON_UNESCAPED_UNICODE)) !== false) {
            if (!@rename($tmp, $file)) {
                @unlink($tmp);
            }
        }
        return $data;
    } finally {
        if ($lock) {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }
}

/** Rate limit fixed-window per IP (IP disimpan dalam bentuk hash). */
function rate_limit(string $bucket, int $limit, int $window): void
{
    $dir = storage('ratelimit');
    $ip  = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $file = $dir . '/' . $bucket . '_' . substr(hash('sha256', $ip), 0, 32) . '.json';

    $h = @fopen($file, 'c+');
    if (!$h) {
        return; // jangan blokir pengguna bila storage bermasalah
    }
    flock($h, LOCK_EX);
    $now   = time();
    $state = json_decode((string) stream_get_contents($h), true);
    if (!is_array($state) || $now - (int) ($state['w'] ?? 0) >= $window) {
        $state = ['w' => $now, 'c' => 0];
    }
    $state['c']++;
    ftruncate($h, 0);
    rewind($h);
    fwrite($h, json_encode($state));
    flock($h, LOCK_UN);
    fclose($h);

    // Bersihkan berkas lama sesekali.
    if (random_int(1, 200) === 1) {
        foreach (glob($dir . '/*.json') ?: [] as $f) {
            if (@filemtime($f) < $now - 3600) {
                @unlink($f);
            }
        }
    }

    if ($state['c'] > $limit) {
        header('Retry-After: ' . max(1, $window - ($now - $state['w'])));
        throw new ApiError('Terlalu banyak permintaan. Silakan tunggu sebentar.', 429);
    }
}

/** Kirim JSON + ETag/Cache-Control; jawab 304 bila konten tidak berubah. */
function send_json(array $payload, int $status = 200, int $maxAge = 0): never
{
    $body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');

    if ($status === 200 && $maxAge > 0) {
        $etag = '"' . substr(hash('sha256', $body), 0, 32) . '"';
        header('ETag: ' . $etag);
        header("Cache-Control: public, max-age=$maxAge, stale-while-revalidate=86400");
        header('Vary: Accept-Encoding');
        if (trim($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
            http_response_code(304);
            exit;
        }
    } else {
        header('Cache-Control: no-store');
    }

    if (strlen($body) > 1024 && function_exists('ob_gzhandler') && !ini_get('zlib.output_compression')) {
        ob_start('ob_gzhandler');
    }
    echo $body;
    exit;
}

/** Hanya izinkan karakter nama wilayah yang wajar. */
function clean_text(mixed $s, int $max = 80): string
{
    $s = preg_replace('/[^\p{L}\p{N} .,\'()\/\-]/u', '', (string) $s) ?? '';
    return mb_substr(trim(preg_replace('/\s+/', ' ', $s) ?? ''), 0, $max);
}

/** Offset zona waktu (WIB/WITA/WIT) berdasarkan nama provinsi. */
function tz_offset(string $province): int
{
    $p = strtoupper($province);
    if (preg_match('/PAPUA|MALUKU/', $p)) {
        return 9;
    }
    if (preg_match('/BALI|NUSA TENGGARA|NTB|NTT|SULAWESI|GORONTALO|KALIMANTAN (SELATAN|TIMUR|UTARA)|KALSEL|KALTIM|KALTARA/', $p)) {
        return 8;
    }
    return 7;
}

/** Normalisasi nama kab/kota untuk pencocokan lokasi. */
function norm_region(string $s): string
{
    $s = strtoupper($s);
    $s = preg_replace('/^(KOTA ADMINISTRASI|KABUPATEN ADMINISTRASI|KABUPATEN|KAB\.?|KOTA)\s+/', '', $s) ?? $s;
    $s = str_replace(['KEP.', 'KEPULAUAN'], 'KEP', $s);
    $s = preg_replace('/[^A-Z0-9]+/', ' ', $s) ?? $s;
    return trim($s);
}

function region_kind(string $s): ?string
{
    $s = strtoupper(ltrim($s));
    return match (true) {
        str_starts_with($s, 'KOTA') => 'KOTA',
        str_starts_with($s, 'KAB')  => 'KAB',
        default                     => null,
    };
}
